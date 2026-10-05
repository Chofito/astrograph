# Contributing

Thanks for helping. The project is intentionally small; please keep changes focused.

1. Read [ARCHITECTURE.md](ARCHITECTURE.md) and [AGENTS.md](AGENTS.md) (the rules apply to humans too).
2. `bun install`, make the change, add or update a test in `test/`.
3. `bun run typecheck && bun run check && bun test`.
4. For changes to the indexing path, include before/after timing and peak memory
   (`/usr/bin/time -l bun src/bin.ts index --force`) on a real repository in the PR.
5. Update `README.md` / `ARCHITECTURE.md` / `CHANGELOG.md` when behavior changes.

Bug reports are most useful with a minimal snippet of source that resolves wrongly and the
output of `astrograph callers <symbol>` or `astrograph status`.
