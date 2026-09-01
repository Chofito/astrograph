# ADR-004: Incremental and full indexing converge

Status: accepted
Baseline: `8c6e9ad004a491886fb396cddca0dd617c67f495`
Canonical owner: indexing architecture

## Context

Astrograph persists a graph across runs and supports filesystem watch. If a reused DB, clean index, and delta sync produce different logical graphs for the same project state, query correctness depends on history and cannot be trusted.

## Decision

For a fixed project filesystem, validated config, backend versions, and deterministic clock normalization:

```text
normalize(indexAll(emptyDb, state))
  == normalize(indexAll(previousDb, state))
  == normalize(applyDeltas(indexAll(emptyDb, priorState), priorState -> state))
```

Full index reconciles removals and membership changes. Delta resolution uses backend semantics and an explicit invalidation set; it does not directly promote edges by name.

## Implemented so far (AG-203)

The reused-versus-clean half of the equivalence is implemented and has focused tests:

```text
normalize(indexAll(emptyDb, state)) == normalize(indexAll(previousDb, state))
```

- Membership comes from `IndexEligibility` (contracts §13); a full index retires every persisted file the current membership rejects, before Pass A, through the same `retireFile()` policy sync uses.
- `normalizeIndex()` in `packages/core/src/testing/normalize.ts` is the comparison boundary. It drops exactly `updatedAt`, `indexedAt`, `modifiedAt`, and the autoincrement `edges.id`. It keeps `contentHash`, `state`, `nodeCount`, and the sorted `errors`, because a converged index must agree about *why* a file is incomplete, not merely that it exists.
- Identity is written last: `configHash`, the version keys, and `passState: "complete"` land in one transaction, and `passState: "in_progress"` is set before any mutation. An interrupted pass is therefore detectable (`status.indexInterrupted`) and the next pass forces Pass A instead of trusting content hashes.

The delta half — `applyDeltas` producing the same normalized graph — is AG-205. Backend-owned invalidation, which replaces name-based healing, is AG-204.

## Consequences

- Clean rebuild is the executable oracle for delta behavior.
- Backend config toggles are membership/semantic changes, not status-only settings.
- Removal must invalidate derived and incoming relationships before answering queries.
- Performance optimization may narrow re-resolution only after dependency correctness is proven.

## Rejected alternatives

- Require users to delete the DB after config changes: operationally fragile and violates local incremental design.
- Best-effort healing by target name: fast but history-dependent and language-incorrect.
- Rebuild everything for every watcher event: correct baseline fallback, but fails the incremental performance goal.

## Verification

- Table-driven add/modify/remove/rename/config-toggle scenarios.
- Normalize and compare clean, reused-full, and delta graphs.
- Assert no dangling targets and equivalent file states/errors.
- Include same-name symbols across languages/namespaces/modules.
- Measure that one-file sync does not rebuild unrelated language projects after correctness is established.

## Current deviations

`DEV-001`, `DEV-003`, and `DEV-011`.

