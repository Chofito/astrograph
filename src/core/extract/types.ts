import type { Node } from "web-tree-sitter";

export type SymbolKind =
	| "class"
	| "interface"
	| "trait"
	| "enum"
	| "type"
	| "function"
	| "method"
	| "property"
	| "constant"
	| "variable";

export type RefKind = "call" | "new" | "extends" | "implements" | "render";

/** A declaration found in one file. `parent` indexes into the same file's symbol list. */
export interface ExtractedSymbol {
	name: string;
	/** `Class.method` for JS/TS (file-scoped), `Ns\Class::method` for PHP (global). */
	qualifiedName: string;
	kind: SymbolKind;
	parent: number | null;
	exported: boolean;
	startLine: number;
	endLine: number;
	signature: string;
	/** Declared return type name (JS/TS functions and methods), used to type `x = f()`. */
	returnType?: string;
}

/** A use of some name: a call, an instantiation, an inheritance clause, a JSX element. */
export interface ExtractedRef {
	kind: RefKind;
	/** Enclosing symbol index, or null for file-level code. */
	from: number | null;
	name: string;
	/** `this`, `super`, `parent`, `self`, `static`, an identifier, or null for a bare call. */
	receiver: string | null;
	/** PHP only: fully qualified target candidates, most specific first. */
	hints: string[] | null;
	line: number;
}

/**
 * A JS/TS module binding. Re-exports use the same shape:
 * `export { a as b } from "./x"` → { local: "b", imported: "a", source: "./x", reexport: true }
 * `export { a as b }`            → { local: "b", imported: "a", source: null, reexport: true }
 * `export * from "./x"`          → { local: "*", imported: "*", source: "./x", reexport: true }
 */
export interface ExtractedImport {
	local: string;
	imported: string;
	source: string | null;
	reexport: boolean;
}

export interface Extraction {
	symbols: ExtractedSymbol[];
	refs: ExtractedRef[];
	imports: ExtractedImport[];
}

/**
 * A declaration up to where its body starts, on one line: `find(id: string): User`,
 * `export class A extends B`. Without a body node, the first line of the declaration.
 */
export function signatureOf(decl: Node, body: Node | null | undefined): string {
	const text =
		body && body.startIndex > decl.startIndex
			? decl.text.slice(0, body.startIndex - decl.startIndex)
			: (decl.text.split("\n", 1)[0] ?? "");
	const cut = text
		.replace(/\s+/g, " ")
		.replace(/([([{<])\s+/g, "$1")
		.replace(/\s+([)\]}>])/g, "$1")
		.replace(/\s*(\{|=>|:)?\s*$/, (_match, tail) => (tail === "=>" ? " =>" : ""))
		.trim();
	return cut.length > 160 ? `${cut.slice(0, 157)}...` : cut;
}
