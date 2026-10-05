import type { Node, Tree } from "web-tree-sitter";
import { type ExtractedSymbol, type Extraction, type RefKind, type SymbolKind, signatureOf } from "./types";

interface Scope {
	/** Symbol that owns refs found here (null = file level). */
	owner: number | null;
	/** Enclosing class symbol, used to qualify members. */
	cls: number | null;
	/** Only file-level declarations become symbols; nested ones fold into their owner. */
	topLevel: boolean;
	/** Known receiver types: `x` from `const x = new Foo()` or `x: Foo`, `this.db` from fields. */
	types: Map<string, string>;
}

const FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);
const MAX_DEPTH = 1500;

/** Extracts declarations, calls, JSX renders, inheritance and module bindings from a JS/TS tree. */
export function extractTypeScript(tree: Tree): Extraction {
	const out: Extraction = { symbols: [], refs: [], imports: [] };

	const addSymbol = (
		node: Node,
		name: string,
		kind: SymbolKind,
		scope: Scope,
		exported: boolean,
		declNode: Node = node,
	): number => {
		const parent = scope.cls;
		const parentName = parent !== null ? out.symbols[parent]?.qualifiedName : undefined;
		const symbol: ExtractedSymbol = {
			name,
			qualifiedName: parentName ? `${parentName}.${name}` : name,
			kind,
			parent,
			exported,
			startLine: declNode.startPosition.row + 1,
			endLine: declNode.endPosition.row + 1,
			signature: signatureOf(declNode.text),
			returnType: returnTypeOf(node),
		};
		out.symbols.push(symbol);
		return out.symbols.length - 1;
	};

	const addRef = (kind: RefKind, target: Node | null, scope: Scope, line: number) => {
		if (!target) return;
		const { name, receiver } = splitTarget(target);
		if (!name) return;
		const type = receiver ? scope.types.get(receiver) : undefined;
		out.refs.push({ kind, from: scope.owner, name, receiver, hints: type ? [type] : null, line });
	};

	const visitChildren = (node: Node, scope: Scope, depth: number) => {
		for (let i = 0; i < node.namedChildCount; i++) {
			const child = node.namedChild(i);
			if (child) visit(child, scope, depth + 1);
		}
	};

	const visitClass = (node: Node, name: string, scope: Scope, exported: boolean, declNode: Node = node) => {
		const index = addSymbol(node, name, "class", scope, exported, declNode);
		const body = node.childForFieldName("body");
		const inner: Scope = { owner: index, cls: index, topLevel: false, types: body ? fieldTypes(body) : new Map() };
		for (let i = 0; i < node.namedChildCount; i++) {
			const child = node.namedChild(i);
			if (child?.type === "class_heritage") visitHeritage(child, inner);
		}
		if (body) visitClassBody(body, inner);
	};

	/** `constructor(private db: Database)` declares a `db` property. */
	const addParameterProperties = (ctor: Node, scope: Scope) => {
		const params = ctor.childForFieldName("parameters");
		for (let i = 0; i < (params?.namedChildCount ?? 0); i++) {
			const param = params?.namedChild(i);
			const pattern = param?.childForFieldName("pattern");
			if (param && pattern?.type === "identifier" && hasModifier(param)) {
				addSymbol(param, pattern.text, "property", scope, false);
			}
		}
	};

	const visitHeritage = (node: Node, scope: Scope) => {
		const line = node.startPosition.row + 1;
		for (let i = 0; i < node.namedChildCount; i++) {
			const child = node.namedChild(i);
			if (!child) continue;
			if (child.type === "extends_clause") {
				addRef("extends", child.childForFieldName("value"), scope, line);
			} else if (child.type === "implements_clause") {
				for (let j = 0; j < child.namedChildCount; j++) {
					addRef("implements", child.namedChild(j), scope, line);
				}
			} else {
				// JS grammar: `class A extends B` has the expression directly under class_heritage.
				addRef("extends", child, scope, line);
			}
		}
	};

	const visitClassBody = (body: Node, scope: Scope) => {
		for (let i = 0; i < body.namedChildCount; i++) {
			const member = body.namedChild(i);
			if (!member) continue;
			const nameNode = member.childForFieldName("name");
			const name = nameNode ? memberName(nameNode) : undefined;
			switch (member.type) {
				case "method_definition":
				case "method_signature":
				case "abstract_method_signature": {
					if (!name) break;
					const index = addSymbol(member, name, "method", scope, false);
					if (name === "constructor") addParameterProperties(member, scope);
					visitChildren(member, { ...scope, owner: index, types: new Map(scope.types) }, 0);
					break;
				}
				case "public_field_definition":
				case "field_definition": {
					const fieldName = name ?? memberName(member.childForFieldName("property"));
					if (!fieldName) break;
					const value = member.childForFieldName("value");
					const kind = value && FUNCTION_VALUES.has(value.type) ? "method" : "property";
					const index = addSymbol(member, fieldName, kind, scope, false);
					if (value) visit(value, { ...scope, owner: index, types: new Map(scope.types) }, 0);
					break;
				}
				default:
					visit(member, scope, 0);
			}
		}
	};

	const visitDeclaration = (node: Node, scope: Scope, exported: boolean, declNode: Node): string | undefined => {
		const name = node.childForFieldName("name")?.text;
		switch (node.type) {
			case "function_declaration":
			case "generator_function_declaration":
			case "function_signature": {
				if (!name) return;
				const index = addSymbol(node, name, "function", scope, exported, declNode);
				visitChildren(node, { owner: index, cls: null, topLevel: false, types: new Map() }, 0);
				return name;
			}
			case "class_declaration":
			case "abstract_class_declaration":
				if (!name) return;
				visitClass(node, name, scope, exported, declNode);
				return name;
			case "interface_declaration": {
				if (!name) return;
				const index = addSymbol(node, name, "interface", scope, exported, declNode);
				const inner: Scope = { owner: index, cls: index, topLevel: false, types: new Map() };
				for (let i = 0; i < node.namedChildCount; i++) {
					const child = node.namedChild(i);
					if (child?.type !== "extends_type_clause") continue;
					for (let j = 0; j < child.namedChildCount; j++) {
						addRef("extends", child.namedChild(j), inner, child.startPosition.row + 1);
					}
				}
				// Members, so calls through an interface-typed receiver have a target.
				const body = node.childForFieldName("body");
				for (let i = 0; i < (body?.namedChildCount ?? 0); i++) {
					const member = body?.namedChild(i);
					const memberName = member ? memberNameOf(member) : undefined;
					if (!member || !memberName) continue;
					if (member.type === "method_signature") addSymbol(member, memberName, "method", inner, false);
					else if (member.type === "property_signature") addSymbol(member, memberName, "property", inner, false);
				}
				return name;
			}
			case "type_alias_declaration":
				if (!name) return;
				addSymbol(node, name, "type", scope, exported, declNode);
				return name;
			case "enum_declaration":
				if (!name) return;
				addSymbol(node, name, "enum", scope, exported, declNode);
				return name;
			case "lexical_declaration":
			case "variable_declaration":
				visitVariables(node, scope, exported, declNode);
				return;
			default:
				visit(node, scope, 0);
				return;
		}
	};

	const visitVariables = (node: Node, scope: Scope, exported: boolean, declNode: Node) => {
		const isConst = node.child(0)?.type === "const";
		for (let i = 0; i < node.namedChildCount; i++) {
			const declarator = node.namedChild(i);
			if (declarator?.type !== "variable_declarator") continue;
			const nameNode = declarator.childForFieldName("name");
			const value = declarator.childForFieldName("value");
			if (!nameNode) continue;

			const required = value ? requireSource(value) : undefined;
			if (required !== undefined) {
				addRequire(nameNode, required);
				continue;
			}
			if (nameNode.type !== "identifier") {
				if (value) visit(value, scope, 0);
				continue;
			}
			const name = nameNode.text;
			if (value && (value.type === "class" || value.type === "class_expression")) {
				visitClass(value, name, scope, exported, node.namedChildCount === 1 ? declNode : declarator);
				continue;
			}
			const kind: SymbolKind =
				value && FUNCTION_VALUES.has(value.type) ? "function" : isConst ? "constant" : "variable";
			const index = addSymbol(
				declarator,
				name,
				kind,
				scope,
				exported,
				node.namedChildCount === 1 ? declNode : declarator,
			);
			if (value) visit(value, { owner: index, cls: null, topLevel: false, types: new Map() }, 0);
		}
	};

	const addRequire = (nameNode: Node, source: string) => {
		if (nameNode.type === "identifier") {
			out.imports.push({ local: nameNode.text, imported: "*", source, reexport: false });
			return;
		}
		if (nameNode.type !== "object_pattern") return;
		for (let i = 0; i < nameNode.namedChildCount; i++) {
			const prop = nameNode.namedChild(i);
			if (!prop) continue;
			if (prop.type === "shorthand_property_identifier_pattern") {
				out.imports.push({ local: prop.text, imported: prop.text, source, reexport: false });
			} else if (prop.type === "pair_pattern") {
				const key = prop.childForFieldName("key")?.text;
				const value = prop.childForFieldName("value");
				if (key && value?.type === "identifier") {
					out.imports.push({ local: value.text, imported: key, source, reexport: false });
				}
			}
		}
	};

	const visitImport = (node: Node) => {
		const source = stringValue(node.childForFieldName("source"));
		if (source === undefined) return;
		for (let i = 0; i < node.namedChildCount; i++) {
			const clause = node.namedChild(i);
			if (clause?.type !== "import_clause") continue;
			for (let j = 0; j < clause.namedChildCount; j++) {
				const part = clause.namedChild(j);
				if (!part) continue;
				if (part.type === "identifier") {
					out.imports.push({ local: part.text, imported: "default", source, reexport: false });
				} else if (part.type === "namespace_import") {
					const local = part.namedChild(0)?.text;
					if (local) out.imports.push({ local, imported: "*", source, reexport: false });
				} else if (part.type === "named_imports") {
					for (const [imported, local] of specifiers(part)) {
						out.imports.push({ local, imported, source, reexport: false });
					}
				}
			}
		}
	};

	const visitExport = (node: Node, scope: Scope) => {
		const source = stringValue(node.childForFieldName("source")) ?? null;
		const isDefault = hasToken(node, "default");
		const declaration = node.childForFieldName("declaration");
		if (declaration) {
			const name = visitDeclaration(declaration, scope, true, node);
			if (isDefault && name) {
				out.imports.push({ local: "default", imported: name, source: null, reexport: true });
			}
			return;
		}

		let sawClause = false;
		for (let i = 0; i < node.namedChildCount; i++) {
			const child = node.namedChild(i);
			if (!child) continue;
			if (child.type === "export_clause") {
				sawClause = true;
				for (const [imported, local] of specifiers(child)) {
					out.imports.push({ local, imported, source, reexport: true });
				}
			} else if (child.type === "namespace_export") {
				sawClause = true;
				const local = child.namedChild(0)?.text;
				if (local && source) {
					out.imports.push({ local, imported: "*", source, reexport: true });
				}
			}
		}
		if (source && !sawClause) {
			out.imports.push({ local: "*", imported: "*", source, reexport: true });
			return;
		}

		const value = node.childForFieldName("value");
		if (!isDefault || !value) return;
		if (value.type === "identifier") {
			out.imports.push({ local: "default", imported: value.text, source: null, reexport: true });
		} else if (value.type === "class" || value.type === "class_expression") {
			visitClass(value, "default", scope, true, node);
		} else if (FUNCTION_VALUES.has(value.type)) {
			const index = addSymbol(value, "default", "function", scope, true, node);
			visitChildren(value, { owner: index, cls: null, topLevel: false, types: new Map() }, 0);
		} else {
			visit(value, scope, 0);
		}
	};

	const visit = (node: Node, scope: Scope, depth: number): void => {
		if (depth > MAX_DEPTH) return;
		switch (node.type) {
			case "import_statement":
				if (scope.topLevel) visitImport(node);
				return;
			case "export_statement":
				if (scope.topLevel) {
					visitExport(node, scope);
					return;
				}
				break;
			case "call_expression": {
				const fn = node.childForFieldName("function");
				if (fn?.type === "identifier" && fn.text === "require") return;
				if (fn && fn.type !== "import" && fn.type !== "super") addRef("call", fn, scope, lineOf(node));
				break;
			}
			case "new_expression":
				addRef("new", node.childForFieldName("constructor"), scope, lineOf(node));
				break;
			case "variable_declarator":
			case "required_parameter":
			case "optional_parameter": {
				const binding = node.childForFieldName("name") ?? node.childForFieldName("pattern");
				const type = declaredType(node);
				if (binding?.type === "identifier" && type) scope.types.set(binding.text, type);
				break;
			}
			case "jsx_opening_element":
			case "jsx_self_closing_element": {
				const name = node.childForFieldName("name");
				if (name && /^[A-Z]/.test(name.text)) addRef("render", name, scope, lineOf(node));
				break;
			}
			default:
				// Nested declarations are not symbols: their refs fold into the owner.
				if (scope.topLevel && isDeclaration(node.type)) {
					visitDeclaration(node, scope, false, node);
					return;
				}
				// Callbacks at file level (`describe(() => …)`) are not file scope.
				if (scope.topLevel && FUNCTION_VALUES.has(node.type)) {
					visitChildren(node, { ...scope, topLevel: false }, depth);
					return;
				}
		}
		visitChildren(node, scope, depth);
	};

	const root = tree.rootNode;
	visitChildren(root, { owner: null, cls: null, topLevel: true, types: new Map() }, 0);
	return out;
}

function lineOf(node: Node): number {
	return node.startPosition.row + 1;
}

function isDeclaration(type: string): boolean {
	return (
		type === "function_declaration" ||
		type === "generator_function_declaration" ||
		type === "function_signature" ||
		type === "class_declaration" ||
		type === "abstract_class_declaration" ||
		type === "interface_declaration" ||
		type === "type_alias_declaration" ||
		type === "enum_declaration" ||
		type === "lexical_declaration" ||
		type === "variable_declaration"
	);
}

/** `foo` → {foo, null}; `a.b` → {b, "a"}; `this.x.y` → {y, "this.x"}; `Foo<T>` → {Foo, null}. */
function splitTarget(node: Node): { name: string | undefined; receiver: string | null } {
	switch (node.type) {
		case "identifier":
		case "type_identifier":
			return { name: node.text, receiver: null };
		case "member_expression":
		case "nested_identifier":
		case "nested_type_identifier": {
			const property = node.childForFieldName("property") ?? node.childForFieldName("name") ?? node.lastNamedChild;
			const object = node.childForFieldName("object") ?? node.childForFieldName("module") ?? node.firstNamedChild;
			const receiver = object?.text ?? null;
			return {
				name: property?.text.replace(/^#/, ""),
				// "?" marks a receiver too complex to name (call chains, literals).
				receiver: receiver && receiver.length <= 80 && /^[\w$#.]+$/.test(receiver) ? receiver : "?",
			};
		}
		case "generic_type": {
			const inner = node.childForFieldName("name") ?? node.firstNamedChild;
			return inner ? splitTarget(inner) : { name: undefined, receiver: null };
		}
		case "call_expression": {
			// Mixins: `class A extends mixin(B)` → record the mixin call target.
			const fn = node.childForFieldName("function");
			return fn ? splitTarget(fn) : { name: undefined, receiver: null };
		}
		default:
			return { name: undefined, receiver: null };
	}
}

function memberNameOf(member: Node): string | undefined {
	return memberName(member.childForFieldName("name"));
}

function memberName(node: Node | null): string | undefined {
	if (!node) return undefined;
	if (node.type === "computed_property_name") return undefined;
	return node.text.replace(/^#/, "").replace(/^["']|["']$/g, "");
}

function stringValue(node: Node | null): string | undefined {
	if (node?.type !== "string") return undefined;
	return node.text.slice(1, -1);
}

function requireSource(value: Node): string | undefined {
	if (value.type !== "call_expression") return undefined;
	const fn = value.childForFieldName("function");
	if (fn?.type !== "identifier" || fn.text !== "require") return undefined;
	const arg = value.childForFieldName("arguments")?.namedChild(0) ?? null;
	return stringValue(arg);
}

function hasToken(node: Node, token: string): boolean {
	for (let i = 0; i < node.childCount; i++) {
		if (node.child(i)?.type === token) return true;
	}
	return false;
}

/** `{ a, b as c }` → [["a","a"], ["b","c"]] as [imported, local]. */
function specifiers(node: Node): [string, string][] {
	const result: [string, string][] = [];
	for (let i = 0; i < node.namedChildCount; i++) {
		const spec = node.namedChild(i);
		if (!spec) continue;
		const name = spec.childForFieldName("name")?.text;
		if (!name) continue;
		const alias = spec.childForFieldName("alias")?.text ?? name;
		result.push([unquote(name), unquote(alias)]);
	}
	return result;
}

function unquote(text: string): string {
	return text.replace(/^["']|["']$/g, "");
}

/** Type of a binding from its annotation or a `new X()` initializer. */
function declaredType(node: Node): string | undefined {
	const annotation = node.childForFieldName("type");
	const fromAnnotation = annotation ? typeName(annotation.namedChild(0)) : undefined;
	if (fromAnnotation) return fromAnnotation;
	let value = node.childForFieldName("value");
	if (value?.type === "await_expression") value = value.namedChild(0);
	if (value?.type === "new_expression") return typeName(value.childForFieldName("constructor"));
	if (value?.type === "call_expression") {
		// Resolved later through the callee's declared return type.
		const fn = value.childForFieldName("function");
		if (fn?.type === "identifier") return `()${fn.text}`;
	}
	return undefined;
}

/**
 * The type a symbol evaluates to: a function's declared return type, or the
 * declared / constructed type of a field, constant or parameter property.
 */
function returnTypeOf(node: Node): string | undefined {
	switch (node.type) {
		case "variable_declarator":
		case "public_field_definition":
		case "field_definition": {
			const value = node.childForFieldName("value");
			if (value && FUNCTION_VALUES.has(value.type)) return returnTypeOf(value);
			return declaredType(node);
		}
		case "property_signature":
		case "required_parameter":
		case "optional_parameter":
			return declaredType(node);
		default:
			return typeName(node.childForFieldName("return_type")?.namedChild(0) ?? null);
	}
}

function typeName(node: Node | null): string | undefined {
	if (!node) return undefined;
	if (node.type === "type_identifier" || node.type === "identifier") return node.text;
	if (node.type === "generic_type") {
		const name = node.childForFieldName("name") ?? node.firstNamedChild;
		// Promise<Foo> → Foo, so `await f()` gets the awaited type.
		if (name?.text === "Promise") return typeName(node.childForFieldName("type_arguments")?.namedChild(0) ?? null);
		return typeName(name);
	}
	return undefined;
}

/** `this.x` types from typed fields and constructor parameter properties. */
function fieldTypes(body: Node): Map<string, string> {
	const types = new Map<string, string>();
	for (let i = 0; i < body.namedChildCount; i++) {
		const member = body.namedChild(i);
		if (!member) continue;
		if (member.type === "public_field_definition" || member.type === "field_definition") {
			const name = member.childForFieldName("name") ?? member.childForFieldName("property");
			const type = declaredType(member);
			if (name && type) types.set(`this.${name.text.replace(/^#/, "")}`, type);
		}
		if (member.type === "method_definition" && member.childForFieldName("name")?.text === "constructor") {
			const params = member.childForFieldName("parameters");
			for (let j = 0; j < (params?.namedChildCount ?? 0); j++) {
				const param = params?.namedChild(j);
				if (!param || !hasModifier(param)) continue;
				const name = param.childForFieldName("pattern");
				const type = declaredType(param);
				if (name?.type === "identifier" && type) types.set(`this.${name.text}`, type);
			}
		}
	}
	return types;
}

function hasModifier(param: Node): boolean {
	for (let i = 0; i < param.childCount; i++) {
		const type = param.child(i)?.type;
		if (type === "accessibility_modifier" || type === "readonly" || type === "override_modifier") return true;
	}
	return false;
}
