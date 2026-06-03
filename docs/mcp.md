# MCP server design (Stage 2)

> 🌐 Languages: **English** (this file) · _ES mirror pending (see backlog)_

> Design doc for Astrograph's MCP server — the agent-facing surface. The 10 tools
> and their structured results already exist and are validated (the `Astrograph`
> facade from `@astrograph/core/bun`); the MCP layer is a **thin wrapper** that maps
> tool calls → facade methods → agent-readable text. Built on the official
> `@modelcontextprotocol/sdk` (stdio). See [docs/tools.md](tools.md),
> [docs/contracts.md §7](contracts.md), [docs/progressive-indexing.md](progressive-indexing.md),
> ROADMAP §5.

## 1. Decisions (settled)

| Topic | Decision |
|---|---|
| Transport | **stdio** via `@modelcontextprotocol/sdk` (SDK owns the protocol plumbing) |
| Tools | the **10** (`astrograph_search/context/trace/callers/callees/impact/node/explore/files/status`), 1:1 over the facade |
| Bootstrap | **requires `astrograph init` first.** No `.astrograph/` → tools return a clear "run `astrograph init`" error (no implicit indexing on connect) |
| Response format | **MCP-specific agent-tuned text formatters** (not the CLI's terminal formatters; share the structured `ToolResult`, differ in presentation) |
| Honesty | external off by default (project-only); every response carries a **coverage + staleness banner**; `unresolved`/`ambiguous`/low-confidence surfaced in notes |
| Freshness | **watcher (background, debounced) + connect-time reconcile catch-up + on-demand sync guarded by a cheap staleness signal** (see §4) |
| Installer | **`install`/`uninstall` for Claude Code + Cursor + Codex + opencode** (write/remove the MCP config + Astrograph guide; see §6) |
| Lifecycle | **one project per server process**, lazy-open on first tool call; single-writer for all index mutations |

Out of scope (later): full progressive serve-while-indexing (Stage 5), agents beyond Claude Code/Cursor, multi-project daemon.

## 2. Architecture

```
agent (Claude Code / Cursor)
   │  stdio (MCP)
   ▼
@astrograph/mcp  ── SDK server: registers 10 tools + server-instructions
   │  maps tool input → facade method; renders ToolResult → agent text
   ▼
openProject(root)  →  Astrograph facade  →  @astrograph/core
```
- **Project resolution:** resolve the nearest `.astrograph/` walking up from the
  client's `rootUri` (else server cwd) — same logic as the CLI's `root.ts`. One
  resolved project per process; lazy-open the facade on first tool call.
- **The MCP layer adds NO graph logic** — it only parses args, calls the facade,
  formats text, and manages the watcher/staleness (§4). Reuses `@astrograph/core/bun`.

## 3. Tools & response formatting

- Each MCP tool `astrograph_<x>` declares its input schema from the contract
  (docs/contracts.md §6) and calls the matching facade method.
- **Agent-tuned text** (not JSON, not terminal ANSI): compact, scannable, with file
  paths + line ranges and, for `context`/`explore`/`node`, the verbatim code blocks
  inline (so the agent treats them as already-read). A trailing **banner**:
  `coverage R/T resolved · partial: yes/no · [N files indexing: …] · [notes]`.
- `external` symbols stay hidden by default (project-only), matching the facade.

## 4. Freshness model (watcher + staleness guard)

This is the "always fresh" behavior, mirroring codegraph but built on our
single-writer core. Three layers:

1. **Watcher (in-session edits).** A `Watcher` adapter (Bun `fs.watch`/chokidar)
   watches the project's source globs; create/modify/delete debounced (default
   ~300ms) → a background `sync()` of the changed files. Runs through the **single
   writer** (no concurrent writes). The watcher keeps an in-memory **pending set**.
2. **Connect-time reconcile (catch-up).** On the first tool call of a session, run
   one `sync()` reconcile (scan + content-hash diff) to absorb edits made while no
   server was running (git pull, another editor, prior session). Once, not per query.
3. **On-demand guard (watcher fallback).** A query does **not** re-stat the whole
   tree. It consults the cheap signal: if the watcher flagged pending files (or the
   watcher is unavailable on this FS), trigger a bounded `sync()` for the affected
   files before answering. Otherwise answer immediately.

**Staleness banner.** Every response reports coverage and any pending files by name
(extends the `ToolMeta` envelope), so the agent never gets a silent wrong answer in
the debounce window — it's told to `Read` a still-pending file directly.

Honest note: full *serve-while-indexing* progressive mode (demand-boost + LRU
eviction) stays at Stage 5; this V1 model is watcher + catch-up + guard.

## 5. Server instructions (delivered in `initialize`)

A single steering string (à la codegraph's `server-instructions.ts`) that tells the
agent to:
- **Answer structural/architecture/flow questions directly with Astrograph** — it
  *is* the pre-built index; don't re-grep/re-Read what it returns. Treat returned
  source as already read.
- **Pick the tool by intent:** `context` first for "how does X work"; `trace` for
  "how does X reach Y"; `search` to find a symbol; `callers`/`callees` to walk call
  flow; `impact` before editing; `node`/`explore` for source.
- **Trust results; check the coverage/staleness banner** after edits; if a file is
  flagged pending, `Read` it directly.
- If `.astrograph/` is missing, offer to run `astrograph init`.

The MCP `initialize` response stays the runtime source of truth for active tool
instructions. The installer also installs the shared Astrograph guide into hosts
that support skills/rules, so agents are nudged toward Astrograph before falling
back to broad grep/read loops.

## 6. Commands & install targets

- `astrograph serve --mcp [--path <dir>] [--no-watch]` — start the stdio MCP server.
- `astrograph install [--target claude,cursor,codex,opencode] [--location global|local] [--yes] [--print-config <id>]`
  — write the MCP server config and install the shared Astrograph agent guide into
  the chosen host(s); `uninstall` reverses Astrograph-owned entries and guide files.
  Project indexes untouched.

**MCP does NOT standardize host configuration** — only the wire protocol. Each host
has its own file/location/format, so the installer needs a per-target adapter
(reference: `codegraph/src/installer/targets/`). The 4 targets:

| Host | Config file (global · local) | Format | Shape |
|---|---|---|---|
| **Claude Code** | `~/.claude.json` · `./.mcp.json` | JSON | `{ mcpServers: { astrograph: { type:"stdio", command, args } } }` |
| **Cursor** | `~/.cursor/mcp.json` · `./.cursor/mcp.json` | JSON | same `{ mcpServers: {…} }` |
| **Codex** | `~/.codex/config.toml` | **TOML** | table `[mcp_servers.astrograph]` (command, args) |
| **opencode** | `~/.config/opencode/opencode.jsonc` (XDG; `%APPDATA%` on Win) · `./opencode.jsonc` | **JSONC** | `{ mcp: { astrograph: { type:"local", command:[…array…], enabled:true } } }` |

Notes: 3 distinct formats → the installer needs a **TOML writer** and a
**comment-preserving JSONC writer** (Claude/Cursor share the JSON `mcpServers`
shape). The MCP server entry is edited surgically. The agent guide content is
embedded in the Astrograph binary and materialized into each host's skill/rule
location during install. Existing real instruction files are not overwritten.
For development, `ASTROGRAPH_AGENT_GUIDE` can opt into symlinking a working-tree
guide instead. Each target is idempotent and supports global vs local scope.

## 7. Build order (3 prompts)

1. **MCP-1 — server + tools.** SDK stdio server, the 10 tools over the facade,
   agent-tuned text formatters + banner, `server-instructions`, `serve --mcp` over an
   already-`init`'d index, **connect-time reconcile**. (Requires-init; no watcher yet.)
2. **MCP-2 — freshness.** `Watcher` Bun adapter + debounced background `sync()`
   (single-writer) + the on-demand staleness guard + the staleness banner.
3. **MCP-3 — installer.** `install`/`uninstall` for Claude Code + Cursor + Codex +
   opencode (4 targets, 3 config formats: JSON `mcpServers`, TOML `[mcp_servers.x]`,
   JSONC `mcp.<name>`). Per-target adapters + a TOML writer + a comment-preserving
   JSONC writer + guide install.

## 8. References
- Tool contract & behavior: [docs/tools.md](tools.md) · facade: [docs/contracts.md §7](contracts.md).
- Freshness rationale: [docs/progressive-indexing.md](progressive-indexing.md) (§2 stack fit, §3.5 partiality, §6 core requirements).
- codegraph for reference (not copied): `src/mcp/server-instructions.ts`, `src/mcp/tools.ts`, `src/sync/watcher.ts`, the "How auto-syncing works" README section.
