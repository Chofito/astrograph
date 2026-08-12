# Extraction architecture overview

> Supporting target design. At baseline, Pass A runs only for files claimed by the registered JS/TS or PHP backends and emits nodes plus `contains`; enrichers supply semantic edges. Progressive/on-demand enrichment and enricher layering described below are future design, not current behavior. See the canonical [backend contract](../architecture/extraction/backend-contract.md) and [indexing pipeline](../architecture/indexing-pipeline.md).
>
> 🌐 Languages: **English** (this file)

---

## Passes: structural → semantic

### Pass A: tree-sitter structural extraction

Per-file AST walk via **tree-sitter grammars**. Produces:
- **Nodes** with positions and basic attributes (`name`, `kind`, `visibility`, etc.)
- **Edges** for the structural `contains` relationship at the current baseline
- **State:** `parsed` — nodes exist; edges are best-effort structural only

**Properties:**
- Fast, deterministic, and reusable for languages with an implemented mapping and registered backend
- No cross-file resolution; no type information
- Handles syntax correctly even for incomplete/broken code (!)
- Scales linearly per-file

**Languages:** any language with a tree-sitter grammar **and a registered backend**. Shipping today: JavaScript, TypeScript, JSX/TSX, PHP. Adding one is a `LanguageBackend` registration, not a core change.

### Pass B: language-specific enrichers

**Optional**, per-language. The current indexer runs it for every routed file during full and delta indexing; demand scheduling is a future design.

**Example — TS Compiler enricher:**
- Input: nodes + edges from Pass A
- Process: uses `ts.TypeChecker` for compiler-backed module, type, and call resolution
- Output: refines/confirms edges with semantic certainty, adds `type_of`/`returns` edges, populates external symbols
- **State:** `resolved` — edges have passed semantic enrichment

**Key design:**
- Pass B can run on a subset of files (only those needing semantic depth)
- Enrichers are **independent plugins** behind the `Enricher` interface
- The current contract accepts at most one enricher per backend; multi-enricher layering is only a future possibility
- No enricher breaks the core graph; they only refine confidence/provenance

---

## Architecture

```
┌──────────────┐
│  Source code │
│  (all langs) │
└────────┬─────┘
         │
         ▼
   ┌─────────────────────────┐
   │  Pass A: tree-sitter    │
   │  ──────────────────     │
   │  • Parse with grammar   │
   │  • Walk AST             │
   │  • Extract symbols      │
   │  • Structural edges     │
   └──────────┬──────────────┘
              │
              ▼
   ┌────────────────────┐     ┌──────────────────┐
   │  Nodes + Edges     │────▶│  Pass B enrichers│
   │  (state=parsed)    │     │  (per language)  │
   └────────────────────┘     │                  │
                              │  JS/TS: TSCo...  │
                              │  Python: AST...  │
                              │  ...             │
                              │                  │
                              └────────┬─────────┘
                                       │
                                       ▼
                              ┌──────────────────┐
                              │  Refined edges   │
                              │  (state=resolved)│
                              │  + external syms │
                              └──────────────────┘
```

---

## Interfaces (the seams)

> ⚠️ **[docs/contracts.md](../contracts.md) is the source of truth for these types.** The signatures below
> are reproduced from it; if they ever drift, contracts.md wins and this file is the bug.

### `LanguageBackend`

```ts
interface LanguageBackend {
  id: string;                 // registry key: 'typescript', 'php'
  languages: Language[];      // languages this backend claims
  extensions: string[];       // '.ts', '.tsx', '.php' — how files route to it
  parser: Parser;
  enricher?: Enricher;
  capabilities: { edgeKinds: EdgeKind[] };
  versionKeys(): Record<string, string>;  // grammar/enricher versions → configHash
}
```

A backend is the unit of language support: tree-sitter parser + optional enricher.

### `Parser`

```ts
interface Parser {
  extractNodes(filePath: string, source: string): PassAResult;
}

interface PassAResult {
  nodes: Node[];
  edges: Edge[];
  errors: ExtractionError[];
}
```

Maps source → CST → nodes/edges. Implements Pass A. Pure per-file, no I/O.
Note the argument order: **`(filePath, source)`**.

### `Enricher`

```ts
type EnricherMode = 'complement' | 'replace' | 'none';

interface Enricher {
  readonly mode: EnricherMode;
  loadProject?(opts: LoadProjectOptions): void;
  resolveEdges(filePath: string): EdgeResolutionResult;
}

interface EdgeResolutionResult {
  edges: Edge[];
  errors: ExtractionError[];
  externalNodes: Node[];   // external (`node_modules`, `.d.ts`) symbols
  nodes?: Node[];          // enricher-supplied project nodes, reconciled by id
}
```

Optional Pass B, **per file**, driven by a project loaded once via `loadProject`. It refines edges (`confidence`, `resolutionState`, `provenance`), adds `type_of`/`returns` edges, creates minimal external nodes, and may supply project nodes Pass A deliberately withheld.

**Modes:**
- `complement` — Pass A emits a conservative **subset** with byte-identical ids; Pass B reconciles by id (see below). **This is the TypeScript backend's mode.**
- `replace` — Pass B supersedes Pass A for the relationships it covers.
- `none` — no enricher; tree-sitter output is final. (Disable a language's enricher with `backends.<id>.enricher: false`.)

### `complement` reconciliation (the rule that keeps ids stable)

1. Pass A emits only what it can id **identically** to the enricher — `hash(project · filePath · kind · qualifiedName · locator)`, byte for byte — plus its `contains` edges (`provenance: 'tree-sitter'`).
2. Where it cannot guarantee that, Pass A emits **nothing** and lets the enricher supply the node. Known cases: **function overloads** (locator is a signature hash only the enricher computes) and **ambiguous `component` vs `function`** for JSX.
3. Pass B reconciles **by node id**: matched nodes are enriched **in place** (so ids never churn as a file moves `parsed → resolved`), enricher-only nodes are added.
4. A **Pass-A-only node** — one Pass A emitted that Pass B does not know — is a **bug**. It is counted and reported, never silently kept or dropped. Full pipeline golden enforcement is still target work; see `DEV-014` in [deviations](../architecture/deviations.md).

Node-level provenance is written to `Node.metadata.provenance`; edge-level provenance is the real `edges.provenance` column. Neither needs a schema change.

### Orchestration

The **indexer** owns the two-pass flow — there is no separate `Extractor` façade type in the contract.
Per file: route by extension via the registry → `parser.extractNodes(filePath, source)` → persist
(`parsed`) → if the backend has an enricher whose mode isn't `none`, `enricher.resolveEdges(filePath)`
→ reconcile → persist (`resolved`).

---

## Coverage states

**Per-file `files.state` column:**

| State | Meaning | Pass A | Pass B |
|---|---|---|---|
| `pending` | Known but untouched | ✗ | ✗ |
| `parsed` | Nodes extracted | ✓ | ✗ |
| `resolved` | Every pass this file's backend runs has run | ✓ | ✓ or N/A |

Progressive indexing queries can work on `parsed` files (get symbols, rough structure) and boost to `resolved` on demand.

`resolved` is **language-agnostic**: for an enricher-less backend (`mode: 'none'`, or
`backends.<id>.enricher: false`) Pass A *is* the whole pipeline, so its files reach `resolved` too.
The difference in fidelity is carried by edge `provenance`/`confidence`, not by parking those
languages at `parsed` forever. Normative definition:
[graph-model §6.1](../graph-model.md#61-what-resolved-means-per-backend-language-agnostic).

---

## Registry

Astrograph maintains a **registry of language backends**, keyed by `id` and indexed by file
extension. What actually ships:

| Backend `id` | Languages | Extensions | Enricher | Mode |
|---|---|---|---|---|
| `typescript` | typescript, tsx, javascript, jsx | `.ts` `.tsx` `.mts` `.cts` `.js` `.jsx` `.mjs` `.cjs` | TS Compiler (Pass B) | **`complement`** |
| `php` | php | `.php` | name resolution (FQN + `use`) | **`complement`** |

PHP ships a **name-resolution enricher** (not a type checker): heritage, `use` → `imports`, `type_of` / `returns`, and `calls` / `instantiates` with honest `external` / `unresolved` buckets. Pass A still owns the node set.

Adding a language = register another `LanguageBackend`. Whether it also gets an enricher is a separate,
later decision — the graph is useful the moment Pass A exists.

Backends can be turned off, or run Pass-A-only, via `backends` in `.astrograph/config.json`
([contracts §9](../contracts.md#9-config-astrographconfigjson)). `astrograph status` reports the
registered backends, their versions, and any grammar it could not load.

---

## Determinism and stability

Same source + same parser/enricher versions ⇒ **identical nodes, edges, and IDs**.
- No timestamps in node IDs.
- Tree-sitter grammar versions are part of the extraction identity.
- Enricher versions are tagged in `provenance` and `confidence`.
- Sort all output for reproducibility.

---

## See also

- [docs/extraction/tree-sitter.md](tree-sitter.md) — Pass A detail for tree-sitter structural extraction
- [docs/extraction/typescript.md](typescript.md) — Pass B detail for TS Compiler enricher
- [docs/contracts.md](../contracts.md) — canonical Node/Edge/Enricher types
- [ROADMAP.md](../../ROADMAP.md) §1–2 — architecture philosophy
