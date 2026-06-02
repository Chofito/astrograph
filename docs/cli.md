# CLI design

> 🌐 Languages: **English** (this file) · _ES mirror pending (see backlog)_

> Design document. Astrograph's command-line surface — derived from inspecting codegraph's CLI (reference only, no code copied) and rebuilt on our **transport-agnostic tool contract** ([docs/tools.md](tools.md)). Expands [ROADMAP §1.6](../ROADMAP.md#16--cli-hybrid).

---

## 1. Principles

1. **Hybrid (ROADMAP §1.6).** One-shot commands emit **scriptable plain text** (pipe-able, stable, `--json` for machines). **opentui** is used *only* for interactive/live views and stays in an isolated layer — command logic never depends on the UI.
2. **The CLI is a thin formatter over the contract.** Every query command calls the same `packages/core` query as the MCP tool and renders the same structured result. CLI = terminal formatter; MCP = agent formatter; Web = 3D formatter. No logic duplicated.
3. **Honesty by default.** Every query command prints a coverage/partiality footer from the result `meta` envelope ([docs/tools.md §3](tools.md#3-shared-result-envelope)); `--json` includes the full envelope. We never present partial/stale/low-confidence data as complete.
4. **TTY-aware.** Rich/live rendering (spinners, opentui) only when stdout is a TTY; piped/CI output is automatically plain. `--quiet` and `--json` force plain.
5. **More than codegraph where it's free.** We expose `trace`, `node`, and `explore` as CLI commands (codegraph keeps them MCP-only) — the contract makes it a one-liner.

---

## 2. Global conventions

- **Project targeting.** Lifecycle commands take a positional `[path]`; query commands take `-p, --path <path>` (defaults to nearest `.astrograph/` upward from cwd, like codegraph).
- **`--json`** on every read command → emits `{ data, meta }` (the envelope), nothing else, for scripting.
- **`-q, --quiet`** → only essential output (paths/values), no decoration. **`-v, --verbose`** → worker/memory/timing diagnostics.
- **Exit codes.** `0` ok · `1` error · `2` no index (`.astrograph/` missing — suggests `astrograph init`) · `3` reserved for `--fail-on-partial` (CI: non-zero when the answer is coverage-partial).
- **Binary name.** `astrograph`, with a short alias `ag` (opt-in during install).

---

## 3. Command catalog

### 3.1 Lifecycle / index management

| Command | Purpose | Key options |
|---|---|---|
| `init [path]` | Create `.astrograph/` and build the initial index | `--no-index` (create dir only), `-y/--yes`, `-v/--verbose` |
| `uninit [path]` | Remove `.astrograph/` for a project | `-f/--force` (skip confirm) |
| `index [path]` | Full / delta index of all files | `-f/--force` (full re-index), `-q/--quiet`, `-v/--verbose` |
| `sync [path]` | Index changes since last run (deltas) | `-q/--quiet` (for git hooks) |
| `status [path]` | Index health, stats, **coverage**, pending sync | `-j/--json` |
| `unlock [path]` | Remove a stale lock file blocking indexing | — |
| `serve` | Run as MCP server (Stage 2) | `--mcp` (stdio), `-p/--path`, `--no-watch` |
| `install` | Configure the MCP server into agent(s) (Stage 2) | `-t/--target`, `-l/--location`, `-y/--yes`, `--print-config <id>` |
| `uninstall` | Remove Astrograph from agent(s) (Stage 2) | `-t/--target`, `-l/--location`, `-y/--yes` |

Notes:
- `init` indexes by default (codegraph deprecated its `-i` flag for the same reason); `--no-index` opts out.
- `index`/`sync` render a **live opentui progress view** on a TTY (files/sec, coverage filling), plain lines when piped.
- `install/uninstall` start minimal in V1 (Claude Code + Cursor); broader agent matrix is a later stage. They never touch the user's `CLAUDE.md` (instructions ship in the MCP `initialize`).

### 3.2 Query commands (one per tool)

All accept `-p/--path` and `-j/--json`, and print the coverage footer.

| Command | Tool | Args | Key options |
|---|---|---|---|
| `search <query>` (alias `query`, `q`) | `astrograph_search` | symbol/partial name | `-l/--limit 10`, `-k/--kind`, `--lang`, `--no-generated` |
| `context <task>` | `astrograph_context` | task description | `-n/--max-symbols 20`, `--no-code`, `--budget <tokens>`, `-f/--format markdown\|json` |
| `trace <from> <to>` | `astrograph_trace` | two symbols | `-d/--max-depth` |
| `callers <symbol>` | `astrograph_callers` | symbol | `-l/--limit 20` |
| `callees <symbol>` | `astrograph_callees` | symbol | `-l/--limit 20` |
| `impact <symbol>` | `astrograph_impact` | symbol | `-d/--depth 2`, `--include-external` |
| `node <symbol>` | `astrograph_node` | name or id | `-c/--code` (include body) |
| `explore <terms...>` | `astrograph_explore` | bag of names/terms | `--max-files 12` |
| `files` | `astrograph_files` | — | `--filter <dir>`, `--pattern <glob>`, `--format tree\|flat\|grouped`, `--max-depth <n>`, `--no-metadata` |
| `status [path]` | `astrograph_status` | — | `-j/--json` (also a lifecycle cmd) |

Honesty flags shared by query commands: `--include-external` (show `node_modules`/`.d.ts` targets), `--min-confidence high|medium|low`, `--show-unresolved`, `--fail-on-partial` (CI).

### 3.3 CLI-only conveniences (built on the graph, offline)

| Command | Purpose | Key options |
|---|---|---|
| `affected [files...]` | Test/impact selection for CI — which tests are affected by changed source files (built on `impact`) | `--stdin`, `-d/--depth 5`, `--filter <glob>`, `-q/--quiet`, `-j/--json` |
| `explore -i` / `tui` | Interactive opentui graph browser (navigate symbols/edges, peek source) | TTY only |
| `why <from> <to>` | Friendly alias of `trace` (ROADMAP §13) | _later_ |

`affected` is kept from codegraph because it's genuinely useful for CI/git-hooks and is fully offline (graph traversal + test-file detection). It is CLI-only (not one of the 10 agent tools).

---

## 4. codegraph → astrograph mapping (what we keep, change, add)

| codegraph command | astrograph counterpart | Difference |
|---|---|---|
| `init [path]` `-i` | `init [path]` `--no-index` | Index-by-default; opt-out flag instead of opt-in |
| `uninit [path]` `-f` | `uninit [path]` `-f` | Same |
| `index [path]` `-f -q -v` | `index [path]` `-f -q -v` | + live opentui progress on TTY |
| `sync [path]` `-q` | `sync [path]` `-q` | Same role (git hooks) |
| `status [path]` `-j` | `status [path]` `-j` | + **coverage** section (progressive model) |
| `unlock [path]` | `unlock [path]` | Same |
| `query <search>` | `search <query>` (alias `query`/`q`) | Renamed canonical to match tool; alias kept |
| `files` | `files` | Same options; + per-file `coverageState` |
| `context <task>` | `context <task>` | + `--budget` (token budget), inclusion reasons |
| `callers/callees/impact` | same | + coverage/partiality footer |
| `affected [files...]` | `affected [files...]` | Same (CI) |
| `serve --mcp --no-watch` | `serve --mcp --no-watch` | Built on official MCP SDK |
| `install/uninstall` | `install/uninstall` | Minimal agent set in V1; grows later |
| _(MCP-only)_ `trace` | **`trace <from> <to>` CLI** | **New CLI command** — contract makes it free |
| _(MCP-only)_ `node` | **`node <symbol>` CLI** | **New CLI command** |
| _(MCP-only)_ `explore` | **`explore <terms...>` CLI** | **New CLI command** (+ interactive `-i`) |

**What we deliberately do not copy:** codegraph's 8-agent installer breadth (V1 scopes to Claude Code + Cursor), and its plain-text-only rendering (we add opentui for live/interactive views). Everything else is a fresh implementation against our own core, not ported code.

---

## 5. Argument parser

Classic args via Bun/Node `util.parseArgs` or `commander` (ROADMAP §1.6). Decision deferred to implementation; the command/flag surface above is parser-agnostic. opentui is a **separate optional dependency** loaded lazily only for interactive/live commands, so a headless/CI install never pays for it.

---

## 6. References
- Tool contract each query command renders: [docs/tools.md](tools.md).
- Coverage footer semantics: [docs/progressive-indexing.md](progressive-indexing.md).
- Data behind the commands: [docs/graph-model.md](graph-model.md).
- codegraph CLI for reference (not copied): [`src/bin/codegraph.ts`](../../codegraph/src/bin/codegraph.ts).
