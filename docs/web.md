# Web UI design — 3D "constellation" explorer (PARKED)

> ⏸️ **PARKED / DEFERRED.** This integrated in-app 3D graph explorer has been **moved
> to a feature branch** and removed from the V1 line. It was the riskiest, lowest-
> validation surface; the current focus is refining Stages 1–2 (CLI + MCP/Skills).
> Stage 3 is now a **promo/documentation website** (ROADMAP §6), not this explorer.
> This doc is preserved as-is for if/when the explorer is revived (ROADMAP §13).

> 🌐 Languages: **English** (this file) · _ES mirror pending (see backlog)_

> Design doc for Astrograph's 3D graph explorer — the human-facing surface. It is a
> **subcommand of the same `astrograph` binary** (`astrograph web`), not a separate
> deploy: `Bun.serve()` serves an embedded React/three.js bundle and a small local
> JSON/WS API backed by the existing `Astrograph` facade (`@astrograph/core/bun`)
> reading the project's `.astrograph/graph.db`. Built per `CLAUDE.md` (Bun.serve +
> HTML imports + React + Tailwind/shadcn; no Vite). See [docs/contracts.md](contracts.md),
> [docs/tools.md](tools.md), ROADMAP §6.

## 1. Decisions (settled)

| Topic | Decision |
|---|---|
| Packaging | **Subcommand of the SAME binary** — `astrograph web`. The frontend bundle is embedded at `bun build --compile` time (Bun "full-stack executables", v1.2.17+; we run 1.3.14). No separate hosting, no static-file dir to ship. |
| Server | **`Bun.serve()`** with `routes` + HTML imports; bound to **`127.0.0.1`** (local-only dev tool, no auth). No Vite, no express. |
| What's embedded vs not | The binary ships the **viewer** (HTML/JS/CSS, three.js), NOT the data. The **`graph.db` stays per-project**, read at runtime from the target repo's `.astrograph/` — same as every other command. (Bun's "embed SQLite" feature is explicitly **not** used; it's for shipping a fixed DB.) |
| Frontend | **React + Tailwind + shadcn/ui** for the chrome; 3D via **`react-force-graph-3d`** (three.js, force-directed) + **`@react-three/postprocessing`** for bloom/glow; drop to react-three-fiber directly only if we need full shader control. |
| Data API | A small **local JSON API** over the facade: bulk graph snapshot + node detail + search + status. Optional **WebSocket** for live deltas. |
| Freshness | The WS pushes `FreshnessManager` deltas → the "living constellation". The viewer is **read-only**; it never writes the index, deferring to the single-writer (daemon/MCP/CLI). |
| Scope | Localhost dev/presentation tool. **One project per process.** No auth, no remote, no multi-tenant. |

Out of scope (later): remote/hosted mode, auth, collaborative cursors, graph editing, embeddings-based "similar code" view, diff-aware constellation (§13 future).

## 2. Architecture

```
human (browser)
   │  http + ws  (127.0.0.1)
   ▼
apps/web  ──  Bun.serve({ routes })
   │   "/"          → embedded SPA (React + three.js constellation)
   │   "/api/*"     → JSON over the facade
   │   "/api/live"  → WS: FreshnessManager deltas
   ▼
openProject(root)  →  Astrograph facade  →  @astrograph/core  →  .astrograph/graph.db (read-only)
```

- `astrograph web [--path <dir>] [--port <n>] [--open]` resolves the nearest
  `.astrograph/` (same `root.ts` logic as the CLI/MCP), lazy-opens the facade,
  starts the server, and optionally opens the browser.
- **The web layer adds NO graph logic** — it parses requests, calls the facade,
  serializes JSON, and pushes freshness deltas. All graph work lives in `@astrograph/core`.

## 3. Data API (local JSON + WS)

| Route | Returns | Facade mapping |
|---|---|---|
| `GET /api/graph` | Bulk snapshot: `{ nodes[], edges[] }` for the constellation, with `?limit` / `?kinds` / LOD params | **new core bulk-export query** (see note) |
| `GET /api/node/:id` | Node detail: source, context, callers, callees, edges | `node` + `context` + `callers`/`callees` |
| `GET /api/search?q=` | Ranked symbol matches (focus/jump-to) | `search` |
| `GET /api/status` | Counts, coverage, backend, freshness banner | `status` |
| `WS  /api/live` | Push `{ changed, added, removed }` node/edge deltas on sync | `FreshnessManager` callbacks |

- **Snapshot contract** reuses the canonical `Node`/`Edge` types (docs/contracts.md);
  the viewer should not invent a parallel shape. Add only view-affine fields
  (e.g. cluster id, degree) server-side if needed.
- **Core gap to close (honest note):** the current `GraphQueries` are query-scoped
  and do bounded N+1 `getNode` lookups; a constellation needs a **dedicated bulk
  graph-export** read (single pass over `nodes`/`edges`) so `/api/graph` stays cheap
  on large repos. This is a small core addition, not a viewer hack.

## 4. Rendering & performance

- **Constellation:** nodes = stars colored by `kind` (and/or language), edges =
  luminous links styled by edge `kind`; bloom/glow via postprocessing; depth/parallax.
- **Large graphs:** LOD + frustum culling + instancing; **label decimation** (only
  show labels near camera / above a degree threshold); cap initial node count via
  `/api/graph?limit` and load detail on demand.
- **2D fallback:** if the graph exceeds a threshold (or WebGL is unavailable),
  degrade to a 2D force layout rather than choking the GPU.
- **Stable layout:** seed positions from stable node IDs (hash of
  `filePath::qualifiedName`) so the constellation doesn't "jump" between reindexes
  (mirrors the stable-ID requirement in ROADMAP §11).

## 5. Interaction

- **3D navigation** (orbit/pan/zoom), **search box** that focuses + flies to a node.
- **Node selection → detail panel** (shadcn): verbatim source, context, callers /
  callees, incoming/outgoing edges; clicking a related symbol re-centers the graph.
- **Filters** by node kind and edge kind (and language); toggle external refs off by
  default (project-only, matching the facade).
- **Living constellation:** WS deltas animate nodes/edges in/out as you edit files.

## 6. Single-binary build & embedding

This is the crux of "everything in one binary". The current build is:

```bash
bun build packages/cli/src/bin/astrograph.ts --compile --outfile dist/astrograph
```

The web bundle rides along **for free** because Bun follows the import graph:

1. `apps/web` exports `serveWeb(...)` which **statically imports `./index.html`**
   (which in turn pulls `app.tsx`, Tailwind CSS, three.js, etc.).
2. The CLI's `web` command imports `serveWeb` (lazy `await import('@astrograph/web')`
   is fine — Bun still embeds dynamic-import chunks, and it keeps non-web commands'
   cold start fast).
3. At `--compile`, Bun sees the HTML import, **runs a frontend build**, and embeds
   the bundled HTML/CSS/JS into the executable. At runtime the HTML import is a
   manifest `Bun.serve` uses to serve assets with correct MIME/cache headers.

So the **same** `dist/astrograph` binary contains: Bun runtime + CLI + MCP server +
the web viewer bundle + npm deps. No extra build step, no `apps/web` deploy.

- **Dev loop:** `bun --hot apps/web/server.ts` (or `bun run dev:web`) → HMR against
  source while we iterate on shaders/effects. **Prod:** the same `serveWeb` is reached
  through the CLI entrypoint and embedded by the existing `build` script.
- **Honest caveats:** (1) three.js + R3F are heavy → the binary grows noticeably;
  acceptable for a dev tool, but measure it and consider a future `--slim` build
  without the web bundle. (2) The HTML import is static, so the web bundle is embedded
  **even if `astrograph web` is never run** — it doesn't slow CLI startup (served
  lazily), only inflates file size.

## 7. Build order (3 prompts)

1. **WEB-1 — server + snapshot + static 3D.** `apps/web` workspace; `Bun.serve()`
   routes; `GET /api/graph` (+ the core bulk-export query) and `GET /api/status`;
   React + Tailwind/shadcn shell; `react-force-graph-3d` rendering a static
   constellation colored by kind. `astrograph web --path --port --open` wired into the
   CLI; verify it embeds under `bun build --compile`.
2. **WEB-2 — interaction + detail.** Search-to-focus, node selection → detail panel
   (`/api/node/:id`, `/api/search`), filters by node/edge kind, bloom/postprocessing,
   LOD/culling + 2D fallback for large graphs.
3. **WEB-3 — living constellation.** `WS /api/live` over `FreshnessManager` deltas;
   animate node/edge in/out on edit; read-only deference to the single writer.

## 8. References

- Data model & facade: [docs/contracts.md](contracts.md) · tool behavior: [docs/tools.md](tools.md).
- Bun full-stack executables (HTML embedding): `bun-types/docs/bundler/executables.mdx`
  (§"Full-stack executables") and `bundler/standalone-html.mdx`.
- Freshness deltas: [docs/mcp.md §4](mcp.md) · `packages/core/src/freshness.ts` (`FreshnessManager`).
- Future (diff-aware constellation, clusters, exporters): ROADMAP §13.
