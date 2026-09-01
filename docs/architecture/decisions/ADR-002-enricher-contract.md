# ADR-002: Enrichers are explicit, complementary, and bounded

Status: accepted
Baseline: `8c6e9ad004a491886fb396cddca0dd617c67f495`
Canonical owner: extraction architecture

## Context

The baseline `Enricher.resolveEdges` may also return nodes, and the indexer memoizes that complete result across two project-wide phases. Reconciliation hardcodes TS provenance. `replace` and object-level `none` modes widen the public contract without a shipping use case and conflict with Pass A authority.

## Decision

A shipping backend has either no enricher or one complement enricher. The enricher declares its ID/provenance, capabilities, project-load inputs, bounded node-enrichment output, edge-resolution output, and disposal lifecycle.

Node enrichment and edge resolution are conceptually separate operations even if a backend shares internal analysis. The indexer may schedule phases for foreign-key safety, but must release per-file result payloads as soon as their final consumer completes.

## Target interface direction

```ts
interface Enricher {
  readonly mode: 'complement'
  readonly provenance: Provenance
  loadProject?(options: LoadProjectOptions): void
  enrichNodes?(filePath: string): NodeEnrichmentResult
  resolveEdges(filePath: string): EdgeResolutionResult
  dispose?(): void
}
```

This is an architectural direction, not a claim that the baseline interface already has this exact shape.

## Implemented interface (DEV-007)

```ts
type EnricherMode = 'complement'
type EnricherStatus = EnricherMode | 'none'   // presentation in `status` only

interface Enricher {
  readonly mode: EnricherMode
  readonly id: string
  readonly provenance: Provenance
  loadProject?(opts: LoadProjectOptions): void
  resolveEdges(filePath: string): EdgeResolutionResult
}
```

Differences from the sketch, and why:

- `id` is required, so evidence can name the producing enricher, not just its provenance class.
- `enrichNodes()` is **not** split out yet. Node enrichment still arrives as the optional `nodes` field of `EdgeResolutionResult`. Splitting the call is only useful together with streaming and per-file lifetime, which are `DEV-008`/`DEV-013`; shipping two node-producing entry points before then would mean two public contracts at once.
- `dispose()` is **not** added yet, for the same reason: it must land with the storage-close ordering work (`DEV-013`).
- Registration is validated by `LanguageRegistry` (`BackendRegistrationError`): unique backend ids, one owner per extension, and capabilities that match what the configured backend can actually emit.
- `LanguageRegistry.versionKeys()` contributes `extraction:contract`, so narrowing this contract rebuilds pre-existing indexes.

## Consequences

- Provenance is backend-owned rather than indexer-hardcoded.
- Backends can reuse a Program/name index without exposing it to core.
- Peak retained output can be bounded per file/phase.
- Pass-A-only configuration is represented by absence of an enricher.
- Future layering requires a new ADR defining ordering/conflict ownership; it is not implied by this interface.

## Rejected alternatives

- Keep `replace` “for flexibility”: unused flexibility weakens invariants now.
- Store all enrichment results for easy two-phase writes: predictable but scales with the entire project payload.
- Let core inspect backend-specific caches: destroys the extension seam.

## Verification

- Stub complement backends use non-TS provenance correctly.
- Pass-A-only files reach `resolved`.
- Backend disposal runs before storage close and is idempotent.
- Retained result count/size is bounded as file count grows.
- PHP and TS continue to resolve cross-file targets after streaming changes.

## Current deviations

`DEV-008`, `DEV-012`, and `DEV-013`. `DEV-007` is closed by the implemented interface above.

