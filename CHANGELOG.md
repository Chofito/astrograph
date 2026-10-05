# Changelog

## 0.2.0 — unreleased

A rewrite. The CLI commands and the MCP tool names stay the same; the index format does not,
so existing `.astrograph/graph.db` files are rebuilt on first use.

- One package and one binary instead of `core`/`cli`/`mcp` packages.
- JS/TS no longer runs the TypeScript compiler. Everything is extracted with tree-sitter and
  linked through imports, re-exports, `tsconfig` paths, workspace packages and declared types.
  Indexing a ~4k-file repository takes ~4 s and ~500 MB peak instead of several GB.
- PHP resolves receiver types from typed params and properties, promoted constructor params,
  constructor DI assignments, `@var`, `new` and `catch`.
- References carry an explicit resolution: `exact`, `inferred`, `ambiguous`, `external`, `unresolved`.
- The MCP server re-syncs changed files before each call. The daemon, `stop`, `unlock`, `sync`
  locking and the watcher are gone.
- Removed: `--json` output, the opentui reporter, the eval/bench harnesses and the docs tree.
  Documentation is now `README.md` and `ARCHITECTURE.md`.

## 0.1.0

Public preview (never released as a binary).
