import type { Node as TsNode } from "web-tree-sitter";
import type {
	Edge,
	EdgeKind,
	EdgeResolutionResult,
	ExtractionError,
	Node,
	NodeKind,
} from "../../types";
import type { PhpAstCache } from "./ast-cache";
import { emitCallAndInstantiateEdges } from "./calls";
import {
	collectUseDeclaration,
	isPhpBuiltinType,
	lastSegment,
	namedChildOfType,
	namedChildrenOfTypes,
	normalizePhpFqn,
	phpFqnJoin,
	resolveTypeReference,
	TYPE_NAME_NODE_TYPES,
} from "./names";

export type PhpFqnIndex = Map<string, string>;

/** Project-wide PHP names collected while trees are live, then trees are dropped. */
export interface PhpNameIndex {
	fqn: PhpFqnIndex;
	/** type node id → method name → method node id */
	methods: Map<string, Map<string, string>>;
	/** type node id → parent FQNs (resolved via use/namespace, not yet existence) */
	extendsOf: Map<string, string[]>;
	implementsOf: Map<string, string[]>;
	traitUse: Set<string>;
}

export function emptyPhpNameIndex(): PhpNameIndex {
	return {
		fqn: new Map(),
		methods: new Map(),
		extendsOf: new Map(),
		implementsOf: new Map(),
		traitUse: new Set(),
	};
}

export interface PhpResolveContext {
	fileNames: string[];
	loadNodesForFile: (filePath: string) => Node[];
	/** Parse helper — one live Tree; {@link buildPhpNameIndex} releases each file. */
	astCache: PhpAstCache;
}

/**
 * Project-wide FQN → node id, plus method/extends tables for call resolution.
 * Parses each file, contributes, then releases the Tree.
 */
export function buildPhpNameIndex(ctx: PhpResolveContext): PhpNameIndex {
	const index = emptyPhpNameIndex();

	for (const relPath of ctx.fileNames) {
		const entry = ctx.astCache.parse(relPath);
		if (entry === undefined) continue;
		try {
			contributePhpNameIndex(
				index,
				entry.tree.rootNode,
				ctx.loadNodesForFile(relPath),
			);
		} finally {
			ctx.astCache.release(relPath);
		}
	}
	return index;
}

export function contributePhpNameIndex(
	index: PhpNameIndex,
	root: TsNode,
	nodes: Node[],
): void {
	forEachPhpScope(root, (scope) => {
		for (const decl of scope.declarations) {
			const name = namedChildOfType(decl, "name")?.text;
			if (name === undefined) continue;
			const kind =
				decl.type === "interface_declaration" ? "interface" : "class";
			const id = findPassANodeId(nodes, kind, name, decl);
			if (id === undefined) continue;
			const fqn = phpFqnJoin(scope.namespaceName, name);
			index.fqn.set(fqn, id);

			const methods = new Map<string, string>();
			const body = decl.childForFieldName("body");
			if (body) {
				for (let i = 0; i < body.namedChildCount; i++) {
					const member = body.namedChild(i);
					if (!member) continue;
					if (member.type === "use_declaration") {
						index.traitUse.add(id);
					}
					if (member.type !== "method_declaration") continue;
					const methodName = namedChildOfType(member, "name")?.text;
					if (methodName === undefined) continue;
					const methodId = findPassANodeId(nodes, "method", methodName, member);
					if (methodId !== undefined) methods.set(methodName, methodId);
				}
			}
			index.methods.set(id, methods);

			const base = namedChildOfType(decl, "base_clause");
			if (base) {
				const parents: string[] = [];
				for (const typeName of namedChildrenOfTypes(
					base,
					TYPE_NAME_NODE_TYPES,
				)) {
					const parentFqn = resolveTypeReference(
						typeName.text,
						scope.aliases,
						scope.namespaceName,
					);
					if (parentFqn) parents.push(parentFqn);
				}
				index.extendsOf.set(id, parents);
			}

			const iface = namedChildOfType(decl, "class_interface_clause");
			if (iface) {
				const ifaces: string[] = [];
				for (const typeName of namedChildrenOfTypes(
					iface,
					TYPE_NAME_NODE_TYPES,
				)) {
					const ifaceFqn = resolveTypeReference(
						typeName.text,
						scope.aliases,
						scope.namespaceName,
					);
					if (ifaceFqn) ifaces.push(ifaceFqn);
				}
				index.implementsOf.set(id, ifaces);
			}
		}
	});
}

/**
 * Resolve PHP edges for one file: heritage, imports, type-position
 * dependencies, then calls/instantiates. Re-uses Pass A `contains` edges so
 * the indexer's edge-replace step does not drop structural edges.
 *
 * `root` must be the root node of the live Tree for this file (caller releases
 * it after this returns).
 */
export function resolvePhpHeritage(
	_relPath: string,
	passA: { nodes: Node[]; edges: Edge[]; errors: ExtractionError[] },
	nameIndex: PhpNameIndex,
	root: TsNode,
): EdgeResolutionResult {
	const fqnIndex = nameIndex.fqn;
	const edges: Edge[] = [...passA.edges];
	const errors: ExtractionError[] = [...passA.errors];
	const fileNode = passA.nodes.find((node) => node.kind === "file");

	forEachPhpScope(root, (scope) => {
		if (fileNode !== undefined) {
			emitImportEdges(
				scope,
				fileNode.id,
				scope.aliases,
				scope.namespaceName,
				fqnIndex,
				edges,
			);
		}

		for (const decl of scope.declarations) {
			emitHeritageForDeclaration(
				decl,
				passA.nodes,
				scope.aliases,
				scope.namespaceName,
				fqnIndex,
				edges,
			);
			emitTypeEdgesForTypeDeclaration(
				decl,
				passA.nodes,
				scope.aliases,
				scope.namespaceName,
				fqnIndex,
				edges,
			);
			emitCallAndInstantiateEdges({
				decl,
				nodes: passA.nodes,
				fileNodeId: fileNode?.id,
				aliases: scope.aliases,
				currentNamespace: scope.namespaceName,
				nameIndex,
				edges,
				errors,
			});
		}

		for (const fn of scope.functions) {
			emitTypeEdgesForFunction(
				fn,
				passA.nodes,
				scope.aliases,
				scope.namespaceName,
				fqnIndex,
				edges,
			);
			emitCallAndInstantiateEdges({
				decl: fn,
				nodes: passA.nodes,
				fileNodeId: fileNode?.id,
				aliases: scope.aliases,
				currentNamespace: scope.namespaceName,
				nameIndex,
				edges,
				errors,
			});
		}
	});

	edges.sort(compareEdges);
	return { edges, errors, externalNodes: [] };
}

interface PhpScope {
	namespaceName: string | undefined;
	aliases: Map<string, string>;
	/** Raw `namespace_use_declaration` nodes in this scope (for imports edges). */
	useDeclarations: TsNode[];
	declarations: TsNode[];
	functions: TsNode[];
}

/**
 * Walk the file respecting PHP namespace scope:
 * - `namespace X;` applies to subsequent siblings until the next `;` namespace
 * - `namespace X { … }` applies only inside the body
 */
function forEachPhpScope(root: TsNode, visit: (scope: PhpScope) => void): void {
	walkContainer(root, undefined, visit);
}

function walkContainer(
	container: TsNode,
	outerNamespace: string | undefined,
	visit: (scope: PhpScope) => void,
): void {
	type Chunk = { namespaceName: string | undefined; siblings: TsNode[] };
	const chunks: Chunk[] = [{ namespaceName: outerNamespace, siblings: [] }];
	let current = chunks[0]!;

	for (let i = 0; i < container.namedChildCount; i++) {
		const child = container.namedChild(i);
		if (!child) continue;

		if (child.type === "namespace_definition") {
			const nameNode = child.childForFieldName("name");
			const ns = nameNode ? normalizePhpFqn(nameNode.text) : undefined;
			const body = child.childForFieldName("body");
			if (body) {
				walkContainer(body, ns, visit);
			} else {
				current = { namespaceName: ns, siblings: [] };
				chunks.push(current);
			}
			continue;
		}

		current.siblings.push(child);
	}

	for (const chunk of chunks) {
		if (chunk.siblings.length === 0) continue;
		const aliases = buildAliasTableFromSiblings(chunk.siblings);
		visit({
			namespaceName: chunk.namespaceName,
			aliases,
			useDeclarations: chunk.siblings.filter(
				(node) => node.type === "namespace_use_declaration",
			),
			declarations: chunk.siblings.filter(
				(node) =>
					node.type === "class_declaration" ||
					node.type === "interface_declaration" ||
					node.type === "trait_declaration",
			),
			functions: chunk.siblings.filter(
				(node) => node.type === "function_definition",
			),
		});
	}
}

function buildAliasTableFromSiblings(siblings: TsNode[]): Map<string, string> {
	const aliases = new Map<string, string>();
	for (const sibling of siblings) {
		if (sibling.type !== "namespace_use_declaration") continue;
		collectUseDeclaration(sibling, aliases);
	}
	return aliases;
}

function emitImportEdges(
	scope: PhpScope,
	fileNodeId: string,
	aliases: Map<string, string>,
	currentNamespace: string | undefined,
	fqnIndex: PhpFqnIndex,
	edges: Edge[],
): void {
	// Each alias entry is one imported FQN (plain, aliased, or grouped member).
	// Rebuild per-declaration so line/col point at the use site.
	for (const useDecl of scope.useDeclarations) {
		const local = new Map<string, string>();
		collectUseDeclaration(useDecl, local);
		for (const fqn of new Set(local.values())) {
			edges.push(
				resolvedEdge({
					sourceId: fileNodeId,
					raw: fqn,
					kind: "imports",
					aliases,
					currentNamespace,
					fqnIndex,
					forceAbsolute: true,
					pos: useDecl.startPosition,
				}),
			);
		}
	}
}

function emitHeritageForDeclaration(
	decl: TsNode,
	nodes: Node[],
	aliases: Map<string, string>,
	currentNamespace: string | undefined,
	fqnIndex: PhpFqnIndex,
	edges: Edge[],
): void {
	const name = namedChildOfType(decl, "name")?.text;
	if (name === undefined) return;
	const kind = decl.type === "interface_declaration" ? "interface" : "class";
	const sourceId = findPassANodeId(nodes, kind, name, decl);
	if (sourceId === undefined) return;

	const base = namedChildOfType(decl, "base_clause");
	if (base) {
		for (const typeName of namedChildrenOfTypes(base, TYPE_NAME_NODE_TYPES)) {
			edges.push(
				resolvedEdge({
					sourceId,
					raw: typeName.text,
					kind: "extends",
					aliases,
					currentNamespace,
					fqnIndex,
					pos: typeName.startPosition,
				}),
			);
		}
	}

	const iface = namedChildOfType(decl, "class_interface_clause");
	if (iface) {
		for (const typeName of namedChildrenOfTypes(iface, TYPE_NAME_NODE_TYPES)) {
			edges.push(
				resolvedEdge({
					sourceId,
					raw: typeName.text,
					kind: "implements",
					aliases,
					currentNamespace,
					fqnIndex,
					pos: typeName.startPosition,
				}),
			);
		}
	}
}

function emitTypeEdgesForTypeDeclaration(
	decl: TsNode,
	nodes: Node[],
	aliases: Map<string, string>,
	currentNamespace: string | undefined,
	fqnIndex: PhpFqnIndex,
	edges: Edge[],
): void {
	const body = decl.childForFieldName("body");
	if (!body) return;

	for (let i = 0; i < body.namedChildCount; i++) {
		const member = body.namedChild(i);
		if (!member) continue;

		if (member.type === "property_declaration") {
			emitPropertyTypeEdges(
				member,
				nodes,
				aliases,
				currentNamespace,
				fqnIndex,
				edges,
			);
		} else if (member.type === "method_declaration") {
			emitTypeEdgesForFunction(
				member,
				nodes,
				aliases,
				currentNamespace,
				fqnIndex,
				edges,
			);
		}
	}
}

function emitPropertyTypeEdges(
	propertyDecl: TsNode,
	nodes: Node[],
	aliases: Map<string, string>,
	currentNamespace: string | undefined,
	fqnIndex: PhpFqnIndex,
	edges: Edge[],
): void {
	const typeNode = typeNodeOf(propertyDecl);
	const namedTypes = collectNamedTypes(typeNode);
	if (namedTypes.length === 0) return;

	for (const element of namedChildrenOfType(propertyDecl, "property_element")) {
		const varName = namedChildOfType(element, "variable_name");
		const name = varName?.text ?? element.namedChild(0)?.text;
		if (name === undefined) continue;
		const sourceId = findPassANodeId(nodes, "property", name, element);
		if (sourceId === undefined) continue;
		for (const named of namedTypes) {
			pushTypeEdge(
				sourceId,
				named,
				"type_of",
				aliases,
				currentNamespace,
				fqnIndex,
				edges,
			);
		}
	}
}

function emitTypeEdgesForFunction(
	fn: TsNode,
	nodes: Node[],
	aliases: Map<string, string>,
	currentNamespace: string | undefined,
	fqnIndex: PhpFqnIndex,
	edges: Edge[],
): void {
	const name = namedChildOfType(fn, "name")?.text;
	if (name === undefined) return;
	const kind: NodeKind =
		fn.type === "function_definition" ? "function" : "method";
	const sourceId = findPassANodeId(nodes, kind, name, fn);
	if (sourceId === undefined) return;

	const params = namedChildOfType(fn, "formal_parameters");
	if (params) {
		for (let i = 0; i < params.namedChildCount; i++) {
			const param = params.namedChild(i);
			if (!param) continue;
			if (
				param.type !== "simple_parameter" &&
				param.type !== "property_promotion_parameter"
			) {
				continue;
			}
			const typeNode = typeNodeOf(param);
			for (const named of collectNamedTypes(typeNode)) {
				// Parameters are not Pass A nodes; Magento DI is read off the
				// enclosing callable (constructor / method / function).
				pushTypeEdge(
					sourceId,
					named,
					"type_of",
					aliases,
					currentNamespace,
					fqnIndex,
					edges,
				);
			}
		}
	}

	const returnType = returnTypeNodeOf(fn);
	for (const named of collectNamedTypes(returnType)) {
		pushTypeEdge(
			sourceId,
			named,
			"returns",
			aliases,
			currentNamespace,
			fqnIndex,
			edges,
		);
	}
}

function pushTypeEdge(
	sourceId: string,
	namedType: TsNode,
	kind: "type_of" | "returns",
	aliases: Map<string, string>,
	currentNamespace: string | undefined,
	fqnIndex: PhpFqnIndex,
	edges: Edge[],
): void {
	const raw = namedType.text;
	if (isPhpBuiltinType(raw)) return;
	edges.push(
		resolvedEdge({
			sourceId,
			raw,
			kind,
			aliases,
			currentNamespace,
			fqnIndex,
			pos: namedType.startPosition,
		}),
	);
}

/** Type child of a parameter / property (named, optional, union, …). */
function typeNodeOf(node: TsNode): TsNode | undefined {
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (!child) continue;
		if (
			child.type === "named_type" ||
			child.type === "primitive_type" ||
			child.type === "optional_type" ||
			child.type === "union_type" ||
			child.type === "intersection_type"
		) {
			return child;
		}
	}
	return undefined;
}

/** Return-type annotation on a method/function (sibling after formal_parameters). */
function returnTypeNodeOf(fn: TsNode): TsNode | undefined {
	let seenParams = false;
	for (let i = 0; i < fn.namedChildCount; i++) {
		const child = fn.namedChild(i);
		if (!child) continue;
		if (child.type === "formal_parameters") {
			seenParams = true;
			continue;
		}
		if (!seenParams) continue;
		if (
			child.type === "named_type" ||
			child.type === "primitive_type" ||
			child.type === "optional_type" ||
			child.type === "union_type" ||
			child.type === "intersection_type"
		) {
			return child;
		}
		// Body / attributes end the return-type window.
		if (
			child.type === "compound_statement" ||
			child.type === "declaration_list"
		) {
			return undefined;
		}
	}
	return undefined;
}

function collectNamedTypes(typeNode: TsNode | undefined): TsNode[] {
	if (typeNode === undefined) return [];
	if (typeNode.type === "primitive_type") return [];
	if (typeNode.type === "named_type") return [typeNode];
	if (
		typeNode.type === "optional_type" ||
		typeNode.type === "union_type" ||
		typeNode.type === "intersection_type"
	) {
		const found: TsNode[] = [];
		for (let i = 0; i < typeNode.namedChildCount; i++) {
			const child = typeNode.namedChild(i);
			if (child) found.push(...collectNamedTypes(child));
		}
		return found;
	}
	return [];
}

function namedChildrenOfType(node: TsNode, type: string): TsNode[] {
	const found: TsNode[] = [];
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (child?.type === type) found.push(child);
	}
	return found;
}

function resolvedEdge(input: {
	sourceId: string;
	raw: string;
	kind: EdgeKind;
	aliases: Map<string, string>;
	currentNamespace: string | undefined;
	fqnIndex: PhpFqnIndex;
	pos: { row: number; column: number };
	forceAbsolute?: boolean;
}): Edge {
	const fqn = input.forceAbsolute
		? normalizePhpFqn(input.raw)
		: resolveTypeReference(input.raw, input.aliases, input.currentNamespace);
	const line = input.pos.row + 1;
	const col = input.pos.column;

	if (fqn === undefined || fqn === "") {
		return {
			source: input.sourceId,
			target: null,
			targetName: input.raw,
			kind: input.kind,
			resolutionState: "unresolved",
			confidence: "low",
			provenance: "tree-sitter",
			line,
			col,
		};
	}

	const target = input.fqnIndex.get(fqn);
	if (target !== undefined) {
		return {
			source: input.sourceId,
			target,
			targetName: lastSegment(fqn),
			kind: input.kind,
			resolutionState: "resolved",
			confidence: "high",
			provenance: "tree-sitter",
			line,
			col,
		};
	}

	return {
		source: input.sourceId,
		target: null,
		targetName: fqn,
		kind: input.kind,
		resolutionState: "external",
		confidence: "high",
		provenance: "tree-sitter",
		line,
		col,
	};
}

export function findPassANodeId(
	nodes: Node[],
	kind: NodeKind,
	name: string,
	decl: TsNode,
): string | undefined {
	const startLine = decl.startPosition.row + 1;
	const startColumn = decl.startPosition.column;
	const match = nodes.find(
		(node) =>
			node.kind === kind &&
			node.name === name &&
			node.range.startLine === startLine &&
			node.range.startColumn === startColumn,
	);
	return match?.id;
}

function compareEdges(a: Edge, b: Edge): number {
	return (
		compareStrings(a.source, b.source) ||
		compareStrings(a.kind, b.kind) ||
		compareStrings(
			a.target ?? a.targetName ?? "",
			b.target ?? b.targetName ?? "",
		) ||
		(a.line ?? -1) - (b.line ?? -1) ||
		(a.col ?? -1) - (b.col ?? -1)
	);
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
