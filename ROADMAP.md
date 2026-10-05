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
- **Single-app repos first.** Primary `tsconfig.json` / `jsconfig.json`. Monorepos / project references wait for `v0.2.0`.
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

## 9. Differentiator and reference policy

tree-sitter **base** (breadth) + **enrichers** (depth). JS/TS gets a real type checker instead of heuristic resolvers. PHP gets honest FQN/`use` resolution, not a second parser. Agents see `external` / `unresolved` instead of invented edges.

CodeGraph is an operational reference, not a target architecture. Astrograph adopts the invariants that make a persistent local index trustworthy: bounded work, SQLite as persisted truth, deterministic ordering, short-lived per-file results, explicit lifecycle, proportional deltas, recovery, and normalized set equivalence. Backpressure, windows, LRU caches, workers, or a separate writer are introduced only when an Astrograph profile shows they address the measured bottleneck. Its Rust kernel, daemon topology, worker pools, telemetry, hosted scope, and language breadth are not requirements.

Graphify is a product-boundary reference. Its broad document ingestion reinforces the decision to keep PDF, Markdown, ADR/document knowledge, and LLM workflows out of Astrograph. That direction belongs to the separate AstroDocs product.

---

## 10. `v0.1.0` preview release program

Work lives on `refactor/tree-sitter-enrichers` until this cut lands on `main`. Tag **`v0.1.0` only after the accepted release revision is merged and its required owner-run evidence is recorded**. A committed test or an agent-reported run is implementation evidence, not owner verification.

### Principle B (locked)

- Pass A always runs.
- Enricher may **insert** nodes Pass A omitted (overloads, kinds the parser cannot identify with a stable id).
- Enricher must **not delete** Pass A nodes. `PASS_A_NODE_DROPPED` is a warning + identity bug; the row stays.
- Cross-file lookup uses Pass A rows in SQLite, not an in-memory Compiler dump of the whole project.

The release program is deliberately ordered so correctness can detect an optimization that changes the graph:

| Stage | Purpose | Current repository state | Gate |
|---|---|---|---|
| **0.1-A** (`AG-101`–`AG-106`) | Freeze version/config/enricher contracts, documentation governance, and the static-quality floor | Implemented on the branch | Keep its contract and review evidence intact |
| **0.1-B** (`AG-201`–`AG-209`) | Establish persisted trust, one eligibility decision, backend-owned invalidation, four-route reconciliation, query-specific completeness, and unresolved evidence | Implemented; see [0.1-B review](docs/architecture/operations/0.1-b-review.md) | No unresolved correctness finding in its reviewed boundary |
| **0.1-C** (`AG-301`–`AG-309`) | Build the production oracle over registry → Indexer → SQLite → queries, with JS/TS, PHP, mixed, failure, and four-route matrices | Implemented and independently reviewed; owner verification is still a separate gate | Close only from the evidence checklist in [0.1-C review](docs/architecture/operations/0.1-c-review.md) |
| **0.1-D** | Prove and fix memory, CPU, delta cost, and lifecycle while preserving the 0.1-C oracle | Next implementation stage | Meet the resource budget and graph-equivalence gates below |
| **0.1-E** | Close remaining shipped-language correctness, static/eval quality, real-team usefulness, installation, upgrade, and exact-revision release evidence | Planned; no new product breadth | Every preview claim has attributable owner-run evidence |

The detailed `*.local.md` backlog is working material, not portable project truth and not completion evidence. This roadmap, contracts, ADRs, canonical architecture documents, and stage review records own durable decisions.

### 0.1-D — resource viability before breadth

Owned gaps: `DEV-008`, `DEV-011`, `DEV-012`, `DEV-013`, and the remaining lifecycle portion of `DEV-018` in [Known deviations](docs/architecture/deviations.md).

1. Freeze a reproducible baseline for clean full, reused full, one-file delta, mutation burst, repeated live-session, and open/close behavior.
2. Bound `Indexer.resolveFor()` result retention without changing persisted files, nodes, edges, errors, or query envelopes.
3. Remove duplicated TypeScript source/node retention before replacing the compiler architecture.
4. Make PHP name-index and delta work proportional to changed declarations and real referrers.
5. Dispose watcher, queued work, backends/parsers, and SQLite in an explicit safe order.
6. Compare every optimized route against the 0.1-C normalized oracle. A faster run with different truth is a failed optimization.

The hard preview gate is **peak RSS ≤ 1.5 GiB on the accepted representative corpus of approximately 2,000 files**. The benchmark record must pin the corpus revision, Astrograph revision, command, platform, elapsed time, peak/end RSS, and route. A warning threshold may be lower; it cannot weaken the 1.5 GiB publication gate. Profile first: workers, LRU, backpressure, a separate writer, or a Rust kernel require evidence that the simpler bounded design cannot meet the gate.

### 0.1-E — correctness, usefulness, and release

- Finish the bounded PHP STEP 3 obligations, including the casing (`DEV-009`) and mixed grouped-use (`DEV-010`) gaps recorded in [Known deviations](docs/architecture/deviations.md), without Magento framework synthesis.
- Validate bounded team tasks for correctness, actionable uncertainty, and reduced discovery effort. The formal same-task A/B against `rg`/`grep` plus direct reading belongs to `v0.2.0`; indexing, sync, and query microbenchmarks remain separate from that comparison.
- Certify one representative JS/TS app and one Magento-like PHP repository using sanitized evidence for external reviewers.
- Align CLI, MCP, agent guide, installer, site, changelog, compatibility/rebuild behavior, and release notes with the exact accepted revision.
- Canonical installer URL remains **`https://www.chofito.dev/astrograph/install.sh`**. Spanish mirrors remain explicitly stale until separately resynchronized.

---

## 11. `v0.2.0` — broader code intelligence, still code only

`v0.2.0` expands the validated code-indexing core; it does not turn Astrograph into a document or LLM knowledge system.

Priority outcomes:

1. Scale and incremental work: monorepos/multiple project configs, measured reindexing, and long-running freshness/recovery.
2. Magento-aware code intelligence: explicit DI and plugin relationships built as a bounded framework layer, never generic name healing.
3. A generic structural-backend path proven by **Python**, the only new language required for `v0.2.0`. Start useful with tree-sitter structure; add a semantic enricher only for separately accepted capabilities.
4. Real-task A/B evaluation against `rg`/`grep` plus direct reading, with indexing/sync/query microbenchmarks reported separately.
5. Revisit CodeGraph-inspired windows, backpressure, caches, workers, and recovery mechanisms only from measured 0.1-D/0.2 bottlenecks.

The expansion order after Python is **Go → Kotlin → Swift → Rust**. Those four languages are directional priorities, not promises for `v0.2.0`; each enters a release only after a capability slice, ownership rules, fixtures, convergence behavior, resource budget, and query-honesty contract are accepted.

LLM calls, embeddings, PDF/Markdown/ADR ingestion, and document knowledge are not scheduled Astrograph features. They belong to AstroDocs unless a later explicit product decision changes the boundary. The 3D constellation remains parked on `feat/web-embedded`.

---

## 12. Premortem (`v0.1.0` preview)

- **#1 — Agents trust a graph that deletes Pass A nodes** → subset contract + no-delete reconcile.
- **#2 — Magento-scale RAM** → bound retained per-file/compiler/parser state; do not merge until peak RSS is ≤ 1.5 GiB on the accepted ~2k-file corpus.
- **#3 — Wrong `calls` on vendor Magento types** → four-bucket honesty (external incomplete chain, not fake resolved).
- **#4 — Docs say PHP is tree-sitter-only** → Track 3 after capabilities are real.
- **#5 — Installer URL / no release** → one canonical URL + `v0.1.0` after merge.
