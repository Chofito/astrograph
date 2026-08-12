# ADR-003: Coverage honesty is query-domain and capability aware

Status: accepted
Baseline: `8c6e9ad004a491886fb396cddca0dd617c67f495`
Canonical owner: query architecture

## Context

Per-file coverage alone cannot make every query honest. A local `callees` lookup and a global reverse `callers` lookup have different omission risks. Scoping coverage to rows that happened to be returned can make a globally incomplete answer look complete.

## Decision

Each tool defines a completeness domain and required backend capabilities. `ToolMeta.partial` is true whenever missing coverage, missing capability, unresolved/ambiguous evidence, or a bounded search can materially change the presented claim.

Payload omission does not permit evidence omission: target-null edges may be absent from node-shaped results, but their relevance must be explained in metadata.

## Domain rules

| Domain | Examples | Coverage rule |
|---|---|---|
| Global discovery | search, context, explore | Global index coverage affects completeness. |
| Global reverse | callers, impact | Any pending potential source makes negative/aggregate answers partial. |
| Global path | trace | Pending path participants or blocking unresolved edges make no-path partial. |
| Local outgoing | callees | Owning file state/capability plus unresolved outgoing evidence. |
| Explicit file scope | files with path/pattern | Coverage over the selected membership domain. |
| Status | status | Reports global state rather than hiding it behind partiality. |

## Consequences

- Negative answers often remain partial longer than positive answers.
- Coverage may be global even when the payload is small.
- Capability notes are part of the public trust contract.
- Bounded traversal/limits must be distinguishable from fully exhausted search when material.

## Rejected alternatives

- Scope coverage to returned files: circular and falsely optimistic.
- Mark every query globally partial until 100%: honest but unnecessarily weak for truly local operations.
- Treat `resolved` file state as semantic equality across backends: ignores capability differences.

## Verification

- Multi-file fixtures with pending omitted files for every global tool.
- No-path/no-call cases with unresolved edges.
- Pass-A-only backend capability gaps.
- Ambiguous lookup selection and notes.
- Limit/depth truncation signaling where it changes completeness.

## Current deviations

`DEV-004` and `DEV-005`.

