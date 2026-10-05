import javascriptWasm from "tree-sitter-wasms/out/tree-sitter-javascript.wasm" with { type: "file" };
import phpWasm from "tree-sitter-wasms/out/tree-sitter-php.wasm" with { type: "file" };
import tsxWasm from "tree-sitter-wasms/out/tree-sitter-tsx.wasm" with { type: "file" };
import typescriptWasm from "tree-sitter-wasms/out/tree-sitter-typescript.wasm" with { type: "file" };
import { Language, Parser, type Tree } from "web-tree-sitter";
import runtimeWasm from "web-tree-sitter/tree-sitter.wasm" with { type: "file" };

export type Lang = "typescript" | "tsx" | "javascript" | "php";

const WASM: Record<Lang, string> = {
	typescript: typescriptWasm,
	tsx: tsxWasm,
	javascript: javascriptWasm,
	php: phpWasm,
};

const EXTENSIONS: Record<string, Lang> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "tsx",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "javascript",
	".php": "php",
};

export function langForPath(path: string): Lang | undefined {
	if (path.endsWith(".d.ts")) return undefined;
	const dot = path.lastIndexOf(".");
	if (dot === -1) return undefined;
	return EXTENSIONS[path.slice(dot).toLowerCase()];
}

export const SUPPORTED_EXTENSIONS = Object.keys(EXTENSIONS);

let runtime: Promise<void> | undefined;
const parsers = new Map<Lang, Parser>();

/** Loads the runtime and the grammars for `langs` once; one parser per language is reused. */
export async function initParsers(langs: Iterable<Lang> = Object.keys(WASM) as Lang[]): Promise<void> {
	runtime ??= Parser.init({ locateFile: () => runtimeWasm });
	await runtime;
	for (const lang of langs) {
		if (parsers.has(lang)) continue;
		const parser = new Parser();
		parser.setLanguage(await Language.load(WASM[lang]));
		parsers.set(lang, parser);
	}
}

/** Parses source and hands the tree to `fn`; the tree is always freed afterwards. */
export function withTree<T>(lang: Lang, source: string, fn: (tree: Tree) => T): T {
	const parser = parsers.get(lang);
	if (!parser) throw new Error("initParsers() must be awaited first");
	const tree = parser.parse(source);
	if (!tree) throw new Error(`tree-sitter could not parse ${lang} source`);
	try {
		return fn(tree);
	} finally {
		tree.delete();
	}
}
