import type { Node as TsNode } from "web-tree-sitter";
import type { Edge, ExtractionError, Node } from "../../types";
import {
	lastSegment,
	namedChildOfType,
	namedChildrenOfTypes,
	normalizePhpFqn,
	phpFqnJoin,
	resolveTypeReference,
	TYPE_NAME_NODE_TYPES,
} from "./names";
import type { PhpNameIndex } from "./resolve";

export interface CallEmitContext {
	decl: TsNode;
	nodes: Node[];
	fileNodeId: string | undefined;
	aliases: Map<string, string>;
	currentNamespace: string | undefined;
	nameIndex: PhpNameIndex;
	edges: Edge[];
	errors: ExtractionError[];
}

/**
 * Emit `calls` / `instantiates` from a class, interface, or file-level function.
 * Receiver types come from an intra-class table (promoted / typed / ctor-assigned
 * properties) plus `$this` / `self` / `static` / `parent`.
 */
export function emitCallAndInstantiateEdges(ctx: CallEmitContext): void {
	const classFqn = classFqnOf(ctx.decl, ctx.currentNamespace);
	const classId =
		classFqn === undefined ? undefined : ctx.nameIndex.fqn.get(classFqn);
	const typeTable =
		ctx.decl.type === "function_definition"
			? new Map<string, string>()
			: buildIntraClassTypeTable(ctx.decl, ctx.aliases, ctx.currentNamespace);

	const fileId = ctx.fileNodeId ?? ctx.nodes.find((n) => n.kind === "file")?.id;
	if (fileId === undefined) return;

	walk(ctx.decl, (node) => {
		if (node.type === "member_call_expression") {
			emitMemberCall(node, ctx, typeTable, classFqn, classId, fileId);
			return;
		}
		if (node.type === "scoped_call_expression") {
			emitScopedCall(node, ctx, classFqn, classId, fileId);
			return;
		}
		if (node.type === "object_creation_expression") {
			emitInstantiate(node, ctx, classId, fileId);
		}
	});
}

export function buildIntraClassTypeTable(
	classDecl: TsNode,
	aliases: Map<string, string>,
	currentNamespace: string | undefined,
): Map<string, string> {
	const table = new Map<string, string>();
	const body = classDecl.childForFieldName("body");
	if (!body) return table;

	const ctorParams = new Map<string, string>();

	for (let i = 0; i < body.namedChildCount; i++) {
		const member = body.namedChild(i);
		if (!member) continue;

		if (member.type === "property_declaration") {
			const fqn = namedTypeFqn(member, aliases, currentNamespace);
			if (fqn === undefined) continue;
			for (const element of namedChildrenOfType(member, "property_element")) {
				const varName = namedChildOfType(element, "variable_name");
				const name = stripDollar(varName?.text ?? element.namedChild(0)?.text);
				if (name) table.set(name, fqn);
			}
		}

		if (member.type === "method_declaration") {
			const name = namedChildOfType(member, "name")?.text;
			if (name !== "__construct") continue;
			const params = namedChildOfType(member, "formal_parameters");
			if (!params) continue;
			for (let p = 0; p < params.namedChildCount; p++) {
				const param = params.namedChild(p);
				if (!param) continue;
				const fqn = namedTypeFqn(param, aliases, currentNamespace);
				const varName = namedChildOfType(param, "variable_name");
				const pname = stripDollar(varName?.text);
				if (pname === undefined) continue;
				if (fqn !== undefined) ctorParams.set(pname, fqn);
				if (param.type === "property_promotion_parameter" && fqn) {
					table.set(pname, fqn);
				}
			}
			collectConstructorAssignments(member, ctorParams, table);
		}
	}

	return table;
}

export type MethodBucket =
	| { bucket: 1; methodId: string }
	| { bucket: 2; targetName: string }
	| { bucket: 3; targetName: string }
	| { bucket: 4 };

export function lookupMethod(
	receiverFqn: string | undefined,
	methodName: string,
	index: PhpNameIndex,
): MethodBucket {
	if (receiverFqn === undefined || receiverFqn === "") return { bucket: 4 };

	const startId = index.fqn.get(receiverFqn);
	if (startId === undefined) {
		return { bucket: 2, targetName: `${receiverFqn}::${methodName}` };
	}

	const visited = new Set<string>();
	const queue: string[] = [startId];
	let incomplete = false;
	let depth = 0;

	while (queue.length > 0 && depth < 32) {
		depth += 1;
		const typeId = queue.shift();
		if (typeId === undefined || visited.has(typeId)) continue;
		visited.add(typeId);

		if (index.traitUse.has(typeId)) incomplete = true;

		const methods = index.methods.get(typeId);
		const methodId = methods?.get(methodName);
		if (methodId !== undefined) return { bucket: 1, methodId };

		for (const parentFqn of index.extendsOf.get(typeId) ?? []) {
			const parentId = index.fqn.get(parentFqn);
			if (parentId === undefined) incomplete = true;
			else queue.push(parentId);
		}
		for (const ifaceFqn of index.implementsOf.get(typeId) ?? []) {
			if (index.fqn.get(ifaceFqn) === undefined) incomplete = true;
		}
	}

	const targetName = `${receiverFqn}::${methodName}`;
	if (incomplete) return { bucket: 2, targetName };
	return { bucket: 3, targetName };
}

function emitMemberCall(
	node: TsNode,
	ctx: CallEmitContext,
	typeTable: Map<string, string>,
	classFqn: string | undefined,
	classId: string | undefined,
	fileId: string,
): void {
	const methodName = callName(node);
	if (methodName === undefined) return;
	const object =
		node.childForFieldName("object") ?? node.namedChild(0) ?? undefined;
	const receiverFqn = resolveMemberReceiver(
		object,
		typeTable,
		classFqn,
		ctx.nameIndex,
	);
	emitCallEdge(node, ctx, methodName, receiverFqn, classId, fileId);
}

function emitScopedCall(
	node: TsNode,
	ctx: CallEmitContext,
	classFqn: string | undefined,
	classId: string | undefined,
	fileId: string,
): void {
	const methodName = callName(node);
	if (methodName === undefined) return;
	const scope =
		node.childForFieldName("scope") ??
		namedChildOfType(node, "relative_scope") ??
		node.namedChild(0) ??
		undefined;
	const receiverFqn = resolveScopedReceiver(
		scope,
		classFqn,
		classId,
		ctx.aliases,
		ctx.currentNamespace,
		ctx.nameIndex,
	);
	emitCallEdge(node, ctx, methodName, receiverFqn, classId, fileId);
}

function emitCallEdge(
	node: TsNode,
	ctx: CallEmitContext,
	methodName: string,
	receiverFqn: string | undefined,
	classId: string | undefined,
	fileId: string,
): void {
	const sourceId = enclosingCallable(node, ctx.nodes, fileId, classId);
	const result = lookupMethod(receiverFqn, methodName, ctx.nameIndex);
	const pos = node.startPosition;

	if (result.bucket === 1) {
		ctx.edges.push({
			source: sourceId,
			target: result.methodId,
			targetName: methodName,
			kind: "calls",
			resolutionState: "resolved",
			confidence: "high",
			provenance: "tree-sitter",
			line: pos.row + 1,
			col: pos.column,
		});
		return;
	}

	if (result.bucket === 2) {
		ctx.edges.push({
			source: sourceId,
			target: null,
			targetName: result.targetName,
			kind: "calls",
			resolutionState: "external",
			confidence: "high",
			provenance: "tree-sitter",
			line: pos.row + 1,
			col: pos.column,
		});
		return;
	}

	if (result.bucket === 3) {
		ctx.errors.push({
			message: `PHP call ${result.targetName} not found on an in-project type chain`,
			filePath: ctx.nodes[0]?.filePath ?? "",
			line: pos.row + 1,
			severity: "warning",
			code: "PHP_CALL_UNRESOLVED",
		});
		ctx.edges.push({
			source: sourceId,
			target: null,
			targetName: result.targetName,
			kind: "calls",
			resolutionState: "unresolved",
			confidence: "low",
			provenance: "tree-sitter",
			line: pos.row + 1,
			col: pos.column,
		});
		return;
	}

	ctx.edges.push({
		source: sourceId,
		target: null,
		targetName: methodName,
		kind: "calls",
		resolutionState: "unresolved",
		confidence: "low",
		provenance: "tree-sitter",
		line: pos.row + 1,
		col: pos.column,
	});
}

function emitInstantiate(
	node: TsNode,
	ctx: CallEmitContext,
	classId: string | undefined,
	fileId: string,
): void {
	const typeNode =
		namedChildrenOfTypes(node, TYPE_NAME_NODE_TYPES)[0] ??
		namedChildOfType(node, "named_type") ??
		node.namedChild(0);
	const raw = typeNode?.text;
	const sourceId = enclosingCallable(node, ctx.nodes, fileId, classId);
	const pos = node.startPosition;

	if (raw === undefined || raw.startsWith("$")) {
		ctx.edges.push({
			source: sourceId,
			target: null,
			targetName: raw ?? "new",
			kind: "instantiates",
			resolutionState: "unresolved",
			confidence: "low",
			provenance: "tree-sitter",
			line: pos.row + 1,
			col: pos.column,
		});
		return;
	}

	const fqn = resolveTypeReference(raw, ctx.aliases, ctx.currentNamespace);
	if (fqn === undefined) {
		ctx.edges.push({
			source: sourceId,
			target: null,
			targetName: raw,
			kind: "instantiates",
			resolutionState: "unresolved",
			confidence: "low",
			provenance: "tree-sitter",
			line: pos.row + 1,
			col: pos.column,
		});
		return;
	}

	const typeId = ctx.nameIndex.fqn.get(fqn);
	if (typeId === undefined) {
		ctx.edges.push({
			source: sourceId,
			target: null,
			targetName: fqn,
			kind: "instantiates",
			resolutionState: "external",
			confidence: "high",
			provenance: "tree-sitter",
			line: pos.row + 1,
			col: pos.column,
		});
		return;
	}

	const ctor = ctx.nameIndex.methods.get(typeId)?.get("__construct");
	ctx.edges.push({
		source: sourceId,
		target: ctor ?? typeId,
		targetName: lastSegment(fqn),
		kind: "instantiates",
		resolutionState: "resolved",
		confidence: "high",
		provenance: "tree-sitter",
		line: pos.row + 1,
		col: pos.column,
	});
}

function resolveMemberReceiver(
	object: TsNode | undefined,
	typeTable: Map<string, string>,
	classFqn: string | undefined,
	index: PhpNameIndex,
): string | undefined {
	if (object === undefined) return undefined;

	if (object.type === "member_call_expression") return undefined;

	if (isThisVar(object)) return classFqn;

	if (
		object.type === "member_access_expression" ||
		object.type === "nullsafe_member_access_expression"
	) {
		const inner = object.childForFieldName("object") ?? object.namedChild(0);
		const prop = callName(object);
		if (inner && isThisVar(inner) && prop !== undefined) {
			return typeTable.get(prop);
		}
		return undefined;
	}

	if (object.type === "variable_name") {
		const name = stripDollar(object.text);
		if (name === "this") return classFqn;
		return undefined;
	}

	void index;
	return undefined;
}

function resolveScopedReceiver(
	scope: TsNode | undefined,
	classFqn: string | undefined,
	classId: string | undefined,
	aliases: Map<string, string>,
	currentNamespace: string | undefined,
	index: PhpNameIndex,
): string | undefined {
	if (scope === undefined) return undefined;
	const text = scope.text;
	if (text === "self" || text === "static") return classFqn;
	if (text === "parent") {
		if (classId === undefined) return undefined;
		const parents = index.extendsOf.get(classId) ?? [];
		return parents[0];
	}
	return resolveTypeReference(text, aliases, currentNamespace);
}

function enclosingCallable(
	node: TsNode,
	nodes: Node[],
	fileId: string,
	classId: string | undefined,
): string {
	let current: TsNode | null = node;
	while (current) {
		if (
			current.type === "method_declaration" ||
			current.type === "function_definition"
		) {
			const name = namedChildOfType(current, "name")?.text;
			if (name !== undefined) {
				const kind =
					current.type === "method_declaration" ? "method" : "function";
				const id = findNodeId(nodes, kind, name, current);
				if (id !== undefined) return id;
			}
		}
		current = current.parent;
	}
	return classId ?? fileId;
}

function findNodeId(
	nodes: Node[],
	kind: Node["kind"],
	name: string,
	decl: TsNode,
): string | undefined {
	const startLine = decl.startPosition.row + 1;
	const startColumn = decl.startPosition.column;
	return nodes.find(
		(node) =>
			node.kind === kind &&
			node.name === name &&
			node.range.startLine === startLine &&
			node.range.startColumn === startColumn,
	)?.id;
}

function classFqnOf(
	decl: TsNode,
	currentNamespace: string | undefined,
): string | undefined {
	if (
		decl.type !== "class_declaration" &&
		decl.type !== "interface_declaration" &&
		decl.type !== "trait_declaration"
	) {
		return undefined;
	}
	const name = namedChildOfType(decl, "name")?.text;
	if (name === undefined) return undefined;
	return phpFqnJoin(currentNamespace, name);
}

function callName(node: TsNode): string | undefined {
	const name = node.childForFieldName("name") ?? namedChildOfType(node, "name");
	return name?.text;
}

function namedTypeFqn(
	owner: TsNode,
	aliases: Map<string, string>,
	currentNamespace: string | undefined,
): string | undefined {
	const named = firstNamedType(owner);
	if (named === undefined) return undefined;
	const raw = named.text;
	if (raw === "" || isBuiltin(raw)) return undefined;
	return resolveTypeReference(raw, aliases, currentNamespace);
}

function firstNamedType(node: TsNode): TsNode | undefined {
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (!child) continue;
		if (TYPE_NAME_NODE_TYPES.has(child.type)) return child;
		if (
			child.type === "named_type" ||
			child.type === "optional_type" ||
			child.type === "union_type" ||
			child.type === "intersection_type"
		) {
			const inner = firstNamedType(child);
			if (inner) return inner;
		}
	}
	return undefined;
}

function collectConstructorAssignments(
	ctor: TsNode,
	ctorParams: Map<string, string>,
	table: Map<string, string>,
): void {
	const body = ctor.childForFieldName("body");
	if (!body) return;
	walk(body, (node) => {
		if (node.type !== "assignment_expression") return;
		const left = node.childForFieldName("left") ?? node.namedChild(0);
		const right = node.childForFieldName("right") ?? node.namedChild(1);
		if (!left || !right) return;
		if (
			left.type !== "member_access_expression" &&
			left.type !== "nullsafe_member_access_expression"
		) {
			return;
		}
		const obj = left.childForFieldName("object") ?? left.namedChild(0);
		if (!obj || !isThisVar(obj)) return;
		const prop = callName(left);
		if (prop === undefined || table.has(prop)) return;
		if (right.type !== "variable_name") return;
		const paramFqn = ctorParams.get(stripDollar(right.text) ?? "");
		if (paramFqn) table.set(prop, paramFqn);
	});
}

function walk(node: TsNode, visit: (n: TsNode) => void): void {
	visit(node);
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (child) walk(child, visit);
	}
}

function namedChildrenOfType(node: TsNode, type: string): TsNode[] {
	const found: TsNode[] = [];
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (child?.type === type) found.push(child);
	}
	return found;
}

function isThisVar(node: TsNode): boolean {
	return node.type === "variable_name" && stripDollar(node.text) === "this";
}

function stripDollar(name: string | undefined): string | undefined {
	if (name === undefined) return undefined;
	return name.startsWith("$") ? name.slice(1) : name;
}

function isBuiltin(raw: string): boolean {
	return [
		"string",
		"int",
		"float",
		"bool",
		"array",
		"void",
		"mixed",
		"never",
		"self",
		"static",
		"parent",
		"iterable",
		"object",
		"callable",
		"null",
	].includes(normalizePhpFqn(raw).toLowerCase());
}
