# Astrograph architecture

Status: mixed
Baseline: `8c6e9ad004a491886fb396cddca0dd617c67f495`
Canonical owner: architecture documentation

## Purpose

This directory is the navigable technical specification for Astrograph. It describes both the frozen implementation and the intended architecture without treating one as evidence for the other.

## Sources of truth

Precedence is intentional:

1. `ROADMAP.md` defines product scope and non-goals.
2. `docs/contracts.md` defines public data and tool contracts.
3. Accepted ADRs in `decisions/` define focused architecture decisions.
4. This directory explains the system and records implementation evidence.
5. Other documents are supporting or historical; their disposition is listed below.

When current code conflicts with the target, the architecture document describes both and `deviations.md` records the work. Documentation never silently converts an implementation bug into the desired contract.

## Reading paths

| Need | Start here | Continue with |
|---|---|---|
| Understand the product | [System overview](system-overview.md) | [Glossary](glossary.md) |
| Follow startup/shutdown | [Project lifecycle](project-lifecycle.md) | [Lifecycle and resources](operations/lifecycle-and-resources.md) |
| Understand indexing | [Indexing pipeline](indexing-pipeline.md) | [Incremental sync](incremental-sync.md) |
| Understand data | [Storage and graph model](storage-and-graph-model.md) | [Query and honesty](query-and-honesty.md) |
| Add a language | [Extension guide](extension-guide.md) | [Backend contract](extraction/backend-contract.md) |
| Understand JS/TS | [TypeScript enricher](extraction/typescript-enricher.md) | [Pass A](extraction/tree-sitter-pass-a.md) |
| Understand PHP | [PHP enricher](extraction/php-enricher.md) | [Pass A](extraction/tree-sitter-pass-a.md) |
| Integrate a client | [CLI](surfaces/cli.md) or [MCP](surfaces/mcp.md) | [Agent skill](surfaces/agent-skill.md) |
| Evaluate/change the system | [Testing and evaluation](operations/testing-and-evaluation.md) | [Deviations](deviations.md) |
| Locate ownership | [Code map](code-map.md) | Canonical subsystem document |

## Document status

- **Current**: describes AS-IS only.
- **Target**: describes TO-BE only and cites a contract or ADR.
- **Mixed**: contains separately labelled AS-IS and TO-BE sections.
- **Historical**: retained for context; not a current contract.

## Architecture set

- [Glossary](glossary.md)
- [Code map](code-map.md)
- [Known deviations](deviations.md)
- [System overview](system-overview.md)
- [Project lifecycle](project-lifecycle.md)
- [Full indexing](indexing-pipeline.md)
- [Incremental sync](incremental-sync.md)
- [Storage and graph model](storage-and-graph-model.md)
- [Queries and honesty](query-and-honesty.md)
- [Configuration and invalidation](configuration-and-invalidation.md)
- [Extension guide](extension-guide.md)
- Extraction: [backend contract](extraction/backend-contract.md), [Pass A](extraction/tree-sitter-pass-a.md), [TypeScript](extraction/typescript-enricher.md), [PHP](extraction/php-enricher.md)
- Surfaces: [CLI](surfaces/cli.md), [MCP](surfaces/mcp.md), [agent skill](surfaces/agent-skill.md)
- Operations: [resources](operations/lifecycle-and-resources.md), [testing/eval](operations/testing-and-evaluation.md), [distribution](operations/distribution.md)
- Decisions: [ADR index](decisions/README.md)

## Legacy documentation disposition

| Document | Disposition | Canonical replacement or role |
|---|---|---|
| `README.md` | supporting | Product overview; architecture links here |
| `ROADMAP.md` | canonical | Product scope and sequencing |
| `docs/contracts.md` | canonical | Public interfaces and wire contracts |
| `docs/graph-model.md` | supporting, mixed | This set owns current storage/coverage explanation |
| `docs/extraction.md` | superseded index | `architecture/extraction/*` |
| `docs/extraction/overview.md` | supporting target design | Backend contract and indexing pipeline own AS-IS |
| `docs/extraction/tree-sitter.md` | supporting target design | Tree-sitter Pass A owns AS-IS |
| `docs/extraction/typescript.md` | supporting | TypeScript enricher |
| `docs/progressive-indexing.md` | target/historical | Incremental sync describes implemented V1 behavior |
| `docs/tools.md` | canonical tool behavior | Query/partiality explanation lives here |
| `docs/cli.md` | canonical surface guide | CLI architecture supplements it |
| `docs/mcp.md` | canonical surface guide | MCP architecture supplements it |
| `docs/testing.md` | target mixed with stale claims | Testing/evaluation records implemented layers |
| `docs/site.md` | supporting | Distribution and site ownership |
| `docs/web.md` | historical/parked | Not part of current product runtime |
| `docs/install.md` | canonical installation guide | Distribution architecture supplements it |
| `docs/superpowers/specs/*` | approved design inputs | ADRs and PHP target behavior cite them |
| `*.es.md` | stale mirror | English documents are canonical |

## Maintenance rule

A behavior change is incomplete until its canonical architecture document, diagram, deviation status, and affected public contract are updated in the same review.
