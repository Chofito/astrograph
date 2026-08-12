import { readFileSync } from "node:fs";
import type { Tree, Parser as WasmParser } from "web-tree-sitter";
import { createParserFor } from "../tree-sitter/grammars";

export interface PhpAstEntry {
	source: string;
	tree: Tree;
}

/**
 * PHP parse helper: at most one live Tree at a time.
 *
 * Call {@link parse} then {@link release} (or `try/finally`) so Magento-scale
 * indexes stay O(1) WASM trees instead of retaining every file for the pass.
 */
export class PhpAstCache {
	private rootPath = "";
	private parser: WasmParser | undefined;
	private livePath: string | undefined;
	private live: PhpAstEntry | undefined;

	setRootPath(rootPath: string): void {
		this.rootPath = rootPath;
	}

	/** Number of trees currently retained (0 or 1). */
	get size(): number {
		return this.live === undefined ? 0 : 1;
	}

	/**
	 * Drop the live Tree. Safe to call repeatedly. Keeps the Parser so the
	 * next file can reuse it without reloading the grammar.
	 */
	clear(): void {
		this.releaseLive();
	}

	/** Test / shutdown helper — also frees the Parser. */
	dispose(): void {
		this.clear();
		this.parser?.delete();
		this.parser = undefined;
	}

	/**
	 * Parse `relPath`. Releases any previously live tree first so peak RAM
	 * stays one Tree + source.
	 */
	parse(relPath: string, source?: string): PhpAstEntry | undefined {
		if (this.livePath === relPath && this.live !== undefined) return this.live;
		this.releaseLive();

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
		this.livePath = relPath;
		this.live = entry;
		return entry;
	}

	/** @deprecated Use {@link parse}; kept so older call sites compile during the cut. */
	get(relPath: string, source?: string): PhpAstEntry | undefined {
		return this.parse(relPath, source);
	}

	release(relPath: string): void {
		if (this.livePath !== relPath) return;
		this.releaseLive();
	}

	private releaseLive(): void {
		this.live?.tree.delete();
		this.live = undefined;
		this.livePath = undefined;
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
