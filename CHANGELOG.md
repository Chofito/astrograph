# Changelog

## Unreleased

- JS/TS: barrels that import a name and export it on its own line (`import { User } from
  "./user"; export { User }`) now resolve. References through them used to stay unresolved. The
  index is rebuilt on first use.

## 0.2.2 — 2026-10-14

- JS/TS: type annotations and values read are references. `callers` and `impact` on a DTO,
  interface or schema constant now list the code that annotates with it or reads it
  (`x: UserDto`, `UserStatus.options`, `.map(toDto)`, `{ handler }`), tagged `type` / `use`.
  `callees` and `trace` leave types out. Only names imported or declared at the top of the file
  count. The index is rebuilt on first use.
- `astrograph install` / `uninstall` follow `CLAUDE_CONFIG_DIR` and `CODEX_HOME`: with a second
  Claude Code profile (`CLAUDE_CONFIG_DIR=~/.claude-work`), the MCP entry goes to
  `$CLAUDE_CONFIG_DIR/.claude.json` and the skill to `$CLAUDE_CONFIG_DIR/skills/`. Run it once per profile.

## 0.2.1 — 2026-10-05

- `astrograph install` now upgrades agent guides written by an older release (any file whose
  frontmatter is `name: astrograph`) instead of skipping them, so skills stay in sync with the
  binary. Files that are not Astrograph guides, such as your own `AGENTS.md`, are still never touched.

## 0.2.0 — 2026-10-05

A rewrite. The CLI commands and the MCP tool names stay the same; the index format does not,
so existing `.astrograph/graph.db` files are rebuilt on first use.

- One package and one binary instead of `core`/`cli`/`mcp` packages.
- JS/TS no longer runs the TypeScript compiler. Everything is extracted with tree-sitter and
  linked through imports, re-exports, `tsconfig` paths, workspace packages and declared types.
  Indexing a ~4k-file repository takes ~4 s and ~500 MB peak instead of several GB.
- PHP resolves receiver types from typed params and properties, promoted constructor params,
  constructor DI assignments, `@var`, `new` and `catch`.
- Token budgets: every tool takes `maxTokens` (lists also `limit`/`offset`) and fits its answer
  to it; cuts are always announced with how to continue. New `outline` tool (signatures and line
  ranges of a file, directory or class). Source is line-numbered; callers and impact are grouped
  by file; MCP answers end with their approximate token cost. `context`'s `tokenBudget` became `maxTokens`.
- Signatures are the declaration up to its body, on one line (multi-line parameter lists included).
- `context` ranking: whole-word stems, multi-word coverage, and fields ranked below code.
- References carry an explicit resolution: `exact`, `inferred`, `ambiguous`, `external`, `unresolved`.
- The MCP server re-syncs changed files before each call. The daemon, `stop`, `unlock`, `sync`
  locking and the watcher are gone.
- Removed: `--json` output, the opentui reporter, the eval/bench harnesses and the docs tree.
  Documentation is now `README.md` and `ARCHITECTURE.md`, plus `ROADMAP.md` (direction),
  `DECISIONS.md` (why) and `bun run bench` (indexing time / memory budget).

## 0.1.0

Public preview (never released as a binary).
