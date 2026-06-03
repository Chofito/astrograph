# Astrograph CLI Guide

This guide explains how to use Astrograph from the terminal: indexing a project,
keeping the graph fresh, installing the MCP server into coding agents, and asking
questions with the read commands.

Astrograph is local first. It writes an index into the target project's
`.astrograph/` directory and does not send code over the network.

## Quick Start

Install dependencies in the Astrograph repo:

```bash
bun install
```

Build the CLI:

```bash
bun run build
```

Optionally place the compiled binary in `~/.local/bin`. The compiled binary
carries the Astrograph agent guide, so `astrograph install` can configure host
skills/rules without needing a checkout of this repo.

```bash
bun run install:local
```

Index a JS or TS project:

```bash
astrograph init /path/to/project
```

Ask questions:

```bash
astrograph search "use account" -p /path/to/project
astrograph callers useAccount -p /path/to/project
astrograph callees AccountScreen -p /path/to/project
astrograph context "how does checkout submit an order?" -p /path/to/project
astrograph trace LoginScreen refreshToken -p /path/to/project
```

When you are already inside an indexed project, `-p` is usually unnecessary.
Astrograph walks upward from the current directory until it finds `.astrograph/`.

## Mental Model

Astrograph has three layers:

| Layer | What it does | Common commands |
|---|---|---|
| Index | Builds or refreshes `.astrograph/graph.db` | `init`, `index`, `sync`, `daemon` |
| Read tools | Query the graph and print human friendly output | `search`, `context`, `callers`, `callees`, `trace` |
| Agent setup | Installs or removes the MCP server config | `install`, `uninstall`, `serve --mcp` |

Use `init` once per project, `sync` when files changed, and `daemon` when you want
Astrograph to keep the index fresh while you work.

## Project Files

Astrograph creates this directory inside every indexed project:

```text
.astrograph/
  graph.db
  config.json
  daemon.json
  daemon.log
```

`graph.db` is the SQLite graph. `config.json` is optional project config.
`daemon.json` and `daemon.log` exist only when the background daemon is running or
has run before.

## Lifecycle Commands

### `astrograph init [path]`

Create `.astrograph/` and index the project.

```bash
astrograph init
astrograph init /path/to/project
```

Useful flags:

| Flag | Meaning |
|---|---|
| `--no-index` | Create `.astrograph/` without indexing yet |
| `-d, --detached` | Start the background daemon after creating the project index |
| `-v, --verbose` | Show fuller output where supported |

Use `--no-index` when you want to create config first:

```bash
astrograph init --no-index
```

Then edit `.astrograph/config.json`, and run:

```bash
astrograph index
```

Use `--detached` when you want Astrograph to index in the background and keep
watching for changes:

```bash
astrograph init /path/to/project --detached
```

### `astrograph index [path]`

Rebuild or refresh the graph for the whole project.

```bash
astrograph index
astrograph index /path/to/project
```

Useful flags:

| Flag | Meaning |
|---|---|
| `-f, --force` | Re-extract files even if their content hash did not change |
| `-q, --quiet` | Suppress normal output |
| `-v, --verbose` | Show fuller output where supported |

If the daemon is running, `index` exits with an error. Stop the daemon first so
there is only one writer:

```bash
astrograph stop
astrograph index -f
```

### `astrograph sync [path]`

Apply file changes since the last index. This is the command to run after normal
editing when you are not using the daemon.

```bash
astrograph sync
astrograph sync /path/to/project
```

It reports added, modified, and removed files:

```text
Synced  +1  ~3  -0
```

Use `-q, --quiet` for scripts or git hooks:

```bash
astrograph sync -q
```

Like `index`, `sync` refuses to run while the daemon is active.

### `astrograph status [path]`

Show graph health, coverage, backend details, pending sync data, and daemon state.

```bash
astrograph status
astrograph status /path/to/project
astrograph status --json
```

Typical output:

```text
Astrograph Status
* files      248
* nodes      5321
* edges      11042
* coverage   248/248 resolved (0 parsed, 0 pending)
* backend    sqlite
* journal    wal
* daemon     running (pid 12345, since 12m)

coverage 248/248 resolved
partial: no
```

### `astrograph uninit [path]`

Remove `.astrograph/` from a project.

```bash
astrograph uninit
astrograph uninit /path/to/project
```

Use `-f, --force` to skip the confirmation prompt:

```bash
astrograph uninit -f
```

This deletes the local graph. It does not modify source files.

### `astrograph unlock [path]`

Remove stale lock files if a previous writer crashed.

```bash
astrograph unlock
```

Use this only when Astrograph says a lock is stale. It removes:

```text
.astrograph/lock
.astrograph/index.lock
```

### `astrograph stop [path]`

Stop the background daemon for a project.

```bash
astrograph stop
astrograph stop /path/to/project
```

## The Daemon

The daemon keeps the index fresh while you work. It starts a watcher and sends
file change batches through the same single writer path as `sync`.

Start it from `init`:

```bash
astrograph init /path/to/project --detached
```

Or run the internal daemon command directly during development:

```bash
astrograph daemon --path /path/to/project
```

Most users should prefer `init --detached`.

### What Happens on Start

On startup, the daemon checks whether the project is already indexed:

| State | Behavior |
|---|---|
| Empty or missing graph | Runs `indexAll()` once |
| Existing graph | Runs `sync()` to reconcile deltas |

After that, it starts the watcher. This avoids full reindexing every time the
daemon starts.

### What Happens on File Change

The watcher records create, modify, and delete events for source files, then
debounces them before syncing:

```text
Syncing 2 changed file(s): src/a.ts, src/b.ts
Synced +0 ~2 -0 from 2 event(s)
```

Ignored directories include:

```text
node_modules/
.git/
.astrograph/
dist/
```

Project `exclude` config is also honored.

### Logs

Detached daemon output goes to:

```text
.astrograph/daemon.log
```

Watch it while debugging:

```bash
tail -f /path/to/project/.astrograph/daemon.log
```

You should see:

```text
Daemon starting
Existing index found: ...
Reconciled existing index: ...
Starting watcher
Watcher ready
```

If the watcher cannot start on the filesystem, the log says so. In that case, run
`astrograph sync` manually after edits or restart the daemon from a supported local
filesystem.

### Single Writer Rule

Only one process should write to the same SQLite graph at a time.

While the daemon is running:

| Command | Behavior |
|---|---|
| `index` | Refuses to run |
| `sync` | Refuses to run |
| `init` with indexing | Refuses to run |
| MCP server | Opens read-only from a freshness perspective and does not start its own watcher |

This keeps SQLite WAL usage predictable and avoids competing writers.

## Read Commands

All read commands accept:

| Flag | Meaning |
|---|---|
| `-p, --path <path>` | Project path. Defaults to nearest parent with `.astrograph/` |
| `-j, --json` | Print the full `{ data, meta }` envelope |
| `--fail-on-partial` | Exit with code `3` when the answer is partial |

The footer tells you whether the answer is complete:

```text
coverage 248/248 resolved
partial: no
```

If files are pending or coverage is incomplete, the footer says so. Treat partial
answers as useful but not authoritative.

### `astrograph search <query>`

Find symbols by name, qualified name, signature, or indexed text.

```bash
astrograph search useAccount
astrograph search "how does add to cart work"
astrograph search "session token" --limit 20
```

Useful flags:

| Flag | Meaning |
|---|---|
| `-l, --limit <n>` | Max results. Default `10` |
| `-k, --kind <kind>` | Restrict by node kind, for example `function`, `class`, `component` |
| `--lang <lang>` | Restrict by `typescript`, `tsx`, `javascript`, or `jsx` |
| `--no-generated` | Hide generated symbols |

Aliases:

```bash
astrograph query useAccount
astrograph q useAccount
```

### `astrograph context <task>`

Build ranked task context. This combines search, graph neighborhood expansion,
ranking, and optional code blocks.

```bash
astrograph context "how does session refresh work?"
astrograph context "why does checkout fail?" --budget 3000
astrograph context "auth flow" --max-symbols 12 --no-code
```

Useful flags:

| Flag | Meaning |
|---|---|
| `-n, --max-symbols <n>` | Max symbols in the context. Default `20` |
| `--budget <tokens>` | Approximate token budget for included code |
| `--no-code` | Return symbols and graph without source blocks |
| `-f, --format markdown|json` | Output format. `json` is equivalent to `--json` |

Use `context` when you are about to work on a feature or bug and want the graph to
surface the likely relevant symbols without dumping the whole repo.

### `astrograph callers <symbol>`

Show who calls or references a symbol.

```bash
astrograph callers useAccount
astrograph callers submitOrder --limit 50
```

Useful flags:

| Flag | Meaning |
|---|---|
| `-l, --limit <n>` | Max results. Default `20` |
| `--include-external` | Include external symbols from `node_modules` and `.d.ts` files |

By default, external symbols are hidden so project results do not get drowned out.

### `astrograph callees <symbol>`

Show what a symbol calls.

```bash
astrograph callees AccountScreen
astrograph callees checkout --include-external
```

Useful flags:

| Flag | Meaning |
|---|---|
| `-l, --limit <n>` | Max results. Default `20` |
| `--include-external` | Include external library calls |

Use this to understand dependencies from a function, hook, method, or component.

### `astrograph impact <symbol>`

Show reverse impact from a symbol. This is useful before refactors.

```bash
astrograph impact updateSession
astrograph impact ProductService --depth 4
```

Useful flags:

| Flag | Meaning |
|---|---|
| `-d, --depth <n>` | Traversal depth. Default `2` |
| `--include-external` | Include external symbols |

### `astrograph trace <from> <to>`

Find a path from one symbol to another.

```bash
astrograph trace LoginScreen refreshToken
astrograph trace CheckoutScreen submitOrder --max-depth 6
```

Useful flags:

| Flag | Meaning |
|---|---|
| `-d, --max-depth <n>` | Max traversal depth |

If no path is found, Astrograph still returns the endpoints and useful nearby code
when available.

### `astrograph node <symbol>`

Inspect one symbol.

```bash
astrograph node useAccount
astrograph node useAccount --code
```

Useful flags:

| Flag | Meaning |
|---|---|
| `-c, --code` | Include the source block |

### `astrograph explore <terms...>`

Group related code blocks by file.

```bash
astrograph explore session refresh token
astrograph explore checkout cart --max-files 8
```

Useful flags:

| Flag | Meaning |
|---|---|
| `--max-files <n>` | Max files to include. Default `12` |

Use this when you have a few rough terms and want a compact file-oriented view.

### `astrograph files`

List indexed files and their coverage state.

```bash
astrograph files
astrograph files --filter src/features
astrograph files --pattern "*.tsx"
astrograph files --format flat --no-metadata
```

Useful flags:

| Flag | Meaning |
|---|---|
| `--filter <dir>` | Restrict to a directory or path prefix |
| `--pattern <glob>` | Restrict by glob |
| `--format tree|flat|grouped` | Output shape. Default `tree` |
| `--max-depth <n>` | Limit tree depth |
| `--no-metadata` | Hide per-file metadata |

## MCP Server

Astrograph can run as a stdio MCP server:

```bash
astrograph serve --mcp --path /path/to/project
```

The MCP server exposes the same graph tools to agent hosts. It performs a
connect-time reconcile, and by default watches files while the session is open.

Disable the watcher:

```bash
astrograph serve --mcp --path /path/to/project --no-watch
```

If the daemon is already running for the project, the MCP server does not start a
second watcher and does not mutate the index. It trusts the daemon as the freshness
owner.

## Agent Guidance

Astrograph keeps a small agent guide at:

```text
agents/astrograph/SKILL.md
```

It tells agents when to use Astrograph instead of broad grep/read loops, how to
pick the right graph tool, and how to interpret coverage/staleness banners.

`astrograph install` installs this guide into the selected harnesses along with
the MCP config. You normally do not need to run anything else.

By default, the guide content is embedded in the Astrograph binary. For custom
dev setups that want live symlinks to a working tree, set
`ASTROGRAPH_AGENT_GUIDE=/absolute/path/to/agents/astrograph` before running
`astrograph install`.

For local dogfooding inside this repo, you can also refresh the repo-local
symlinks directly:

```bash
scripts/link-agent-guide.sh
```

That script links one source of truth into local host-specific locations:

```text
.claude/skills/astrograph
.codex/skills/astrograph
.cursor/rules/astrograph.mdc
.opencode/AGENTS.md
```

This guide is separate from MCP config. MCP config tells the host how to start
Astrograph; the guide nudges the agent to use Astrograph before reaching for
generic text search when the task is structural.

## Installing MCP Config

Use `install` to add Astrograph to supported agent hosts. It writes the MCP server
config and installs the Astrograph agent guide for that host when supported.

```bash
astrograph install
```

By default, this targets all supported hosts globally:

```text
claude, cursor, codex, opencode
```

Useful flags:

| Flag | Meaning |
|---|---|
| `-t, --target <ids>` | Comma-separated targets |
| `-l, --location <scope>` | `global` or `local`. Default `global` |
| `--command <bin>` | Override the binary path. Default `astrograph` |
| `-y, --yes` | Skip confirmation |
| `--print-config <id>` | Print the merged config for one target without writing |

Examples:

```bash
astrograph install --target claude --yes
astrograph install --target cursor,opencode --location local
astrograph install --target codex --command /Users/me/.local/bin/astrograph --yes
astrograph install --print-config claude
```

Supported targets:

| Target | Global config | Local config | Agent guide |
|---|---|---|---|
| `claude` | `~/.claude.json` | `./.mcp.json` | `.claude/skills/astrograph` |
| `cursor` | `~/.cursor/mcp.json` | `./.cursor/mcp.json` | `.cursor/rules/astrograph.mdc` |
| `codex` | `~/.codex/config.toml` | Not supported | `.codex/skills/astrograph` |
| `opencode` | `$XDG_CONFIG_HOME/opencode/opencode.jsonc` or `~/.config/opencode/opencode.jsonc` | `./opencode.jsonc` | `AGENTS.md` |

For Claude global config, Astrograph creates a `.bak` backup before writing when
the file already exists.

Installing MCP config does not index every project automatically. Each project
still needs:

```bash
astrograph init /path/to/project
```

or:

```bash
astrograph init /path/to/project --detached
```

## Uninstalling MCP Config

Remove Astrograph from agent host configs:

```bash
astrograph uninstall
```

Useful flags:

| Flag | Meaning |
|---|---|
| `-t, --target <ids>` | Comma-separated targets |
| `-l, --location <scope>` | `global` or `local`. Default `global` |
| `-y, --yes` | Skip confirmation |

Examples:

```bash
astrograph uninstall --target claude --yes
astrograph uninstall --target cursor,opencode --location local
```

Uninstall removes the `astrograph` MCP entry and Astrograph-owned guide files.
It preserves other MCP servers and unrelated config. If a guide destination is a
real file with custom content, uninstall leaves it alone.

## JSON and Scripting

Every read command supports `--json`:

```bash
astrograph search useAccount --json
astrograph context "auth flow" --json
astrograph status --json
```

The JSON shape is always:

```ts
{
  data: unknown;
  meta: {
    coverage: {
      total: number;
      resolved: number;
      parsed: number;
      pending: number;
    };
    partial: boolean;
    pendingFiles?: string[];
    notes?: string[];
  };
}
```

Use `--fail-on-partial` in CI or automation:

```bash
astrograph context "checkout flow" --fail-on-partial
```

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Command error |
| `2` | No `.astrograph/` index found |
| `3` | Partial result when `--fail-on-partial` was requested |

## Project Config

Optional project config lives at:

```text
.astrograph/config.json
```

Supported keys:

```json
{
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["node_modules", "dist"],
  "maxFileSizeBytes": 2000000,
  "kinds": ["function", "class", "component"],
  "watchDebounceMs": 300,
  "tsconfigPath": "tsconfig.json"
}
```

Common use cases:

| Need | Config |
|---|---|
| Avoid generated folders | Add them to `exclude` |
| Watch slower filesystems | Increase `watchDebounceMs` |
| Use a nonstandard TS config | Set `tsconfigPath` |
| Skip huge generated files | Lower or tune `maxFileSizeBytes` |

After changing config, run:

```bash
astrograph sync
```

or restart the daemon.

## Recommended Workflows

### One-time local use

```bash
astrograph init
astrograph context "how does auth work?"
```

### Daily project work

```bash
astrograph init --detached
astrograph status
astrograph callers useAccount
tail -f .astrograph/daemon.log
```

### Manual freshness

```bash
astrograph init
# edit files
astrograph sync
astrograph impact ChangedThing
```

### Agent setup

```bash
bun run build
bun run install:local
astrograph install --target claude,codex --yes
astrograph init /path/to/project --detached
```

## Troubleshooting

### No index found

Run:

```bash
astrograph init /path/to/project
```

or pass the project path:

```bash
astrograph search useAccount -p /path/to/project
```

### The daemon does not seem to react

Check the log:

```bash
tail -f .astrograph/daemon.log
```

Look for `Watcher ready`, `Syncing`, and `Synced` lines.

If you see `Watcher unavailable`, use manual `sync` or restart the daemon from a
local filesystem.

### `index` or `sync` refuses to run

The daemon is probably active. Stop it first:

```bash
astrograph stop
astrograph sync
```

### Results are too noisy

Project symbols are the default for `callers`, `callees`, `context`, and
`explore`. If external symbols still appear noisy, prefer narrower symbol names,
`search --kind`, or `context --max-symbols`.

Use external results only when you need them:

```bash
astrograph callees useThing --include-external
```

### The MCP host cannot find `astrograph`

Use an absolute command path:

```bash
astrograph install --target claude --command /Users/me/.local/bin/astrograph --yes
```

Preview first:

```bash
astrograph install --print-config claude --command /Users/me/.local/bin/astrograph
```

### I want to remove everything

Remove MCP entries:

```bash
astrograph uninstall --yes
```

Remove the project index:

```bash
astrograph uninit -f
```

## Command Reference

| Command | Purpose |
|---|---|
| `init [path]` | Create `.astrograph/` and index by default |
| `index [path]` | Reindex project files |
| `sync [path]` | Index changed files |
| `status [path]` | Show graph health |
| `uninit [path]` | Remove `.astrograph/` |
| `unlock [path]` | Remove stale lock files |
| `stop [path]` | Stop background daemon |
| `daemon --path <dir>` | Internal background writer |
| `search <query>` | Find symbols |
| `context <task>` | Build ranked task context |
| `callers <symbol>` | Show callers |
| `callees <symbol>` | Show callees |
| `impact <symbol>` | Show reverse impact |
| `trace <from> <to>` | Find a graph path |
| `node <symbol>` | Inspect one symbol |
| `explore <terms...>` | Group related code by file |
| `files` | List indexed files |
| `serve --mcp` | Run the stdio MCP server |
| `install` | Add MCP config and agent guide to hosts |
| `uninstall` | Remove MCP config and agent guide from hosts |
