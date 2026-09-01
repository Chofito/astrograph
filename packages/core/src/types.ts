import type {
	DiagnosticCounts,
	ExtractionDiagnosticCode,
} from "./diagnostics";

/** Stable persisted categories for graph nodes across all language backends. */
export type NodeKind =
	| "file"
	| "module"
	| "class"
	| "interface"
	| "function"
	| "method"
	| "property"
	| "field"
	| "variable"
	| "constant"
	| "enum"
	| "enum_member"
	| "type_alias"
	| "namespace"
	| "parameter"
	| "import"
	| "export"
	| "component";

/** Stable relationship vocabulary shared by extraction, storage, and queries. */
export type EdgeKind =
	| "contains"
	| "calls"
	| "imports"
	| "exports"
	| "extends"
	| "implements"
	| "references"
	| "type_of"
	| "returns"
	| "instantiates"
	| "overrides"
	| "decorates";

/** Backend-defined language identifier; the registry, not this union, is authoritative. */
export type Language = string;
/** Language identifiers shipped by the default registry at the documented baseline. */
export type KnownLanguage = "typescript" | "tsx" | "javascript" | "jsx" | "php";

/** Whether an edge target is proven, outside the project, unknown, or non-unique. */
export type ResolutionState =
	| "resolved"
	| "external"
	| "unresolved"
	| "ambiguous";
/** Qualitative strength of the evidence supporting an extracted relation. */
export type Confidence = "high" | "medium" | "low";
/** Extraction engine or transformation responsible for a persisted fact. */
export type Provenance =
	| "tree-sitter"
	| "ts-compiler"
	| "heuristic"
	| `synthesized:${string}`;
/** Per-file progress through structural parsing and semantic resolution. */
export type CoverageState = "pending" | "parsed" | "resolved";
export type Visibility = "public" | "private" | "protected" | "internal";

/** Source span with one-based lines and zero-based extractor columns. */
export interface Range {
	startLine: number;
	endLine: number;
	startColumn: number;
	endColumn: number;
}

/** Canonical persisted symbol or structural entity in the project graph. */
export interface Node {
	id: string;
	project: string;
	kind: NodeKind;
	name: string;
	qualifiedName: string;
	filePath: string;
	language: Language;
	range: Range;
	signature?: string;
	docstring?: string;
	visibility?: Visibility;
	isExported: boolean;
	isAsync: boolean;
	isStatic: boolean;
	isAbstract: boolean;
	isExternal: boolean;
	isGenerated: boolean;
	isTest: boolean;
	decorators?: string[];
	typeParameters?: string[];
	metadata?: Record<string, unknown>;
	updatedAt: number;
}

/** Persisted directed relation whose target may intentionally remain unresolved. */
export interface Edge {
	id?: number;
	source: string;
	target: string | null;
	targetName?: string;
	kind: EdgeKind;
	resolutionState: ResolutionState;
	confidence: Confidence;
	provenance: Provenance;
	line?: number;
	col?: number;
	metadata?: Record<string, unknown>;
}

/** Stored indexing state and content identity for one project-relative file. */
export interface FileRecord {
	path: string;
	project: string;
	contentHash: string;
	language: Language;
	size: number;
	modifiedAt: number;
	indexedAt: number;
	nodeCount: number;
	state: CoverageState;
	errors?: ExtractionError[];
}

/**
 * Non-fatal or fatal extraction evidence attached to a file record.
 *
 * `code` is the contract; `message` is for humans. Nothing may infer behavior
 * from the message text. Every code is classified by the versioned registry in
 * `diagnostics.ts`, which is what separates lifecycle state from trust.
 */
export interface ExtractionError {
	message: string;
	filePath?: string;
	line?: number;
	column?: number;
	severity: "error" | "warning";
	code?: ExtractionDiagnosticCode;
}

/** Bounded node projection returned by public graph tools. */
export interface NodeRef {
	id: string;
	name: string;
	kind: NodeKind;
	qualifiedName: string;
	filePath: string;
	range: Range;
	signature?: string;
}

/** Bounded edge projection returned by public graph tools. */
export interface EdgeRef {
	source: string;
	target: string | null;
	targetName?: string;
	kind: EdgeKind;
	resolutionState: ResolutionState;
	confidence: Confidence;
	line?: number;
	col?: number;
}

export interface CodeBlock {
	filePath: string;
	startLine: number;
	endLine: number;
	language: Language;
	content: string;
}

export interface SqliteStatement {
	run(...params: unknown[]): {
		changes: number;
		lastInsertRowid: number | bigint;
	};
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
}

/** Minimal SQLite-like port required by migrations, persistence, and queries. */
export interface StorageAdapter {
	prepare(sql: string): SqliteStatement;
	exec(sql: string): void;
	transaction<T>(fn: (...a: unknown[]) => T): (...a: unknown[]) => T;
	pragma(s: string, opts?: { simple?: boolean }): unknown;
	close(): void;
	readonly open: boolean;
}

/** Read-only filesystem port used by indexing and source-code projections. */
export interface FileSystem {
	readText(path: string): Promise<string>;
	exists(path: string): Promise<boolean>;
	stat(path: string): Promise<{ size: number; modifiedAt: number }>;
}

export interface Hasher {
	hash(content: string | Uint8Array): string;
}

/** Project scanner port; concrete adapters must return project-relative candidates. */
export interface GlobScanner {
	scan(
		root: string,
		opts: { include?: string[]; exclude?: string[]; gitignore?: boolean },
	): AsyncIterable<string>;
}

/** Normalized source lifecycle event consumed by incremental synchronization. */
export type WatchEvent = { type: "add" | "change" | "unlink"; path: string };
/** Recursive filesystem watch port whose returned handle owns the subscription. */
export interface Watcher {
	watch(
		paths: string[],
		onEvent: (e: WatchEvent) => void,
		opts?: { debounceMs?: number },
	): { close(): void };
}

/** Project-wide inputs supplied to a semantic enricher before per-file resolution. */
export interface LoadProjectOptions {
	rootPath: string;
	tsconfigPath?: string;
	fileNames?: string[];
	loadNodesForFile?: (filePath: string) => Node[];
}

/** Pass A output: structural nodes + structural edges, from the base parser. */
export interface PassAResult {
	nodes: Node[];
	edges: Edge[];
	errors: ExtractionError[];
}

/** Language parser responsible for Pass A structural output. */
export interface Parser {
	extractNodes(filePath: string, source: string): PassAResult;
}

/**
 * The only relationship an enricher may have with its Pass A parser: Pass A
 * always runs, and the enricher's node view is reconciled onto it. Pass-A-only
 * is expressed by {@link LanguageBackend.enricher} being `undefined`, not by a
 * mode value.
 */
export type EnricherMode = "complement";

/**
 * How `status` presents a backend's enrichment. Derived from the presence of an
 * enricher; it is a projection, never an operating mode a backend can select.
 */
export type EnricherStatus = EnricherMode | "none";

/**
 * Optional backend-specific semantic pass. It may update nodes whose ids match
 * Pass A, insert declarations Pass A intentionally omitted, and add semantic
 * edges; it can never delete a Pass A node.
 */
export interface Enricher {
	readonly mode: EnricherMode;
	/** Identity of the producing enricher, for evidence and diagnostics. */
	readonly id: string;
	/** Stamped on the nodes this enricher owns; the indexer never infers it. */
	readonly provenance: Provenance;
	loadProject?(opts: LoadProjectOptions): void;
	resolveEdges(filePath: string): EdgeResolutionResult;
}

/** Semantic pass output, including honest external targets and extraction evidence. */
export interface EdgeResolutionResult {
	edges: Edge[];
	errors: ExtractionError[];
	externalNodes: Node[];
	/** The enricher's authoritative node view for the file, when it has one. */
	nodes?: Node[];
}

/**
 * Declared graph edges a backend can produce. Queries that need an edge kind
 * absent from this set must say so in `ToolMeta` — empty results under a clean
 * coverage banner would otherwise look like "nothing calls this".
 */
export interface BackendCapabilities {
	edgeKinds: EdgeKind[];
}

/** Complete registry unit for routing a language through parsing and enrichment. */
export interface LanguageBackend {
	id: string;
	languages: Language[];
	extensions: string[];
	parser: Parser;
	enricher?: Enricher;
	/** Edge kinds this backend can emit (Pass A and/or enricher). */
	capabilities: BackendCapabilities;
	versionKeys(): Record<string, string>;
}

export interface EdgeResolver {
	loadProject(opts: LoadProjectOptions): void;
	resolveEdges(filePath: string): EdgeResolutionResult;
}

export interface Extractor {
	extractNodes(filePath: string, source: string): PassAResult;
	resolveEdges(filePath: string): EdgeResolutionResult;
}

export interface ProjectExtractor extends Extractor, EdgeResolver {}

/** Project-level file counts used to describe query completeness. */
export interface Coverage {
	total: number;
	resolved: number;
	parsed: number;
	pending: number;
}
/** Trust envelope returned with every graph-tool payload. */
export interface ToolMeta {
	coverage: Coverage;
	partial: boolean;
	pendingFiles?: string[];
	notes?: string[];
}
/** Public tool response: data is never separated from its coverage evidence. */
export interface ToolResult<T> {
	data: T;
	meta: ToolMeta;
}

interface Scoped {
	projectPath?: string;
}

export interface SearchInput extends Scoped {
	query: string;
	kind?: NodeKind;
	lang?: Language;
	limit?: number;
	includeGenerated?: boolean;
}
export type SearchOutput = {
	node: NodeRef;
	score: number;
	highlights?: string[];
}[];

export interface ContextInput extends Scoped {
	task: string;
	maxSymbols?: number;
	includeCode?: boolean;
	tokenBudget?: number;
}
export interface ContextOutput {
	entryPoints: NodeRef[];
	subgraph: { nodes: NodeRef[]; edges: EdgeRef[] };
	codeBlocks: CodeBlock[];
	inclusionReasons: Record<string, string>;
	relatedFiles: string[];
	stats: {
		nodeCount: number;
		edgeCount: number;
		fileCount: number;
		codeBlockCount: number;
		totalCodeChars: number;
	};
}

export interface TraceInput extends Scoped {
	from: string;
	to: string;
	maxDepth?: number;
}
export interface TraceOutput {
	found: boolean;
	hops: { node: NodeRef; via: EdgeRef; body: CodeBlock }[];
	destinationCallees?: NodeRef[];
	endpoints?: { node: NodeRef; body: CodeBlock }[];
}

export interface CallersInput extends Scoped {
	symbol: string;
	limit?: number;
	includeExternal?: boolean;
}
export type CallersOutput = { caller: NodeRef; callSite: EdgeRef }[];

export interface CalleesInput extends Scoped {
	symbol: string;
	limit?: number;
	includeExternal?: boolean;
}
export type CalleesOutput = { callee: NodeRef; callSite: EdgeRef }[];

export interface ImpactInput extends Scoped {
	symbol: string;
	depth?: number;
	includeExternal?: boolean;
}
export type ImpactOutput = {
	node: NodeRef;
	distance: number;
	viaPath: EdgeRef[];
}[];

export interface NodeInput extends Scoped {
	symbol: string;
	includeCode?: boolean;
}
export interface NodeOutput {
	node: NodeRef;
	docstring?: string;
	callersPreview: NodeRef[];
	calleesPreview: NodeRef[];
	code?: CodeBlock;
}

export interface ExploreInput extends Scoped {
	query: string;
	maxFiles?: number;
}
export interface ExploreOutput {
	files: { filePath: string; blocks: CodeBlock[] }[];
	relationshipMap: EdgeRef[];
}

export interface FilesInput extends Scoped {
	path?: string;
	pattern?: string;
	format?: "tree" | "flat" | "grouped";
	includeMetadata?: boolean;
	maxDepth?: number;
}
export interface FileEntry {
	filePath: string;
	language: Language;
	nodeCount: number;
	coverageState: CoverageState;
}
export type FilesOutput = {
	format: "tree" | "flat" | "grouped";
	entries: FileEntry[];
};

export interface StatusInput extends Scoped {}
export interface BackendStatus {
	id: string;
	languages: string[];
	extensions: string[];
	/** Version keys that feed the config hash (parser + enricher versions). */
	versions: Record<string, string>;
	/** Presentation of enrichment; "none" when the backend has no enricher. */
	enricher: EnricherStatus;
	/** Edge kinds this backend can produce. */
	capabilities: BackendCapabilities;
	/** Grammars this backend needs that are loaded and ready. */
	grammarsLoaded: string[];
	/** Grammars this backend needs that failed to load, with the reason. */
	grammarsUnavailable: { lang: string; reason: string }[];
}

export interface StatusOutput {
	nodeCount: number;
	edgeCount: number;
	fileCount: number;
	nodesByKind: Record<string, number>;
	edgesByKind: Record<string, number>;
	filesByLanguage: Record<string, number>;
	coverage: Coverage;
	/**
	 * Diagnostic tally by trust category. Independent of `coverage`, which only
	 * reports lifecycle: a project can be 100% `resolved` and still report a
	 * non-zero `coverage_gap` here (AG-201).
	 */
	diagnostics?: DiagnosticCounts;
	/** Files whose diagnostics say content is missing, whatever their state. */
	filesWithCoverageGap?: string[];
	pendingSync?: string[];
	dbSizeBytes: number;
	lastUpdated: number;
	backend: string;
	journalMode: string;
	/** Active language backends (parser + optional enricher). */
	backends?: BackendStatus[];
}

/** Language-agnostic facade shared by CLI, MCP, evaluation, and embedders. */
export interface AstrographCore {
	search(i: SearchInput): Promise<ToolResult<SearchOutput>>;
	context(i: ContextInput): Promise<ToolResult<ContextOutput>>;
	trace(i: TraceInput): Promise<ToolResult<TraceOutput>>;
	callers(i: CallersInput): Promise<ToolResult<CallersOutput>>;
	callees(i: CalleesInput): Promise<ToolResult<CalleesOutput>>;
	impact(i: ImpactInput): Promise<ToolResult<ImpactOutput>>;
	getNode(i: NodeInput): Promise<ToolResult<NodeOutput>>;
	explore(i: ExploreInput): Promise<ToolResult<ExploreOutput>>;
	getFiles(i: FilesInput): Promise<ToolResult<FilesOutput>>;
	getStats(i: StatusInput): Promise<ToolResult<StatusOutput>>;
	indexAll(opts?: {
		force?: boolean;
		onProgress?: (e: IndexProgress) => void;
	}): Promise<void>;
	/**
	 * Extensions the registered language backends can parse, e.g. `[".ts", ".php"]`.
	 * Single source of truth: the file scanner and the freshness watcher both ask
	 * here instead of keeping their own hardcoded lists.
	 */
	indexableExtensions(): string[];
	sync(): Promise<{ added: string[]; modified: string[]; removed: string[] }>;
	syncFiles(
		events: WatchEvent[],
	): Promise<{ added: string[]; modified: string[]; removed: string[] }>;
	close(): void;
}

/** Progress event emitted by a full index operation. */
export interface IndexProgress {
	phase: "scan" | "parse" | "resolve" | "done";
	current: number;
	total: number;
	file?: string;
}

export class AstrographError extends Error {
	code: string;

	constructor(message: string, code = "ASTROGRAPH_ERROR") {
		super(message);
		this.name = new.target.name;
		this.code = code;
	}
}

export class NotInitializedError extends AstrographError {
	constructor(message = "Astrograph is not initialized") {
		super(message, "NOT_INITIALIZED");
	}
}

export class LockUnavailableError extends AstrographError {
	constructor(message = "Astrograph lock is unavailable") {
		super(message, "LOCK_UNAVAILABLE");
	}
}

export class ExtractionFailedError extends AstrographError {
	filePath: string;

	constructor(filePath: string, message = `Extraction failed for ${filePath}`) {
		super(message, "EXTRACTION_FAILED");
		this.filePath = filePath;
	}
}

export class StorageError extends AstrographError {
	constructor(message = "Storage operation failed") {
		super(message, "STORAGE_ERROR");
	}
}

/**
 * The index on disk was written by a build this binary cannot understand.
 *
 * The index format is disposable (contracts §12.4), so the answer is always a
 * rebuild — never a best-effort open. Reading rows whose meaning has changed
 * would make the graph lie with a clean coverage banner, which is the one
 * failure mode Astrograph must not have.
 */
export class IncompatibleIndexError extends AstrographError {
	/** Schema version found in the database. */
	readonly found: number;
	/** Highest schema version this binary knows how to read. */
	readonly supported: number;

	constructor(found: number, supported: number) {
		super(
			`This .astrograph index was written by a newer Astrograph (schema v${found}); this binary supports up to v${supported}. ` +
				"Upgrade Astrograph, or delete .astrograph/graph.db and re-run `astrograph index` to rebuild. Your project source is never modified by either.",
			"INCOMPATIBLE_INDEX",
		);
		this.found = found;
		this.supported = supported;
	}
}
