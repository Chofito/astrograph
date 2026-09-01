# Canonical contracts (types)

> 🌐 Languages: **English** (this file) · _ES mirror pending (see backlog)_

> **Single source of truth.** These TypeScript interfaces are the contract every implementer (and every coding model) must use verbatim. When code and prose disagree, **these types win**. They live in `packages/core/src/types.ts`, `packages/core/src/config.ts`, and `.../contracts.ts` for tool I/O. Derived from [docs/graph-model.md](graph-model.md) and [docs/tools.md](tools.md).
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
 * The only relationship an enricher may have with Pass A: Pass A emits a conservative
 * SUBSET; the enricher reconciles by node id, enriches matches in place, and adds its
 * own nodes (§5.1). Pass-A-only is `LanguageBackend.enricher === undefined`, not a mode.
 */
export type EnricherMode = 'complement';

/** How `status` presents enrichment. Derived from presence; never selected by a backend. */
export type EnricherStatus = EnricherMode | 'none';

export interface EdgeResolutionResult {
  edges: Edge[];
  errors: ExtractionError[];
  externalNodes: Node[];
  /** Enricher-supplied project nodes (reconciled against Pass A by id — §5.1). */
  nodes?: Node[];
}

/** Pass B: language-specific semantic enrichment (e.g. TS Compiler for JS/TS). */
export interface Enricher {
  readonly mode: EnricherMode;                 // always 'complement'
  readonly id: string;                         // producing enricher, for evidence
  /** Stamped on this enricher's reconciled nodes. The indexer never infers it. */
  readonly provenance: Provenance;
  /** Load whatever cross-file program the enricher needs (optional). */
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

`LanguageRegistry` rejects a backend at construction (`BackendRegistrationError`) when ids or
extensions collide, when `capabilities.edgeKinds` is empty, duplicated, unknown, or omits
`contains` (Pass A always runs), or when a backend without an enricher advertises
enricher-only edge kinds. The registry also folds `extraction:contract` into `versionKeys()`,
so narrowing this contract rebuilds pre-existing indexes instead of mixing row generations.

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

PHP currently uses `complement` mode but contributes semantic edges only, so Pass A remains the
authoritative PHP node set and no PHP node reconciliation occurs. `none` mode is the behavior of any
backend whose enricher is absent or disabled: Pass A is the final answer and the file still reaches
`resolved` (graph-model §6).

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
  enricher: EnricherStatus;              // 'none' when the backend has no enricher
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

`context` is the product surface and the eval target, so its ranking is **specified, not vibes**. The formula below is normative target behavior; current golden coverage does not yet pin the complete pipeline (see [testing and evaluation](architecture/operations/testing-and-evaluation.md) and `DEV-014`). Score each candidate node and keep the top `maxSymbols` within `tokenBudget`:

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
  include?: string[];          // default: every extension claimed by an enabled backend
  exclude?: string[];          // default: [] ; added to .gitignore-derived ignores
  maxFileSizeBytes?: number;   // default: 2_000_000; integer 1..1_073_741_824
  watchDebounceMs?: number;    // default: 300; integer 0..60_000, operational only
  tsconfigPath?: string;       // optional non-empty project-relative TS config path
  /** Per-backend switches, keyed by LanguageBackend.id ('typescript', 'php', …). */
  backends?: Record<string, {
    enabled?: boolean;         // default true — false skips the backend entirely (its files aren't indexed)
    enricher?: boolean;        // default true — false runs Pass A only, as if mode were 'none'
  }>;
}
```

`parseAstrographConfig(input, { knownBackendIds })` in `@astrograph/core` is the
side-effect-free canonical parser. It returns either `{ ok: true, config,
diagnostics: [] }` with defaults applied, or `{ ok: false, diagnostics }`. Every
diagnostic has a stable `code`, an RFC 6901 JSON Pointer `path` (the root is
`""`), and a message. Unknown top-level keys, unknown backend IDs, and unknown
backend override keys are errors. In particular, `kinds` is no longer supported:
existing configs must remove it rather than relying on an ignored filter.

Normalized `include`/`exclude` lists are de-duplicated and sorted; project-relative
paths use `/`. The semantic config identity contains include/exclude, size,
TypeScript path, and backend switches, but deliberately excludes
`watchDebounceMs`.

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

### 10.1 Diagnostic taxonomy (trust, not lifecycle)

`FileRecord.state` (`pending` | `parsed` | `resolved`) is **lifecycle only**: how far the pipeline
got. It never means "this answer is complete". A file can be `resolved` and still be missing
content, for example when its grammar was unavailable.

Trust is carried by `ExtractionError.code`. **The code is the contract; the message is for
humans and must never be parsed.** Every code is classified by the versioned, exhaustive
registry in `packages/core/src/diagnostics.ts`:

```ts
type DiagnosticCategory =
  | 'coverage_gap'          // content that should be in the graph is missing or partial
  | 'semantic_uncertainty'  // the content exists; a relationship could not be proven
  | 'configuration'         // configuration or environment kept the work from happening
  | 'diagnostic';           // internal defect evidence, no completeness cost
```

| Code | Category | Degrades completeness |
|---|---|---|
| `PARSE_ERROR` | `coverage_gap` | yes |
| `TREE_SITTER_PARSE_ERROR` | `coverage_gap` | yes |
| `RESOLVE_ERROR` | `coverage_gap` | yes |
| `PHP_CALL_UNRESOLVED` | `semantic_uncertainty` | yes |
| `FILE_TOO_LARGE` | `configuration` | yes |
| `NO_BACKEND` | `configuration` | yes |
| `TREE_SITTER_UNAVAILABLE` | `configuration` | yes |
| `TREE_SITTER_GRAMMAR_MISSING` | `configuration` | yes |
| `PASS_A_NODE_DROPPED` | `diagnostic` | no |
| every `ConfigDiagnosticCode` | `configuration` | no |

`degradesCompleteness` is a separate axis from `category` on purpose. `PASS_A_NODE_DROPPED` is a
real backend defect that costs the user nothing, because the Pass A row is kept. A configuration
exclusion is not a defect, but it does hide content. Whether a gap actually reaches a given query
is the query domain's decision, not this table's.

`DIAGNOSTIC_REGISTRY_VERSION` participates in index identity, so re-categorizing a code rebuilds
rather than leaving persisted rows meaning something else. An unregistered code read from an index
written by another build is reported as `diagnostic` and never counts as complete coverage.

Storage exposes the two axes separately: `getCoverage()` for lifecycle,
`getFilesWithCoverageGap()`, `getFilesWithDiagnosticCategory()`, and `getDiagnosticCounts()` for
trust. `status` returns both.

Parse failures of a single file are **non-fatal**: record an `ExtractionError`, leave the file `parsed` with whatever nodes succeeded (or `pending` with an error), and continue. Never abort a whole index for one bad file.

## 11. References
- Data model: [docs/graph-model.md](graph-model.md) · Tools: [docs/tools.md](tools.md) · Extraction: [docs/extraction/overview.md](extraction/overview.md) (Pass A: [tree-sitter.md](extraction/tree-sitter.md), Pass B: [typescript.md](extraction/typescript.md)) · Tests/golden: [docs/testing.md](testing.md).

## 15. Completeness domains

`ToolMeta.partial` is evaluated over the query's **completeness domain**, not over the files the
payload happened to return. Scoping to the payload is circular: a reverse lookup that finds
nothing returns no files, so it would report complete coverage over the empty set and present
"nothing calls this" with `partial: false`.

| Domain | Tools | Completeness rule |
|---|---|---|
| `global_discovery` | `search`, `context`, `explore` | any file may qualify; project coverage decides |
| `global_reverse` | `callers`, `impact`, `getNode` previews | any file may hold an incoming relation |
| `global_path` | `trace` | any file may hold a hop; a negative answer is `truncated` by `maxDepth` |
| `local_outgoing` | `callees` | only the source's own file and its own backend |
| `explicit_scope` | `files` | coverage over the selected membership |
| `descriptive` | `status` | reports global state instead of hiding it behind partiality |

Causes are structured, so a consumer never parses prose:

```ts
type PartialReasonKind =
  | 'coverage_incomplete'      // files unresolved, or resolved with a §10.1 coverage gap
  | 'capability_unsupported'   // a backend that could originate the relation cannot emit it
  | 'search_truncated'         // a limit cut the search short
  | 'semantic_uncertainty';    // a relation exists but its target is unproven

interface PartialReason { kind: PartialReasonKind; detail: string; files?: string[] }
```

Rules:

- **A `resolved` file with a coverage gap (§10.1) still makes a global answer partial.** Lifecycle completion is not trust.
- Incoming questions evaluate every backend that owns files in this project; outgoing questions evaluate only the source's backend.
- **A backend with no eligible files penalizes nothing.** Disabling PHP in a pure TypeScript repository must not degrade every `callers` result.
- `notes` mirrors `reasons` in order, so CLI and MCP render identical facts from one source.
- Reasons are sorted deterministically: coverage, capability, semantic, truncation.

## 14. Invalidation is backend-owned

Core never decides that two symbols are the same. When files change it supplies facts and asks
each backend which of *its own* files must be resolved again.

```ts
interface InvalidationInput {
  added: readonly string[];
  modified: readonly string[];
  removed: readonly string[];
  /** Identities captured BEFORE deletion; afterwards the evidence is gone. */
  priorIdentities: readonly PriorIdentity[];
  configurationChanged: boolean;
  /** Files holding recorded edges into this file. Never name similarity. */
  dependentsOf(filePath: string): string[];
  dependenciesOf(filePath: string): string[];
}

interface InvalidationResult {
  resolveFiles: readonly string[];
  notes?: readonly ExtractionError[];
}
```

Rules:

- **No production code may promote an edge using only `node.name` or `targetName`.** Storage offers no lookup from a target name to edges, so the behavior cannot be rebuilt by accident.
- Core filters `resolveFiles` through membership and ownership. A backend that returns another language's paths gets them dropped; ownership is enforced, not trusted.
- TypeScript derives dependents from module and type semantics; PHP from FQNs, `use` aliases, inheritance, and known types. Neither may return a path it does not own.
- A backend that cannot prove a single target leaves the edge `unresolved` or `ambiguous`. That is a correct answer, not a failure.
- Omitting `invalidate` selects a conservative default: the changed files the backend owns plus the files holding recorded edges into them.

Consequence worth stating plainly: adding a declaration named `laterFn` somewhere no longer
resolves an unproven `laterFn()` call elsewhere. Only a real module or name-resolution
relationship does, and the owning backend decides.

## 13. Index membership

One classification decides which files belong to the graph and which backend owns each. It is
computed once per pass and read by the scanner boundary, `indexAll`, `sync`, `syncFiles`,
`loadProject`, Pass A, both Pass B phases, and coverage.

```ts
type EligibilityReason =
  | 'out_of_scope'       // the scanner did not yield it: include/exclude/.gitignore
  | 'no_backend'         // no registered backend claims the extension
  | 'backend_disabled'   // a shipped backend claims it, configuration turned it off
  | 'too_large'          // over maxFileSizeBytes
  | 'missing';           // could not be stat'ed

interface IndexEligibility {
  path: string;
  backendId?: string;
  language?: Language;
  eligible: boolean;
  reason?: EligibilityReason;
  size?: number;
}
```

Rules:

- **A non-eligible path never reaches `extractNodes`, `loadProject`, `resolveEdges`, or reconciliation.** An oversized file is evidence, not input.
- The scanner owns `include`/`exclude`/`.gitignore`; membership records the outcome as `out_of_scope` rather than re-implementing the matching. Two matchers would be two definitions.
- `backend_disabled` is distinguished from `no_backend` because "PHP is turned off" is actionable and "nothing reads .php" is not.
- Membership is sorted by path throughout and never depends on backend registration order or SQLite row order.
- `out_of_scope` produces no file record: the project simply does not contain the file, and a row would make the graph claim knowledge of it.
- `too_large`, `no_backend`, and `backend_disabled` produce a record carrying `FILE_TOO_LARGE` or `NO_BACKEND`, which §10.1 classifies as coverage-degrading.

## 12. Release identity and compatibility

The current cut is **`v0.1.0` public preview**, not `v1.0.0`. One SemVer value identifies the tag, the release, the binary's `--version`, the stamped package manifests, the `CHANGELOG.md` entry, and this documentation snapshot. `ROADMAP.md` §0 states the same thing; if they ever disagree, `ROADMAP.md` wins on scope and this section wins on surfaces.

### 12.1 Public preview surfaces

Changes here are deliberate, documented, and get a `CHANGELOG.md` entry:

- CLI command names, required positional arguments, documented flags, exit-code categories, and the JSON `ToolResult` envelope (§6).
- MCP tool names, input schemas, structured result semantics, and project-root behavior.
- `.astrograph/config.json` fields, defaults, validation diagnostics, and invalidation meaning (§9).
- The graph vocabulary users see: `NodeKind`, `EdgeKind`, `ResolutionState`, `Confidence`, `Provenance`, and the meaning of coverage and partiality (§1–§3).
- The supported JS/TS and PHP extension and capability matrix, within documented static-analysis limits.
- Install, uninstall, and upgrade behavior on the supported macOS/Linux architecture matrix.
- The rule that project source stays local and is never modified by indexing.

### 12.2 Experimental — may change without a major bump

- Ranking weights and result ordering beyond the deterministic tie-breaks in §8.
- Performance work that preserves output semantics.
- Tool options explicitly labelled experimental.

### 12.3 Internal — not a public contract

- The SQLite schema, its indexes, the FTS implementation, internal row IDs, and the `.astrograph` lock and daemon metadata formats.
- The `@astrograph/*` TypeScript packages. They are `private` workspace source, not a published SDK. Importing them is unsupported.
- `LanguageBackend`, `Parser`, `Enricher`, and reconciliation internals (§5). They are documented so the system is navigable, not so third parties can ship a backend against a frozen shape; that would need its own decision.

### 12.4 Compatibility rules

| Release | May do |
|---|---|
| Patch | fix incorrect edges or ranking while preserving the schema and every public preview surface |
| Minor | add optional fields, tools, node/edge kinds, or language capability. Consumers must ignore additive fields they do not know |
| Major | remove or rename public fields, commands, tools, or config keys, or change their meaning |

Two rules apply at any level:

- **The index format is disposable.** The SQLite schema and the extraction identity (`LanguageRegistry.versionKeys()`, including `extraction:contract`) may change in any release. The binary must detect incompatibility and rebuild or refuse — it must never read incompatible rows as current. See [distribution §index compatibility](architecture/operations/distribution.md#index-compatibility-upgrade-and-rollback).
- **Removing a wrong edge is a fix, not a break.** Dropping a previously `resolved` edge because it was incorrect is a correctness fix. It gets a changelog entry when material, not a major bump.
