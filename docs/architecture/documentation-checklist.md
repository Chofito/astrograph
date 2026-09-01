# Documentation checklist

Status: current
Baseline: `d536928`
Canonical owner: architecture documentation

## Purpose

Make the [maintenance rule](README.md#maintenance-rule) — a behavior change is incomplete until its canonical document is updated in the same review — checkable in a minute, by a human or an agent. This document is the process companion to `bun run docs:check`, which enforces only the mechanical half.

## Changed path → canonical document

Update the canonical owner in the **same** review. Supporting documents link to it rather than restating it.

| If the change touches | Update |
|---|---|
| `packages/core/src/types.ts` (public types) | [contracts](../contracts.md), plus the subsystem document that owns the type |
| `packages/core/src/indexer.ts` | [indexing pipeline](indexing-pipeline.md), [incremental sync](incremental-sync.md) |
| `packages/core/src/extraction/registry.ts`, a backend, or `reconcile.ts` | [backend contract](extraction/backend-contract.md), the affected [enricher document](extraction/typescript-enricher.md), [extraction overview](../extraction/overview.md) |
| `packages/core/src/extraction/tree-sitter/**` | [Pass A](extraction/tree-sitter-pass-a.md) |
| `packages/core/src/query/**`, coverage or `ToolMeta` | [queries and honesty](query-and-honesty.md), [tools](../tools.md) |
| `packages/core/src/db/**` (schema, migrations) | [storage and graph model](storage-and-graph-model.md) |
| `packages/core/src/config.ts`, config fields or defaults | [configuration and invalidation](configuration-and-invalidation.md), [contracts](../contracts.md) §9 |
| `packages/cli/**` (commands, flags, output) | [CLI surface](surfaces/cli.md), [CLI guide](../cli.md) |
| `packages/mcp/**` (tools, server behavior) | [MCP surface](surfaces/mcp.md), [MCP guide](../mcp.md) |
| `apps/site/public/install.sh`, release workflow | [distribution](operations/distribution.md), [install guide](../install.md) |
| A new or moved production module | [code map](code-map.md) |
| An architecture decision | a new ADR in [decisions](decisions/README.md) |

## Per-pull-request checklist

- [ ] `bun run docs:check` passes, or every new finding is explained in the PR body.
- [ ] Each changed path family above has its canonical document updated in this PR.
- [ ] Every new AS-IS claim cites a path or symbol; every TO-BE claim cites `ROADMAP.md`, `docs/contracts.md`, an accepted ADR, or an approved spec.
- [ ] Diagrams affected by the change were edited, not left describing the old flow.
- [ ] A deviation opened, closed, or re-scoped in [deviations](deviations.md) carries source evidence, user impact, and the verification command the user ran.
- [ ] Examples whose output is not a golden are marked illustrative, so an invented `partial: no` is never read as executed evidence.
- [ ] Rendered Mermaid was eyeballed if a diagram changed — `docs:check` proves fences balance, never that a diagram renders.

## What `docs:check` enforces

`bun run docs:check` (`scripts/docs-check.ts`) is static and fast. It checks:

- **Links and anchors** — every local Markdown link resolves to a file on disk, and every `#fragment` matches a real heading slug or HTML anchor. Links inside code fences and backticks are citations, not links, and are skipped.
- **Architecture metadata** — every file under `docs/architecture/` has an H1, a `Status:` from the document-status vocabulary (ADRs use decision status), a `Baseline:` commit, and a `Canonical owner:`.
- **Mermaid and code fences** — every fence closes. This is parse validity only.
- **Deviation IDs** — no duplicate ID in the register, and every `docs/todo/items/DEV-*.local.md` brief has a row.
- **Inventory** — the required document floor exists, and every architecture document is reachable from the architecture index.

It deliberately does **not** generate prose from code, verify that a claim is true, or render diagrams.

## Suppressions and false positives

Fix a false positive **in the checker**. If a single line genuinely must be exempt, put `<!-- docs-check: ignore-line -->` on the line above it together with the reason. Never disable a rule for a whole document class.

Findings in `*.es.md` are reported as warnings, not errors: [the architecture index](README.md#legacy-documentation-disposition) declares the Spanish mirrors stale and non-canonical, so their drift must stay visible without blocking a change to the canonical English set. Resynchronizing them is `DEV-016`/`NEW-003` work.

## CI status

`bun run docs:check` is a **required gate** in CI and in the release workflow, as of **2026-09-01**. A pull request that breaks a link, drops architecture metadata, leaves a fence open, duplicates a deviation ID, or removes a required document fails the build.

The cutover happened when the pre-existing debt reached zero errors:

| Former debt | Resolution |
|---|---|
| `docs/graph-model.md`, `docs/tools.md` cited `../../codegraph/src/**` | named rather than linked — that project is not vendored here (`NEW-003`) |
| `docs/architecture/configuration-and-invalidation.md` `Status:` was prose | `Status: mixed`, with the nuance moved into the Purpose section |
| `ROADMAP.es.md`, `docs/tools.es.md` mirror drift | still present, reported as warnings by design — the mirrors are non-canonical and must never gate the English set |

If you need to land a change while a finding is unavoidable, fix it in the checker or suppress the single line with `<!-- docs-check: ignore-line -->` and a reason. Do not reintroduce `--warn-only`.

## Related documents

- [Architecture index and governance](README.md)
- [Document template](document-template.md)
- [Known deviations](deviations.md)
