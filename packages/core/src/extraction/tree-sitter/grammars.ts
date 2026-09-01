/// <reference path="../../wasm.d.ts" />

import javascriptWasm from "tree-sitter-wasms/out/tree-sitter-javascript.wasm" with {
	type: "file",
};
import phpWasm from "tree-sitter-wasms/out/tree-sitter-php.wasm" with {
	type: "file",
};
import tsxWasm from "tree-sitter-wasms/out/tree-sitter-tsx.wasm" with {
	type: "file",
};
// Static `type: "file"` imports resolve to a path at runtime AND get embedded
// by `bun build --compile`. The previous runtime `require.resolve` into
// node_modules silently produced a binary that parsed nothing.
import typescriptWasm from "tree-sitter-wasms/out/tree-sitter-typescript.wasm" with {
	type: "file",
};
import treeSitterWasmsPkg from "tree-sitter-wasms/package.json" with {
	type: "json",
};
import { Parser, Language as WasmLanguage } from "web-tree-sitter";
// web-tree-sitter loads its own Emscripten core alongside the grammars. Without
// this it is resolved relative to the bundle and a compiled binary dies with
// `ENOENT /$bunfs/root/tree-sitter.wasm` before parsing anything.
import treeSitterRuntimeWasm from "web-tree-sitter/tree-sitter.wasm" with {
	type: "file",
};

export type TreeSitterLang =
	| "typescript"
	| "tsx"
	| "javascript"
	| "jsx"
	| "php";

/** Real installed version of the grammar bundle — feeds the index config hash. */
export const TREE_SITTER_WASMS_VERSION: string = treeSitterWasmsPkg.version;

const WASM_FILES: Record<TreeSitterLang, string> = {
	typescript: typescriptWasm,
	tsx: tsxWasm,
	javascript: javascriptWasm,
	// The JS grammar covers JSX; there is no separate tree-sitter-jsx.
	jsx: javascriptWasm,
	php: phpWasm,
};

export interface GrammarUnavailable {
	lang: TreeSitterLang;
	reason: string;
}

const languageCache = new Map<TreeSitterLang, WasmLanguage>();
const unavailable = new Map<TreeSitterLang, string>();
let initialized = false;
let runtimeFailure: string | undefined;

/** Initialize the web-tree-sitter WASM runtime (idempotent). */
export async function initTreeSitter(): Promise<void> {
	if (initialized) return;
	try {
		await Parser.init({
			// Emscripten asks for "tree-sitter.wasm" by bare name; hand it the
			// embedded copy so this works from a standalone binary too.
			locateFile: () => treeSitterRuntimeWasm,
		} as Parameters<typeof Parser.init>[0]);
		initialized = true;
		runtimeFailure = undefined;
	} catch (error) {
		runtimeFailure = error instanceof Error ? error.message : String(error);
		throw error;
	}
}

export function isTreeSitterReady(): boolean {
	return initialized;
}

/** Why the tree-sitter runtime itself is unusable, if it is. */
export function treeSitterRuntimeFailure(): string | undefined {
	return runtimeFailure;
}

/** Lazy-load grammars for the given languages. Failures are recorded, not thrown. */
export async function loadGrammars(langs: TreeSitterLang[]): Promise<void> {
	if (!initialized) await initTreeSitter();
	for (const lang of [...new Set(langs)]) {
		if (languageCache.has(lang) || unavailable.has(lang)) continue;
		try {
			const language = await WasmLanguage.load(WASM_FILES[lang]);
			languageCache.set(lang, language);
		} catch (error) {
			unavailable.set(
				lang,
				error instanceof Error ? error.message : String(error),
			);
		}
	}
}

export function getLanguage(lang: TreeSitterLang): WasmLanguage | undefined {
	return languageCache.get(lang);
}

export function isGrammarLoaded(lang: TreeSitterLang): boolean {
	return languageCache.has(lang);
}

/** Grammars successfully loaded so far, sorted. */
export function loadedGrammars(): TreeSitterLang[] {
	return [...languageCache.keys()].sort();
}

/**
 * Grammars we tried and failed to load, with the reason — surfaced through
 * `BackendStatus` so `status` can report an unusable parser instead of
 * silently returning file-only graphs.
 */
export function unavailableGrammars(): GrammarUnavailable[] {
	return [...unavailable.entries()]
		.map(([lang, reason]) => ({ lang, reason }))
		.sort((a, b) => (a.lang < b.lang ? -1 : a.lang > b.lang ? 1 : 0));
}

export function createParserFor(lang: TreeSitterLang): Parser | undefined {
	const language = languageCache.get(lang);
	if (!language) return undefined;
	const parser = new Parser();
	parser.setLanguage(language);
	return parser;
}

export function treeSitterLangFromPath(
	filePath: string,
): TreeSitterLang | undefined {
	const dot = filePath.lastIndexOf(".");
	if (dot === -1) return undefined;
	switch (filePath.slice(dot).toLowerCase()) {
		case ".ts":
		case ".mts":
		case ".cts":
			return "typescript";
		case ".tsx":
			return "tsx";
		case ".js":
		case ".mjs":
		case ".cjs":
			return "javascript";
		case ".jsx":
			return "jsx";
		case ".php":
			return "php";
		default:
			return undefined;
	}
}
