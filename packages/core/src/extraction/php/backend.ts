import type {
	Hasher,
	Language,
	LanguageBackend,
	Parser,
	PassAResult,
} from "../../types";
import { TREE_SITTER_WASMS_VERSION } from "../tree-sitter/grammars";
import { TreeSitterParser } from "../tree-sitter/parser";

export interface PhpBackendOptions {
	hasher: Hasher;
	now?: () => number;
	project?: string;
}

/**
 * PHP backend: tree-sitter only, no enricher.
 *
 * Because `enricher` is absent, the indexer treats Pass A as the final answer:
 * a PHP file reaches the `resolved` coverage state on structural nodes and
 * `contains` edges alone, rather than being parked at `parsed` forever waiting
 * on a Pass B that will never run. Those edges carry
 * `provenance: "tree-sitter"` and `confidence: "high"` — they are lexical
 * containment facts, which tree-sitter knows exactly; nothing here claims
 * name resolution, so no `calls`/`imports` targets are invented.
 */
export class PhpLanguageBackend implements LanguageBackend {
	readonly id = "php";
	readonly languages: Language[] = ["php"];
	readonly extensions = [".php"];
	readonly parser: Parser;
	readonly enricher = undefined;

	constructor(opts: PhpBackendOptions) {
		this.parser = new TreeSitterParser(opts);
	}

	versionKeys(): Record<string, string> {
		return { "parser:tree-sitter-wasms": TREE_SITTER_WASMS_VERSION };
	}

	extractNodes(filePath: string, source: string): PassAResult {
		return this.parser.extractNodes(filePath, source);
	}
}

export function createPhpBackend(opts: PhpBackendOptions): LanguageBackend {
	return new PhpLanguageBackend(opts);
}
