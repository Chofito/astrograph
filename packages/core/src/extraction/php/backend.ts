import type {
	BackendCapabilities,
	EdgeResolutionResult,
	Enricher,
	EnricherMode,
	Hasher,
	Language,
	LanguageBackend,
	LoadProjectOptions,
	Node,
	Parser,
} from "../../types";
import { TREE_SITTER_WASMS_VERSION } from "../tree-sitter/grammars";
import { TreeSitterParser } from "../tree-sitter/parser";
import { PhpAstCache } from "./ast-cache";
import {
	buildPhpNameIndex,
	emptyPhpNameIndex,
	type PhpNameIndex,
	resolvePhpHeritage,
} from "./resolve";

export interface PhpBackendOptions {
	hasher: Hasher;
	now?: () => number;
	project?: string;
	/** Set false to keep Pass A only (`backends.php.enricher: false`). */
	enricher?: boolean;
}

const PASS_A_ONLY_CAPABILITIES: BackendCapabilities = {
	edgeKinds: ["contains"],
};

const ENRICHED_CAPABILITIES: BackendCapabilities = {
	edgeKinds: [
		"contains",
		"extends",
		"implements",
		"imports",
		"type_of",
		"returns",
		"calls",
		"instantiates",
	],
};

/**
 * PHP backend: tree-sitter Pass A + optional name-resolution enricher.
 *
 * Trees are not retained across files. Pass A parses and frees. The enricher
 * rebuilds a name index (one Tree at a time) then re-parses each file for
 * edges. Peak RAM is O(1 tree) + O(FQN/method maps).
 */
export class PhpLanguageBackend implements LanguageBackend {
	readonly id = "php";
	readonly languages: Language[] = ["php"];
	readonly extensions = [".php"];
	readonly parser: Parser;
	readonly enricher: Enricher | undefined;
	readonly capabilities: BackendCapabilities;

	private readonly treeSitter: TreeSitterParser;
	private readonly astCache = new PhpAstCache();
	private fileNames: string[] = [];
	private loadNodesForFile: (filePath: string) => Node[] = () => [];
	private nameIndex: PhpNameIndex | null = null;

	constructor(opts: PhpBackendOptions) {
		this.treeSitter = new TreeSitterParser(opts);
		this.parser = this.treeSitter;
		if (opts.enricher === false) {
			this.enricher = undefined;
			this.capabilities = PASS_A_ONLY_CAPABILITIES;
		} else {
			this.enricher = {
				mode: "complement" satisfies EnricherMode,
				loadProject: (o) => this.loadProject(o),
				resolveEdges: (filePath) => this.resolveEdges(filePath),
			};
			this.capabilities = ENRICHED_CAPABILITIES;
		}
	}

	versionKeys(): Record<string, string> {
		const keys: Record<string, string> = {
			"parser:tree-sitter-wasms": TREE_SITTER_WASMS_VERSION,
		};
		if (this.enricher !== undefined) {
			keys["enricher:php-names"] = "3";
		}
		return keys;
	}

	private loadProject(opts: LoadProjectOptions): void {
		this.astCache.clear();
		this.astCache.setRootPath(opts.rootPath);
		this.fileNames = opts.fileNames ?? [];
		this.loadNodesForFile = opts.loadNodesForFile ?? (() => []);
		this.nameIndex = null;
	}

	private resolveEdges(filePath: string): EdgeResolutionResult {
		this.ensureNameIndex();

		const entry = this.astCache.parse(filePath);
		if (entry === undefined) {
			return { edges: [], errors: [], externalNodes: [] };
		}
		try {
			const passA = this.treeSitter.extractNodes(filePath, entry.source, {
				tree: entry.tree,
			});
			return resolvePhpHeritage(
				filePath,
				passA,
				this.nameIndex ?? emptyPhpNameIndex(),
				entry.tree.rootNode,
			);
		} finally {
			this.astCache.release(filePath);
		}
	}

	private ensureNameIndex(): void {
		if (this.nameIndex !== null) return;
		this.nameIndex = buildPhpNameIndex({
			fileNames: this.fileNames,
			loadNodesForFile: (path) => this.loadNodesForFile(path),
			astCache: this.astCache,
		});
	}
}

export function createPhpBackend(opts: PhpBackendOptions): LanguageBackend {
	return new PhpLanguageBackend(opts);
}
