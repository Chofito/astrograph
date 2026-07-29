import { readFileSync } from "node:fs";
import type { Tree, Parser as WasmParser } from "web-tree-sitter";
import { createParserFor } from "../tree-sitter/grammars";

export interface PhpAstEntry {
	source: string;
	tree: Tree;
}

/**
 * Per-project PHP parse cache: one WASM Parser, one Tree (+ source) per file.
 *
 * Trees are owned here and released in {@link clear}, which the backend calls
 * from `loadProject` so every re-index / sync invalidates them. Callers must
 * not `tree.delete()` themselves.
 */
export class PhpAstCache {
	private rootPath = "";
	private parser: WasmParser | undefined;
	private readonly entries = new Map<string, PhpAstEntry>();

	setRootPath(rootPath: string): void {
		this.rootPath = rootPath;
	}

	/**
	 * Drop every cached Tree. Safe to call repeatedly. Keeps the Parser so the
	 * next project can reuse it without reloading the grammar.
	 */
	clear(): void {
		for (const entry of this.entries.values()) {
			entry.tree.delete();
		}
		this.entries.clear();
	}

	/** Test / shutdown helper — also frees the Parser. */
	dispose(): void {
		this.clear();
		this.parser?.delete();
		this.parser = undefined;
	}

	/**
	 * Return a cached parse, or parse once. Prefer `source` when the caller
	 * already has file contents so we never re-read from disk.
	 */
	get(relPath: string, source?: string): PhpAstEntry | undefined {
		const hit = this.entries.get(relPath);
		if (hit !== undefined) return hit;

		const text = source ?? readSource(this.rootPath, relPath);
		if (text === undefined) return undefined;

		const parser = this.ensureParser();
		if (parser === undefined) return undefined;

		let tree: Tree | null;
		try {
			tree = parser.parse(text);
		} catch {
			return undefined;
		}
		if (tree === null) return undefined;

		const entry: PhpAstEntry = { source: text, tree };
		this.entries.set(relPath, entry);
		return entry;
	}

	private ensureParser(): WasmParser | undefined {
		if (this.parser !== undefined) return this.parser;
		this.parser = createParserFor("php");
		return this.parser;
	}
}

function readSource(rootPath: string, relPath: string): string | undefined {
	try {
		return readFileSync(`${rootPath}/${relPath}`, "utf8");
	} catch {
		return undefined;
	}
}
