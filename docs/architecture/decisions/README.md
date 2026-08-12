# Architecture decision records

Status: target
Baseline: `8c6e9ad004a491886fb396cddca0dd617c67f495`
Canonical owner: architecture governance

ADRs record target decisions that implementation and explanatory documents may cite. An ADR does not prove the baseline implements the decision; mismatches belong in `../deviations.md`.

| ADR | Status | Decision |
|---|---|---|
| [ADR-001](ADR-001-pass-a-authority.md) | accepted | Tree-sitter Pass A owns structural project nodes. |
| [ADR-002](ADR-002-enricher-contract.md) | accepted | Shipping enrichers complement Pass A through explicit, bounded contracts. |
| [ADR-003](ADR-003-coverage-honesty.md) | accepted | Completeness is query-domain and capability aware. |
| [ADR-004](ADR-004-incremental-convergence.md) | accepted | Full and incremental indexing converge to the same logical graph. |

New ADRs use: context, decision, consequences, rejected alternatives, implementation obligations, and verification.

