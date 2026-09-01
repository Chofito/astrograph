# Incremental synchronization

Status: mixed
Baseline: `8c6e9ad004a491886fb396cddca0dd617c67f495`
Canonical owner: indexing

## Purpose

Define how filesystem/config deltas update the graph and the equivalence expected between incremental and clean indexing.

## Current behavior (AS-IS)

### Event coalescing

At most one event survives per path. `unlink` dominates: a batch that both changed and deleted a path describes a deleted path, and watchers do not guarantee arrival order, so "last wins" would let a stale `change` resurrect a deleted file. `syncFiles` then re-checks existence, which is what lets a genuine delete-then-recreate come back. A **rename arrives as `unlink` + `add` on two paths** and needs no case of its own.


`indexAll()`, `sync()` and `syncFiles(events)` are one reconciliation model. They differ only in which paths they nominate as candidates — every eligible file, every eligible file, or the coalesced event batch — and everything after that is the same code in one fixed order:

1. classify membership (once, contracts §13);
2. capture invalidation evidence, before anything is destroyed;
3. retire what no longer belongs;
4. Pass A over changed files;
5. load each backend's project state;
6. re-resolve the affected set (contracts §14);
7. persist the identity.

Steps 4 and 5 are in that order deliberately: a backend builds its project view from persisted Pass A rows, so loading first would show it the previous pass's nodes.

`syncFiles` refreshes `configHash` and the version keys exactly like `sync`; a watch-driven index that never updated its identity was a second kind of index. An event batch never retires a path it did not mention, because silence is not deletion. A file being added or removed re-resolves the owning backend's whole file set, because a module that did not exist yet has no recorded edge pointing at it. Content-only edits use recorded dependents.

Name-based healing is gone. It matched a bare `node.name` against every unresolved edge and promoted whatever it found, which could link a PHP `save()` to a TypeScript call and two same-named symbols in different namespaces to each other. Storage no longer offers a lookup from a target name to edges, so the behavior cannot return by accident. An edge whose target cannot be proven stays `unresolved` — a correct answer, not a gap.

```mermaid
sequenceDiagram
    participant Caller
    participant I as Indexer
    participant DB as QueryBuilder
    participant B as Backends

    Caller->>I: sync() / syncFiles(events)
    I->>I: classify added, modified, removed
    I->>DB: capture prior identities, find recorded dependents for changed target IDs
    loop removed files
        I->>DB: capture incoming edges
        I->>DB: delete file/nodes/outgoing edges
        I->>DB: rewrite captured incoming edges unresolved
    end
    I->>B: loadProject(current project files)
    loop changed files
        I->>DB: persist Pass A
    end
    loop changed + direct referrers
        I->>DB: reconcile nodes; replace edges
    end
    I->>DB: heal unresolved edges by targetName
```

Full `sync()` treats a config-hash change as modification of every scanned known file. `syncFiles()` does not persist project metadata and calculates its current project set from DB plus additions.

## Target behavior (TO-BE)

For a fixed filesystem and config:

```text
normalize(cleanIndex(state)) == normalize(index(oldState) + applyDelta(old→state))
```

Removal and addition must re-run semantic resolution rather than mutate trust based only on a name. Referrer closure must cover every derived edge affected by a removed or changed type/module, including language-specific inheritance chains. Configuration invalidation must be handled consistently by full scan and watcher-driven paths.

```mermaid
flowchart TD
    Event["Filesystem/config delta"] --> Classify["Canonicalize + classify"]
    Classify --> Invalidate["Find semantic invalidation set"]
    Invalidate --> Remove["Delete obsolete owned rows"]
    Remove --> Parse["Pass A for changed eligible files"]
    Parse --> Resolve["Backend re-resolution for invalidated files"]
    Resolve --> Integrity["Check target integrity + states"]
    Integrity --> Compare["Equivalent to clean graph"]
```

## Event semantics

| Event | Required graph effect |
|---|---|
| Add | Create file/structural nodes; re-resolve references that may bind to it. |
| Modify | Replace owned structural/semantic data; re-resolve impacted referrers. |
| Remove | Delete owned rows; re-resolve incoming references and derived relationships. |
| Rename | Equivalent to remove old + add new; stable IDs are not expected across file-path changes. |
| Config/backend change | Recompute index membership and invalidate every affected backend project. |
| Oversized transition | Enter/leave recorded skipped state without passing oversized content to backends. |

## Invariants

- No edge points to a deleted node.
- “Resolved” is never assigned by bare-name coincidence.
- Event coalescing is deterministic: unlink dominates stale change for the same path.
- Backend project state reflects the post-event project set before resolution.
- Sync results return sorted, unique paths.

## Failure and partial states

A failed delta must leave affected files visibly non-authoritative and must not claim global freshness. FreshnessManager serializes batches through `syncQueue`; its error callback is responsible for surfacing an unavailable watcher/sync state to the transport.

## Source evidence

- `packages/core/src/indexer.ts`: `sync`, `syncFiles`, referrer lookup, removal downgrade and healing.
- `packages/core/src/freshness.ts`: event filtering, debounce, queue and close.
- `packages/core/src/adapters/bun/watcher.ts`: concrete watcher.

## Known deviations

See `DEV-001`, `DEV-002`, `DEV-003`, and `DEV-011`.

