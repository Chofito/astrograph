# Progressive indexing (streaming, "WoW"-style)

> 🌐 Languages: **English** (this file) · [Español](progressive-indexing.es.md)

> Design document. It belongs to **Stage 2 (MCP daemon)** of the [ROADMAP](../ROADMAP.md), but distinguishes the first practical V1 version from the fully mature Stage 5 / v2 version. It imposes **requirements on the V1 core** (see §6). The ROADMAP only references this document; the detail lives here so it doesn't bloat.

## 1. Idea

Instead of blocking until the whole repo is indexed, Astrograph behaves like a game that *streams the world*: it starts instantly, indexes in the background, **makes available what's already ready**, and if you query something not yet indexed, it **prioritizes that zone, finishes it, answers, and returns** to the background.

Target flow:

1. The user runs `astrograph init` (or the agent connects the MCP).
2. Background indexing starts and the **MCP is available immediately**.
3. Queries work over what's already indexed; coverage grows on its own.
4. If a query touches a `pending`/partial zone, that zone **jumps to the front**, is indexed synchronously, gets answered, and the background continues.

In V1, this assumes a separated single-app repo with one primary `tsconfig.json` / `jsconfig.json` when present. Multi-project scheduling, per-`tsconfig` queues, and monorepo-aware coverage are Stage 4 / v1.5 and Stage 5 / v2 hardening work.

Effect: it feels instant, peak memory drops (if cold units are evicted), and the day-to-day feels like an IDE.

It's a well-known pattern (LSP servers, IntelliJ). **A differentiator vs codegraph**, which indexes everything in `init -i` before serving.

## 2. Why our stack fits

- **`bun:sqlite` + WAL** → one writer (the indexer) + many readers (MCP queries) concurrent without blocking. It's the exact model we need.
- **`ts.LanguageService` is lazy / demand-driven by design** — it's built to request a file's symbols without checking the rest. Progressive indexing *is* its natural mode of use, not a fight against the tool.

## 3. Design

### 3.1 Per-file coverage state
A state column in the `files` table: **`pending → parsed → resolved`**.
- `pending`: known (discovered by the walker) but untouched.
- `parsed`: AST + extracted nodes persisted (the symbols already exist).
- `resolved`: edges resolved (imports/calls/extends…). "Full" coverage of that file.

It's the WoW-style "level of detail" per file.

Stage 2 starts with file-level coverage for simple repos. Later stages should grow this into coverage by project/config, freshness, and edge kind, because "calls are partial" is different from "nodes are missing".

### 3.2 Single-consumer job queue
A priority queue of files; **a single consumer** (the indexer) drains it and writes to the DB. A **demand** job is simply a max-priority job that the query `await`s. A single writer avoids corruption (coordinated with the `Mutex`/`FileLock` codegraph already uses).

For V1/Stage 2, this can be one repo-level queue. Stage 4 / v1.5 introduces per-project coverage for monorepos; Stage 5 / v2 promotes this into per-project/config queues and robust scheduling.

### 3.3 On-demand boost (+ 1 hop)
When a query touches `pending` files, we enqueue **those files + their 1-hop neighbors** at the front, wait for them to reach `resolved`, answer, and the background resumes where it was. The "1 hop" is the "WoW also streams the adjacent zone" — needed because of the resolution cascade (§5.2).

### 3.4 Indexer in a Worker (or yield between files)
Running the indexer in a **Bun Worker** keeps the MCP event loop free. Simpler alternative: run on the main thread **yielding between files** (`await`), since parsing a file is a matter of ms → *file-granularity interleaving* feels instant. **No real mid-parse preemption needed.**

### 3.5 Partiality signaling
Every MCP response declares coverage: `"coverage 60% · N files pending"`. It extends codegraph's staleness banner. **Never return something incomplete while passing it off as complete.** Responses should also carry freshness/staleness and, where relevant, unresolved/ambiguous/external references and low-confidence edges.

## 4. What works progressively and what doesn't

| Query type | Progressive? | Note |
|---|---|---|
| `node`, `context` (local to a symbol), `files` | ✅ perfect | Local: the on-demand boost resolves it instantly |
| `search` (FTS) | ✅ with growing coverage | Results grow; label as partial |
| `trace` (A→B) | ⚠️ partial | Works if A, B and the path are covered; otherwise demand |
| `callers`, `impact` (reverse, global) | ❌ not guaranteed until full coverage | A caller may live in a `pending` file → report coverage and mark "partial, N pending" |

**Rule:** *local* queries shine in progressive mode; *global reverse* queries are only complete with full coverage — and must be labeled honestly meanwhile.

## 5. Hard parts (real nuances)

1. **Global reverse queries need full coverage** (see §4 table). Nuance #1.
2. **Resolution cascade.** Resolving an edge to a symbol in B requires B to be at least `parsed`. TS resolves the module *path* without parsing B, but the *symbol edge* does require it → hence the 1-hop boost. It must be bounded or it blows up.
3. **"Less memory" isn't free.** Peak RAM only drops if you **evict** cold TS Programs (LRU per project/file). Tension: streaming-with-release = low RAM but re-parses on incremental; persistent service = more RAM but instant incremental. It's tunable. In V1 this can be simple; in Stage 5 / v2 it becomes important for monorepos and large repos (index per `tsconfig`, evict the cold ones).
4. **Write coordination.** A single writer, no exceptions. Single-consumer queue + lock.
5. **Results that "grow".** Fine for an agent *if labeled*; dangerous if presented as complete.

Overall difficulty for the simple-repo Stage 2 version: **medium, not high**. Almost all the risk is in (a) signaling partiality well and (b) global reverse queries. The mature Stage 5 / v2 version adds harder scheduling and memory tradeoffs for monorepos.

## 6. Requirements this imposes on the V1 core

Even though the daemon that "turns it on" is Stage 2, the V1 core must be born ready, or the refactor will be ugly:

- **Per-file coverage state** (`files.state: pending|parsed|resolved`) in the schema from day 1.
- **Indexing priority queue** as an abstraction (even if in V1 the CLI drains it in a single pass).
- **Single-writer model** for the DB (background + demand never write at the same time).
- **Level-separable resolution**: node extraction (`parsed`) decoupled from edge resolution (`resolved`), so nodes can be made available before edges.
- **Queryable coverage**: be able to answer "what % / which files are missing?" for partiality signaling.

## 7. Phasing

- **V1 (Stage 1, CLI):** single-pass indexing, but respecting the §6 requirements. Streaming mode is not exposed yet.
- **V1 (Stage 2, MCP daemon):** the first practical model turns on for simple repos — background indexing, demand jobs, and honest partiality signaling.
- **Stage 4 / v1.5:** add monorepo and multi-`tsconfig` foundations: per-project coverage, project-aware invalidation, and scheduling boundaries.
- **Stage 5 / v2:** mature progressive indexing — robust demand boosting, per-project/config queues, Worker/LRU/eviction tuning, and advanced partiality by project, freshness, and edge kind.
