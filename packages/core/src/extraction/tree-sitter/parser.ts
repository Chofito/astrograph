import type { Tree, Node as TsNode } from "web-tree-sitter";
import { makeNodeId } from "../../ids";
import type {
	Edge,
	ExtractionError,
	Hasher,
	Language,
	Node,
	NodeKind,
	Parser,
	PassAResult,
	Range,
} from "../../types";
import { isGenerated, isTest } from "../shared/classify";
import { isJsxLanguage, languageFromPath } from "../shared/language";
import { buildQualifiedName } from "../shared/qualified-name";
import {
	createParserFor,
	isTreeSitterReady,
	type TreeSitterLang,
	treeSitterLangFromPath,
} from "./grammars";

export interface TreeSitterParserOptions {
	hasher: Hasher;
	now?: () => number;
	project?: string;
}

/**
 * A declaration Pass A is considering. `kind === undefined` means "I cannot
 * prove which kind the enricher would assign" — the candidate is dropped so it
 * can never contribute a node id the enricher would not also produce.
 */
interface Candidate {
	kind: NodeKind | undefined;
	name: string;
	/** qualifiedName parts *below* the enclosing container stack. */
	parts: string[];
	range: Range;
	isExported: boolean;
	isAsync: boolean;
	isStatic: boolean;
	isAbstract: boolean;
	/**
	 * A bodyless overload signature. Counted when detecting duplicates — that is
	 * the whole point of collecting it — but never emitted: the enricher gives
	 * each signature a `sig:` locator we cannot reproduce, so these belong to
	 * Pass B alone.
	 */
	signatureOnly?: boolean;
}

/**
 * Pass A structural parser backed by web-tree-sitter WASM grammars.
 *
 * ## The subset contract
 *
 * Node ids hash `project · filePath · kind · qualifiedName · locator`, and the
 * golden fixtures pin ids. Pass A therefore may only emit a declaration when it
 * can *prove* the enricher would compute the identical tuple. Every ambiguous
 * case is skipped: the reconciler inserts it from the enricher's node view
 * instead. Pass A is a subset of Pass B, never a superset.
 *
 * Concretely, for JS/TS we skip:
 *   - anything the TS extractor never visits (it only walks *statements*, so
 *     declarations nested inside function bodies or blocks are out);
 *   - any (qualifiedName, kind) that occurs more than once in the file, since
 *     the enricher may assign it a `sig:<hash>` locator we cannot reproduce;
 *   - overload signatures and their implementation;
 *   - PascalCase declarations in .tsx/.jsx files, where function-vs-component
 *     depends on a JSX search we do not want to have to match byte for byte;
 *   - get/set accessors, whose de-duplication rule is order sensitive;
 *   - `import x = require(...)`, whose name is a reconstructed source slice.
 */
export class TreeSitterParser implements Parser {
	private readonly hasher: Hasher;
	private readonly now: () => number;
	private readonly project: string;

	constructor(opts: TreeSitterParserOptions) {
		this.hasher = opts.hasher;
		this.now = opts.now ?? Date.now;
		this.project = opts.project ?? "root";
	}

	extractNodes(filePath: string, source: string): PassAResult {
		const errors: ExtractionError[] = [];
		const language = languageFromPath(filePath) ?? "unknown";
		const tsLang = treeSitterLangFromPath(filePath);
		const generated = isGenerated(filePath, source, language);
		const test = isTest(filePath, language);
		const basename = filePath.split("/").pop() ?? filePath;
		const lineCount = Math.max(1, source.split("\n").length);

		const fileNode = this.makeNode({
			kind: "file",
			name: basename,
			qualifiedName: filePath,
			filePath,
			language,
			generated,
			test,
			range: {
				startLine: 1,
				endLine: lineCount,
				startColumn: 0,
				endColumn: 0,
			},
		});

		const fileOnly = (error: ExtractionError): PassAResult => ({
			nodes: [fileNode],
			edges: [],
			errors: [...errors, error],
		});

		if (!tsLang || !isTreeSitterReady()) {
			return fileOnly({
				message: tsLang
					? "tree-sitter runtime not initialized; file node only"
					: `No tree-sitter grammar for ${filePath}`,
				filePath,
				severity: "warning",
				code: "TREE_SITTER_UNAVAILABLE",
			});
		}

		const parser = createParserFor(tsLang);
		if (!parser) {
			return fileOnly({
				message: `tree-sitter grammar not loaded for ${tsLang}`,
				filePath,
				severity: "warning",
				code: "TREE_SITTER_GRAMMAR_MISSING",
			});
		}

		let tree: Tree | null;
		try {
			tree = parser.parse(source);
		} catch (error) {
			parser.delete();
			return fileOnly({
				message: error instanceof Error ? error.message : String(error),
				filePath,
				severity: "error",
				code: "TREE_SITTER_PARSE_ERROR",
			});
		}

		if (!tree) {
			parser.delete();
			return fileOnly({
				message: "tree-sitter returned null tree",
				filePath,
				severity: "error",
				code: "TREE_SITTER_PARSE_ERROR",
			});
		}

		const collected: { candidate: Candidate; parentIndex: number }[] = [];
		try {
			if (tsLang === "php") {
				collectPhp(tree.rootNode, [], collected, -1);
			} else {
				collectJsTs(tree.rootNode, [], collected, -1, language);
			}
		} finally {
			tree.delete?.();
			parser.delete();
		}

		// Drop every candidate whose (qualifiedName, kind) is not unique in the
		// file: duplicates are exactly where the enricher reaches for a locator.
		const qualified = collected.map(({ candidate }) =>
			buildQualifiedName({ filePath, parts: candidate.parts }),
		);
		const seen = new Map<string, number>();
		for (let i = 0; i < collected.length; i++) {
			const key = `${collected[i]!.candidate.kind ?? "?"}${qualified[i]}`;
			seen.set(key, (seen.get(key) ?? 0) + 1);
		}

		const nodes: Node[] = [fileNode];
		const emittedIndex = new Map<number, string>();

		for (let i = 0; i < collected.length; i++) {
			const { candidate, parentIndex } = collected[i]!;
			if (candidate.kind === undefined) continue;
			// Counted above for duplicate detection, never emitted. See Candidate.
			if (candidate.signatureOnly === true) continue;
			const qualifiedName = qualified[i]!;
			if ((seen.get(`${candidate.kind}${qualifiedName}`) ?? 0) > 1) continue;

			const node = this.makeNode({
				kind: candidate.kind,
				name: candidate.name,
				qualifiedName,
				filePath,
				language,
				generated,
				test,
				range: candidate.range,
				isExported: candidate.isExported,
				isAsync: candidate.isAsync,
				isStatic: candidate.isStatic,
				isAbstract: candidate.isAbstract,
			});
			nodes.push(node);
			emittedIndex.set(i, node.id);
		}

		// `contains` edges give the `parsed` coverage state real structure. They
		// only ever reference ids emitted above, so they can never dangle.
		const edges: Edge[] = [];
		for (const [index, nodeId] of emittedIndex) {
			const parentIndex = collected[index]!.parentIndex;
			const parentId =
				parentIndex === -1 ? fileNode.id : emittedIndex.get(parentIndex);
			if (parentId === undefined || parentId === nodeId) continue;
			edges.push({
				source: parentId,
				target: nodeId,
				kind: "contains",
				resolutionState: "resolved",
				confidence: "high",
				provenance: "tree-sitter",
				line: collected[index]!.candidate.range.startLine,
			});
		}

		return { nodes, edges, errors };
	}

	private makeNode(input: {
		kind: NodeKind;
		name: string;
		qualifiedName: string;
		filePath: string;
		language: Language;
		generated: boolean;
		test: boolean;
		range: Range;
		isExported?: boolean;
		isAsync?: boolean;
		isStatic?: boolean;
		isAbstract?: boolean;
	}): Node {
		return {
			id: makeNodeId(
				{
					project: this.project,
					filePath: input.filePath,
					kind: input.kind,
					qualifiedName: input.qualifiedName,
				},
				this.hasher,
			),
			project: this.project,
			kind: input.kind,
			name: input.name,
			qualifiedName: input.qualifiedName,
			filePath: input.filePath,
			language: input.language,
			range: input.range,
			isExported: input.isExported ?? false,
			isAsync: input.isAsync ?? false,
			isStatic: input.isStatic ?? false,
			isAbstract: input.isAbstract ?? false,
			isExternal: false,
			isGenerated: input.generated,
			isTest: input.test,
			metadata: { provenance: "tree-sitter" },
			updatedAt: this.now(),
		};
	}
}

// ---------------------------------------------------------------------------
// JS / TS
// ---------------------------------------------------------------------------

type Collected = { candidate: Candidate; parentIndex: number }[];

const JSX_NODE_TYPES = new Set([
	"jsx_element",
	"jsx_self_closing_element",
	"jsx_fragment",
]);

const FC_MARKERS = ["React.FC", "FunctionComponent", "React.FunctionComponent"];

/**
 * Walk *statement* positions only, mirroring `TsExtractor.visitStatements`,
 * which uses `ts.forEachChild` on the source file / module block and never
 * descends into function bodies.
 */
function collectJsTs(
	container: TsNode,
	stack: string[],
	out: Collected,
	parentIndex: number,
	language: Language,
): void {
	for (let i = 0; i < container.namedChildCount; i++) {
		const child = container.namedChild(i);
		if (child) visitJsTsStatement(child, stack, out, parentIndex, language);
	}
}

function visitJsTsStatement(
	node: TsNode,
	stack: string[],
	out: Collected,
	parentIndex: number,
	language: Language,
): void {
	// `export …` wraps the declaration; unwrap and keep the export range.
	if (node.type === "export_statement") {
		const decl = exportedDeclaration(node);
		if (decl) {
			visitDeclaration(decl, stack, out, parentIndex, language, true, node);
			return;
		}
		pushCandidate(exportCandidate(node), out, parentIndex);
		return;
	}

	// `namespace X { … }` shows up as expression_statement > internal_module.
	if (node.type === "expression_statement") {
		const inner = firstNamedChildOfTypes(node, ["internal_module"]);
		if (inner) {
			visitDeclaration(inner, stack, out, parentIndex, language, false, node);
		}
		return;
	}

	visitDeclaration(node, stack, out, parentIndex, language, false, node);
}

function visitDeclaration(
	node: TsNode,
	stack: string[],
	out: Collected,
	parentIndex: number,
	language: Language,
	isExported: boolean,
	rangeNode: TsNode,
): void {
	switch (node.type) {
		// `declare …` — the modifier belongs to the inner declaration in TS, so
		// unwrap while keeping the ambient node's range (which starts at `declare`).
		case "ambient_declaration": {
			const moduleNode = firstNamedChildOfTypes(node, [
				"module",
				"internal_module",
			]);
			if (moduleNode) {
				visitDeclaration(
					moduleNode,
					stack,
					out,
					parentIndex,
					language,
					isExported,
					rangeNode,
				);
				return;
			}
			// `declare global { … }` is a ModuleDeclaration named "global" to the TS
			// compiler, but the CST carries no name node. Emitting its members would
			// give them qualified names missing the "global" prefix, so skip the
			// whole subtree and let the enricher own it.
			if (firstNamedChildOfTypes(node, ["statement_block"])) return;
			for (let i = 0; i < node.namedChildCount; i++) {
				const child = node.namedChild(i);
				if (child) {
					visitDeclaration(
						child,
						stack,
						out,
						parentIndex,
						language,
						isExported,
						rangeNode,
					);
				}
			}
			return;
		}

		case "function_signature":
		case "function_declaration":
		case "generator_function_declaration": {
			const name = fieldText(node, "name");
			if (name === undefined) return;
			pushCandidate(
				{
					kind: functionKind(name, node, language),
					name,
					parts: [...stack, name],
					range: rangeOf(rangeNode),
					isExported,
					isAsync: hasAnonChild(node, "async"),
					isStatic: false,
					isAbstract: false,
					signatureOnly: node.type === "function_signature",
				},
				out,
				parentIndex,
			);
			return;
		}

		case "class_declaration":
		case "abstract_class_declaration": {
			const name = fieldText(node, "name");
			if (name === undefined) return;
			const index = pushCandidate(
				{
					kind: "class",
					name,
					parts: [...stack, name],
					range: rangeOf(rangeNode),
					isExported,
					isAsync: false,
					isStatic: false,
					isAbstract: node.type === "abstract_class_declaration",
				},
				out,
				parentIndex,
			);
			const body = node.childForFieldName("body");
			if (body) collectClassMembers(body, [...stack, name], out, index);
			return;
		}

		case "interface_declaration": {
			const name = fieldText(node, "name");
			if (name === undefined) return;
			const index = pushCandidate(
				{
					kind: "interface",
					name,
					parts: [...stack, name],
					range: rangeOf(rangeNode),
					isExported,
					isAsync: false,
					isStatic: false,
					isAbstract: false,
				},
				out,
				parentIndex,
			);
			const body = node.childForFieldName("body");
			if (body) collectInterfaceMembers(body, [...stack, name], out, index);
			return;
		}

		case "enum_declaration": {
			const name = fieldText(node, "name");
			if (name === undefined) return;
			const index = pushCandidate(
				{
					kind: "enum",
					name,
					parts: [...stack, name],
					range: rangeOf(rangeNode),
					isExported,
					isAsync: false,
					isStatic: false,
					isAbstract: false,
				},
				out,
				parentIndex,
			);
			const body = node.childForFieldName("body");
			if (body) collectEnumMembers(body, [...stack, name], out, index);
			return;
		}

		case "type_alias_declaration": {
			const name = fieldText(node, "name");
			if (name === undefined) return;
			pushCandidate(
				{
					kind: "type_alias",
					name,
					parts: [...stack, name],
					range: rangeOf(rangeNode),
					isExported,
					isAsync: false,
					isStatic: false,
					isAbstract: false,
				},
				out,
				parentIndex,
			);
			return;
		}

		case "internal_module":
		case "module": {
			// TS names a ModuleDeclaration with `name.getText()`, so a string-literal
			// module keeps its quotes — which is exactly the CST node text.
			const name = fieldText(node, "name");
			if (name === undefined) return;
			const index = pushCandidate(
				{
					kind: "namespace",
					name,
					parts: [...stack, name],
					range: rangeOf(rangeNode),
					isExported,
					isAsync: false,
					isStatic: false,
					isAbstract: false,
				},
				out,
				parentIndex,
			);
			const body = node.childForFieldName("body");
			if (body && body.type === "statement_block") {
				collectJsTs(body, [...stack, name], out, index, language);
			}
			return;
		}

		case "lexical_declaration":
		case "variable_declaration": {
			collectVariables(
				node,
				stack,
				out,
				parentIndex,
				language,
				isExported,
				rangeNode,
			);
			return;
		}

		case "import_statement": {
			// `import x = require("m")` needs the moduleReference source slice
			// reconstructed exactly; not worth the risk.
			if (firstNamedChildOfTypes(node, ["import_require_clause"])) return;
			const source = node.childForFieldName("source");
			if (!source) return;
			const moduleName = stringLiteralValue(source);
			if (moduleName === undefined) return;
			pushCandidate(
				{
					kind: "import",
					name: moduleName,
					parts: [...stack, `import(${moduleName})`],
					range: rangeOf(rangeNode),
					isExported: false,
					isAsync: false,
					isStatic: false,
					isAbstract: false,
				},
				out,
				parentIndex,
			);
			return;
		}

		default:
			return;
	}
}

/** CST node types that carry a declaration the TS extractor names itself. */
const DECLARATION_TYPES = [
	"ambient_declaration",
	"function_signature",
	"function_declaration",
	"generator_function_declaration",
	"class_declaration",
	"abstract_class_declaration",
	"interface_declaration",
	"enum_declaration",
	"type_alias_declaration",
	"lexical_declaration",
	"variable_declaration",
	"internal_module",
	"module",
];

/** The declaration an `export_statement` wraps, if it wraps one. */
function exportedDeclaration(node: TsNode): TsNode | undefined {
	const declaration = node.childForFieldName("declaration");
	if (declaration) return declaration;
	return firstNamedChildOfTypes(node, DECLARATION_TYPES);
}

/**
 * Mirrors `nameFromDeclaration` for ExportDeclaration / ExportAssignment.
 * `moduleSpecifier` is checked before `exportClause`, exactly as the enricher
 * does, so `export { a } from "m"` names itself `re-export(m)` and not `{ a }`.
 */
function exportCandidate(node: TsNode): Candidate {
	const source = node.childForFieldName("source");
	const clause = firstNamedChildOfTypes(node, ["export_clause"]);

	let name: string;
	if (source) {
		const moduleName = stringLiteralValue(source);
		if (moduleName === undefined) return unprovableCandidate(node);
		name = `re-export(${moduleName})`;
	} else if (clause) {
		name = clause.text;
	} else if (node.namedChildCount === 1) {
		// `export default <expr>` / `export = <expr>` — both ExportAssignment,
		// both named "default". Anything with a different shape is left alone.
		name = "default";
	} else {
		return unprovableCandidate(node);
	}

	return {
		kind: "export",
		name,
		parts: [`export(${name})`],
		range: rangeOf(node),
		isExported: true,
		isAsync: false,
		isStatic: false,
		isAbstract: false,
	};
}

function unprovableCandidate(node: TsNode): Candidate {
	return {
		kind: undefined,
		name: "",
		parts: [],
		range: rangeOf(node),
		isExported: false,
		isAsync: false,
		isStatic: false,
		isAbstract: false,
	};
}

function collectVariables(
	node: TsNode,
	stack: string[],
	out: Collected,
	parentIndex: number,
	language: Language,
	isExported: boolean,
	rangeNode: TsNode,
): void {
	// Read the actual `kind` token rather than sniffing leading source text,
	// which decorators and comments break.
	const kindToken = node.childForFieldName("kind")?.text ?? tokenKind(node);
	const isConst = kindToken === "const";

	for (let i = 0; i < node.namedChildCount; i++) {
		const decl = node.namedChild(i);
		if (!decl || decl.type !== "variable_declarator") continue;

		const nameNode = decl.childForFieldName("name");
		// Destructuring patterns are not `ts.isIdentifier`, so the enricher skips
		// them too.
		if (!nameNode || nameNode.type !== "identifier") continue;
		const name = nameNode.text;

		const value = decl.childForFieldName("value");
		let kind: NodeKind | undefined;
		if (
			value &&
			(value.type === "arrow_function" || value.type === "function_expression")
		) {
			kind = functionKind(name, value, language, decl);
		} else if (
			value &&
			(value.type === "class" || value.type === "class_declaration")
		) {
			kind = "class";
		} else {
			kind = isConst ? "constant" : "variable";
		}

		pushCandidate(
			{
				kind,
				name,
				parts: [...stack, name],
				range: rangeOf(rangeNode),
				isExported,
				isAsync: value ? hasAnonChild(value, "async") : false,
				isStatic: false,
				isAbstract: false,
			},
			out,
			parentIndex,
		);
	}
}

function collectClassMembers(
	body: TsNode,
	stack: string[],
	out: Collected,
	parentIndex: number,
): void {
	for (let i = 0; i < body.namedChildCount; i++) {
		const member = body.namedChild(i);
		if (!member) continue;

		if (member.type === "public_field_definition") {
			const name = memberName(member);
			if (name === undefined) continue;
			pushCandidate(
				{
					kind: "property",
					name,
					parts: [...stack, name],
					range: rangeOf(member),
					isExported: false,
					isAsync: false,
					isStatic: hasAnonChild(member, "static"),
					isAbstract: hasAnonChild(member, "abstract"),
				},
				out,
				parentIndex,
			);
			continue;
		}

		if (
			member.type === "method_definition" ||
			member.type === "method_signature" ||
			member.type === "abstract_method_signature"
		) {
			// get/set accessors become a single "property" through an
			// order-sensitive de-duplication we do not try to reproduce.
			if (hasAnonChild(member, "get") || hasAnonChild(member, "set")) {
				pushCandidate(unprovableCandidate(member), out, parentIndex);
				continue;
			}
			const name = memberName(member);
			if (name === undefined) continue;
			pushCandidate(
				{
					kind: "method",
					name,
					parts: [...stack, name],
					range: rangeOf(member),
					isExported: false,
					isAsync: hasAnonChild(member, "async"),
					isStatic: hasAnonChild(member, "static"),
					isAbstract:
						member.type === "abstract_method_signature" ||
						hasAnonChild(member, "abstract"),
				},
				out,
				parentIndex,
			);
		}
	}
}

function collectInterfaceMembers(
	body: TsNode,
	stack: string[],
	out: Collected,
	parentIndex: number,
): void {
	for (let i = 0; i < body.namedChildCount; i++) {
		const member = body.namedChild(i);
		if (!member) continue;
		const kind: NodeKind | undefined =
			member.type === "method_signature"
				? "method"
				: member.type === "property_signature"
					? "property"
					: undefined;
		if (kind === undefined) continue;
		const name = memberName(member);
		if (name === undefined) continue;
		pushCandidate(
			{
				kind,
				name,
				parts: [...stack, name],
				range: rangeOf(member),
				isExported: false,
				isAsync: false,
				isStatic: false,
				isAbstract: false,
			},
			out,
			parentIndex,
		);
	}
}

function collectEnumMembers(
	body: TsNode,
	stack: string[],
	out: Collected,
	parentIndex: number,
): void {
	for (let i = 0; i < body.namedChildCount; i++) {
		const member = body.namedChild(i);
		if (!member) continue;
		const name =
			member.type === "enum_assignment"
				? member.childForFieldName("name")?.text
				: member.type === "property_identifier"
					? member.text
					: undefined;
		if (name === undefined) continue;
		pushCandidate(
			{
				kind: "enum_member",
				name,
				parts: [...stack, name],
				range: rangeOf(member),
				isExported: false,
				isAsync: false,
				isStatic: false,
				isAbstract: false,
			},
			out,
			parentIndex,
		);
	}
}

/**
 * Mirrors the enricher's `isComponent`: PascalCase AND (JSX inside a .tsx/.jsx
 * file OR a React.FC-style annotation). In a JSX file the JSX search is the
 * deciding factor, and matching it byte for byte is not worth the risk — so a
 * PascalCase declaration there is left entirely to the enricher.
 */
function functionKind(
	name: string,
	node: TsNode,
	language: Language,
	varDecl?: TsNode,
): NodeKind | undefined {
	if (!/^[A-Z][a-zA-Z0-9]*$/.test(name)) return "function";
	if (isJsxLanguage(language)) return undefined;
	const annotated =
		hasFcAnnotation(node) ||
		(varDecl !== undefined && hasFcAnnotation(varDecl));
	return annotated ? "component" : "function";
}

function hasFcAnnotation(node: TsNode): boolean {
	const typeNode =
		node.childForFieldName("return_type") ?? node.childForFieldName("type");
	if (!typeNode) return false;
	const text = typeNode.text;
	return FC_MARKERS.some((marker) => text.includes(marker));
}

// ---------------------------------------------------------------------------
// PHP
// ---------------------------------------------------------------------------

/**
 * PHP has a name-resolution enricher (FQN + `use` aliases), but Pass A still
 * owns the node set and `contains` skeleton. Node type names verified against
 * tree-sitter-php.
 */
function collectPhp(
	container: TsNode,
	stack: string[],
	out: Collected,
	parentIndex: number,
): void {
	for (let i = 0; i < container.namedChildCount; i++) {
		const node = container.namedChild(i);
		if (!node) continue;

		switch (node.type) {
			case "namespace_definition": {
				const nameNode = node.childForFieldName("name");
				const name = nameNode?.text;
				if (name === undefined) break;
				const index = pushCandidate(
					phpCandidate("namespace", name, [...stack, name], node),
					out,
					parentIndex,
				);
				// Braced form: `namespace X { … }`. The `;` form has no body and its
				// siblings stay at the top level, matching PHP scoping closely enough.
				const body = node.childForFieldName("body");
				if (body) collectPhp(body, [...stack, name], out, index);
				break;
			}

			case "namespace_use_declaration":
				// `use` is resolved by the PHP enricher into `imports` edges from
				// the file node. Emitting leaf `import` nodes here bloated Magento
				// graphs (~30% of nodes) without any outbound edge an agent could follow.
				break;

			case "function_definition": {
				const name = fieldText(node, "name");
				if (name === undefined) break;
				pushCandidate(
					{
						...phpCandidate("function", name, [...stack, name], node),
						isExported: true,
					},
					out,
					parentIndex,
				);
				break;
			}

			case "class_declaration":
			case "trait_declaration":
			case "interface_declaration": {
				const name = fieldText(node, "name");
				if (name === undefined) break;
				const kind: NodeKind =
					node.type === "interface_declaration" ? "interface" : "class";
				const index = pushCandidate(
					{
						...phpCandidate(kind, name, [...stack, name], node),
						isExported: true,
						isAbstract:
							firstNamedChildOfTypes(node, ["abstract_modifier"]) !== undefined,
					},
					out,
					parentIndex,
				);
				const body = node.childForFieldName("body");
				if (body) collectPhpClassMembers(body, [...stack, name], out, index);
				break;
			}

			case "enum_declaration": {
				const name = fieldText(node, "name");
				if (name === undefined) break;
				const index = pushCandidate(
					{
						...phpCandidate("enum", name, [...stack, name], node),
						isExported: true,
					},
					out,
					parentIndex,
				);
				const body = node.childForFieldName("body");
				if (body) collectPhpClassMembers(body, [...stack, name], out, index);
				break;
			}

			case "const_declaration": {
				for (const element of namedChildrenOfType(node, "const_element")) {
					const name = element.namedChild(0)?.text;
					if (name === undefined) continue;
					pushCandidate(
						{
							...phpCandidate("constant", name, [...stack, name], element),
							isExported: true,
						},
						out,
						parentIndex,
					);
				}
				break;
			}

			default:
				break;
		}
	}
}

function collectPhpClassMembers(
	body: TsNode,
	stack: string[],
	out: Collected,
	parentIndex: number,
): void {
	for (let i = 0; i < body.namedChildCount; i++) {
		const member = body.namedChild(i);
		if (!member) continue;

		switch (member.type) {
			case "method_declaration": {
				const name = fieldText(member, "name");
				if (name === undefined) break;
				pushCandidate(
					{
						...phpCandidate("method", name, [...stack, name], member),
						isStatic:
							firstNamedChildOfTypes(member, ["static_modifier"]) !== undefined,
						isAbstract:
							firstNamedChildOfTypes(member, ["abstract_modifier"]) !==
							undefined,
					},
					out,
					parentIndex,
				);
				break;
			}

			case "property_declaration": {
				const isStatic =
					firstNamedChildOfTypes(member, ["static_modifier"]) !== undefined;
				for (const element of namedChildrenOfType(member, "property_element")) {
					const name = element.namedChild(0)?.text;
					if (name === undefined) continue;
					pushCandidate(
						{
							...phpCandidate("property", name, [...stack, name], element),
							isStatic,
						},
						out,
						parentIndex,
					);
				}
				break;
			}

			case "const_declaration": {
				for (const element of namedChildrenOfType(member, "const_element")) {
					const name = element.namedChild(0)?.text;
					if (name === undefined) continue;
					pushCandidate(
						phpCandidate("constant", name, [...stack, name], element),
						out,
						parentIndex,
					);
				}
				break;
			}

			case "enum_case": {
				const name = fieldText(member, "name") ?? member.namedChild(0)?.text;
				if (name === undefined) break;
				pushCandidate(
					phpCandidate("enum_member", name, [...stack, name], member),
					out,
					parentIndex,
				);
				break;
			}

			default:
				break;
		}
	}
}

function phpCandidate(
	kind: NodeKind,
	name: string,
	parts: string[],
	node: TsNode,
): Candidate {
	return {
		kind,
		name,
		parts,
		range: rangeOf(node),
		isExported: false,
		isAsync: false,
		isStatic: false,
		isAbstract: false,
	};
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function pushCandidate(
	candidate: Candidate,
	out: Collected,
	parentIndex: number,
): number {
	out.push({ candidate, parentIndex });
	return out.length - 1;
}

function rangeOf(node: TsNode): Range {
	return {
		startLine: node.startPosition.row + 1,
		endLine: node.endPosition.row + 1,
		startColumn: node.startPosition.column,
		endColumn: node.endPosition.column,
	};
}

function fieldText(node: TsNode, field: string): string | undefined {
	const child = node.childForFieldName(field);
	return child?.text;
}

function memberName(member: TsNode): string | undefined {
	const nameNode = member.childForFieldName("name");
	return nameNode?.text;
}

function firstNamedChildOfTypes(
	node: TsNode,
	types: string[],
): TsNode | undefined {
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (child && types.includes(child.type)) return child;
	}
	return undefined;
}

function namedChildrenOfType(node: TsNode, type: string): TsNode[] {
	const found: TsNode[] = [];
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (child && child.type === type) found.push(child);
	}
	return found;
}

function hasAnonChild(node: TsNode, keyword: string): boolean {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child && !child.isNamed && child.type === keyword) return true;
		// `accessibility_modifier` / `abstract_modifier` are named in some grammars.
		if (child?.isNamed && child.type === keyword) return true;
	}
	return false;
}

/** First token of a declaration list when the grammar exposes no `kind` field. */
function tokenKind(node: TsNode): string | undefined {
	const first = node.child(0);
	return first && !first.isNamed ? first.type : undefined;
}

function stringLiteralValue(node: TsNode): string | undefined {
	const fragment = firstNamedChildOfTypes(node, ["string_fragment"]);
	if (fragment) return fragment.text;
	const text = node.text;
	if (text.length >= 2) {
		const quote = text[0];
		if ((quote === '"' || quote === "'") && text.endsWith(quote)) {
			return text.slice(1, -1);
		}
	}
	return undefined;
}

/** Exported for the PHP backend's grammar-availability check. */
export function treeSitterLangFor(
	filePath: string,
): TreeSitterLang | undefined {
	return treeSitterLangFromPath(filePath);
}
