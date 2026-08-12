# ADR-001: Tree-sitter Pass A owns structural project nodes

Status: accepted
Baseline: `8c6e9ad004a491886fb396cddca0dd617c67f495`
Canonical owner: extraction architecture

## Context

Astrograph needs stable symbol identity across languages and across progressive states. Letting two producers independently replace a file's node set creates ID churn, dangling cross-file edges, and language-specific orchestration in the indexer.

## Decision

For every registered language, Tree-sitter Pass A is the structural base. It emits only declarations whose ID it can reproduce deterministically, plus structural `contains` edges. A complement enricher may update matching nodes and insert declarations Pass A deliberately withheld, but it must not delete Pass A nodes.

`dropped > 0` is an identity/subset defect. It is reported and the structural row remains until the mapping is corrected.

## Consequences

- Node identity is shared infrastructure, not backend-private convention.
- Pass A may be intentionally conservative for overloads or ambiguous kinds.
- Semantic edges can be replaced without replacing stable project nodes.
- Every complement backend requires parity verification.
- A backend without an enricher still produces a useful resolved structural graph.

## Rejected alternatives

- **Semantic producer replaces all nodes:** simpler per backend, but breaks stable references and doubles ownership.
- **Union nodes by name/location heuristics:** cannot prove identity and hides collisions.
- **Tree-sitter only for unsupported languages:** makes the core's structural invariant conditional and encourages divergent pipelines.

## Implementation obligations

- Run Pass A for every eligible file.
- Reconcile by ID, never bare name.
- Record node producer metadata and edge provenance separately.
- Keep extension-to-backend routing deterministic.
- Exclude oversized/unsupported files before backend project loading.

## Verification

- Non-vacuous Pass A fixtures for every backend.
- Pass A IDs are a subset of complement-enricher IDs.
- No Pass-A-only row is deleted during reconciliation.
- IDs shared by parsed/resolved snapshots are unchanged.
- Full pipeline, not only helper functions, reports zero dropped nodes.

## Current deviations

`DEV-002`, `DEV-007`, and `DEV-014` in [deviations](../deviations.md).

