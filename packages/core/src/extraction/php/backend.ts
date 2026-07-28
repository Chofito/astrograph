import { readFileSync } from "node:fs";
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
 */
export class PhpLanguageBackend implements LanguageBackend {
	readonly id = "php";
	readonly languages: Language[] = ["php"];
	readonly extensions = [".php"];
	readonly parser: Parser;
	readonly enricher: Enricher | undefined;
	readonly capabilities: BackendCapabilities;

	private rootPath = "";
	private fileNames: string[] = [];
	private loadNodesForFile: (filePath: string) => Node[] = () => [];
	private fqnIndex: PhpFqnIndex | null = null;

	constructor(opts: PhpBackendOptions) {
		this.parser = new TreeSitterParser(opts);
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
			keys["enricher:php-names"] = "2";
		}
		return keys;
	}

	extractNodes(filePath: string, source: string): PassAResult {
		return this.parser.extractNodes(filePath, source);
	}

	private loadProject(opts: LoadProjectOptions): void {
		this.rootPath = opts.rootPath;
		this.fileNames = opts.fileNames ?? [];
		this.loadNodesForFile = opts.loadNodesForFile ?? (() => []);
		this.fqnIndex = null;
	}

	private resolveEdges(filePath: string): EdgeResolutionResult {
		this.ensureFqnIndex();

		const source = this.readSource(filePath);
		if (source === undefined) {
			return { edges: [], errors: [], externalNodes: [] };
		}

		const passA = this.parser.extractNodes(filePath, source);
		return resolvePhpHeritage(
			filePath,
			source,
			passA,
			this.fqnIndex ?? new Map(),
		);
	}

	private ensureFqnIndex(): void {
		if (this.fqnIndex !== null) return;
		this.fqnIndex = buildPhpFqnIndex({
			rootPath: this.rootPath,
			fileNames: this.fileNames,
			loadNodesForFile: (path) => this.loadNodesForFile(path),
		});
	}

	private readSource(relPath: string): string | undefined {
		try {
			return readFileSync(`${this.rootPath}/${relPath}`, "utf8");
		} catch {
			return undefined;
		}
	}
}

export function createPhpBackend(opts: PhpBackendOptions): LanguageBackend {
	return new PhpLanguageBackend(opts);
}
