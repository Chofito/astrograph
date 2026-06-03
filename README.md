# Astrograph

Astrograph is a local code graph for JavaScript and TypeScript projects.

It indexes symbols, relationships, call paths, imports, inheritance, references, and file coverage into a local SQLite database, then exposes that knowledge through a small set of deterministic tools.

The goal is simple: help humans and coding agents understand a codebase without repeatedly burning time on broad grep searches and file by file spelunking.

> Local first. No network. No LLM calls. No API keys.

## What It Does

Astrograph turns a JS or TS repo into a queryable graph:

```text
source files
  TypeScript Compiler API
  symbols and edges
  SQLite plus FTS5
  CLI, MCP, future Web UI
```

It knows about:

* files, classes, interfaces, functions, methods, variables, types, components, imports, exports
* calls, imports, inheritance, implementations, references, type usage, return types, overrides
* external symbols from `node_modules` and `.d.ts` files
* unresolved and ambiguous edges, reported honestly instead of hidden
* coverage states so every answer can say whether it is complete or partial

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

Stage 1 is focused on the core graph and CLI.

```text
Core storage              done
JS and TS extraction      done
Edge resolution           done
Read tools                done
CLI                       active
Tier 1 eval harness       active
MCP server                active
3D web constellation      later stage
```

See [ROADMAP.md](ROADMAP.md) for the full staged plan and [docs/contracts.md](docs/contracts.md) for the canonical types.

## Quick Start

Install dependencies:

```bash
bun install
```

Build the local CLI binary:

```bash
bun run build
```

Optionally install it into `~/.local/bin`. The compiled binary carries the
Astrograph agent guide, so `astrograph install` can set up Claude Code, Codex,
Cursor, and opencode without needing a checkout of this repo.

```bash
bun run install:local
```

Index a project:

```bash
astrograph init /path/to/project
```

Ask questions:

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
astrograph install                 install MCP config and agent guide into hosts
astrograph uninstall               remove MCP config and agent guide from hosts
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
  storage adapters
  schema and migrations
  TS extraction
  edge resolution
  graph traversal
  read tools

packages/cli
  terminal commands
  plain text formatters
  JSON envelope output

packages/mcp
  reserved for the Stage 2 MCP server

apps/web
  reserved for the Stage 3 visual graph UI
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

Run it against another repo:

```bash
bun run eval /path/to/other/repo
```

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

* [ROADMAP.md](ROADMAP.md): product scope and staged plan
* [docs/contracts.md](docs/contracts.md): canonical public types
* [docs/cli.md](docs/cli.md): command usage, daemon, MCP install and troubleshooting
* [agents/astrograph/SKILL.md](agents/astrograph/SKILL.md): agent guidance for using Astrograph before broad text search
* [docs/graph-model.md](docs/graph-model.md): schema, IDs, indexes, resolution states
* [docs/extraction.md](docs/extraction.md): TS Compiler API extraction rules
* [docs/tools.md](docs/tools.md): tool behavior and result shapes
* [docs/testing.md](docs/testing.md): fixtures, determinism, eval harness
* [docs/progressive-indexing.md](docs/progressive-indexing.md): coverage and partiality model

Spanish mirrors exist for the roadmap and selected docs:

* [ROADMAP.es.md](ROADMAP.es.md)
* [docs/tools.es.md](docs/tools.es.md)
* [docs/progressive-indexing.es.md](docs/progressive-indexing.es.md)

## Design Principles

### Local first

Astrograph stores everything under `.astrograph/` inside the indexed project. No source code leaves your machine.

### Deterministic

IDs, query ordering, ranking, tests, and eval output are designed to be stable.

### Honest

External, unresolved, ambiguous, stale, and partial results are first class states.

### JS and TS depth first

Astrograph starts narrow so it can be accurate. More languages can come later without weakening the JS and TS foundation.

## Project Layout

```text
astrograph/
  packages/
    core/
    cli/
    mcp/
  apps/
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
