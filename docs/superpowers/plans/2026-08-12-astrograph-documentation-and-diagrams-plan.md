# Astrograph documentation and diagrams execution plan

Status: complete; user test run pending
Baseline: `8c6e9ad004a491886fb396cddca0dd617c67f495`
Canonical owner: architecture documentation

## Goal

Freeze feature work long enough to describe Astrograph as an implementable system specification. The result must distinguish the code that exists at the baseline (**AS-IS**) from the approved design (**TO-BE**), map every production module, explain reusable and language-specific seams, and make important flows visible with Mermaid diagrams.

This initiative changes documentation and explanatory comments only. Functional defects are recorded in `docs/architecture/deviations.md`; they are not repaired here.

## Deliverables

- `docs/architecture/README.md`: canonical navigation and document ownership.
- `glossary.md`, `code-map.md`, and `deviations.md`: shared vocabulary, complete production inventory, and implementation backlog.
- System, lifecycle, indexing, sync, storage, query, configuration, extraction, surface, and operations documents.
- Four architectural decision records covering Pass A authority, the enricher contract, coverage honesty, and incremental convergence.
- Selective TSDoc on public contracts, lifecycle boundaries, and non-obvious invariants.
- A disposition table for legacy documentation: canonical, supporting, historical, or superseded.

## Execution order

1. Record branch, baseline SHA, worktree state, and Astrograph coverage.
2. Inventory production files and assign each one a layer, reuse scope, stability, lifecycle, and canonical document.
3. Establish the architecture index, glossary, document template, and deviation format.
4. Document AS-IS project composition, indexing, sync, storage, queries, configuration, and resource ownership from source evidence.
5. Document AS-IS Tree-sitter, TypeScript, and PHP extraction separately.
6. Document CLI, MCP, agent skill, site, evaluation, tests, benchmark, build, and distribution surfaces.
7. Extract TO-BE rules from `ROADMAP.md`, `docs/contracts.md`, and approved ADRs; never infer a target solely from current code.
8. Reconcile each AS-IS/TO-BE mismatch into `deviations.md`.
9. Add Mermaid diagrams and validate their syntax and local links.
10. Add selective TSDoc without changing runtime behavior.
11. Classify and redirect legacy documents.
12. Run non-test static verification. The user runs tests.

## Documentation rules

- English is canonical. Spanish mirrors may be stale and must say so explicitly.
- Every architecture document declares status, baseline, and canonical owner.
- AS-IS claims cite repository paths or symbols from the frozen baseline.
- TO-BE claims cite the roadmap, canonical contract, or an ADR.
- Mixed diagrams are avoided; when necessary, AS-IS and TO-BE subgraphs are visibly labelled.
- Terms such as “all languages”, “exact”, “resolved”, and “complete” require explicit boundaries.
- TSDoc explains contracts, invariants, ownership, failure behavior, or extension seams. It does not narrate obvious statements.

## Completion evidence

- Every production file listed by the inventory command appears in `code-map.md`.
- Every core flow has a Mermaid diagram including important failure/partial paths.
- Every known architecture mismatch has a stable `DEV-nnn` entry.
- Public package entrypoints and main lifecycle seams carry useful TSDoc or link to the canonical contract.
- Legacy documents have an explicit disposition and no unqualified contradiction to the architecture set.
- All local Markdown links and Mermaid blocks validate.
- `git diff --check`, `bun run typecheck`, and `bun run check` are reported. Tests are requested from the user rather than run by the agent.

## Baseline record

| Item | Value |
|---|---|
| Branch | `refactor/tree-sitter-enrichers` |
| Commit | `8c6e9ad004a491886fb396cddca0dd617c67f495` |
| Worktree at freeze | clean |
| Indexed files | 203 |
| Coverage | 203 resolved, 0 parsed, 0 pending |
| Daemon | not running |

## Completion record

| Evidence | Result |
|---|---|
| Production/config inventory | 176 of 176 baseline files named exactly in `code-map.md` |
| Test/fixture inventory | 86 of 86 baseline test, fixture, and golden files named in testing/evaluation |
| Architecture set | 28 documents with status, baseline, and owner metadata |
| Diagrams | 31 Mermaid blocks; fences, supported headers, and quotes checked structurally; no Mermaid renderer is installed for full render validation |
| Links | 376 local/remote Markdown references scanned; every local target and GitHub-style anchor resolved |
| Deviations | `DEV-001` through `DEV-018`; documentation drift (`DEV-016`) resolved at this baseline |
| Type safety | `bun run typecheck` passed |
| Static quality | targeted touched core/CLI/MCP files added no Biome errors; repository-wide `bun run check` remains red with 37 errors, 134 warnings, and 7 infos (`DEV-017`) |
| Tests | not run by the implementing agent; user verification required |
