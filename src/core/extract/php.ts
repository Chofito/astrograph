import type { Node, Tree } from "web-tree-sitter";
import { type Extraction, type RefKind, type SymbolKind, signatureOf } from "./types";

interface Scope {
	owner: number | null;
	cls: number | null;
	/** Known receiver types (FQN): `$x` from params/`new`/catch, `$this->p` from properties and DI. */
	types: Map<string, string>;
}

interface FileContext {
	namespace: string;
	classes: Map<string, string>;
	functions: Map<string, string>;
}

const TYPE_DECLARATIONS: Record<string, SymbolKind> = {
	class_declaration: "class",
	interface_declaration: "interface",
	trait_declaration: "trait",
	enum_declaration: "enum",
};
const MAX_DEPTH = 1500;

/**
 * Extracts PHP declarations with fully qualified names and records every call
 * target as FQN candidates, using the file's namespace and `use` imports.
 */
export function extractPhp(tree: Tree): Extraction {
	const out: Extraction = { symbols: [], refs: [], imports: [] };
	const ctx: FileContext = { namespace: "", classes: new Map(), functions: new Map() };

	const qualify = (name: string) => (ctx.namespace ? `${ctx.namespace}\\${name}` : name);

	const resolveClass = (text: string): string => {
		if (text.startsWith("\\")) return text.slice(1);
		const [head, ...rest] = text.split("\\");
		const imported = head ? ctx.classes.get(head.toLowerCase()) : undefined;
		if (imported) return [imported, ...rest].join("\\");
		return qualify(text);
	};

	let currentClass = "";
	const typeOf = (node: Node | null | undefined): string | undefined => {
		if (!node) return undefined;
		switch (node.type) {
			case "named_type":
			case "optional_type":
			case "type_list":
			case "union_type":
			case "nullable_type":
				for (let i = 0; i < node.namedChildCount; i++) {
					const hit = typeOf(node.namedChild(i));
					if (hit) return hit;
				}
				return undefined;
			case "name":
			case "qualified_name": {
				const lower = node.text.toLowerCase();
				if (lower === "self" || lower === "static") return currentClass || undefined;
				return resolveClass(node.text);
			}
			default:
				return undefined;
		}
	};

	const functionHints = (text: string): string[] => {
		if (text.startsWith("\\")) return [text.slice(1)];
		if (text.includes("\\")) return [resolveClass(text)];
		const imported = ctx.functions.get(text.toLowerCase());
		if (imported) return [imported];
		// PHP falls back to the global function when the namespaced one does not exist.
		return ctx.namespace ? [qualify(text), text] : [text];
	};

	const addSymbol = (node: Node, name: string, qualifiedName: string, kind: SymbolKind, scope: Scope): number => {
		out.symbols.push({
			name,
			qualifiedName,
			kind,
			parent: scope.cls,
			exported: true,
			startLine: node.startPosition.row + 1,
			endLine: node.endPosition.row + 1,
			signature: signatureOf(node.text),
		});
		return out.symbols.length - 1;
	};

	const addRef = (
		kind: RefKind,
		scope: Scope,
		node: Node,
		name: string,
		receiver: string | null,
		hints: string[] | null,
	) => {
		out.refs.push({
			kind,
			from: scope.owner,
			name,
			receiver,
			hints,
			line: node.startPosition.row + 1,
		});
	};

	const addClassRef = (kind: RefKind, scope: Scope, node: Node | null) => {
		if (!node || (node.type !== "name" && node.type !== "qualified_name")) return;
		const fqn = resolveClass(node.text);
		addRef(kind, scope, node, lastSegment(fqn), null, [fqn]);
	};

	const visitUse = (node: Node) => {
		const isFunction = hasToken(node, "function");
		const isConst = hasToken(node, "const");
		if (isConst) return;
		const target = isFunction ? ctx.functions : ctx.classes;
		let prefix = "";
		for (let i = 0; i < node.namedChildCount; i++) {
			const child = node.namedChild(i);
			if (!child) continue;
			if (child.type === "namespace_name") prefix = child.text;
			if (child.type === "namespace_use_clause") addUse(target, child, "");
			if (child.type === "namespace_use_group") {
				for (let j = 0; j < child.namedChildCount; j++) {
					const clause = child.namedChild(j);
					if (clause) addUse(target, clause, prefix);
				}
			}
		}
	};

	/** `$var` → type for a function's typed parameters. */
	const paramTypes = (fn: Node): Map<string, string> => {
		const types = new Map<string, string>();
		const params = fn.childForFieldName("parameters");
		for (let i = 0; i < (params?.namedChildCount ?? 0); i++) {
			const param = params?.namedChild(i);
			const variable = param?.childForFieldName("name");
			const type = typeOf(param?.childForFieldName("type"));
			if (variable && type) types.set(variable.text, type);
		}
		return types;
	};

	/**
	 * `$this->prop` types: typed or `@var`-documented properties, promoted
	 * constructor parameters, and constructor assignments from typed params.
	 */
	const classTypes = (body: Node): Map<string, string> => {
		const types = new Map<string, string>();
		let docType: string | undefined;
		for (let i = 0; i < body.namedChildCount; i++) {
			const member = body.namedChild(i);
			if (!member) continue;
			if (member.type === "comment") {
				const match = /@var\s+\??([\\\w]+)/.exec(member.text);
				docType =
					match?.[1] && !/^(array|string|int|bool|float|mixed|callable|object|null)$/i.test(match[1])
						? resolveClass(match[1])
						: undefined;
				continue;
			}
			if (member.type === "property_declaration") {
				const type = typeOf(member.childForFieldName("type")) ?? docType;
				for (let j = 0; j < member.namedChildCount; j++) {
					const element = member.namedChild(j);
					const variable = element?.type === "property_element" ? element.namedChild(0) : undefined;
					if (variable && type) types.set(`$this->${variable.text.replace(/^\$/, "")}`, type);
				}
			}
			if (member.type === "method_declaration" && member.childForFieldName("name")?.text === "__construct") {
				const params = paramTypes(member);
				const list = member.childForFieldName("parameters");
				for (let j = 0; j < (list?.namedChildCount ?? 0); j++) {
					const param = list?.namedChild(j);
					const variable = param?.childForFieldName("name")?.text;
					const type = variable ? params.get(variable) : undefined;
					if (param?.type === "property_promotion_parameter" && variable && type) {
						types.set(`$this->${variable.slice(1)}`, type);
					}
				}
				collectAssignments(member.childForFieldName("body"), params, types);
			}
			docType = undefined;
		}
		return types;
	};

	const collectAssignments = (node: Node | null, params: Map<string, string>, types: Map<string, string>) => {
		if (!node) return;
		for (let i = 0; i < node.namedChildCount; i++) {
			const child = node.namedChild(i);
			if (!child) continue;
			if (child.type === "assignment_expression") {
				const left = child.childForFieldName("left");
				const right = child.childForFieldName("right");
				if (left?.type === "member_access_expression" && left.childForFieldName("object")?.text === "$this") {
					const prop = left.childForFieldName("name")?.text;
					const type =
						right?.type === "variable_name"
							? params.get(right.text)
							: right?.type === "object_creation_expression"
								? typeOf(right.namedChildren.find((c) => c?.type === "name" || c?.type === "qualified_name"))
								: undefined;
					if (prop && type) types.set(`$this->${prop}`, type);
				}
			} else if (child.type === "expression_statement") {
				collectAssignments(child, params, types);
			}
		}
	};

	const visitTypeDeclaration = (node: Node, kind: SymbolKind, scope: Scope) => {
		const name = node.childForFieldName("name")?.text;
		if (!name) return;
		const fqn = qualify(name);
		currentClass = fqn;
		const index = addSymbol(node, name, fqn, kind, scope);
		const body = node.childForFieldName("body");
		const inner: Scope = { owner: index, cls: index, types: body ? classTypes(body) : new Map() };
		for (let i = 0; i < node.namedChildCount; i++) {
			const child = node.namedChild(i);
			if (!child) continue;
			if (child.type === "base_clause") {
				for (let j = 0; j < child.namedChildCount; j++) {
					addClassRef("extends", inner, child.namedChild(j));
				}
			} else if (child.type === "class_interface_clause") {
				for (let j = 0; j < child.namedChildCount; j++) {
					addClassRef("implements", inner, child.namedChild(j));
				}
			}
		}
		if (!body) return;
		for (let i = 0; i < body.namedChildCount; i++) {
			const member = body.namedChild(i);
			if (member) visitMember(member, fqn, inner);
		}
	};

	const visitMember = (member: Node, classFqn: string, scope: Scope) => {
		switch (member.type) {
			case "method_declaration": {
				const name = member.childForFieldName("name")?.text;
				if (!name) return;
				const index = addSymbol(member, name, `${classFqn}::${name}`, "method", scope);
				const types = new Map(scope.types);
				for (const [variable, type] of paramTypes(member)) types.set(variable, type);
				visitChildren(member, { owner: index, cls: scope.cls, types }, 0);
				return;
			}
			case "property_declaration":
				for (let i = 0; i < member.namedChildCount; i++) {
					const element = member.namedChild(i);
					if (element?.type !== "property_element") continue;
					const variable = element.namedChild(0);
					const name = variable?.text.replace(/^\$/, "");
					if (name) addSymbol(member, name, `${classFqn}::$${name}`, "property", scope);
				}
				return;
			case "const_declaration":
				for (const name of constNames(member)) {
					addSymbol(member, name, `${classFqn}::${name}`, "constant", scope);
				}
				return;
			case "enum_case": {
				const name = member.childForFieldName("name")?.text;
				if (name) addSymbol(member, name, `${classFqn}::${name}`, "constant", scope);
				return;
			}
			case "use_declaration":
				// Traits behave like a parent for member lookup.
				for (let i = 0; i < member.namedChildCount; i++) {
					addClassRef("extends", scope, member.namedChild(i));
				}
				return;
			default:
				visit(member, scope, 0);
		}
	};

	const visitChildren = (node: Node, scope: Scope, depth: number) => {
		for (let i = 0; i < node.namedChildCount; i++) {
			const child = node.namedChild(i);
			if (child) visit(child, scope, depth + 1);
		}
	};

	const visit = (node: Node, scope: Scope, depth: number): void => {
		if (depth > MAX_DEPTH) return;
		const typeKind = TYPE_DECLARATIONS[node.type];
		if (typeKind && scope.owner === null) {
			visitTypeDeclaration(node, typeKind, scope);
			return;
		}
		switch (node.type) {
			case "namespace_definition": {
				ctx.namespace = node.childForFieldName("name")?.text ?? "";
				ctx.classes.clear();
				ctx.functions.clear();
				const body = node.childForFieldName("body");
				if (body) visitChildren(body, scope, depth);
				return;
			}
			case "namespace_use_declaration":
				visitUse(node);
				return;
			case "function_definition": {
				if (scope.owner !== null) break;
				const name = node.childForFieldName("name")?.text;
				if (!name) break;
				const index = addSymbol(node, name, qualify(name), "function", scope);
				visitChildren(node, { owner: index, cls: null, types: paramTypes(node) }, depth);
				return;
			}
			case "const_declaration":
				if (scope.owner !== null) break;
				for (const name of constNames(node)) {
					addSymbol(node, name, qualify(name), "constant", scope);
				}
				return;
			case "function_call_expression": {
				const fn = node.childForFieldName("function");
				if (fn && (fn.type === "name" || fn.type === "qualified_name")) {
					const hints = functionHints(fn.text);
					addRef("call", scope, node, lastSegment(fn.text), null, hints);
				}
				break;
			}
			case "member_call_expression":
			case "nullsafe_member_call_expression": {
				const name = node.childForFieldName("name");
				const object = node.childForFieldName("object");
				if (name?.type === "name") {
					const text = object?.text ?? "?";
					const type = scope.types.get(text);
					const receiver = text === "$this" ? "this" : shortReceiver(text);
					addRef("call", scope, node, name.text, receiver, type ? [`${type}::${name.text}`] : null);
				}
				break;
			}
			case "scoped_call_expression": {
				const name = node.childForFieldName("name");
				const target = node.childForFieldName("scope");
				if (name?.type === "name" && target) {
					if (target.type === "relative_scope") {
						addRef("call", scope, node, name.text, target.text.toLowerCase(), null);
					} else if (target.type === "name" || target.type === "qualified_name") {
						const fqn = resolveClass(target.text);
						addRef("call", scope, node, name.text, fqn, [`${fqn}::${name.text}`]);
					}
				}
				break;
			}
			case "assignment_expression": {
				const left = node.childForFieldName("left");
				const right = node.childForFieldName("right");
				if (left?.type === "variable_name" && right?.type === "object_creation_expression") {
					const type = typeOf(right.namedChildren.find((c) => c?.type === "name" || c?.type === "qualified_name"));
					if (type) scope.types.set(left.text, type);
				}
				break;
			}
			case "catch_clause": {
				const variable = node.childForFieldName("name");
				const type = typeOf(node.childForFieldName("type"));
				if (variable && type) scope.types.set(variable.text, type);
				break;
			}
			case "object_creation_expression":
				for (let i = 0; i < node.namedChildCount; i++) {
					const child = node.namedChild(i);
					if (child?.type === "name" || child?.type === "qualified_name") {
						addClassRef("new", scope, child);
						break;
					}
				}
				break;
		}
		visitChildren(node, scope, depth);
	};

	visitChildren(tree.rootNode, { owner: null, cls: null, types: new Map() }, 0);
	return out;
}

function addUse(target: Map<string, string>, clause: Node, prefix: string) {
	let fqn: string | undefined;
	let alias: string | undefined;
	for (let i = 0; i < clause.namedChildCount; i++) {
		const child = clause.namedChild(i);
		if (!child) continue;
		if (child.type === "namespace_aliasing_clause") alias = child.namedChild(0)?.text;
		else if (child.type === "name" && fqn !== undefined) alias = child.text;
		else if (fqn === undefined) fqn = child.text;
	}
	if (!fqn) return;
	fqn = fqn.replace(/^\\/, "");
	if (prefix) fqn = `${prefix}\\${fqn}`;
	target.set((alias ?? lastSegment(fqn)).toLowerCase(), fqn);
}

function constNames(node: Node): string[] {
	const names: string[] = [];
	for (let i = 0; i < node.namedChildCount; i++) {
		const element = node.namedChild(i);
		if (element?.type !== "const_element") continue;
		const name = element.namedChild(0)?.text;
		if (name) names.push(name);
	}
	return names;
}

function hasToken(node: Node, token: string): boolean {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child && !child.isNamed && child.type === token) return true;
	}
	return false;
}

function lastSegment(name: string): string {
	const index = name.lastIndexOf("\\");
	return index === -1 ? name : name.slice(index + 1);
}

/** "?" marks a receiver too complex to name (fluent chains, calls, literals). */
function shortReceiver(receiver: string): string {
	return receiver.length <= 80 && !receiver.includes("\n") && !receiver.includes("(") ? receiver : "?";
}
