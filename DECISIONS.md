# Decisions

Append-only. One entry per decision that is not obvious from the code, newest first. When a
decision is reversed, add a new entry that points to the old one; do not edit history.

Format: **date — decision.** *Why:* … *Revisit if:* …

---

**2026-10-05 — Rewrite instead of refactoring 0.1.**
*Why:* the 0.1 line had ~19k lines of code, ~18k of tests and fixtures, and 97 docs files on a
43-commit branch that never merged; its core (the TypeScript compiler) caused the memory
problem, so fixing it meant rewriting the core anyway. The CLI commands, MCP tool names and the
installer were kept. The 0.1 state is preserved on `refactor/tree-sitter-enrichers`.
*Revisit if:* never; this is history.

**2026-10-05 — No TypeScript compiler; types only from what the source declares.**
*Why:* a `ts.Program` with a type checker kept the whole project in memory (~3 GB on real repos)
and needed two sources of truth (tree-sitter and the compiler) to be reconciled. Declared types,
`new`, return types and fields cover most calls agents ask about; the rest is labeled
`inferred` / `ambiguous` instead of guessed.
*Revisit if:* the A/B eval shows wrong or missing answers caused specifically by untyped receivers.

**2026-10-05 — tree-sitter through WASM (web-tree-sitter + tree-sitter-wasms).**
*Why:* grammars embed in the `bun build --compile` binary; no native addons per platform.
*Revisit if:* a grammar we need is not available as WASM, or parsing speed becomes the bottleneck.

**2026-10-05 — No extraction workers.**
*Why:* measured on a ~3.7k-file repo: in-process 480 MB peak; one worker recycled every 800 files
823 MB, every 300 files 895 MB. Bun does not return a terminated worker's memory. `TreeCursor`
walking and `bun --smol` did not lower the peak either.
*Revisit if:* Bun releases worker memory on terminate, or indexing time (not memory) becomes the problem.

**2026-10-05 — No daemon, watcher or lock files; sync before each query.**
*Why:* a sync with no changes is a stat walk (~50 ms on ~300 files, a few hundred ms on thousands).
SQLite in WAL mode with a busy timeout serializes concurrent writers. The daemon, pid files, locks
and watcher of 0.1 were most of its lifecycle complexity.
*Revisit if:* sync latency on large repos makes MCP calls noticeably slow.

**2026-10-05 — The index is a disposable cache; no migrations.**
*Why:* it can always be rebuilt from source in seconds. `SCHEMA_VERSION` mismatch → delete and rebuild.
*Revisit if:* rebuilds take minutes on repositories people actually use.

**2026-10-05 — Source code is not stored in the index.**
*Why:* smaller index, nothing stale to show, and less sensitive data at rest. Code in results is
read from disk at query time.
*Revisit if:* never planned.

**2026-10-05 — One package; CLI and MCP share one tool catalog; text output only.**
*Why:* the same operation should not be implemented, validated and documented twice. Output is
written for agents (compact text with `path:line` and `#id`s). `--json` was dropped: nothing used it.
*Revisit if:* a real consumer needs structured output (then add it once, in `tools.ts`).

**2026-10-05 — Documentation is a fixed set of files.**
*Why:* 0.1 accumulated 13k lines of docs that drifted from the code. Now: README (users), the site
(user reference), ARCHITECTURE (design), DECISIONS (why), ROADMAP (direction), AGENTS
(working rules), CHANGELOG. Work items live in GitHub issues; reviews live in PR descriptions.
*Revisit if:* one of these files grows past what one person can keep accurate.
