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

/** Truly open: any string a registered backend reports. Stored as free TEXT (graph-model §9). */
export type Language = string;
/** The languages a shipped backend actually covers today. Advisory only — never used to narrow `Language`. */
export type KnownLanguage = 'typescript' | 'tsx' | 'javascript' | 'jsx' | 'php';

export type ResolutionState = 'resolved' | 'external' | 'unresolved' | 'ambiguous';
export type Confidence       = 'high' | 'medium' | 'low';
export type Provenance       = 'tree-sitter' | 'ts-compiler' | 'heuristic' | `synthesized:${string}`;  // tree-sitter Pass A, enricher, or synthesized
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
  metadata?: Record<string, unknown>;   // escape hatch (graph-model §9).
                                        // `metadata.provenance: Provenance` is where NODE-level
                                        // provenance lives — there is no `provenance` column on
                                        // `nodes`. (Edges do have a real `provenance` column.)
  updatedAt: number;          // epoch ms
}

export interface Edge {
  id?: number;                // storage rowid; absent before insert
  source: string;             // always a real project node id
  target: string | null;      // null when unresolved, OR when external and the
                              // declaration is not persisted as a node (TS default
                              // libs / paths outside the project root — graph-model §5/§6)
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
  target: string | null;      // same null cases as Edge.target (unresolved, or
                              // external without a persisted node — graph-model §6)
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

/** Pass A output. Structural only — no cross-file resolution. */
export interface PassAResult {
  nodes: Node[];
  edges: Edge[];
  errors: ExtractionError[];
}

/** Pass A: structural extraction via tree-sitter. Per-file, pure, no I/O. */
export interface Parser {
  /** Parse source → nodes + structural edges (file reaches state='parsed'). */
  extractNodes(filePath: string, source: string): PassAResult;
}

/**
 * How a backend's enricher blends with Pass A:
 * - `complement` — Pass A emits a conservative SUBSET; the enricher reconciles by node id,
 *   enriches matches in place, and adds its own nodes (§5.1).
 * - `replace`     — enricher output supersedes Pass A for the relationships it covers.
 * - `none`        — no enricher runs; tree-sitter output is final (e.g. PHP).
 */
export type EnricherMode = 'complement' | 'replace' | 'none';

export interface EdgeResolutionResult {
  edges: Edge[];
  errors: ExtractionError[];
  externalNodes: Node[];
  /** Enricher-supplied project nodes (reconciled against Pass A by id — §5.1). */
  nodes?: Node[];
}

/** Pass B: language-specific semantic enrichment (e.g. TS Compiler for JS/TS). */
export interface Enricher {
  readonly mode: EnricherMode;
  /** Load whatever cross-file program the enricher needs (optional; `none`-mode backends omit it). */
  loadProject?(opts: LoadProjectOptions): void;
  /** Resolve one file's references into edges (+ external/enricher-only nodes). */
  resolveEdges(filePath: string): EdgeResolutionResult;
}

/** A registered language backend: tree-sitter parser + optional enricher. */
export interface BackendCapabilities {
  edgeKinds: EdgeKind[];          // edge kinds this backend can emit
}

export interface LanguageBackend {
  id: string;                 // registry key, e.g. 'typescript', 'php'
  languages: Language[];      // languages this backend claims
  extensions: string[];       // '.ts', '.tsx', '.php' — how files are routed to it
  parser: Parser;
  enricher?: Enricher;
  capabilities: BackendCapabilities;
  /** Extraction identity: grammar/enricher versions folded into `project_metadata.configHash`. */
  versionKeys(): Record<string, string>;
}
```

### 5.1 `complement` mode — the reconciliation rule (normative)

`complement` is the mode the **TypeScript backend ships with**, and it is the only place the two
passes can disagree, so the rule is exact:

- **Pass A emits a conservative subset.** Every node it emits must have a **byte-identical id** to the
  one the enricher would compute for the same declaration — same `project·filePath·kind·qualifiedName·locator`
  (§4). Pass A also emits its `contains` edges, with `provenance: 'tree-sitter'`.
- **Where Pass A cannot guarantee that id, it emits nothing.** Function overloads (locator = signature
  hash the enricher computes) and the ambiguous `component`-vs-`function` JSX call are the two known
  cases: tree-sitter deliberately stays silent and lets the enricher supply the node.
- **Pass B reconciles BY NODE ID.** A matched node is **enriched in place** — the id never churns as a
  file moves `parsed → resolved`. An enricher-only node is added. A **Pass-A-only node** (present after
  Pass A, absent from Pass B) is a **bug**: it is counted and reported, not silently kept or dropped.
- Node-level provenance is recorded in `Node.metadata.provenance`; edge-level provenance is the real
  `edges.provenance` column. **Neither requires a SQL schema change.**

`none` mode (PHP today) skips all of the above: Pass A's nodes and edges are the final answer for that
file, and the file still reaches `resolved` (graph-model §6).

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

export interface CallersInput extends Scoped { symbol: string; limit?: number; includeExternal?: boolean; }
export type   CallersOutput = { caller: NodeRef; callSite: EdgeRef }[];

export interface CalleesInput extends Scoped { symbol: string; limit?: number; includeExternal?: boolean; }
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

/** One registered language backend, as reported by `status`. */
export interface BackendStatus {
  id: string;                            // 'typescript', 'php'
  languages: string[];
  extensions: string[];
  versions: Record<string, string>;      // from LanguageBackend.versionKeys() — grammar + enricher versions
  enricher: EnricherMode;                // 'none' when the backend has no enricher
  capabilities: BackendCapabilities;     // edge kinds this backend can produce
  grammarsLoaded: string[];              // grammars loaded and ready this session
  grammarsUnavailable: { lang: string; reason: string }[];  // declared but unloadable — degrade, never throw
}
// `grammarsUnavailable` is the honest answer to "why is my file missing?" — a backend whose grammar
// failed to load degrades to indexing nothing for that language, it never aborts the index.

export interface StatusOutput {
  nodeCount: number; edgeCount: number; fileCount: number;
  nodesByKind: Record<string, number>;
  edgesByKind: Record<string, number>;
  filesByLanguage: Record<string, number>;
  coverage: Coverage;
  pendingSync?: string[];
  dbSizeBytes: number; lastUpdated: number;
  backend: string; journalMode: string;   // storage backend ('sqlite') + journal mode — NOT language backends
  backends?: BackendStatus[];             // the registered language backends
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
  syncFiles(events: WatchEvent[]): Promise<{ added: string[]; modified: string[]; removed: string[] }>;
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
  include?: string[];          // default: every file under root whose extension a registered
                               // backend claims (LanguageBackend.extensions)
  exclude?: string[];          // added to .gitignore-derived ignores
  maxFileSizeBytes?: number;   // default 2_000_000; larger files skipped (recorded)
  kinds?: NodeKind[];          // optional allow-list of kinds to index
  watchDebounceMs?: number;    // default 2000, clamp [100, 60000]
  tsconfigPath?: string;       // override primary config discovery (TypeScript backend only)
  /** Per-backend switches, keyed by LanguageBackend.id ('typescript', 'php', …). */
  backends?: Record<string, {
    enabled?: boolean;         // default true — false skips the backend entirely (its files aren't indexed)
    enricher?: boolean;        // default true — false runs Pass A only, as if mode were 'none'
  }>;
}
```

Turning an enricher off is **honest, not lossy**: the affected files still reach `resolved` with
tree-sitter-provenance edges (graph-model §6), they just lose semantic depth. Changing `backends`
changes `project_metadata.configHash` → affected coverage is marked stale (graph-model §8).

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
- Data model: [docs/graph-model.md](graph-model.md) · Tools: [docs/tools.md](tools.md) · Extraction: [docs/extraction/overview.md](extraction/overview.md) (Pass A: [tree-sitter.md](extraction/tree-sitter.md), Pass B: [typescript.md](extraction/typescript.md)) · Tests/golden: [docs/testing.md](testing.md).
