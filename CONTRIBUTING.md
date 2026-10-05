# Contributing

Thanks for helping. The project is intentionally small; please keep changes focused.

1. Read [ARCHITECTURE.md](ARCHITECTURE.md) and [AGENTS.md](AGENTS.md) (the rules apply to humans too).
   For a feature, check that it fits [ROADMAP.md](ROADMAP.md) and is not ruled out in
   [DECISIONS.md](DECISIONS.md); if unsure, open an issue first.
2. `bun install`, make the change, add or update a test in `test/`.
3. `bun run typecheck && bun run check && bun test`.
4. For changes to the indexing path, include `bun run bench` output (before/after) in the PR.
5. Update `README.md` / `ARCHITECTURE.md` / `CHANGELOG.md` when behavior changes.

Bug reports are most useful with a minimal snippet of source that resolves wrongly and the
output of `astrograph callers <symbol>` or `astrograph status`.
