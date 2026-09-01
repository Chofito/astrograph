import ts from "typescript";
import type {
	BackendCapabilities,
	EdgeResolutionResult,
	Enricher,
	InvalidationInput,
	InvalidationResult,
	Language,
	LanguageBackend,
	LoadProjectOptions,
	PassAResult,
	ProjectExtractor,
} from "../../types";
import { TREE_SITTER_WASMS_VERSION } from "../tree-sitter/grammars";
import { TreeSitterParser } from "../tree-sitter/parser";
import { TsExtractor, type TsExtractorOptions } from "./extractor";

export interface TypescriptBackendOptions extends TsExtractorOptions {
	/** Set false to run Pass A only (config `backends.typescript.enricher`). */
	enricher?: boolean;
}

/** Pass A alone — structural containment only. */
const PASS_A_ONLY_CAPABILITIES: BackendCapabilities = {
	edgeKinds: ["contains"],
};

/** Pass A + TS compiler enricher. */
const ENRICHED_CAPABILITIES: BackendCapabilities = {
	edgeKinds: [
		"contains",
		"calls",
		"imports",
		"exports",
		"extends",
		"implements",
		"references",
		"type_of",
		"returns",
		"instantiates",
		"overrides",
		"decorates",
	],
};

/**
 * JS/TS backend: tree-sitter Pass A (structural) + TypeScript Compiler Pass B.
 *
 * Pass A emits a conservative subset of the compiler's node set with
 * byte-identical ids; Pass B may insert enricher-only nodes and resolved
 * edges. Cross-file id lookups use Pass A rows from SQLite via
 * `loadNodesForFile` — the compiler must not dump every file's nodes into RAM.
 */
export class TypescriptLanguageBackend
	implements ProjectExtractor, LanguageBackend
{
	readonly id = "typescript";
	readonly languages: Language[] = ["typescript", "tsx", "javascript", "jsx"];
	readonly extensions = [
		".ts",
		".tsx",
		".js",
		".jsx",
		".mts",
		".cts",
		".mjs",
		".cjs",
	];

	readonly parser: TreeSitterParser;
	readonly enricher: Enricher | undefined;
	readonly capabilities: BackendCapabilities;

	private readonly tsExtractor: TsExtractor;

	constructor(opts: TypescriptBackendOptions) {
		this.parser = new TreeSitterParser(opts);
		this.tsExtractor = new TsExtractor(opts);
		this.enricher =
			opts.enricher === false
				? undefined
				: {
						mode: "complement",
						id: "ts-compiler",
						// Reconciled nodes are the compiler's own view of this file.
						provenance: "ts-compiler",
						loadProject: (o) => this.loadProject(o),
						resolveEdges: (filePath) => this.resolveEdges(filePath),
						invalidate: (input) => this.invalidate(input),
					};
		this.capabilities =
			this.enricher === undefined
				? PASS_A_ONLY_CAPABILITIES
				: ENRICHED_CAPABILITIES;
	}

	versionKeys(): Record<string, string> {
		return {
			"enricher:typescript": ts.version,
			"parser:tree-sitter-wasms": TREE_SITTER_WASMS_VERSION,
		};
	}

	loadProject(opts: LoadProjectOptions): void {
		this.tsExtractor.loadProject(opts);
	}

	/** Pass A — tree-sitter structural nodes and `contains` edges. */
	extractNodes(filePath: string, source: string): PassAResult {
		return this.parser.extractNodes(filePath, source);
	}

	/**
	 * Which JS/TS files must be resolved again.
	 *
	 * Module semantics, expressed through recorded edges: a file is affected when
	 * it changed, or when it holds a real `imports`/`calls`/type edge into a file
	 * that changed or was removed. A removal additionally re-resolves the
	 * importers named by the identities that existed before it, so an edge that
	 * pointed at a deleted declaration is recomputed rather than left pointing at
	 * a ghost.
	 *
	 * What it deliberately does not do is search by name. `laterFn` appearing in
	 * a new file proves nothing about a `laterFn()` call elsewhere unless a module
	 * relationship connects them; the compiler decides that during resolution,
	 * not this method by string equality.
	 */
	private invalidate(input: InvalidationInput): InvalidationResult {
		const affected = new Set<string>();
		const changed = [...input.added, ...input.modified];

		for (const filePath of changed) {
			affected.add(filePath);
			for (const dependent of input.dependentsOf(filePath)) {
				affected.add(dependent);
			}
		}

		// A removed file's importers must be re-resolved, and the identities were
		// captured before deletion precisely so this is still answerable.
		for (const filePath of input.removed) {
			for (const dependent of input.dependentsOf(filePath)) {
				affected.add(dependent);
			}
		}
		for (const identity of input.priorIdentities) {
			if (!this.owns(identity.filePath)) continue;
			for (const dependent of input.dependentsOf(identity.filePath)) {
				affected.add(dependent);
			}
		}

		// A configuration or version change invalidates the whole program: the
		// compiler's view of every file may differ.
		return {
			resolveFiles: [...affected].filter((path) => this.owns(path)).sort(),
		};
	}

	private owns(filePath: string): boolean {
		const dot = filePath.lastIndexOf(".");
		if (dot === -1) return false;
		return this.extensions.includes(filePath.slice(dot).toLowerCase());
	}

	/** Pass B — compiler nodes (inserts allowed) plus resolved edges. */
	resolveEdges(filePath: string): EdgeResolutionResult {
		const source = this.tsExtractor.getSourceText(filePath);
		if (source === undefined) {
			return { edges: [], errors: [], externalNodes: [] };
		}

		const extracted = this.tsExtractor.extractNodes(filePath, source);
		const resolved = this.tsExtractor.resolveEdges(filePath);

		return {
			edges: resolved.edges,
			errors: [...extracted.errors, ...resolved.errors],
			externalNodes: resolved.externalNodes,
			nodes: extracted.nodes,
		};
	}
}
