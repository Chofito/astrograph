# Canonical contracts (types)

> 🌐 Languages: **English** (this file) · _ES mirror pending (see backlog)_

> **Single source of truth.** These TypeScript interfaces are the contract every implementer (and every coding model) must use verbatim. When code and prose disagree, **these types win**. They live in `packages/core/src/types.ts` (and `.../contracts.ts` for tool I/O). Derived from [docs/graph-model.md](graph-model.md) and [docs/tools.md](tools.md).
>
> Rule: **the core never imports `bun:*`.** Everything platform-specific is an adapter interface (§5), injected.

---

## 1. Enums (open unions)

`NodeKind` and `EdgeKind` are string unions in TS but stored as free `TEXT` (graph-model §9) — adding a kind does not require a migration. Keep the union as the *known* set; unknown strings are tolerated by storage.

```ts
export type NodeKind =
  | 'file' | 'module' | 'class' | 'interface' | 'function' | 'method'
  | 'property' | 'field' | 'variable' | 'constant' | 'enum' | 'enum_member'
  | 'type_alias' | 'namespace' | 'parameter' | 'import' | 'export'
  | 'component';                       // JSX component (heuristic)

export type EdgeKind =
  | 'contains' | 'calls' | 'imports' | 'exports' | 'extends' | 'implements'
  | 'references' | 'type_of' | 'returns' | 'instantiates' | 'overrides'
  | 'decorates';

export type Language = 'typescript' | 'tsx' | 'javascript' | 'jsx';

export type ResolutionState = 'resolved' | 'external' | 'unresolved' | 'ambiguous';
export type Confidence       = 'high' | 'medium' | 'low';
export type Provenance       = 'ts-compiler' | 'heuristic' | `synthesized:${string}`;
export type CoverageState    = 'pending' | 'parsed' | 'resolved';
export type Visibility       = 'public' | 'private' | 'protected' | 'internal';
```

## 2. Core graph types

```ts
export interface Range {
  startLine: number;   // 1-indexed
  endLine: number;     // 1-indexed
  startColumn: number; // 0-indexed
  endColumn: number;   // 0-indexed
}

export interface Node {
  id: string;                 // §4 — stable composite hash
  project: string;            // scope key; 'root' in V1 (graph-model §8)
  kind: NodeKind;
  name: string;
  qualifiedName: string;      // e.g. "src/auth/service.ts::AuthService.login"
  filePath: string;           // repo-relative, '/'-normalized
  language: Language;
  range: Range;
  signature?: string;
  docstring?: string;
  visibility?: Visibility;
  isExported: boolean;
  isAsync: boolean;
  isStatic: boolean;
  isAbstract: boolean;
  isExternal: boolean;        // from node_modules/.d.ts (graph-model §5)
  isGenerated: boolean;       // .generated.ts / .gen.ts / …
  isTest: boolean;
  decorators?: string[];
  typeParameters?: string[];
  metadata?: Record<string, unknown>;   // escape hatch (graph-model §9)
  updatedAt: number;          // epoch ms
}

export interface Edge {
  id?: number;                // storage rowid; absent before insert
  source: string;             // always a real project node id
  target: string | null;      // null when unresolved
  targetName?: string;        // textual ref kept for re-resolution / display
  kind: EdgeKind;
  resolutionState: ResolutionState;
  confidence: Confidence;
  provenance: Provenance;
  line?: number;
  col?: number;
  metadata?: Record<string, unknown>;    // e.g. { candidates: string[] } when ambiguous
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
  severity: 'error' | 'warning';
  code?: string;
}
```

## 3. View types (lightweight, for tool outputs)

```ts
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
  content: string;            // verbatim slice read from disk
}
```

## 4. Node ID

```ts
/** Stable across reindexes; total over overloads/locals/anonymous. graph-model §2. */
export function makeNodeId(input: {
  project: string;
  filePath: string;
  kind: NodeKind;
  qualifiedName: string;
  locator?: string;           // signature-hash | ordinal | enclosing-path; only when needed
}): string;                   // = hash(project·filePath·kind·qualifiedName·locator)
```

## 5. Adapter interfaces (the seams — core depends only on these)

```ts
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
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

export interface Hasher { hash(content: string | Uint8Array): string; }

export interface GlobScanner {
  /** Yields repo-relative paths under root, honoring include/exclude + .gitignore. */
  scan(root: string, opts: { include?: string[]; exclude?: string[]; gitignore?: boolean }): AsyncIterable<string>;
}

export type WatchEvent = { type: 'add' | 'change' | 'unlink'; path: string };
export interface Watcher {
  watch(paths: string[], onEvent: (e: WatchEvent) => void, opts?: { debounceMs?: number }): { close(): void };
}

export interface LoadProjectOptions {
  rootPath: string;
  tsconfigPath?: string;
  fileNames?: string[];
  loadNodesForFile?: (filePath: string) => Node[];
}

export interface EdgeResolutionResult {
  edges: Edge[];
  errors: ExtractionError[];
  externalNodes: Node[];
}

export interface EdgeResolver {
  loadProject(opts: LoadProjectOptions): void;
  resolveEdges(filePath: string): EdgeResolutionResult;
}

/** Two-level extraction (graph-model §0 rule 3). Pass A → nodes; Pass B → edges. */
export interface Extractor {
  /** Pass A: parse + collect declarations. No cross-file resolution. */
  extractNodes(filePath: string, source: string): { nodes: Node[]; errors: ExtractionError[] };
  /** Pass B: resolve references for one file into edges, using the program/checker. */
  resolveEdges(filePath: string): EdgeResolutionResult;
}

export interface ProjectExtractor extends Extractor, EdgeResolver {}
```

## 6. Tool I/O (the 10 — see docs/tools.md for behavior)

Every tool returns `ToolResult<T>`.

```ts
export interface Coverage { total: number; resolved: number; parsed: number; pending: number; }
export interface ToolMeta { coverage: Coverage; partial: boolean; pendingFiles?: string[]; notes?: string[]; }
export interface ToolResult<T> { data: T; meta: ToolMeta; }

// shared optional scope on read tools
interface Scoped { projectPath?: string; }

export interface SearchInput extends Scoped { query: string; kind?: NodeKind; lang?: Language; limit?: number; includeGenerated?: boolean; }
export type   SearchOutput = { node: NodeRef; score: number; highlights?: string[] }[];

export interface ContextInput extends Scoped { task: string; maxSymbols?: number; includeCode?: boolean; tokenBudget?: number; }
export interface ContextOutput {
  entryPoints: NodeRef[];
  subgraph: { nodes: NodeRef[]; edges: EdgeRef[] };
  codeBlocks: CodeBlock[];
  inclusionReasons: Record<string, string>;   // nodeId -> why included
  relatedFiles: string[];
  stats: { nodeCount: number; edgeCount: number; fileCount: number; codeBlockCount: number; totalCodeChars: number };
}

export interface TraceInput extends Scoped { from: string; to: string; maxDepth?: number; }
export interface TraceOutput {
  found: boolean;
  hops: { node: NodeRef; via: EdgeRef; body: CodeBlock }[];
  destinationCallees?: NodeRef[];
  endpoints?: { node: NodeRef; body: CodeBlock }[]; // only when !found: from/to endpoints + TO-file siblings
}

export interface CallersInput extends Scoped { symbol: string; limit?: number; }
export type   CallersOutput = { caller: NodeRef; callSite: EdgeRef }[];

export interface CalleesInput extends Scoped { symbol: string; limit?: number; }
export type   CalleesOutput = { callee: NodeRef; callSite: EdgeRef }[];

export interface ImpactInput extends Scoped { symbol: string; depth?: number; includeExternal?: boolean; }
export type   ImpactOutput = { node: NodeRef; distance: number; viaPath: EdgeRef[] }[];

export interface NodeInput extends Scoped { symbol: string; includeCode?: boolean; }
export interface NodeOutput {
  node: NodeRef; docstring?: string;
  callersPreview: NodeRef[]; calleesPreview: NodeRef[];
  code?: CodeBlock;
}

export interface ExploreInput extends Scoped { query: string; maxFiles?: number; }
export interface ExploreOutput { files: { filePath: string; blocks: CodeBlock[] }[]; relationshipMap: EdgeRef[]; }

export interface FilesInput extends Scoped { path?: string; pattern?: string; format?: 'tree' | 'flat' | 'grouped'; includeMetadata?: boolean; maxDepth?: number; }
export interface FileEntry { filePath: string; language: Language; nodeCount: number; coverageState: CoverageState; }
export type   FilesOutput = { format: 'tree' | 'flat' | 'grouped'; entries: FileEntry[] /* tree nests via path */ };

export interface StatusInput extends Scoped {}
export interface StatusOutput {
  nodeCount: number; edgeCount: number; fileCount: number;
  nodesByKind: Record<string, number>;
  edgesByKind: Record<string, number>;
  filesByLanguage: Record<string, number>;
  coverage: Coverage;
  pendingSync?: string[];
  dbSizeBytes: number; lastUpdated: number;
  backend: string; journalMode: string;
}
```

## 7. Core facade

```ts
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
  // lifecycle
  indexAll(opts?: { force?: boolean }): Promise<void>;
  sync(): Promise<{ added: string[]; modified: string[]; removed: string[] }>;
  close(): void;
}
```

## 8. `context` ranking contract (deterministic)

`context` is the product surface and the eval target, so its ranking is **specified, not vibes** — golden tests pin it (docs/testing.md). Score each candidate node and keep the top `maxSymbols` within `tokenBudget`:

```
score = w_fts * bm25_norm           // FTS relevance to the task string
      + w_central * centrality       // in/out degree of the node (normalized)
      + w_export * isExported
      - w_gen * isGenerated
      - w_test * isTest
      + w_prox * proximity           // hops from an entry point (closer = higher)
```

Defaults: `w_fts=1.0, w_central=0.4, w_export=0.3, w_gen=0.5, w_test=0.3, w_prox=0.5`. Traversal expands `contains`,`calls`,`imports`,`extends`,`implements`,`type_of` up to a bounded neighborhood (default 2 hops) from FTS entry points. `inclusionReasons[id]` records the dominant term (e.g. `"fts-match"`, `"called-by:login"`, `"extends:BaseService"`). Ties broken by `(score desc, filePath asc, startLine asc)` for determinism.

## 9. Config (`.astrograph/config.json`)

```ts
export interface AstrographConfig {
  include?: string[];          // default: all JS/TS under root
  exclude?: string[];          // added to .gitignore-derived ignores
  maxFileSizeBytes?: number;   // default 2_000_000; larger files skipped (recorded)
  kinds?: NodeKind[];          // optional allow-list of kinds to index
  watchDebounceMs?: number;    // default 2000, clamp [100, 60000]
  tsconfigPath?: string;       // override primary config discovery
}
```

## 10. Errors

```ts
export class AstrographError extends Error { code: string; }
export class NotInitializedError extends AstrographError {}  // no .astrograph/ → CLI exit 2
export class LockUnavailableError extends AstrographError {}
export class ExtractionFailedError extends AstrographError { filePath: string; }
export class StorageError extends AstrographError {}
```

Parse failures of a single file are **non-fatal**: record an `ExtractionError`, leave the file `parsed` with whatever nodes succeeded (or `pending` with an error), and continue. Never abort a whole index for one bad file.

## 11. References
- Data model: [docs/graph-model.md](graph-model.md) · Tools: [docs/tools.md](tools.md) · Extraction: [docs/extraction.md](extraction.md) · Tests/golden: [docs/testing.md](testing.md).
