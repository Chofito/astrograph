# ADR-003: Coverage honesty is query-domain and capability aware

Status: accepted
Baseline: `8c6e9ad004a491886fb396cddca0dd617c67f495`
Canonical owner: query architecture

## Context

Per-file coverage alone cannot make every query honest. A local `callees` lookup and a global reverse `callers` lookup have different omission risks. Scoping coverage to rows that happened to be returned can make a globally incomplete answer look complete.

## Decision

Each tool defines a completeness domain and required backend capabilities. `ToolMeta.partial` is true whenever missing coverage, missing capability, unresolved/ambiguous evidence, or a bounded search can materially change the presented claim.

Payload omission does not permit evidence omission: target-null edges may be absent from node-shaped results, but their relevance must be explained in metadata.

## Lifecycle is not trust (AG-201)

`pending`, `parsed`, and `resolved` are lifecycle states and nothing else. Trust is carried by
diagnostic codes, classified by a single versioned, exhaustive registry into `coverage_gap`,
`semantic_uncertainty`, `configuration`, and `diagnostic`, plus an independent
`degradesCompleteness` flag.

Consequences that bind the rest of this ADR:

- A `resolved` file may carry a `coverage_gap`. `partial` may therefore be true at 100% resolved coverage.
- No code path may infer behavior from an error `message`. The code is the contract.
- The registry version is part of index identity, so re-categorizing rebuilds instead of leaving persisted rows meaning something else.
- The registry says a code *can* matter; the query domain below decides whether it *does* for a given question.

## Domain rules

| Domain | Examples | Coverage rule |
|---|---|---|
| Global discovery | search, context, explore | Global index coverage affects completeness. |
| Global reverse | callers, impact | Any pending potential source makes negative/aggregate answers partial. |
| Global path | trace | Pending path participants or blocking unresolved edges make no-path partial. |
| Local outgoing | callees | Owning file state/capability plus unresolved outgoing evidence. |
| Explicit file scope | files with path/pattern | Coverage over the selected membership domain. |
| Status | status | Reports global state rather than hiding it behind partiality. |

## Implemented (AG-206)

Domains are explicit descriptors passed into `buildMeta`, and the payload no longer decides its
own completeness. Two evaluators became one: the old per-node `capabilityNotes`, which consulted
whichever backend claimed the node's language, is replaced by domain-directed evaluation that
consults every backend with files for incoming questions and only the source's backend for
outgoing ones. Causes are structured (`PartialReason`), so CLI and MCP stop substring-matching
prose to detect a capability gap, and `notes` is derived from `reasons` so both surfaces carry the
same facts.

A backend registered but holding no files in the project contributes nothing: an unused backend
must not make every answer look partial.

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

