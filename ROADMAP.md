# Astrograph — Roadmap & Scope

> **Local-first code graph** — tree-sitter for structural extraction + language-specific enrichers (JS/TS: TypeScript Compiler; PHP: name resolution including calls) — exposed through CLI, MCP, and agent skills.
>
> 🌐 Languages: **English** (this file) · [Español](ROADMAP.es.md) (STALE — do not trust for release decisions)

This document is the project's **source of truth**. Stages 1–3 (core, MCP, promo site) are **functionally built**. **`v0.1.0` is a public preview** — the stabilization cut in §10, not a new product surface.

## 0. Release identity

There is one interpretation of the version, and it is `v0.1.0` **public preview**. `v1.0.0` is reserved for the first stable public contract and is not what §10 ships.

| | `v0.1.0` preview |
|---|---|
| Scope | JS/TS and PHP, **single-app** repositories |
| Public preview surfaces | CLI commands and JSON envelope, MCP tools, `.astrograph/config.json`, the graph vocabulary users see |
| Not a public SDK | the `@astrograph/*` TypeScript packages, the SQLite schema, and backend/enricher internals |
| Locality | 100% local. No network, no API keys, no LLM calls |
| Index compatibility | the index format may change in any release; an incompatible index is rebuilt or refused, never read as current |
| Out of the 0.1 and 0.2 roadmap | LLM calls, PDF or Markdown ingestion, AstroDocs |

Preview means CLI, MCP, and config may change deliberately between 0.x releases with a changelog entry. It does **not** waive correctness, honesty, local-only, or source-safety requirements. The full surface inventory and compatibility rules live in [contracts §12](docs/contracts.md#12-release-identity-and-compatibility); what changed in each release is in [CHANGELOG.md](CHANGELOG.md).

`v1.0.0` requires: real team usage evidence from the preview, every release-blocking deviation closed, implemented and documented upgrade/rebuild behavior, and at least one release candidate installed from the exact published artifacts.

---

## 1. Vision and goals

**Astrograph** indexes a repository into a graph of symbols and relationships, stored locally in SQLite, and exposes it through:

1. **CLI** — humans and scripts.
2. **MCP server + agent skills** — agents query the graph instead of grep/Read.
3. **Promo/docs site** — explains the product (not an in-app graph explorer).

**For whom?**
- **AI agents**: architecture/flow answers with fewer tokens and fewer tool calls.
- **Humans**: understand a codebase, trace a flow, gauge impact before refactoring.

**Design principles:**
- **100% local.** No API keys, no external services. SQLite only.
- **tree-sitter is always the base.** Pass A always runs and owns structural nodes. Enrichers add edges and may **insert** nodes Pass A skipped; they must **not delete** Pass A nodes (`dropped > 0` is an identity bug).
- **Performance-friendly.** Extraction ~linear in repo size; incremental delta reindex; peak RAM bounded (see §10 Track 2).
- **Pluggable language backends.** Registry of `LanguageBackend`s. Shipping: JS/TS + PHP.
- **Single-app repos first.** Primary `tsconfig.json` / `jsconfig.json`. Monorepos / project references wait for Stage 4.
- **Runtime-decoupled.** Bun-specific bits live behind adapters.

> **Parked:** the 3D "constellation" explorer lives on `feat/web-embedded`; design in [docs/web.md](docs/web.md).

---

## 2. Architecture decisions

| Topic | Decision | Why |
|---|---|---|
| Runtime + SQLite | **Bun + `bun:sqlite`** | Native, FTS5/WAL; matches monorepo `CLAUDE.md` |
| Extraction | **tree-sitter Pass A + per-language enrichers** | Breadth across languages; semantic depth where an enricher exists |
| JS/TS enricher | **TypeScript Compiler** (`complement`) | Exact module/call/type resolution |
| PHP enricher | **Name resolution** (`complement`) | FQN + `use` aliases; heritage, types, calls/instantiates. Not a type checker |
| Node authority | **Pass A subset of Pass B** | Inserts allowed; deletes forbidden. Cross-file ids from Pass A rows in SQLite |
| Languages | **JS/TS + PHP**; registry open | Adding a language is a backend registration |
| CLI | Classic args + isolated **opentui** | Scriptable one-shot; TUI only for interactive views |
| MCP | Official `@modelcontextprotocol/sdk` | Stdio tools over the core facade |
| Web | Promo/docs site (Fumadocs → GitHub Pages) | Not the 3D explorer |

### Passes

- **Pass A:** per-file tree-sitter walk → nodes + `contains`. State `parsed`.
- **Pass B:** optional enricher → edges (+ optional extra nodes). State `resolved`.
- **Deltas:** content hash vs `files` table; re-extract changed files; re-resolve incoming referrers.
- **Honesty:** edges carry `resolutionState` (`resolved` / `external` / `unresolved` / `ambiguous`), `confidence`, `provenance`.

The core **never imports `bun:*`**. Deps: `tree-sitter` (required), `typescript` (JS/TS enricher), `ignore`.

Canonical types: [docs/contracts.md](docs/contracts.md). Graph/DB: [docs/graph-model.md](docs/graph-model.md). Extraction: [docs/extraction/overview.md](docs/extraction/overview.md).

---

## 3. Graph model (short)

**Nodes:** `file`, `module`, `class`, `interface`, `function`, `method`, `property`, `field`, `variable`, `constant`, `enum`, `enum_member`, `type_alias`, `namespace`, `parameter`, `import`, `export`, `component`.

**Edges:** `contains`, `calls`, `imports`, `exports`, `extends`, `implements`, `references`, `type_of`, `returns`, `instantiates`, `overrides`, `decorates`.

**Node id:** stable hash of `project`, `filePath`, `qualifiedName`, kind, locator. Identical between Pass A and Pass B for the same declaration.

**Backends today:** `typescript` (`.ts` `.tsx` `.js` `.jsx` `.mts` `.cts` `.mjs` `.cjs`) and `php` (`.php`).

Coverage column on `files`: `pending → parsed → resolved`. See [docs/progressive-indexing.md](docs/progressive-indexing.md).

---

## 4–6. Stages 1–3 (shipped, not preview-complete)

| Stage | Surface | Status |
|---|---|---|
| 1 | Graph + CLI + tests | Built on `refactor/tree-sitter-enrichers` |
| 2 | MCP (10 tools) + agent skill + installer for hosts | Built |
| 3 | Promo/docs site + `install.sh` + release workflow | Built; **no `v*` GitHub Release yet** |

Remaining work to *ship* is §10, not another stage number.

Design refs: [docs/cli.md](docs/cli.md), [docs/mcp.md](docs/mcp.md), [docs/tools.md](docs/tools.md), [docs/site.md](docs/site.md), [docs/install.md](docs/install.md), [docs/testing.md](docs/testing.md).

---

## 7. Repo layout

```
astrograph/
├── packages/core/     # graph, DB, extraction, queries
├── packages/cli/      # commands + opentui
├── packages/mcp/      # stdio MCP server
├── apps/site/         # Fumadocs → GitHub Pages; public/install.sh
├── bench/             # RSS / index timing helper
├── docs/              # contracts, extraction, tools, …
├── ROADMAP.md
└── package.json
```

Per-project index: **`.astrograph/`** → `graph.db`, `config.json`, lock, daemon metadata.

---

## 8. Non-goals (`v0.1.0` preview)

Monorepos / multi-`tsconfig` / project references · frameworks-aware routes · embeddings · Windows installer · Spanish doc resync · mature progressive indexing (demand-boost, workers, LRU) · 3D constellation · `explain-context` · `astrograph_coverage` tool (listed in tools.md historically; **not implemented**).

Eval vs grep/ripgrep is the **post-preview quality gate**, not a ship blocker.

---

## 9. Differentiator vs codegraph

tree-sitter **base** (breadth) + **enrichers** (depth). JS/TS gets a real type checker instead of heuristic resolvers. PHP gets honest FQN/`use` resolution, not a second parser. Agents see `external` / `unresolved` instead of invented edges.

---

## 10. `v0.1.0` preview cut (current source of truth)

Work lives on `refactor/tree-sitter-enrichers` until this cut lands on `main`. PHP retains at most one live Tree (the old Magento-scale all-trees cache is gone). Tag **`v0.1.0` after merge**.

### Principle B (locked)

- Pass A always runs.
- Enricher may **insert** nodes Pass A omitted (overloads, kinds the parser cannot identify with a stable id).
- Enricher must **not delete** Pass A nodes. `PASS_A_NODE_DROPPED` is a warning + identity bug; the row stays.
- Cross-file lookup uses Pass A rows in SQLite, not an in-memory Compiler dump of the whole project.

PHP already follows this (enricher returns edges only). JS/TS must.

### Track 1 — Finish JS/TS and PHP

**PHP STEP 3** (spec: [docs/superpowers/specs/2026-07-29-php-call-resolution-design.md](docs/superpowers/specs/2026-07-29-php-call-resolution-design.md)):

- `calls` from `member_call_expression` / `scoped_call_expression`; `instantiates` from `new`.
- Intra-class type table (promoted properties, typed properties, constructor assignment).
- Four buckets: resolved / external (incomplete chain) / unresolved+warning / unresolved unknown receiver.
- Out of scope: `di.xml`, Factories/Proxies, return-type chaining, `__call`, traits as method bodies.

**JS/TS:**

- Drop `warmAllTsNodes`; pass `loadNodesForFile` through to the resolver.
- `rootNames` = indexed files, not the full tsconfig enumeration.
- CommonJS `require` / `module.exports` as `imports` / `exports`.
- `export * from` export edges.
- Dynamic `import()` stays honest `unresolved` when non-literal.

**Ready when:** a JS/TS app repo and a Magento-like PHP tree answer `search` / `context` / `callers` / `trace` with honest edges; `status.backends` matches emitted `edgeKinds`.

### Track 2 — RAM and CPU

Documented target ([docs/testing.md](docs/testing.md) §6): **peak RSS &lt; 1.5 GB on ~2k files**. Magento-scale PHP previously peaked around **3 GB** because `PhpAstCache` retained every WASM `Tree` + source for the whole pass.

**PHP:** parse → extract nodes / contribute FQN → emit that file's edges → `tree.delete()`. Peak = O(1 tree) + O(FQN map). Up to **two parses per file** is acceptable. No global tree map. LRU is Stage 5.

**JS/TS:** no whole-project node warm. `createProgram` stays in 0.1; `LanguageService` is Stage 4 unless RSS still blows the budget after the warm removal.

**Measure:** `bun run bench -- <repo>` records RSS around `indexAll` into `docs/benchmarks/`. Gate: fail if peak &gt; 2× target.

### Track 3 — Docs, installer, site

Align **after** capabilities match code:

- One story: tree-sitter + enrichers; PHP has a name enricher (heritage, types, calls).
- Canonical installer URL: **`https://www.chofito.dev/astrograph/install.sh`** (script SoT: `apps/site/public/install.sh`). GitHub Pages may mirror the same file; docs do not advertise `github.io` as the install command.
- First GitHub Release: tag **`v0.1.0` after merge to `main`**.
- Spanish mirrors stay STALE. No `TODO.md` (gitignored; not project truth).

### Sequence

1. This roadmap (identity + tracks).
2. JS/TS subset contract + PHP tree streaming + bench (parallel).
3. PHP STEP 3.
4. JS/TS CommonJS / `export *` + fixture backlog trim.
5. Docs / site / SKILL.
6. Merge to `main` when RAM is in budget → tag `v0.1.0`.
7. After the preview: eval vs grep, `LanguageService`, stricter token budgets, Stage 4.

---

## 11. After the `v0.1.0` preview (Stage 4, Stage 5)

**Stage 4:** monorepos / multi-tsconfig · `LanguageService` · diff-aware graph · richer index debt · context recipes.

**Stage 5:** mature progressive indexing · worker/LRU eviction · exporters (JSON/Mermaid/DOT) · optional embeddings · frameworks-aware routes · `astrograph why`.

**Parked:** 3D constellation (`feat/web-embedded`).

---

## 12. Premortem (`v0.1.0` preview)

- **#1 — Agents trust a graph that deletes Pass A nodes** → subset contract + no-delete reconcile.
- **#2 — Magento-scale RAM** → stream PHP trees; bench RSS; do not merge until &lt; 1.5 GB on ~2k files (or &lt; 2× that gate).
- **#3 — Wrong `calls` on vendor Magento types** → four-bucket honesty (external incomplete chain, not fake resolved).
- **#4 — Docs say PHP is tree-sitter-only** → Track 3 after capabilities are real.
- **#5 — Installer URL / no release** → one canonical URL + `v0.1.0` after merge.
