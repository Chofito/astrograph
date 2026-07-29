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
	PassAResult,
} from "../../types";
import { TREE_SITTER_WASMS_VERSION } from "../tree-sitter/grammars";
import { TreeSitterParser } from "../tree-sitter/parser";
import { PhpAstCache } from "./ast-cache";
import {
	buildPhpFqnIndex,
	type PhpFqnIndex,
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
	],
};

/**
 * PHP backend: tree-sitter Pass A + optional name-resolution enricher.
 *
 * The enricher is not a type checker — it builds a project-wide FQN → node id
 * index and resolves `extends` / `implements` / `imports` / `type_of` /
 * `returns` from `use` aliases and the current namespace only. Never bare-name
 * search. Pass A does not emit leaf `import` nodes; `use` becomes `imports`
 * edges from the file node instead.
 *
 * Parse cost with the enricher on: each file is parsed once into
 * {@link PhpAstCache} during Pass A (using the source the indexer already
 * read). FQN-index build, contains re-extract, and heritage all reuse that
 * Tree. Trees are released on every `loadProject`. Files that skip Pass A in
 * a sync still parse once on first enricher touch (disk fallback).
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
	private fqnIndex: PhpFqnIndex | null = null;

	constructor(opts: PhpBackendOptions) {
		this.treeSitter = new TreeSitterParser(opts);
		if (opts.enricher === false) {
			this.parser = this.treeSitter;
			this.enricher = undefined;
			this.capabilities = PASS_A_ONLY_CAPABILITIES;
		} else {
			// Indexer calls backend.parser — wrap so Pass A fills the shared cache.
			this.parser = {
				extractNodes: (filePath, source) =>
					this.extractNodesCached(filePath, source),
			};
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
			keys["enricher:php-names"] = "2";
		}
		return keys;
	}

	private extractNodesCached(filePath: string, source: string): PassAResult {
		const entry = this.astCache.get(filePath, source);
		if (entry === undefined) {
			return this.treeSitter.extractNodes(filePath, source);
		}
		return this.treeSitter.extractNodes(filePath, entry.source, {
			tree: entry.tree,
		});
	}

	private loadProject(opts: LoadProjectOptions): void {
		this.astCache.clear();
		this.astCache.setRootPath(opts.rootPath);
		this.fileNames = opts.fileNames ?? [];
		this.loadNodesForFile = opts.loadNodesForFile ?? (() => []);
		this.fqnIndex = null;
	}

	private resolveEdges(filePath: string): EdgeResolutionResult {
		this.ensureFqnIndex();

		const entry = this.astCache.get(filePath);
		if (entry === undefined) {
			return { edges: [], errors: [], externalNodes: [] };
		}

		// Reuse the cached Tree so contains re-extract does not re-parse.
		const passA = this.treeSitter.extractNodes(filePath, entry.source, {
			tree: entry.tree,
		});
		return resolvePhpHeritage(
			filePath,
			passA,
			this.fqnIndex ?? new Map(),
			entry.tree.rootNode,
		);
	}

	private ensureFqnIndex(): void {
		if (this.fqnIndex !== null) return;
		// Uses trees already cached by Pass A; disk-parses only uncached files.
		this.fqnIndex = buildPhpFqnIndex({
			fileNames: this.fileNames,
			loadNodesForFile: (path) => this.loadNodesForFile(path),
			astCache: this.astCache,
		});
	}
}

export function createPhpBackend(opts: PhpBackendOptions): LanguageBackend {
	return new PhpLanguageBackend(opts);
}
