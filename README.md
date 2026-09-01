# Astrograph

Astrograph is a **local-first code graph** powered by **tree-sitter** for broad structural extraction and language-specific **enrichers** (JS/TS ships with TypeScript Compiler enricher for semantic depth).

It indexes symbols, relationships, call paths, imports, inheritance, references, and file coverage into a local SQLite database, then exposes that knowledge through a small set of deterministic tools — **CLI, MCP, and agent skills**.

The goal is simple: help humans and coding agents understand a codebase without repeatedly burning time on broad grep searches and file by file spelunking.

> Local first. No network. No LLM calls. No API keys.

## Status: public preview (`v0.1.0`)

This is a **preview**, not a stable 1.0. It is meant to be used on real repositories and to be honest about what it does not know.

| | |
|---|---|
| **Scope** | JS/TS and PHP, **single-app** repositories. Monorepos and multiple `tsconfig.json` files are not supported yet |
| **Public preview surfaces** | CLI, MCP tools, `.astrograph/config.json`, and the graph vocabulary. They may change deliberately between `0.x` releases — each change is in [CHANGELOG.md](CHANGELOG.md) |
| **Not a public SDK** | the `@astrograph/*` TypeScript packages, the SQLite schema, and backend internals ([contracts §12](docs/contracts.md#12-release-identity-and-compatibility)) |
| **Platforms** | macOS and Linux, x64 and arm64. No Windows binary |
| **Your index** | `.astrograph/graph.db` is disposable. Upgrades may require a rebuild; an index a newer binary wrote is refused, never misread. [Upgrade and rollback](docs/install.md#upgrade-pinning-and-rollback) |
| **Your source** | read-only. Indexing never modifies the repository it indexes |

Preview is not a licence to be wrong: unresolved and ambiguous edges stay visible, and every answer carries coverage so you can tell a complete result from a partial one. `v1.0.0` is reserved for the first stable public contract — see `ROADMAP.md` §0.

## What It Does

Astrograph turns a code repo into a queryable graph:

```text
source files (any language with a backend — JS/TS and PHP today)
  tree-sitter structural extraction (Pass A)
  language enrichers (Pass B, e.g. TS Compiler)
  symbols and edges
  SQLite plus FTS5
  CLI, MCP server, agent skills
```

It knows about:

* files, classes, interfaces, functions, methods, variables, types, components, imports, exports
* calls, imports, inheritance, implementations, references, type usage, return types, overrides
* external symbols from `node_modules` and `.d.ts` files
* unresolved and ambiguous edges, reported honestly instead of hidden
* coverage states so every answer can say whether it is complete or partial

**JS/TS has semantic depth:** the TypeScript Compiler enricher (Pass B) provides compiler-backed import/type/call resolution. **PHP has a name-resolution enricher** (FQN + `use` aliases) for heritage, type positions, calls, and `new`. Files are indexed only when a registered backend claims their extension; adding a grammar alone does not enable another language.

Language backends shipping today:

| Backend | Files | Pass B enricher |
|---|---|---|
| `typescript` | `.ts` `.tsx` `.mts` `.cts` `.js` `.jsx` `.mjs` `.cjs` | TypeScript Compiler (semantic depth) |
| `php` | `.php` | name resolution (heritage, types, calls) |

`astrograph status` lists the active backends. Adding a language means registering another backend, not changing the core.

## Why It Exists

Most coding tools start from text search. That works, but it is noisy:

```bash
rg "useAccount"
rg "AccountService"
rg "login"
```

Astrograph builds the semantic map once, locally, and lets tools ask sharper questions:

```bash
astrograph callers useAccount
astrograph callees AccountScreen
astrograph trace login submitLogin
astrograph context "how does session refresh work?"
```

Instead of dumping files, Astrograph returns structured results with locations, call sites, code slices, relationship maps, and coverage metadata.

## Current Status

Stage 1 (core graph + CLI) is complete and in polish; Stage 2 (MCP server + agent skills) is built and
in use. Stage 3 (promo/docs site) is live and being filled in.

```text
Core storage              done
JS and TS extraction      done (tree-sitter + TS Compiler enricher)
PHP extraction            done (tree-sitter + name enricher: heritage, types, calls)
Edge resolution           done
Read tools                done
CLI                       done, in polish
MCP server                done, in polish
Tier 1 eval harness       active (calibrating on real repos)
Promo/docs site           active (Stage 3)
3D explorer               parked
```

See [ROADMAP.md](ROADMAP.md) for product scope, [docs/contracts.md](docs/contracts.md) for canonical types, and the [architecture index](docs/architecture/README.md) for implemented flows, diagrams, ownership, and known deviations.

## Quick Start

### Install the binary

```bash
curl -fsSL https://www.chofito.dev/astrograph/install.sh | sh
```

That installs `astrograph` to `~/.local/bin` (ensure it is on your `PATH`). Full details: [docs/install.md](docs/install.md).

| Step | Command | What it does |
|---|---|---|
| Install the tool | `curl …/install.sh \| sh` | Puts the binary on your machine |
| Configure agents | `astrograph install` | MCP config + agent guide into Claude/Cursor/Codex/opencode |
| Index a repo | `astrograph init` | Creates `.astrograph/` and builds the graph |

### Index a project

```bash
astrograph init /path/to/project
```

### Ask questions

```bash
astrograph search "auth session"
astrograph context "how does checkout work?"
astrograph callers useCart
astrograph callees CheckoutScreen
astrograph impact updateSession
astrograph trace login refreshToken
astrograph files
astrograph status
```

Every read command also supports JSON output:

```bash
astrograph context "how does checkout work?" --json
```

### Contributors (from source)

Building the binary yourself instead of using the installer:

```bash
bun install
bun run build
bun run install:local
```

## CLI Commands

For the complete human friendly command guide, see [docs/cli.md](docs/cli.md).

### Lifecycle

```text
astrograph init [path]       create .astrograph and index by default
astrograph init [path] -d    create the index and keep it fresh in the daemon
astrograph index [path]      rebuild or refresh the graph
astrograph sync [path]       index changed files
astrograph status [path]     show graph health and coverage
astrograph stop [path]       stop the background daemon
astrograph uninit [path]     remove .astrograph
astrograph unlock [path]     clear a stale lock
```

### Queries

```text
astrograph search <query>          find symbols by name
astrograph context <task>          assemble ranked task context
astrograph node <symbol>           inspect one symbol
astrograph callers <symbol>        show project callers
astrograph callees <symbol>        show project callees
astrograph impact <symbol>         show reverse impact
astrograph trace <from> <to>       trace a call or reference path
astrograph explore <terms...>      group related code by file
astrograph files                   show indexed files
astrograph serve --mcp             run the MCP server over stdio
astrograph install                 configure agent hosts (MCP config, agent skills)
astrograph uninstall               remove MCP config and agent skills from hosts
```

By default, `callers`, `callees`, `context`, and `explore` focus on project symbols. Use `--include-external` on callers or callees when you want `node_modules` and `.d.ts` symbols in the result.

## Example Output

```text
$ astrograph callees CheckoutScreen
function useCart          src/cart/useCart.ts:12      at 34:16
function submitOrder      src/orders/submitOrder.ts:8 at 41:10

coverage 128/128 resolved
partial: no
```

```text
$ astrograph context "how does checkout submit an order?"
entry points
  CheckoutScreen      src/screens/CheckoutScreen.tsx:22
  submitOrder         src/orders/submitOrder.ts:8

included code
  src/screens/CheckoutScreen.tsx
  src/orders/submitOrder.ts
  src/cart/useCart.ts

stats
  nodes: 12
  edges: 18
  files: 3
  code blocks: 7
```

## Architecture

```text
packages/core
  storage adapters (bun:sqlite)
  schema and migrations
  tree-sitter extraction (Pass A)
  language enrichers (Pass B, e.g. TS Compiler)
  edge resolution
  graph traversal
  read tools

packages/cli
  terminal commands
  plain text formatters
  JSON envelope output

packages/mcp
  MCP server (stdio) + host installers

apps/
  site/    promo + docs site
  web/     3D explorer (PARKED)
```

The core is runtime decoupled. Bun specific code lives under:

```text
packages/core/src/adapters/bun
```

Everything else depends on injected interfaces such as storage, filesystem, globbing, and hashing.

## Tool Surface

Astrograph exposes the same structured result model across every surface.

```ts
interface ToolResult<T> {
  data: T;
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

That envelope is what keeps answers honest. If the graph is incomplete, stale, ambiguous, or low confidence, the tool result has a place to say so.

## Evaluation

Astrograph includes a deterministic Tier 1 eval harness. It indexes a repo, runs curated `search` and `context` cases, then reports recall and MRR.

```bash
bun run eval
```

The checked-in cases currently name Astrograph symbols. Passing another repository path only changes the indexed repository; it does not provide a valid comparative suite unless repository-specific cases are added. See [Testing and evaluation](docs/architecture/operations/testing-and-evaluation.md).

This is not an LLM benchmark. It measures whether the graph surfaces the symbols a human would expect to see.

## Development

Useful commands:

```bash
bun run typecheck
bun test
bun run eval
bun run build
```

Package scoped checks:

```bash
bun run --filter @astrograph/core typecheck
bun run --filter @astrograph/cli typecheck
```

## Documentation

* [docs/architecture/README.md](docs/architecture/README.md): canonical architecture map, AS-IS/TO-BE flows, ADRs, ownership, and deviations
* [ROADMAP.md](ROADMAP.md): product scope and staged plan
* [docs/contracts.md](docs/contracts.md): canonical public types
* [docs/cli.md](docs/cli.md): command usage, daemon, MCP install and troubleshooting
* [docs/install.md](docs/install.md): binary installation, platforms, checksums
* [docs/extraction/overview.md](docs/extraction/overview.md): extraction passes, enricher architecture
* [docs/extraction/tree-sitter.md](docs/extraction/tree-sitter.md): tree-sitter Pass A
* [docs/extraction/typescript.md](docs/extraction/typescript.md): TS Compiler enricher (Pass B)
* [agents/astrograph/SKILL.md](agents/astrograph/SKILL.md): agent guidance for using Astrograph before broad text search
* [docs/graph-model.md](docs/graph-model.md): schema, IDs, indexes, resolution states
* [docs/tools.md](docs/tools.md): tool behavior and result shapes
* [docs/testing.md](docs/testing.md): fixtures, determinism, eval harness
* [docs/progressive-indexing.md](docs/progressive-indexing.md): coverage and partiality model

Spanish mirrors exist for selected docs:

All three are **stale** — they predate the tree-sitter + enrichers refactor. Refer to the English originals.

* [ROADMAP.es.md](ROADMAP.es.md) — roadmap
* [docs/tools.es.md](docs/tools.es.md) — tool contract
* [docs/progressive-indexing.es.md](docs/progressive-indexing.es.md) — coverage model

## Design Principles

### Local first

Astrograph stores everything under `.astrograph/` inside the indexed project. No source code leaves your machine.

### Deterministic

IDs, query ordering, ranking, tests, and eval output are designed to be stable.

### Honest

External, unresolved, ambiguous, stale, and partial results are first class states.

### Pluggable language backends

Astrograph uses **tree-sitter** for structural extraction and **per-language enrichers** (like the TS Compiler for JS/TS) for semantic depth. A backend is a parser plus an optional enricher: JS/TS ships the Compiler enricher, PHP ships a name-resolution enricher (heritage, types, calls/`new`), and a new language is a new backend registration. Files from an enricher-less backend still reach full coverage — their edges just carry `tree-sitter` provenance instead of `ts-compiler`, so you always know how much an edge is worth.

## Project Layout

```text
astrograph/
  packages/
    core/
    cli/
    mcp/
  apps/
    site/
    web/
  docs/
  eval/
  ROADMAP.md
  README.md
```

Per indexed project:

```text
.astrograph/
  graph.db
  config.json
  daemon.json
  daemon.log
```

## License

Astrograph is authored by Rodolfo Robles.

Copyright 2026 Rodolfo Robles.

Licensed under the [Apache License 2.0](LICENSE).
