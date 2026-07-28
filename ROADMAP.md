# Astrograph — Roadmap & Scope

> **Local-first code graph** — tree-sitter for broad structural extraction + language-specific enrichers (JS/TS ships with TypeScript Compiler enricher for semantic depth) — exposed through CLI, MCP server, and agent skills. Helps humans and agents understand code fast.
>
> Inspired by [`codegraph`](../codegraph) (which lives next to this repo), but built on **pluggable language backends**: tree-sitter as the structural base, with per-language enrichers for semantic depth. JS/TS is first-class with TS Compiler Enricher. Explicitly not "JS/TS only forever".
>
> 🌐 Languages: **English** (this file) · [Español](ROADMAP.es.md)

This document is the project's **source of truth**. It's built in stages ("vibecoding"), and each stage is prompted separately using this roadmap as context.

---

## 1. Vision and goals

**Astrograph** indexes a code repository into a graph of symbols (functions, classes, types…) and relationships (contains, calls, imports, extends…), stored locally, and exposes it through two product surfaces:

1. **CLI** — for humans and scripts (Stage 1, on top of the Core).
2. **MCP server + agent skills** — for AI agents, which query the graph instead of running grep/Read (Stage 2).

Core + CLI + MCP/Skills are the first complete product version: **V1**. A **promotion & documentation website** (Stage 3) presents and documents the system. Later stages harden and expand the foundation (Stage 4 / v1.5, Stage 5 / v2).

> **Parked:** the integrated **3D "constellation" graph explorer** (an in-app web view that renders the graph in 3D) was the riskiest, lowest-validation surface, so it's been **moved to a feature branch** and deferred out of the V1 line. Its design is preserved in [docs/web.md](docs/web.md); see §13 for where it may land later. Stage 3's "web" is the **promo/docs site**, not this explorer.

**For whom?**
- **AI agents**: answer architecture/flow questions with fewer tokens and fewer tool calls (the graph already did the exploration work).
- **Humans**: understand a new codebase, trace a flow end to end, and gauge impact before refactoring.

**Design principles:**
- **100% local.** Nothing leaves your machine. No API keys, no external services. SQLite only.
- **Performance-friendly.** **~Linear complexity relative to repo size** for extraction; **incremental delta reindexing** as files change.
- **Pluggable language backends.** **tree-sitter** is the structural foundation for broad language support. Per-language **enrichers** (e.g. TS Compiler for JS/TS) add semantic depth where it matters. JS/TS gets the Compiler enricher from day 1; other languages welcome as backends and enrichers land.
- **JS/TS semantic depth first.** With the TypeScript Compiler enricher, JS/TS achieves exact import/call/type resolution; other languages use tree-sitter structural extraction. More enrichers can come later without weakening JS/TS.
- **Single-app repos first.** V1 targets normal separated JS/TS app repos (Next.js, React Native/Expo, NestJS, Strapi). It uses the primary `tsconfig.json` / `jsconfig.json` where possible; formal monorepo, multi-`tsconfig`, and project references support moves to Stage 4 / v1.5.
- **Runtime-decoupled.** Bun-specific bits live behind adapters; the core must not be wedded to Bun.

---

## 2. Architecture decisions

| Topic | Decision | Why |
|---|---|---|
| Runtime + SQLite driver | **Bun + `bun:sqlite`** | Native, fast, supports FTS5/WAL; consistent with the monorepo `CLAUDE.md` |
| Extraction engine | **tree-sitter base + per-language enrichers** | Structural extraction (tree-sitter) broad, fast, deterministic across languages. TS Compiler enricher for JS/TS adds semantic depth (exact resolution, types, inheritance). Open registry for more backends/enrichers. |
| Languages | **JS/TS first with enricher; registry open for more** | JS/TS ships with Compiler enricher (high fidelity). Other languages as tree-sitter backends. Future: enricher per language. |
| Core dependencies | **tree-sitter** + **typescript (enricher only)** + **ignore** | tree-sitter grammars + TS Compiler enricher (when needed) for JS/TS. Bun-specific bits behind adapters. |
| Repo structure | **Monorepo with Bun workspaces** | `packages/core`, `packages/cli`, later `packages/mcp`, `apps/site` |
| Stage 1 scope | **Complete core/CLI for single-app repos** | Graph with `contains/imports/calls/extends/implements/references` + queries `search/context/callers/callees/impact/trace/node/files/status`; primary `tsconfig`/`jsconfig` support |
| CLI | **Hybrid**: classic args + **opentui** | Scriptable/pipe-able one-shot; opentui only for interactive views |
| State | **Hybrid**: SQL + FS | Graph in `.astrograph/graph.db`; runtime/config in `.astrograph/` (config, lock, daemon) |
| MCP (Stage 2) | **Official `@modelcontextprotocol/sdk`** | Less plumbing; focus on the tools |
| Web (Stage 3) | **Promo/docs site (Fumadocs/Next.js)** | Static export to GitHub Pages. NOT the 3D constellation explorer (that's parked on a branch). Reuses `docs/*.md` as source material. |

### Storage
`bun:sqlite` with **WAL + FTS5**. Schema inspired by codegraph (`nodes`, `edges`, `files`, `nodes_fts`, `project_metadata`, `schema_versions`), with one important difference: **we do not need codegraph's heuristic `unresolved_refs` second-pass pipeline**, because semantic enrichers (TS Compiler for JS/TS) resolve most references directly. However, Astrograph still records honest resolution states (`external`, `unresolved`, `ambiguous`) plus edge `confidence`/`provenance`, because real code includes dynamic imports, CommonJS, `any`, broken aliases, generated code, and other gray areas.

### Extraction and incrementality
- **Pass A (tree-sitter structural):** per-file AST walk via tree-sitter grammars. Fast, per-file, produces nodes (`state='parsed'`). All languages use this.
- **Pass B (per-language enrichers):** e.g. TS Compiler API for JS/TS. Optional, enriches edges + type fidelity. Lazy: only files that need semantic depth trigger this pass.
- **Primary project config first:** V1 loads the repo's main `tsconfig.json` or `jsconfig.json` when present, with a sane fallback for JS/TS repos that do not define one.
- We extract symbols with tree-sitter AST walk; we enrich types/imports/calls with the enricher (e.g. `TypeChecker`) **only where needed (lazy)** to bound the cost.
- **Delta detection:** per-file content hash (`Bun.hash`/wyhash) compared against the `files` table. Only changed files are re-extracted, unless project-level inputs changed (`tsconfig`/`jsconfig`, `package.json`, lockfile, `.gitignore`, `.astrograph/config.json`, TypeScript/tree-sitter versions), in which case affected coverage is marked stale.
- **File watcher** with debounce that auto-triggers `sync`.

### Decoupling (key)
Everything runtime-specific goes behind interfaces/adapters:
- `StorageAdapter` — `bun:sqlite` impl. (shape `prepare/run/get/all/exec/transaction/pragma`, à la codegraph's `sqlite-adapter.ts`).
- `LanguageBackend` / `Parser` / `Enricher` — pluggable architecture. Tree-sitter backend + per-language enricher (TS Compiler enricher ships first).
- `FileSystem` / `Hasher` / `Glob` — `Bun.file` / `Bun.hash` / `Bun.Glob` impls.
- `Watcher` — Bun watcher impl.

The core **never imports `bun:*` directly**. Minimal external deps: `tree-sitter` (parser, required), `typescript` (enricher, optional for JS/TS), and `ignore` (.gitignore). Everything else (BFS/DFS/impact/trace traversal, formatters, FTS query parser) is ours.

### Why it satisfies "linear + deltas + pluggable"
- **Extraction** of each file is ~linear in its size (one tree-sitter walk).
- **Full index** is the sum over files → linear in the project's total source code.
- **Sync** only touches changed files (+ their incoming referrers) → cost proportional to the change, not the repo.
- **Enrichers are pluggable** because parsing and enrichment are separable (Pass A, Pass B). Tree-sitter breadth + per-language depth means we don't sacrifice JS/TS fidelity as more languages land.
- ⚠️ Honest caveat: enricher resolution (e.g. TS type-checker) is lazy but can be superlinear in pathological cases (huge recursive types). Mitigations: lazy enrichment, caching, `skipLibCheck`, batching, and metrics.

---

## 3. Graph model (data contract)

We adapt codegraph's types (see [`codegraph/src/types.ts`](../codegraph/src/types.ts)).

**Nodes** (`kind`): `file`, `module`, `class`, `interface`, `function`, `method`, `property`, `field`, `variable`, `constant`, `enum`, `enum_member`, `type_alias`, `namespace`, `parameter`, `import`, `export`, `component`.

Each node: `id`, `kind`, `name`, `qualifiedName`, `filePath`, `language`, position (`startLine/endLine/startColumn/endColumn`), `docstring?`, `signature?`, `visibility?`, flags (`isExported/isAsync/isStatic/isAbstract`), `decorators?`, `typeParameters?`, `updatedAt`.

**Edges** (`kind`): `contains`, `calls`, `imports`, `exports`, `extends`, `implements`, `references`, `type_of`, `returns`, `instantiates`, `overrides`, `decorates`. Each edge: `source`, `target`, `kind`, `metadata?`, `line?`, `column?`, `provenance?` (e.g. `tree-sitter` or `ts-compiler`), `confidence?` (`high|medium|low`), `resolutionState?` (`resolved|external|unresolved|ambiguous`).

**Node `id`:** stable hash derived from `project`, `filePath`, `qualifiedName`, declaration kind, and a stable declaration locator (signature hash/ordinal where needed). It must be **stable across reindexes**, identical between Pass A and Pass B for the same declaration, and robust enough for overloads, local symbols, and assigned anonymous functions (see §11).

**`language`** is a genuinely open string — whatever a registered backend reports — stored as free `TEXT`. Backends shipping today: `typescript` (typescript/tsx/javascript/jsx, with the TS Compiler enricher) and `php` (tree-sitter only). Node-level provenance lives in `metadata.provenance`; on edges it is a real column.

**SQL schema:** based on [`codegraph/src/db/schema.sql`](../codegraph/src/db/schema.sql) — tables `nodes`, `edges`, `files`, virtual `nodes_fts` (FTS5 with sync triggers), `project_metadata`, `schema_versions`. Indexes: by `kind`, `name`, `qualified_name`, `file_path`, `(source, kind)`, `(target, kind)`, `lower(name)`.

> The `files` table includes, from day 1, a **coverage state** column (`pending → parsed → resolved`) that enables Stage 2's progressive indexing. See [docs/progressive-indexing.md](docs/progressive-indexing.md).

> **Full data model** — tables, node-ID policy, indexes, resolution states, coverage, incremental-sync data-flow, and the extensibility playbook (derived from the 10 tools): [docs/graph-model.md](docs/graph-model.md). **Canonical TS interfaces (the verbatim source of truth all implementers import):** [docs/contracts.md](docs/contracts.md).

---

## 4. Stage 1 — Graph + CLI + tests (V1)

Goal: a correct and fast graph for JS/TS and other tree-sitter languages, queryable via CLI, with solid tests. V1 targets separated single-app repos first: Next.js, React Native/Expo, NestJS, Strapi, and similar JS/TS projects.

> **Sequencing recommendation (see §14):** start with a **vertical slice (1.0)** before going broad.

### 1.0 — Vertical slice (first value milestone)
`index → search → context` working end-to-end on **a real repo** (not just fixtures), with an **eval harness** measuring quality against a `grep`/`Read`-style exploration baseline. Answers the question "does this actually help agents use fewer tool calls/tokens and miss less?".

### 1.1 — Scaffolding
Bun monorepo (`packages/core`, `packages/cli`), `tsconfig`, SQLite schema, `StorageAdapter` over `bun:sqlite`, `DatabaseConnection`/`QueryBuilder` layer.

### 1.2 — JS/TS extraction (Pass A + B)
Integrate tree-sitter and TS Compiler API; extract nodes/edges from a file. Respect the repo's primary `tsconfig.json` / `jsconfig.json` where possible. A **fixtures** folder (`packages/core/__fixtures__/`) covering: classes + inheritance, relative and alias imports (`tsconfig paths`), functions / arrow functions, re-exports / barrels, JSX/TSX (components), `async`, decorators, enums, namespaces, default exports, CommonJS. **Exact AST→graph mapping + resolution decision tree:** [docs/extraction/overview.md](docs/extraction/overview.md), [docs/extraction/tree-sitter.md](docs/extraction/tree-sitter.md), [docs/extraction/typescript.md](docs/extraction/typescript.md). **Canonical types:** [docs/contracts.md](docs/contracts.md).

### 1.3 — Resolution
Imports and calls via tree-sitter (Pass A) and enrichers (Pass B, e.g. TS Compiler); path aliases and barrels (`index.ts`) resolved by enrichers natively. Mark refs into `node_modules`/`.d.ts` as **external** (no project nodes created). Track **unresolved** and **ambiguous** references explicitly, and attach `confidence`/`provenance` to edges where resolution is not fully certain.

### 1.4 — Full index + incremental delta sync
`indexAll`, `sync` (added/modified/removed by content hash), file watcher with debounce. On file change: delete its nodes+edges, re-extract, **re-resolve incoming referrers**.
Extraction is designed in **two separable levels** — nodes (`parsed` via Pass A) decoupled from edges (`resolved` via Pass B enrichers) — with a **single-writer model** and an **indexing queue** as an abstraction. In V1 the CLI drains it in a single pass, but these requirements leave the core ready for Stage 2's progressive indexing (see [docs/progressive-indexing.md](docs/progressive-indexing.md)).
Project-level invalidation watches the main config inputs: `tsconfig.json`/`jsconfig.json`, `package.json`, lockfiles, `.gitignore`, `.astrograph/config.json`, and the TypeScript/tree-sitter versions used for extraction.

### 1.5 — Graph queries
BFS/DFS traversal, `search` (FTS5), `callers`, `callees`, `impact`, `trace`, `context` (context builder), `node`, `files`, `status`. The context builder must support token budgets, ranking, bounded neighborhoods, and inclusion reasons so agents receive compact, explainable context rather than a raw graph dump.

### 1.6 — CLI (hybrid)
Classic args parser (`util.parseArgs` from Bun/Node or `commander`). Commands mirroring the UX of [`codegraph/src/bin/codegraph.ts`](../codegraph/src/bin/codegraph.ts):
`init [-i] · uninit · index · sync · status · query · callers · callees · impact · trace · context · files · unlock`.
One-shot commands in **scriptable plain text**; **opentui** reserved for interactive views (live indexing progress, navigable `explore`). The opentui layer stays isolated so command logic isn't coupled to the UI. **Full command catalog + codegraph→astrograph mapping:** [docs/cli.md](docs/cli.md).

### 1.7 — Tests (`bun test`)
Unit tests for extraction and resolution over the fixtures; graph/query tests; an **incremental sync cycle** test (add/modify/delete and verify no dangling edges remain). **Full fixture catalog, golden-snapshot mechanism, and eval harness:** [docs/testing.md](docs/testing.md).
> Note: tests are run by the user, not the agent.

### Acceptance criteria (Stage 1)
- Indexes real separated JS/TS app repos (at least one Next.js, React Native/Expo, NestJS, or Strapi repo) without crashing; reasonable, ~linear timing.
- Uses the primary `tsconfig.json` / `jsconfig.json` where present.
- `search`/`context`/`trace` return correct, compact results verified by the eval harness against a `grep`/`Read` baseline.
- External, unresolved, and ambiguous references are reported honestly.
- `sync` after editing a file reflects the change with no dangling edges.
- CLI usable and scriptable; all tests green (run by the user).

---

## 5. Stage 2 — MCP support

MCP server (`packages/mcp`) on top of the **official `@modelcontextprotocol/sdk`** (stdio transport). **Full server design — decisions, freshness model, install targets, build order:** [docs/mcp.md](docs/mcp.md).

- **Tools** equivalent to codegraph: `astrograph_search/context/callers/callees/impact/trace/node/explore/files/status`. Reference [`codegraph/src/mcp/tools.ts`](../codegraph/src/mcp/tools.ts) and [`server-instructions.ts`](../codegraph/src/mcp/server-instructions.ts) for shape/descriptions — but the protocol plumbing comes from the SDK. **Full transport-agnostic tool contract (inputs, structured results, offline-viability, per-surface formatting):** [docs/tools.md](docs/tools.md).
- **Usage instructions** delivered in the MCP `initialize` (without touching the user's `CLAUDE.md`).
- **Live auto-sync:** watcher + per-file staleness banner + connect-time catch-up (see codegraph's "How auto-syncing works" section in the [codegraph README](../codegraph/README.md)).
- **Honest agent responses:** every tool response surfaces freshness/staleness, basic coverage, `external`/`unresolved`/`ambiguous` references, and edge confidence where relevant.
- **Progressive indexing (streaming / "WoW"-style):** Stage 2 can ship a practical first version for simple repos: the MCP is available quickly, indexes in the background, and every response declares its **coverage/partiality**. The fully mature version for monorepos, per-project queues, LRU eviction, and robust demand boosting is deferred to Stage 5 / v2. **Full design and core requirements:** [docs/progressive-indexing.md](docs/progressive-indexing.md).
- **Commands** `install/uninstall/serve --mcp` and config for Claude Code / Cursor.
- **References:** `modelcontextprotocol.io` (docs + spec) and the TypeScript SDK repo.

### Acceptance criteria (Stage 2)
- An agent (Claude Code) loads the MCP, sees the tools, and answers an architecture question using them.
- Editing a file and asking again reflects the change (auto-sync + staleness banner).
- Responses never present partial, stale, unresolved, or low-confidence results as complete facts.

---

## 6. Stage 3 — Promotion & documentation website

A public-facing **website to present and document** Astrograph — **not** the in-app graph explorer (that's parked; see §1 note and §13). It explains what Astrograph is, why the **tree-sitter structural breadth + enricher semantic depth** is the differentiator, and how to install and use it (CLI + MCP server + agent skills). **Full site design — stack, routes, static deploy, build order:** [docs/site.md](docs/site.md).

- **Two surfaces:** a flashy **landing page** (`/`) + **documentation** (`/docs/*`), one app, one deploy.
- **Stack:** **Fumadocs** on Next.js, **fully static export** deployed to **GitHub Pages** (Orama search runs in the browser, no server). Bun as package manager/runner. Reuses the existing `docs/*.md` as source material. This standalone site is **decoupled from the `astrograph` binary** (the monorepo's Bun.serve/no-Next rule is scoped to the product core).

> The integrated **3D "constellation" graph explorer** is **not** this stage. Its design is preserved in [docs/web.md](docs/web.md) (now a deferred/parked design on a feature branch).

### Acceptance criteria (Stage 3)
- A visitor understands what Astrograph is, how it differs (tree-sitter breadth + enricher depth), and how to install + use the CLI, MCP server, and agent skills — all from the site.
- Install/usage instructions are accurate against the shipped CLI and installer.

---

## 7. Final repo layout (target)

```
astrograph/
├── packages/
│   ├── core/            # graph, DB (adapters), extraction (tree-sitter + enrichers), resolution, queries, traversal
│   │   └── __fixtures__/ # JS/TS test cases
│   ├── cli/             # commands (classic args + isolated opentui)
│   └── mcp/             # MCP server (official SDK)   [Stage 2]
├── apps/
│   ├── site/            # promo + docs website (Fumadocs/Next.js, static → GH Pages)  [Stage 3]
│   └── web/             # 3D explorer (PARKED on a feature branch)
├── docs/
│   ├── contracts.md                                 # canonical TS types (source of truth)
│   ├── extraction/
│   │   ├── overview.md                              # Pass A/B, LanguageBackend, Parser, Enricher
│   │   ├── tree-sitter.md                           # structural extraction, CST→nodes
│   │   └── typescript.md                            # TS Compiler enricher, semantic depth
│   ├── testing.md                                   # fixtures + golden + eval harness
│   ├── cli.md                                       # CLI command catalog & design
│   ├── install.md                                   # curl|sh installer, platforms, checksums
│   ├── mcp.md                                        # MCP server design (Stage 2)
│   ├── site.md                                        # promo + docs website design (Stage 3)
│   ├── web.md                                         # 3D explorer design (PARKED — branch)
│   ├── graph-model.md                               # full graph/DB data model
│   ├── tools.md / tools.es.md                       # agent-facing tool contract
│   ├── progressive-indexing.md      # streaming indexing design (S2) — EN
│   └── progressive-indexing.es.md   # same — ES
├── ROADMAP.md           # EN
├── ROADMAP.es.md        # ES
└── package.json         # Bun workspaces
```

Per-project index directory: **`.astrograph/`** (mirroring `.codegraph/`) → `graph.db`, `config.json`, lockfile, daemon/watcher metadata.

---

## 8. Non-goals (for now)

Frameworks-aware routes · embeddings / vector semantic search · iOS/RN/Expo bridging · formal monorepo/multi-`tsconfig` support in V1 · multi-agent installers beyond the basics. (Several of these are in "future", §13.)

---

## 9. Design references (in `../codegraph`)

| File | What it gives us |
|---|---|
| [`src/types.ts`](../codegraph/src/types.ts) | Node/Edge/Subgraph/Context model |
| [`src/db/schema.sql`](../codegraph/src/db/schema.sql) | SQL schema + FTS5 + indexes |
| [`src/db/sqlite-adapter.ts`](../codegraph/src/db/sqlite-adapter.ts) | DB wrapper pattern (to replicate with `bun:sqlite`) |
| [`src/db/migrations.ts`](../codegraph/src/db/migrations.ts) | Schema versioning/migrations |
| [`src/bin/codegraph.ts`](../codegraph/src/bin/codegraph.ts) | CLI command surface to replicate |
| [`src/mcp/tools.ts`](../codegraph/src/mcp/tools.ts) · [`server-instructions.ts`](../codegraph/src/mcp/server-instructions.ts) | MCP tools and instructions (Stage 2) |
| [`src/sync/`](../codegraph/src/sync) | Incremental sync + watcher + staleness |
| [`src/extraction/`](../codegraph/src/extraction) · [`src/resolution/`](../codegraph/src/resolution) | How they did it with tree-sitter (for contrast) |
| [`src/extraction/generated-detection.ts`](../codegraph/src/extraction/generated-detection.ts) | Generated-file detection |
| [`__tests__/evaluation/`](../codegraph/__tests__/evaluation) | Eval harness model |
| [`README.md`](../codegraph/README.md) | Features, benchmarks, "How auto-syncing works" |

---

## 10. Key differentiator vs codegraph

**Pluggable language backends with semantic enrichers**, not a single parser choice. codegraph uses tree-sitter everywhere and therefore had to build heuristic resolution scaffolding: `path-aliases.ts`, `import-resolver.ts` (~42KB), `name-matcher.ts`, callback/framework synthesizers. Astrograph uses **tree-sitter as the structural base** (breadth across languages) + **per-language enrichers** (semantic depth). For JS/TS, the TS Compiler enricher provides **exact module resolution, types, inheritance, overloads, re-exports/barrels** — much of which is **free and exact**. Expected result: **fewer heuristics, higher fidelity on JS/TS**, and a **clear path for more languages** (add their enricher, keep tree-sitter Pass A the same).

| Dimension | codegraph | astrograph (V1) |
|---|---|---|
| Languages | 20+ | **tree-sitter structural + per-language enrichers (JS/TS first)** |
| Parser | tree-sitter (wasm) | **tree-sitter (Pass A) + enrichers (Pass B, e.g. TS Compiler)** |
| Reference resolution | heuristic + `unresolved_refs` table | **tree-sitter + enricher** (TS Compiler for JS/TS) + honest `external`/`unresolved`/`ambiguous` tracking |
| Path aliases / module res. | hand-reimplemented (limited scope) | **native to enricher** (exact for JS/TS via TS) |
| Runtime / DB | Node + `node:sqlite` | **Bun + `bun:sqlite`** |
| MCP | custom transport/daemon | **official SDK** |
| Frameworks-aware routes | yes (14 frameworks) | **out of V1** (re-addable on top of exact resolution) |
| iOS/RN/Expo native bridging | yes | **out of V1** — the native side (Swift/Kotlin/ObjC) needs its own backends; the JS/TS side is already covered |
| Web UI | docs site (Astro) | **promo/docs site** (3D "constellation" explorer parked) |
| Architecture for multi-language | already done | **tree-sitter breadth + pluggable enrichers** |

**Key tradeoff:** we lead with **JS/TS semantic depth** (Compiler enricher) and **open language extensibility** (per-language enrichers). Other languages get tree-sitter Pass A instantly and better enrichers over time. If we ever want to add a language without an enricher yet, tree-sitter gives us something useful from day one.

---

## 11. Critical aspects not to overlook in V1

- **Primary `tsconfig` / `jsconfig` support.** V1 targets separated app repos, but should respect the main project config wherever possible. Formal multi-`tsconfig`, project references, and monorepo workspaces move to Stage 4 / v1.5.
- **Node scope vs resolution scope.** Index **only project files** as nodes; let refs resolve into `node_modules`/`.d.ts` (marked "external") without creating nodes for them.
- **Honest uncertainty.** Track `external`, `unresolved`, and `ambiguous` references, plus `confidence`/`provenance` on edges, so agents do not mistake weak or incomplete edges for facts.
- **Stable node IDs** across reindexes/file moves where possible: incremental sync, edge healing, and any consumer holding a node id all depend on it — and in `complement` mode Pass A and Pass B must compute the **same** id for the same declaration, or the graph forks. The ID policy must handle overloads, local symbols, and assigned anonymous functions better than `filePath::qualifiedName` alone.
- **Dangling edges in incremental sync.** On file change: delete nodes+edges, re-extract, and **re-resolve incoming referrers** (not just the changed file).
- **Config invalidation.** Changing `tsconfig`/`jsconfig`, `package.json`, lockfiles, `.gitignore`, `.astrograph/config.json`, or TypeScript/tree-sitter versions can stale resolution even if source files are unchanged.
- **Generated/vendored/minified files.** Exclude or down-rank (`.generated.ts`, `.gen.ts`, etc.).
- **JS/TS cases to extract well:** default exports, re-exports/barrels (`export * from`), `import type`, dynamic `import()`, CommonJS `require`/`module.exports`, assigned arrow functions, decorators, namespaces, enums, JSX/TSX, HOCs.
- **Context quality.** `context` is the agent-facing product surface: it needs ranking, token budgets, bounded neighborhoods, and inclusion reasons.
- **Concurrency/locking.** CLI + MCP daemon may touch the same DB → `FileLock` + WAL.
- **Schema migrations from day 1.** `schema_versions` + versioned migrations.
- **Core ready for progressive indexing.** Per-file coverage state, separable extraction (nodes vs edges), single writer, and indexing queue — even though streaming mode only "turns on" in S2. Detail: [docs/progressive-indexing.md](docs/progressive-indexing.md).
- **Project config:** `include/exclude`, `.gitignore` (`ignore` lib), max file size, which kinds to index — in `.astrograph/config.json`.
- **Honesty about "linear".** Extraction ~linear (tree-sitter + per-file); enricher resolution lazy but potentially superlinear in pathological cases. Document reality + mitigations.

---

## 12. Premortem (why it could fail and mitigation)

- **#1 — Resolution quality on real app repos** (Next.js, React Native/Expo, NestJS, Strapi) worse than on fixtures → bad contexts → no better than `grep`. **Mitigation:** eval harness early (mirroring `codegraph/__tests__/evaluation/`); validate on real repos before declaring V1.
- **#2 — tree-sitter + enricher memory/time on bigger repos** → slow cold index, not "linear". **Mitigation:** `LanguageService`/incremental, lazy enrichment, `skipLibCheck`, batching and metrics. Monorepo/project-reference hardening waits for Stage 4 / v1.5.
- **#3 — Incremental sync correctness** (dangling edges, stale incoming refs). **Mitigation:** dedicated delta-cycle test; re-resolve referrers.
- **#4 — Agents over-trust partial graph data.** **Mitigation:** carry `external`/`unresolved`/`ambiguous`, freshness, coverage, and confidence through CLI/MCP responses.
- **#5 — Over-scoping the "complete" S1** delays validation. **Mitigation:** vertical slice first (§14).
- **#6 — Bleeding edge** (opentui, advanced tree-sitter/enricher polish, new Bun APIs) eats time with no core value. **Mitigation:** keep Stage 3 to a clear static site; push interactive/visual extras to Stage 4 / v1.5 and Stage 5 / v2.
- **#7 — Real value shows up in S2 (MCP).** A CLI-only V1 may seem "unimpressive". **Mitigation:** be clear that S1 validates **graph quality**; don't over-invest in CLI polish before that.

---

## 13. Creative ideas and future (Stage 4 / v1.5, Stage 5 / v2)

**Stage 4 / v1.5 — hardening and near-term product depth:**
- **Monorepos / multi-`tsconfig` / project references:** per-project indexing, per-project coverage, workspace-aware invalidation.
- **Diff-aware graph:** "what changed in the graph between commit A and B" / a PR's impact. Useful for review and agents; a differentiator vs codegraph.
- **Richer status / index debt:** show stale, partial, ambiguous, and unresolved zones clearly.
- **`explain-context`:** show why each symbol was included in an agent context payload.
- **Context recipes:** modes for debugging, review, refactor, and architecture questions.
- **Architecture rules:** simple import boundaries, forbidden dependencies, cycles, and layer checks.

**Stage 5 / v2 — advanced intelligence and scale:**
- **Mature progressive indexing:** robust demand boosting, project/config queues, and advanced partiality for freshness, project, and edge kind.
- **Worker/LRU/eviction tuning:** lower peak memory on large repos and monorepos without giving up incremental speed.
- **Exporters:** graph to JSON, **Mermaid**, **DOT/Graphviz**.
- **Optional semantic layer (embeddings)** for "similar code" / meaning-based search — explicitly out of V1.
- **Frameworks-aware routes for JS/TS** (Express/Nest/Next/Remix) rebuilt *on top of* exact resolution — easier than in codegraph.
- **`astrograph why <A> <B>`:** narrated explanation of the path (a friendly alias of `trace`).

**Further out — platform bets:**
- **Pluggable language enrichers.** Decouple enrichers (TS Compiler API, others) so more languages plug in **without sacrificing JS/TS depth**. This is the path to multi-language done right.
- **Non-code knowledge sources.** Index documents/knowledge — **PDFs, Confluence, wikis, etc.** — into a compatible graph, exposed through the same MCP/skill surface, so agents query docs the way they query code.

**Parked — integrated 3D "constellation" explorer** (moved to a feature branch; design in [docs/web.md](docs/web.md)). If/when revived, it brings:
- **Single-binary 3D viewer:** `astrograph web` subcommand, frontend bundle embedded via Bun's full-stack `--compile`; reads the local `.astrograph/` read-only.
- **Live constellation:** WebSocket (`Bun.serve`) pushing watcher/`FreshnessManager` deltas to the view in real time as you edit.
- **Community/cluster detection** (modules) to draw real constellations (group stars by cohesion); color by cluster/language/kind.

---

## 14. V1 scoping recommendation

**V1 = Core/CLI (Stage 1) + MCP/Skills (Stage 2).** Both are functionally complete; the current focus is **refining and hardening Stages 1–2** (eval-harness calibration on real repos, FTS recall, single-writer hardening, Tier-2 agent A/B eval — see [TODO.md](TODO.md)). Stage 3 (promo/docs site) presents the finished product; the 3D explorer is parked (§13).

Stage 1 was sequenced **vertical-slice-first** to validate quality before breadth:
- **1.0 (vertical slice):** `index → search → context` end-to-end on **a real repo**, with the eval harness measuring quality. The "does this actually help?".
- Then broad (1.1–1.7) toward the full set of queries/edges.
