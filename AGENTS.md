# Working on Astrograph

Astrograph is a local code graph for TypeScript, JavaScript and PHP, served to coding agents over
MCP. It is a small Bun + TypeScript project: one package, one binary. Before working, read
[ROADMAP.md](ROADMAP.md) (what matters now) and, for anything under `src/core/`,
[ARCHITECTURE.md](ARCHITECTURE.md) (the whole design, one page). Check [DECISIONS.md](DECISIONS.md)
before proposing an approach that sounds obvious: it may already have been tried and measured.

**Use Astrograph on this repository.** If the `astrograph_*` MCP tools are available, explore with
them (`outline` before reading a file, `context` for "how does X work", `callers`/`impact` before
editing). If an answer is wrong or wastes tokens, say so: that is product feedback (see #2).

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

- Work on what is in **Now** in `ROADMAP.md`, or on a GitHub issue the owner points to. If a task
  is not there, say so before starting, and propose it as an issue instead.
- A new feature needs a reason in terms of the roadmap metric (fewer tool calls / tokens, right
  answers) or a concrete pain from real use. Otherwise propose it for *Later* instead of building it.
- Anything listed under *Not doing* needs a new DECISIONS.md entry first.

## Workflow

1. **One issue, one branch, one PR.** Branch from up-to-date `main` (`fix/…`, `feat/…`, `docs/…`).
   Several sessions can work in parallel on different issues, each in its own branch or worktree;
   keep PRs small so they merge quickly and do not drift.
2. Make the change with its tests and docs (see the table above), then run `bun test`,
   `bun run typecheck` and `bun run check`.
3. Commit, push, and open the PR with `gh pr create`; write the review in its description (what,
   why, how it was verified) and reference the issue (`Part of #N` / `Closes #N`).
4. When CI is green, merge with `gh pr merge --squash`.

**Pushing.** `origin` uses the owner's SSH key, which agents usually cannot use. If `git push`
fails with `Permission denied (publickey)`, push over HTTPS with the GitHub CLI token for that one
command:

```bash
git -c credential.helper= -c credential.helper='!gh auth git-credential' \
  push https://github.com/Chofito/astrograph.git HEAD:<branch>
```

That token cannot push changes under `.github/workflows/` unless it has the `workflow` scope; in
that case, or if `gh` is not authenticated, ask the owner to push. Never change the owner's git
or SSH configuration.

## Releasing

Releases are cut from `main` when a set of user-visible changes is worth shipping:

1. In a PR: bump `version` in `package.json` and add `## X.Y.Z — YYYY-MM-DD` at the top of
   `CHANGELOG.md` (the release workflow refuses a tag without that section). Merge it.
2. Tag the merge commit: `gh api repos/Chofito/astrograph/git/refs -f ref=refs/tags/vX.Y.Z -f sha=<sha>`.
3. The `Release` workflow builds four binaries and `SHA256SUMS` and publishes the GitHub release;
   `https://www.chofito.dev/astrograph/install.sh` installs the latest release. Watch it with
   `gh run watch`, then check `gh release view vX.Y.Z`.
4. At the end of a release, the owner updates *Now* in `ROADMAP.md`.

## Ground rules

- **Keep it small.** Prefer deleting code to adding layers. No new abstractions for a single
  caller, no feature flags, no compatibility shims for old index formats (bump `SCHEMA_VERSION`).
- **Code is the source of truth.** When behavior or design changes, update the file the table
  above assigns it to, in the same change.
- **Keep tests green.** Add or update tests under `test/` with every behavior change and run
  `bun test`, `bun run typecheck` and `bun run check` before finishing.
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
