# Graph & DB model

> 🌐 Languages: **English** (this file) · _ES mirror pending (see backlog)_

> Design document. The full data model behind Astrograph's graph: tables, columns, IDs, indexes, resolution states, coverage, incremental sync, and the extensibility playbook. It is **derived from the 10 tools** ([docs/tools.md](tools.md)), **enriched for future tools**, and **built to extend without painful migrations**. Expands [ROADMAP §3](../ROADMAP.md#3-graph-model-data-contract).

---

## 0. Design philosophy (the strong logic)

Five rules that every decision below obeys:

1. **Derive from the tools.** Every column and index earns its place by serving a query in [docs/tools.md](tools.md). No speculative structure (the JSON `metadata` escape hatch is the *only* exception, and it is deliberate — §9).
2. **Nodes are identity; edges & coverage are derived.** A node's `id` is the one durable thing. Edges, FTS rows, and coverage are recomputable from source + nodes — so reindexing/migrations never have to preserve them.
3. **Two extraction levels are first-class data** (`parsed` = nodes exist, `resolved` = edges exist). This is what makes progressive indexing possible ([docs/progressive-indexing.md](progressive-indexing.md)).
4. **Honesty is stored, not inferred at the end.** `resolutionState`, `confidence`, and `provenance` live on the edge. Real JS/TS has `any`, dynamic `import()`, CommonJS, broken aliases, generated code — the model records that uncertainty instead of pretending.
5. **Open enums + one JSON escape hatch = extension without migration.** Node/edge `kind` are `TEXT`, not `CHECK`-constrained. New kinds (`route`, `component`, `channel`) and new per-row attributes land with zero schema change.

A corollary: **everything a tool needs is an index lookup, never a table scan.** §3 proves it tool-by-tool.

---

## 1. Entities at a glance

| Table | Holds | Lifecycle |
|---|---|---|
| `nodes` | Code symbols (functions, classes, types…) + lightweight **external** symbols | Durable identity; re-extracted per file |
| `edges` | Relationships (contains, calls, imports, extends…), incl. unresolved/external/ambiguous | Derived; recomputable |
| `files` | Tracked source files + **coverage state** + content hash | Per-file delta unit |
| `nodes_fts` | FTS5 mirror of node text (name, qname, docstring, signature) | Trigger-synced from `nodes` |
| `project_metadata` | Root path, config hashes, TS version, schema version, timestamps | Project-level invalidation |
| `schema_versions` | Applied migrations | Append-only |

No separate `unresolved_refs` table (codegraph has one) — unresolved/external/ambiguous references are **folded into `edges`** as states (§6). That keeps re-resolution a single-table operation and avoids a second-pass pipeline.

---

## 2. Node identity (`nodes.id`)

The ID must be **stable across reindexes** (so incremental sync and the 3D constellation don't churn) yet **unique** for tricky JS/TS shapes (overloads, locals, assigned anonymous functions). ROADMAP §11 flags this explicitly.

```
id = hash(project · filePath · kind · qualifiedName · locator)
```

- `project` — scope key (default `"root"`; see §8 monorepo extensibility).
- `filePath` — repo-relative, normalized to `/`.
- `kind` — disambiguates a class vs an interface of the same name.
- `qualifiedName` — `module/path::Outer.method` style (TS gives us the symbol chain).
- `locator` — **only present when needed**:
  - **overloads** (same qname+kind): signature hash, or declaration ordinal.
  - **anonymous assigned** (`const f = () => …`): use the binding name as `qualifiedName`; locator empty.
  - **truly anonymous / local**: enclosing-symbol path + ordinal. These are inherently less stable across edits → emit with lower edge `confidence` for stability-sensitive consumers.

`hash` = `Bun.hash` (wyhash) behind the `Hasher` adapter, so the ID policy is swappable.

> **Why a composite, not just `filePath::qualifiedName`** (codegraph's scheme): that collides on overloads and can't address locals. The extra `kind` + `locator` make IDs total over real JS/TS without a second lookup.

---

## 3. Requirements matrix — every tool, what the DB must serve

This is the load-bearing section: the schema is the *union* of these needs.

| Tool | Primary read | DB capability it forces |
|---|---|---|
| `search` | FTS over names | `nodes_fts` (bm25); filter indexes on `kind`, `language`, `file_path`; `is_generated`/`is_test`/`is_exported` flags for ranking |
| `context` | search → bounded k-hop traversal → slice | `(source,kind)` + `(target,kind)` edge indexes; node `range` for slicing; node line-span for token budgeting; `coverage` of touched files |
| `trace` | BFS `from`→`to` over call/dispatch edges | both edge-direction indexes across kinds `calls`,`references`,`implements`,`overrides`; node `range` for inlining bodies |
| `callers` | reverse edges into a symbol | `(target, kind='calls')` index |
| `callees` | forward edges out of a symbol | `(source, kind='calls')` index |
| `impact` | reverse-transitive closure, bounded depth | `(target, kind)` index over `calls`,`references`,`extends`,`implements`,`type_of` |
| `node` | one symbol + immediate trails + body | `id` PK / `lower(name)` index; both edge indexes; `range` |
| `explore` | bag of names → group by file + map | `lower(name)`/FTS lookup; `file_path` index (grouping); edges-within-set; `signature` (collapse redundant impls) |
| `files` | indexed file tree | `files(path, language, node_count, state)`; `path` prefix scan |
| `status` | aggregate counts + coverage + pending | grouped counts on `nodes.kind` / `edges.kind` / `files.language` / `files.state`; `project_metadata` |

Two needs recur and so become **invariants of the schema**:
- **Bidirectional, kind-scoped edge lookup** → composite indexes `(source, kind)` and `(target, kind)`. (Like codegraph, the narrow source-only/target-only indexes are omitted — the composites cover them via left-prefix.)
- **Code slicing on demand** → every node stores its `range`; bodies are read from disk (not stored — §10).

---

## 4. Schema (DDL sketch)

SQLite via `bun:sqlite`, **WAL + FTS5**. Enum-like columns are `TEXT` on purpose (extensibility, §9).

### 4.1 `nodes`
```sql
CREATE TABLE nodes (
  id            TEXT PRIMARY KEY,        -- §2 composite hash
  project       TEXT NOT NULL DEFAULT 'root',  -- §8 monorepo scope
  kind          TEXT NOT NULL,           -- open enum: function|class|interface|…|route|component
  name          TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  language      TEXT NOT NULL,           -- typescript|tsx|javascript|jsx
  -- position (1-indexed lines, 0-indexed cols) — slicing & token budgeting
  start_line    INTEGER NOT NULL,
  end_line      INTEGER NOT NULL,
  start_col     INTEGER NOT NULL,
  end_col       INTEGER NOT NULL,
  -- presentation / ranking
  signature     TEXT,
  docstring     TEXT,
  visibility    TEXT,                    -- public|private|protected|internal
  is_exported   INTEGER NOT NULL DEFAULT 0,
  is_async      INTEGER NOT NULL DEFAULT 0,
  is_static     INTEGER NOT NULL DEFAULT 0,
  is_abstract   INTEGER NOT NULL DEFAULT 0,
  -- classification (fast ranking/filtering; long tail goes in metadata)
  is_external   INTEGER NOT NULL DEFAULT 0,  -- from node_modules/.d.ts (§5/§6)
  is_generated  INTEGER NOT NULL DEFAULT 0,  -- .generated.ts/.gen.ts/… → down-rank
  is_test       INTEGER NOT NULL DEFAULT 0,
  -- structured extras
  decorators      TEXT,                  -- JSON array
  type_parameters TEXT,                  -- JSON array
  metadata        TEXT,                  -- JSON object — the escape hatch (§9)
  updated_at    INTEGER NOT NULL
);
```

### 4.2 `edges`
```sql
CREATE TABLE edges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,             -- always a real project node
  target      TEXT,                      -- NULL when unresolved (§6)
  target_name TEXT,                      -- textual ref kept for re-resolution / display
  kind        TEXT NOT NULL,             -- open enum: contains|calls|imports|extends|…
  resolution_state TEXT NOT NULL DEFAULT 'resolved',  -- resolved|external|unresolved|ambiguous
  confidence  TEXT NOT NULL DEFAULT 'high',           -- high|medium|low
  provenance  TEXT NOT NULL DEFAULT 'ts-compiler',    -- ts-compiler|heuristic|synthesized:<channel>
  line        INTEGER,
  col         INTEGER,
  metadata    TEXT,                       -- JSON (e.g. candidates[] for ambiguous)
  FOREIGN KEY (source) REFERENCES nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (target) REFERENCES nodes(id) ON DELETE CASCADE
);
```

### 4.3 `files`
```sql
CREATE TABLE files (
  path         TEXT PRIMARY KEY,
  project      TEXT NOT NULL DEFAULT 'root',
  content_hash TEXT NOT NULL,            -- Bun.hash — delta detection
  language     TEXT NOT NULL,
  size         INTEGER NOT NULL,
  modified_at  INTEGER NOT NULL,
  indexed_at   INTEGER NOT NULL,
  node_count   INTEGER NOT NULL DEFAULT 0,
  state        TEXT NOT NULL DEFAULT 'pending',  -- pending|parsed|resolved (§7)
  errors       TEXT                      -- JSON array of ExtractionError
);
```

### 4.4 `project_metadata`, `schema_versions`
```sql
CREATE TABLE project_metadata (    -- key/value: rootPath, tsVersion, schemaVersion,
  key TEXT PRIMARY KEY,            -- configHash (tsconfig+jsconfig+package.json+lockfile),
  value TEXT NOT NULL,            -- lastFullIndexAt, …  → §8 config invalidation
  updated_at INTEGER NOT NULL
);
CREATE TABLE schema_versions ( version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT );
```

### 4.5 `nodes_fts` (FTS5, external-content)
```sql
CREATE VIRTUAL TABLE nodes_fts USING fts5(
  id UNINDEXED, name, qualified_name, docstring, signature,
  content='nodes', content_rowid='rowid'
);
-- AFTER INSERT/DELETE/UPDATE triggers keep it in sync (same shape as codegraph schema.sql)
```

---

## 5. External symbols (don't index the world, but keep edges whole)

ROADMAP §11: index **only project files** as nodes, but refs into `node_modules`/`.d.ts` must still resolve so `callees`/`context`/`explore` can show "calls `lodash.debounce`".

Decision: when a reference resolves to a non-project file, **lazily create a minimal external node** (`is_external=1`, no body, `range` may be 0) and point the edge at it with `resolution_state='external'`. Benefits:
- Edges stay **uniform** (`target` is always a node id or NULL) — no special-casing in every traversal.
- The FK holds; cascade still works.
- Bounded cost: external nodes only exist for symbols actually referenced, not all of `node_modules`.
- Enriches a future `astrograph_diff`/dependency tool for free.

Tools filter `is_external` when they want project-only results (e.g. `impact` defaults to project scope).

---

## 6. Resolution states (the folded `unresolved_refs`)

Every edge carries `resolution_state`:

| State | `target` | `target_name` | Meaning |
|---|---|---|---|
| `resolved` | node id | — | TypeChecker found exactly one project symbol |
| `external` | external node id (§5) | pkg/symbol | resolves into `node_modules`/`.d.ts` |
| `ambiguous` | best-candidate id | name | multiple candidates; `metadata.candidates=[ids]` |
| `unresolved` | **NULL** | the reference text | dynamic `import()`, `any`, broken alias, not-yet-parsed target |

`confidence` is orthogonal: a `resolved` edge from a `// @ts-ignore`'d call may still be `medium`. Consumers surface non-`high`/non-`resolved` edges in the result `meta.notes` ([docs/tools.md §3](tools.md#3-shared-result-envelope)).

**Why fold instead of a side table:** re-resolution becomes "update rows in `edges`", and tools never join a second table to learn an edge's trustworthiness.

---

## 7. Coverage & progressive indexing

`files.state` is the per-file LOD: `pending → parsed → resolved`. The result envelope's `meta.coverage` is a single grouped query over the touched files:

```sql
SELECT state, COUNT(*) FROM files WHERE path IN (:scope) GROUP BY state;
```

- A tool whose answer only depends on `resolved` files in scope → `partial=false`.
- A global-reverse tool (`callers`, `impact`) is `partial=true` until **every** in-scope file is `resolved` (a caller may hide in a `pending` file) — see [docs/progressive-indexing.md §4](progressive-indexing.md#4-what-works-progressively-and-what-doesnt).

Edge-level coverage (e.g. "nodes done, calls pending") is a Stage 4/5 refinement; the column model already supports it because edges are level-separable from nodes.

---

## 8. Project scope & config invalidation

- **`project` column on `nodes`/`files`/edges-by-join** (default `'root'`) is pre-added now so the Stage 4 monorepo work (per-`tsconfig`) is a *data* change, not a *schema* migration. V1 writes `'root'` everywhere.
- **Config invalidation:** `project_metadata.configHash` = hash of `tsconfig.json`/`jsconfig.json` + `package.json` + lockfile + `.gitignore` + `.astrograph/config.json` + TS version. On `sync`, if it changed, mark affected coverage stale even when source files didn't change (ROADMAP §11). This catches "you upgraded TS / changed paths" cases that pure content hashing misses.

---

## 9. Extensibility playbook

How each kind of growth lands **without breaking the schema**:

| Want to add… | How | Migration? |
|---|---|---|
| A new **node kind** (`route`, `component`, `enum_member`) | write the new `kind` string; tools that care opt in | **No** (open enum) |
| A new **edge kind** (`decorates`, `renders`, `emits`) | write the new `kind`; add an index only if a hot tool needs it | **No** |
| A new **per-node/edge attribute** (rarely queried) | put it in `metadata` JSON | **No** |
| A new **attribute you must filter/sort by** (hot path) | promote to a real column + index | Yes (versioned migration) |
| A new **tool** | compose existing reads; the matrix §3 already covers most | usually **No** |
| A **synthesized edge** (framework routes, future heuristics) | `provenance='synthesized:<channel>'`, `confidence` accordingly | **No** |
| **Monorepo / multi-`tsconfig`** | populate `project` with per-project keys; add per-project coverage | **No** schema change (column exists) |
| A new **language** (post-V1) | new `Extractor` impl. emits the same nodes/edges contract | **No** |
| **Embeddings** (Stage 5, optional) | new `node_vectors` table keyed by `nodes.id` (sqlite-vec/extension), never touches core tables | additive table |

Guardrail: the JSON `metadata` hatch is for the **long tail**, not a dumping ground. If a tool needs to *filter or rank* by something, it gets promoted to a column. Reads stay index-backed (§0 corollary).

---

## 10. Code content strategy: store ranges, read from disk

We store **positions, not source**. `context`/`trace`/`node`/`explore` slice bodies by reading the file (via the `FileSystem` adapter) using `nodes.range`, verifying against `files.content_hash`.

- **Why not store content:** doubles DB size, and risks serving stale code — exactly the dishonesty the model fights. Reading from local disk is cheap (we're local-first).
- **Drift handling:** if the file's live hash ≠ `files.content_hash`, the file is mid-edit → mark the slice `partial` / pending (staleness banner), don't silently return old bytes.
- Optional later: an LRU slice cache in the daemon (memory, not DB) if profiling shows disk reads dominate.

---

## 11. Incremental sync (data-flow contract)

On a file change (`B.ts`):

1. **Delete** `B`'s nodes → `ON DELETE CASCADE` drops their outgoing edges and FTS rows.
2. **Re-extract** `B` → insert nodes (`state='parsed'`), then resolve → insert edges (`state='resolved'`).
3. **Re-resolve incoming referrers** — the subtle part:
   - Edges that *pointed into* `B` and are now wrong: found via the `(target,kind)` index joined to `B`'s old node ids.
   - Edges previously `unresolved` whose `target_name` matches a **new** symbol in `B`: found via an index on `edges(resolution_state, target_name)`. This is how a now-existing symbol "heals" earlier unresolved refs — the folded replacement for codegraph's `unresolved_refs` re-scan.
4. **Delete** removed files; **add** new files as `pending`.

Bounded by the change set + its 1-hop referrers, never the whole repo (ROADMAP "linear + deltas").

---

## 12. Index catalog (and the tool each serves)

```sql
-- nodes
CREATE INDEX idx_nodes_kind        ON nodes(kind);            -- status, search filter
CREATE INDEX idx_nodes_name        ON nodes(name);            -- node, explore
CREATE INDEX idx_nodes_lower_name  ON nodes(lower(name));     -- case-insensitive lookup
CREATE INDEX idx_nodes_qname       ON nodes(qualified_name);  -- node, trace endpoints
CREATE INDEX idx_nodes_file        ON nodes(file_path);       -- files grouping, slicing
CREATE INDEX idx_nodes_file_line   ON nodes(file_path, start_line); -- explore ordering
CREATE INDEX idx_nodes_language    ON nodes(language);        -- status, search filter
CREATE INDEX idx_nodes_project     ON nodes(project);         -- §8 scope
-- edges
CREATE INDEX idx_edges_source_kind ON edges(source, kind);    -- callees, context, trace fwd
CREATE INDEX idx_edges_target_kind ON edges(target, kind);    -- callers, impact, trace rev
CREATE INDEX idx_edges_kind        ON edges(kind);            -- status
CREATE INDEX idx_edges_unresolved  ON edges(resolution_state, target_name); -- §11 healing
-- files
CREATE INDEX idx_files_language    ON files(language);        -- status
CREATE INDEX idx_files_state       ON files(state);           -- §7 coverage
```

Deliberately **omitted**: source-only / target-only edge indexes (the composites cover them by left-prefix) and indexes on boolean flags (low selectivity; filtered in the query after an index hit). Fewer indexes = faster writes during indexing.

---

## 13. References
- Tool contract this serves: [docs/tools.md](tools.md).
- Progressive coverage model: [docs/progressive-indexing.md](progressive-indexing.md).
- Roadmap data contract & critical aspects: [ROADMAP §3](../ROADMAP.md#3-graph-model-data-contract), [§11](../ROADMAP.md#11-critical-aspects-not-to-overlook-in-v1).
- codegraph for contrast: [`src/db/schema.sql`](../../codegraph/src/db/schema.sql), [`src/db/queries.ts`](../../codegraph/src/db/queries.ts), [`src/db/migrations.ts`](../../codegraph/src/db/migrations.ts), [`src/types.ts`](../../codegraph/src/types.ts).
