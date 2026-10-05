# Working on Astrograph

Astrograph is a small Bun + TypeScript project. Read [ARCHITECTURE.md](ARCHITECTURE.md) before
changing anything under `src/core/`; it is one page and describes the whole design.

## Ground rules

- **Keep it small.** Prefer deleting code to adding layers. No new abstractions for a single
  caller, no feature flags, no compatibility shims for old index formats (bump `SCHEMA_VERSION`).
- **Code is the source of truth.** Docs are `README.md` (users), `ARCHITECTURE.md` (design) and
  this file. Update the relevant one in the same change; do not add new docs trees, stage plans,
  review logs or handoff files.
- **Tests are run by the owner.** Write or update tests under `test/`, then ask the owner to run
  `bun test` and share the output. Do not run the test suite yourself. Typecheck
  (`bun run typecheck`) and lint (`bun run check`) are fine to run.
- **Indexing performance is a feature.** For changes to `scan`, `extract`, `indexer` or `link`,
  compare `/usr/bin/time -l bun src/bin.ts index --force` on a real repository before and after.
- **Never write outside `.astrograph/`** of the indexed project, and never store source code in
  the index.

## Commands

```bash
bun install
bun run dev -- <command>   # run the CLI from source, e.g. `bun run dev -- callers foo`
bun run typecheck
bun run check              # `bun run check:fix` to apply formatting
bun run build              # dist/astrograph
```

## Where things go

- New query → `src/core/graph.ts` (data) + `src/format.ts` (text) + one entry in `src/tools.ts`.
- New reference pattern → the language extractor in `src/core/extract/`, a case in
  `test/extract.test.ts`, and the resolution rule in `src/core/link.ts` + `ARCHITECTURE.md`.
- New language → a grammar in `src/core/parser.ts`, an extractor, and resolution rules.
