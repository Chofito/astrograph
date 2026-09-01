# Language backend contract

Status: current (enricher contract); mixed (lifecycle)
Baseline: `8c6e9ad004a491886fb396cddca0dd617c67f495`
Canonical owner: `packages/core/src/extraction/registry.ts`

## Purpose

Define the boundary between reusable graph indexing and a language backend. A backend owns extension routing, Tree-sitter structural extraction, optional language-aware enrichment, advertised capabilities, and version keys. It does not own scanning, SQLite persistence, coverage calculation, or query semantics.

## Boundaries and responsibilities

| Concern | Owner |
|---|---|
| File extension -> backend | `LanguageRegistry` |
| Structural nodes and `contains` edges | backend `parser` (Tree-sitter Pass A) |
| Language semantics and optional extra nodes | backend `enricher` (Pass B) |
| Node identity/reconciliation and persisted coverage | `Indexer` + storage |
| Grammar loading and availability state | `tree-sitter/grammars.ts` |
| Public result types | `packages/core/src/types.ts`, [contracts](../../contracts.md) |

At the baseline, the default registry registers two backends only: `typescript` for `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`, and `php` for `.php`. An extension without a registered backend is not indexed; there is no universal language fallback.

## Current behavior (AS-IS)

`LanguageRegistry` stores backends by ID and extensions in a lower-cased map. `backendForPath()` is the single routing authority, while `allExtensions()` supplies the scanner's indexable suffixes. `createDefaultRegistry()` applies `config.backends.<id>.enabled` and `.enricher` overrides before constructing the two shipping backends.

Every `LanguageBackend` exposes a parser, optional `Enricher`, `BackendCapabilities`, and `versionKeys()`. The registry prefixes each backend's version keys before they participate in index identity, and adds its own `extraction:contract` key so a narrowing of this contract rebuilds pre-existing indexes. `summary()` reports claimed languages/extensions, enricher presentation (`complement` or `none`), capability edge kinds, and grammar availability for status consumers.

`EnricherMode` is the single literal `"complement"`. A backend either has no enricher — Pass-A-only, and the file reaches `resolved` after Pass A — or exactly one complementary enricher that declares its own `id` and `provenance`. There is no mode that skips Pass A and no object-valued `none`. `LanguageRegistry` enforces this at construction and throws `BackendRegistrationError` on duplicate backend ids, an extension claimed by two backends, empty/duplicated/unknown edge kinds, capabilities that omit `contains`, a Pass-A-only backend advertising enricher-only edge kinds, or an enricher missing `id`/`provenance`.

```mermaid
flowchart LR
  Scan["Scanner yields relative path"] --> Registry["LanguageRegistry.backendForPath"]
  Registry -->|"registered extension"| Backend["LanguageBackend"]
  Registry -->|"no owner"| Skip["not indexable"]
  Backend --> Parser["Parser: Pass A"]
  Parser --> Structural["nodes + contains"]
  Backend --> Enricher{"enricher present?"}
  Enricher -->|"yes"| Semantic["Pass B: nodes/edges/errors"]
  Enricher -->|"no"| FinalA["Pass A-only result"]
  Structural --> Indexer["Indexer persists/reconciles"]
  Semantic --> Indexer
  FinalA --> Indexer
```

## Operational contract

`ROADMAP.md` §1–2 and §10 lock the model, and it is now implemented: Tree-sitter Pass A always runs and owns structural nodes; an enricher may add edges and insert nodes that Pass A intentionally omitted, but it must not delete Pass A nodes. `docs/contracts.md` §5.1 defines ID-based reconciliation and the `PASS_A_NODE_DROPPED` warning for subset violations.

- no enricher: Pass A is the final extraction for the file, and the file record reaches `resolved`;
- complement enricher: Pass A first, then ID-based updates/inserts plus semantic edges;
- no configuration bypasses Pass A or deletes a Pass-A node;
- provenance is declared by the producing enricher (`Enricher.provenance`) and stamped by reconciliation; the indexer never infers it from a language name.

Node enrichment and edge resolution stay conceptually separate (ADR-002), but `resolveEdges()` still returns both in one bounded result; splitting the call and streaming it belongs to `DEV-008`/`DEV-013`.

## Invariants

- One extension has at most one owning backend in a registry.
- A backend advertises only edge kinds it can emit in its active configuration.
- Parser output is per-file, structural, and has no cross-file resolution requirement.
- A complement enricher preserves stable IDs for declarations shared with Pass A.
- Cross-file lookup belongs behind the supplied project-loading interface; it is not a registry concern.
- Grammar unavailability is observable through backend status and becomes extraction errors/file-only output rather than an invented graph.

## Failure and partial states

| Condition | Baseline behavior |
|---|---|
| Unclaimed extension | Scanner/indexer does not route it to extraction. |
| Runtime or grammar unavailable | `TreeSitterParser` returns a file node plus `TREE_SITTER_UNAVAILABLE`/`TREE_SITTER_GRAMMAR_MISSING`. |
| Enricher disabled | Backend capabilities are `contains` only; no Pass B is loaded. |
| Enricher cannot load/resolve a file | It returns its errors/empty semantic result; coverage and tool partiality are owned by core. |
| Pass-A/enricher identity mismatch | Reconciliation keeps Pass-A rows and emits `PASS_A_NODE_DROPPED`. |

## Reusable vs specific parts

| Reusable core seam | Language-specific implementation |
|---|---|
| `LanguageBackend`, `Parser`, `Enricher`, registry, reconciliation types | Grammar selection, AST walk, semantic compiler/name resolver |
| Config/backend enablement and version-key hashing | Extension list, language enum entries, capability edge kinds |
| SQLite lookup callback supplied to enrichers | TypeScript `Program` / PHP FQN and method tables |

## Source evidence

- `packages/core/src/types.ts`: `Parser`, `Enricher`, `LanguageBackend`, `EdgeResolutionResult`, `EnricherMode`, and `EnricherStatus`.
- `packages/core/src/extraction/registry.ts`: routing, default construction, status and grammar derivation.
- `packages/core/src/extraction/typescript/backend.ts`: shipping JS/TS complement backend.
- `packages/core/src/extraction/php/backend.ts`: shipping PHP complement backend.
- `packages/core/src/extraction/reconcile.ts`: ID-based subset reconciliation.

## Known deviations

- `DEV-008`: resolving all files before a separate edge phase can retain result data beyond a per-file lifetime.
- `DEV-013`: the backend contract has no disposal lifecycle despite PHP owning a WASM parser.

## Related documents

- [Pass A](tree-sitter-pass-a.md)
- [TypeScript enricher](typescript-enricher.md)
- [PHP enricher](php-enricher.md)
- [Language extension guide](../extension-guide.md)
- [Full indexing pipeline](../indexing-pipeline.md)
