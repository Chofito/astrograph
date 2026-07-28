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

export type Language = string;
export type KnownLanguage = "typescript" | "tsx" | "javascript" | "jsx" | "php";

export type ResolutionState =
	| "resolved"
	| "external"
	| "unresolved"
	| "ambiguous";
export type Confidence = "high" | "medium" | "low";
export type Provenance =
	| "tree-sitter"
	| "ts-compiler"
	| "heuristic"
	| `synthesized:${string}`;
export type CoverageState = "pending" | "parsed" | "resolved";
export type Visibility = "public" | "private" | "protected" | "internal";

export interface Range {
	startLine: number;
	endLine: number;
	startColumn: number;
	endColumn: number;
}

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

export interface ExtractionError {
	message: string;
	filePath?: string;
	line?: number;
	column?: number;
	severity: "error" | "warning";
	code?: string;
}

export interface NodeRef {
	id: string;
	name: string;
	kind: NodeKind;
	qualifiedName: string;
	filePath: string;
	range: Range;
	signature?: string;
}

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

export interface StorageAdapter {
	prepare(sql: string): SqliteStatement;
	exec(sql: string): void;
	transaction<T>(fn: (...a: unknown[]) => T): (...a: unknown[]) => T;
	pragma(s: string, opts?: { simple?: boolean }): unknown;
	close(): void;
	readonly open: boolean;
}

export interface FileSystem {
	readText(path: string): Promise<string>;
	exists(path: string): Promise<boolean>;
	stat(path: string): Promise<{ size: number; modifiedAt: number }>;
}

export interface Hasher {
	hash(content: string | Uint8Array): string;
}

export interface GlobScanner {
	scan(
		root: string,
		opts: { include?: string[]; exclude?: string[]; gitignore?: boolean },
	): AsyncIterable<string>;
}

export type WatchEvent = { type: "add" | "change" | "unlink"; path: string };
export interface Watcher {
	watch(
		paths: string[],
		onEvent: (e: WatchEvent) => void,
		opts?: { debounceMs?: number },
	): { close(): void };
}

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

export interface Parser {
	extractNodes(filePath: string, source: string): PassAResult;
}

/**
 * How a backend's enricher relates to its Pass A parser.
 * - `complement`: Pass A runs, the enricher's node view is reconciled onto it.
 * - `replace`: Pass A is skipped; the enricher is the only source of nodes.
 * - `none`: there is no enricher; Pass A output is the final answer.
 */
export type EnricherMode = "complement" | "replace" | "none";

export interface Enricher {
	readonly mode: EnricherMode;
	loadProject?(opts: LoadProjectOptions): void;
	resolveEdges(filePath: string): EdgeResolutionResult;
}

export interface EdgeResolutionResult {
	edges: Edge[];
	errors: ExtractionError[];
	externalNodes: Node[];
	/** The enricher's authoritative node view for the file, when it has one. */
	nodes?: Node[];
}

export interface LanguageBackend {
	id: string;
	languages: Language[];
	extensions: string[];
	parser: Parser;
	enricher?: Enricher;
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

export interface Coverage {
	total: number;
	resolved: number;
	parsed: number;
	pending: number;
}
export interface ToolMeta {
	coverage: Coverage;
	partial: boolean;
	pendingFiles?: string[];
	notes?: string[];
}
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
	/** Enricher mode; "none" when the backend has no enricher. */
	enricher: EnricherMode;
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
	pendingSync?: string[];
	dbSizeBytes: number;
	lastUpdated: number;
	backend: string;
	journalMode: string;
	/** Active language backends (parser + optional enricher). */
	backends?: BackendStatus[];
}

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

export interface IndexProgress {
	phase: "scan" | "parse" | "resolve" | "done";
	current: number;
	total: number;
	file?: string;
}

export interface AstrographConfig {
	include?: string[];
	exclude?: string[];
	maxFileSizeBytes?: number;
	kinds?: NodeKind[];
	watchDebounceMs?: number;
	tsconfigPath?: string;
	/**
	 * Per-backend overrides keyed by `LanguageBackend.id`.
	 * `enabled: false` drops the backend (its files stop being indexed);
	 * `enricher: false` keeps Pass A but disables Pass B for that backend.
	 */
	backends?: Record<string, { enabled?: boolean; enricher?: boolean }>;
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
