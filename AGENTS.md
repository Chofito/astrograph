# Working on Astrograph

Astrograph is a small Bun + TypeScript project. Read [ARCHITECTURE.md](ARCHITECTURE.md) before
changing anything under `src/core/`; it is one page and describes the whole design. Check
[DECISIONS.md](DECISIONS.md) before proposing an approach that sounds obvious: it may already have
been tried and measured.

## Where information lives

| Question | File | Updated by |
|---|---|---|
| What is it, how do I use it? | `README.md`, `apps/site/content/docs/` | the change that alters behavior |
| How does it work inside? | `ARCHITECTURE.md` | the change that touches `src/core/` |
| Why was it decided this way? | `DECISIONS.md` (append-only) | the change that makes a non-obvious decision |
| Where is it going? | `ROADMAP.md` | the owner, at the end of each release |
| What changed in a release? | `CHANGELOG.md` | every user-visible change |
| What is the next concrete task? | GitHub issues | — |

Do not create other documentation files.

## Choosing what to build

- Work on what is in **Now** in `ROADMAP.md`, or on an issue the owner points to. If a task is
  not there, say so before starting.
- A new feature needs a reason in terms of the roadmap metric (fewer tool calls / tokens, right
  answers) or a concrete pain from real use. Otherwise propose it for *Later* instead of building it.
- Anything listed under *Not doing* needs a new DECISIONS.md entry first.
- One branch at a time, merged to `main` before the next starts. Reviews go in the PR description.

## Ground rules

- **Keep it small.** Prefer deleting code to adding layers. No new abstractions for a single
  caller, no feature flags, no compatibility shims for old index formats (bump `SCHEMA_VERSION`).
- **Code is the source of truth.** Docs are `README.md` (users), `ARCHITECTURE.md` (design) and
  this file. Update the relevant one in the same change; do not add new docs trees, stage plans,
  review logs or handoff files.
- **Tests are run by the owner.** Write or update tests under `test/`, then ask the owner to run
  `bun test` and share the output. Do not run the test suite yourself. Typecheck
  (`bun run typecheck`) and lint (`bun run check`) are fine to run.
- **Indexing performance is a budget.** For changes to `scan`, `extract`, `indexer` or `link`,
  run `bun run bench <repo>...` (clones, not working copies) before and after; more than 20%
  slower or bigger is a regression to fix or justify in DECISIONS.md.
- **Never write outside `.astrograph/`** of the indexed project, and never store source code in
  the index.

## Commands

```bash
bun install
bun run dev -- <command>   # run the CLI from source, e.g. `bun run dev -- callers foo`
bun run typecheck
bun run check              # `bun run check:fix` to apply formatting
bun run build              # dist/astrograph
bun run bench <repo>...    # indexing time / peak memory vs. the saved baseline (--save to record)
```

## Where things go

- New query → `src/core/graph.ts` (data) + `src/format.ts` (text) + one entry in `src/tools.ts`.
- New reference pattern → the language extractor in `src/core/extract/`, a case in
  `test/extract.test.ts`, and the resolution rule in `src/core/link.ts` + `ARCHITECTURE.md`.
- New language → a grammar in `src/core/parser.ts`, an extractor, and resolution rules.
