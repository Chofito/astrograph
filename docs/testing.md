# Testing, fixtures & eval

> 🌐 Languages: **English** (this file) · _ES mirror pending (see backlog)_

> Design document. How we keep three coding models honest: a **fixture catalog**, **golden graph snapshots**, **incremental-sync scenarios**, and the **eval harness** that proves Astrograph beats a `grep`/`Read` baseline. Tests are the contract enforcement layer — when a model's code diverges from [docs/contracts.md](contracts.md) or [docs/extraction/overview.md](extraction/overview.md), a golden test fails.
>
> Extraction is **two-pass and multi-backend** ([overview](extraction/overview.md)): Pass A is tree-sitter, Pass B is an optional per-language enricher. The test suite has to pin **both passes, per backend**, and the seam between them (§2.1–2.2) — not just the JS/TS happy path.
>
> ⚠️ **Tests are run by the user, never autonomously by an implementing agent** (per repo convention). Agents *write* tests; the user runs `bun test`.

---

## 0. Layers

| Layer | Question it answers | Speed |
|---|---|---|
| Unit | Does this function do its job? | fast |
| **Golden extraction** | Does fixture X produce exactly graph G? | fast |
| **Sync cycle** | Do deltas update the graph without dangling edges? | fast |
| **Resolution** | Are external/unresolved/ambiguous classified right? | fast |
| Determinism | Same input ⇒ same IDs/order, across runs & reindex? | fast |
| Performance | Index/query within budget? | medium |
| **Eval** | Does it beat grep/Read for agents? | slow (real repos) |

Bun: `bun test`. Eval: `bun run eval` (separate, opt-in).

---

## 1. Fixture catalog (`packages/core/__fixtures__/`)

Small, single-purpose source files, each pinned by a golden snapshot. Every JS/TS edge case in [extraction/typescript.md §5](extraction/typescript.md#5-jsts-edge-cases-checklist-golden-test) has a fixture. Fixtures are **per backend**, not per language feature only — see §2.1.

**Coverage backlog** (Pass A + B `graph.json` goldens):

- [x] `basic/`
- [x] `functions/`
- [x] `jsx/`
- [x] `decorators/`
- [x] `exports/`
- [x] `overloads/`
- [x] `imports/barrel/`
- [x] `imports/commonjs/` — golden present; `require` modeled as `calls`/`external` only (no `imports`/`exports` edges yet)
- [x] `imports/type-only/` — golden present; `metadata.typeOnly` not emitted yet
- [x] `imports/dynamic-literal/` — golden present; `import()` call stays `unresolved`, member `references` resolve
- [x] `resolution/ambiguous/`
- [ ] `inheritance/`
- [ ] `imports/relative/`
- [ ] `imports/alias/`
- [ ] `imports/dynamic/` (non-literal unresolved; integration test only today)
- [ ] `resolution/external/`
- [ ] `resolution/unresolved/`
- [ ] `perf/`
- [ ] `php/basic/` — **enricher-less backend** (`mode: 'none'`): classes, functions, methods, namespaces, `use` imports. Asserts a PHP file reaches `resolved` with `provenance: 'tree-sitter'` edges (see §2.2).
- [ ] `mixed/` — a repo fragment with `.ts` **and** `.php` side by side. Asserts extension routing, per-language coverage counts, and that `status.filesByLanguage` / `status.backends` report both.

```
__fixtures__/
├── basic/                 # function, class, method, property, const, enum, type_alias, namespace
├── inheritance/           # extends, implements, overrides
├── imports/
│   ├── relative/          # ./x, ../y
│   ├── alias/             # @/lib/x  (with a tsconfig paths fixture)
│   ├── barrel/            # index.ts re-exports; export * from
│   ├── type-only/         # import type
│   ├── dynamic/           # import('./x') literal + non-literal
│   └── commonjs/          # require / module.exports
├── exports/               # default, named, re-export-as
├── functions/             # declarations, arrows assigned to const, anonymous callbacks
├── jsx/                   # PascalCase component, <Comp/> usage, HOC
├── decorators/            # @Injectable, class + method decorators
├── resolution/
│   ├── external/          # imports from a fake node_modules pkg → external node
│   ├── unresolved/        # dynamic non-literal, any-typed call
│   └── ambiguous/         # merged declaration / union
├── php/
│   └── basic/             # enricher-less backend: classes, functions, `use` imports
├── mixed/                 # .ts + .php in one tree — routing, per-language coverage
└── perf/                  # a generated 1k-symbol file for budget tests
```

Each fixture dir contains the source + `__golden__/graph.json`.

---

## 2. Golden graph snapshots

A golden is the **normalized** extraction result. Normalization = the only thing that makes goldens stable across machines/models.

**Normalization rules (must be identical everywhere):**
- Drop volatile fields: `updatedAt`, `dbSizeBytes`, absolute paths (store repo-relative).
- Sort `nodes` by `(filePath, startLine, kind, qualifiedName)`; sort `edges` by `(source, kind, target, line)`.
- Keep `id` (so ID stability is part of the contract — see §5) but also assert structurally so an intentional ID-policy change is a deliberate golden update, not a silent break.

Golden shape:
```jsonc
{
  "nodes": [ { "id","kind","name","qualifiedName","filePath","range","isExported", ... } ],
  "edges": [ { "source","target","targetName?","kind","resolutionState","confidence","line" } ]
}
```

Test:
```ts
test('imports/alias golden', async () => {
  const g = await extractFixture('imports/alias');     // runs Pass A + B over the fixture
  expect(normalize(g)).toEqual(loadGolden('imports/alias'));
});
```

Updating a golden is a reviewed act — run `bun packages/core/__fixtures__/update-goldens.ts [fixture...]` (or `UPDATE_GOLDENS=1 bun test packages/core/__fixtures__/extraction.test.ts`), never automatic in CI. A missing `graph.json` fails the test suite.

### 2.1 Per-backend golden matrix

A single "run the whole pipeline and snapshot it" golden hides which pass produced what. Each fixture is
snapshotted **per pass, per backend**, so a tree-sitter grammar bump and an enricher change fail
different files:

| Golden | Produced by | Covers | Applies to |
|---|---|---|---|
| `__golden__/pass-a.json` | `parser.extractNodes(filePath, source)` alone | structural nodes + `contains`/syntactic edges, all `provenance: 'tree-sitter'` | **every** backend |
| `__golden__/graph.json` | full pipeline (Pass A → reconcile → Pass B) | the graph as persisted, incl. `resolutionState`, `confidence`, `provenance` | every backend |
| `__golden__/externals.json` | Pass B only | external nodes + `external` edges | enricher backends only |

Matrix rules:
- A fixture under `php/` or `mixed/` has **no** `externals.json`, and its `pass-a.json` and `graph.json`
  must have **identical nodes** — a `none`-mode backend adds nothing in Pass B. That equality *is* the
  test that `mode: 'none'` is wired correctly.
- Every golden records the backend `id` and its `versionKeys()` in a header field, so "the grammar
  changed under us" is a visible diff instead of a mystery failure.
- Adding a backend without adding its `pass-a.json` goldens fails the suite (same rule as a missing
  `graph.json`).

### 2.2 Pass-A ⊆ Pass-B id-parity golden (the seam test)

The `complement` contract ([overview](extraction/overview.md#complement-reconciliation-the-rule-that-keeps-ids-stable))
says Pass A emits a conservative **subset** of Pass B's nodes with **byte-identical ids**. That is the
single most breakable invariant in the two-pass design, and it gets a dedicated golden + assertion,
run over **every** `complement`-mode fixture:

```ts
test('pass A node ids are a subset of pass B node ids', async () => {
  const a = await passA('functions');            // tree-sitter only
  const b = await passAB('functions');           // full pipeline
  const bIds = new Set(b.nodes.map(n => n.id));
  const orphans = a.nodes.filter(n => !bIds.has(n.id));
  expect(orphans).toEqual([]);                   // a Pass-A-only node is a BUG, not a merge case
});
```

- **Direction matters.** Pass-B-only nodes are expected and fine (overloads, `component`-vs-`function`,
  externals). Pass-A-only nodes are a defect: report them with `qualifiedName` + `filePath` in the
  failure so the offending mapping is obvious.
- **No id churn across states.** Index a fixture to `parsed`, snapshot ids; drive it to `resolved`;
  the ids of every node present in both states must be **unchanged**. This is what guarantees stable
  ids for incremental sync and for anything holding a node id.
- **The deliberate silences are pinned too.** `overloads/` and `jsx/` assert that Pass A emits *nothing*
  for the overload set / the ambiguous component, so a well-meaning "improvement" to the tree-sitter
  mapping that starts guessing ids fails loudly.
- The runtime counter for Pass-A-only nodes (surfaced in `ExtractionError`s) is asserted to be **0**
  across the fixture set.

---

## 3. Sync-cycle tests (no dangling edges)

The delta contract from [graph-model §11](graph-model.md#11-incremental-sync-data-flow-contract) (the canonical statement — the old `extraction.md §7 "incremental re-extraction"` section no longer exists anywhere):

- **modify:** edit a fixture file → `sync` → graph equals a full re-index of the new state (delta == full). Assert **no edge has a `source`/`target` pointing to a deleted node**.
- **delete:** remove a file → its nodes/edges gone; edges that *targeted* it become `unresolved` (target null, `targetName` kept), not dangling.
- **add:** new file → `pending`→`resolved`; **healing:** a previously `unresolved` edge whose `targetName` matches a new symbol becomes `resolved`.
- **coverage transitions:** assert `files.state` walks `pending → parsed → resolved`.

```ts
test('delete leaves no dangling edges, downgrades referrers to unresolved', async () => {
  const cg = await freshIndex('inheritance');
  await cg.removeFile('inheritance/base.ts');
  const edges = cg.allEdges();
  expect(edges.every(e => e.target === null || cg.hasNode(e.target))).toBe(true);
});
```

---

## 4. Resolution-state tests

Direct assertions on [extraction/typescript.md §2](extraction/typescript.md#2-resolution-decision-tree--resolutionstate--confidence):
- `resolution/external` → edge `resolutionState:'external'`, target is `isExternal` node, **no project node created for the pkg internals**.
- `resolution/unresolved` (non-literal dynamic import / any-call) → `target:null`, `targetName` set, `confidence:'low'`.
- `resolution/ambiguous` → `resolutionState:'ambiguous'`, `metadata.candidates.length > 1`.
- **ID parity** (the #1 integration bug, [typescript.md §2.2](extraction/typescript.md#22-id-parity-critical)): for every `resolved` edge, `target` exists in `nodes` — a dedicated test asserts zero `resolved` edges with a missing target.
- **Enricher-less backend** (`php/basic`) → every edge has `provenance:'tree-sitter'`, the file's
  `state` is `resolved` (not stuck at `parsed` — [graph-model §6.1](graph-model.md#61-what-resolved-means-per-backend-language-agnostic)),
  and cross-file references Pass A cannot pin are honestly `unresolved`, never optimistically `resolved`.
- **Provenance placement** → node provenance is read from `Node.metadata.provenance`; edge provenance
  from the `edges.provenance` column. A test asserts no `provenance` column was added to `nodes`.

---

## 5. Determinism tests
- Extract a fixture **twice** → identical `id`s and identical normalized output.
- Full-index vs (index + edit + sync back to original) → identical graph (IDs stable across reindex).
- ID collision scan: no two distinct declarations share an `id` across the whole fixture set (overloads, locals included) — **across backends too**, so a `.ts` and a `.php` symbol can never collide.
- **Version identity:** a change in any backend's `versionKeys()` (grammar or enricher version) changes
  `project_metadata.configHash` and marks coverage stale. Asserted with a stubbed backend, not by
  actually bumping a dependency.

---

## 6. Performance budget tests

Turn "linear / performance-friendly" into thresholds (ROADMAP §1 / premortem #2). Numbers are starting targets on a dev laptop; tune with real measurements, but **fail the test if exceeded by >2×**.

| Metric | Target (V1) |
|---|---|
| Cold index throughput | ≥ ~1,000 files/min on a typical app repo |
| Incremental sync (1 file) | < 300 ms p95 |
| `search` / `node` latency | < 50 ms p95 |
| `context` latency | < 500 ms p95 |
| Peak RSS, ~2k-file repo | < 1.5 GB |
| Linearity check | index time of `perf/` (1k symbols) ≈ 2× of 500-symbol variant (±30%) |

Measured via a `bench` helper; recorded to `docs/benchmarks/` over time.

---

## 7. Eval harness (does it actually help agents?)

Mirrors [`codegraph/__tests__/evaluation/`](../../codegraph/__tests__/evaluation) in spirit. **This is the V1 1.0 gate** (ROADMAP §14): if it doesn't beat the baseline, the design is wrong, not the polish.

**Methodology.**
- Pick real **single-app** repos (Next.js, React Native/Expo, NestJS, Strapi — ROADMAP §1).
- For each repo, a set of architecture/flow questions with a known answer set (files/symbols that *must* appear).
- **Arm A (with Astrograph):** an agent answers using only Astrograph tools.
- **Arm B (baseline):** the same agent with only `grep`/`Read`/glob.
- Run N times per arm; report medians.

**Metrics:** tool-call count, tokens, wall-clock, and **answer correctness** (did required symbols/files surface?). Astrograph wins if it cuts tool-calls/tokens **without** losing correctness.

**Honesty checks in eval:** assert tool responses carried correct `meta.coverage`/`partial`, and that `unresolved`/`ambiguous` were surfaced — a fast-but-lying tool must not score well.

**Run:** `bun run eval` (opt-in, not in unit CI; uses cloned repos at `--depth 1`).

---

## 8. What CI runs (when the user runs it)
1. `bun test` — unit + golden + sync + resolution + determinism (fast, always).
2. `bun run bench` — performance budgets (medium; gate on >2× regressions).
3. `bun run eval` — manual/periodic on real repos (slow).

Reminder: the **agent writes** these; the **user runs** them.

---

## 9. References
- Contracts under test: [docs/contracts.md](contracts.md).
- Behavior the goldens encode: [docs/extraction/overview.md](extraction/overview.md) (two passes, reconciliation) · [tree-sitter.md](extraction/tree-sitter.md) (Pass A) · [typescript.md](extraction/typescript.md) (Pass B).
- Coverage/partiality semantics asserted: [docs/progressive-indexing.md](progressive-indexing.md).
- Eval reference: [`codegraph/__tests__/evaluation/`](../../codegraph/__tests__/evaluation).
