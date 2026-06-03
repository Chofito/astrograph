# Tool contract (agent-facing surface)

> 🌐 Languages: **English** (this file) · [Español](tools.es.md)

> Design document. Defines the **transport-agnostic tool contract** that Astrograph exposes to consumers. The contract (name, inputs, **structured result**) lives in `packages/core`; **MCP** (Stage 2), the **CLI** (Stage 1), and the **Web UI** (Stage 3) are thin formatters over the same structured results. See [ROADMAP §5](../ROADMAP.md#5-stage-2--mcp-support).

## 1. Why a contract, not "MCP tools"

codegraph keeps the heavy logic in a core facade that both its CLI and MCP layer call — but the **tool definitions and agent-facing formatting live inside its MCP layer** (`mcp/tools.ts`), and the CLI re-formats independently. Astrograph goes one step further: each tool's **structured result** is part of the core contract, so all three surfaces (CLI, MCP, Web) reuse the same result and only differ in presentation.

```
packages/core
  ├── queries (search, buildContext, trace, callers, …)   ← logic
  └── tool contract (name + input schema + StructuredResult)  ← single source of truth
        ↓ thin formatters
   CLI (terminal text) · MCP (agent text + envelope) · Web (JSON → 3D)
```

This matters because Stage 3's Web UI consumes the *same* results (context, callers, impact…). A shared structured result means we build the assembly logic once.

## 2. Tool design bars

Every tool must clear two bars before it earns a place:

1. **Real utility.** It answers a question an agent/human actually asks, and does it better/cheaper than `grep` + `Read`.
2. **Real viability (offline, local-first).** It is **deterministic** and runs with **no LLM and no network**. Astrograph is 100% local — **no tool may generate natural-language prose.** Tools *assemble* (rank, slice, map); they never *write*.

> `context` and `explore` look "smart" but are pure assembly: ranking + verbatim code slices + a relationship map. No model is called. They pass the bar.

Additional rules:
- **Honest results.** Every result carries coverage/partiality and, where relevant, `resolutionState` (`resolved|external|unresolved|ambiguous`) and edge `confidence` (`high|medium|low`) — see [ROADMAP §3](../ROADMAP.md#3-graph-model-data-contract). Never present partial/stale/low-confidence data as complete fact.
- **Token-budget aware.** Context-shaped tools accept a budget and return *compact, explainable* payloads, not raw graph dumps.
- **MCP naming.** Exposed over MCP as `astrograph_<tool>`.

## 3. Shared result envelope

Every tool's structured result is wrapped with a `meta` envelope so partiality is uniform across surfaces:

```ts
interface ToolResult<T> {
  data: T;                         // the tool-specific structured payload
  meta: {
    coverage: {                    // from docs/progressive-indexing.md
      total: number;               // files in scope
      resolved: number;            // fully indexed (edges done)
      parsed: number;              // nodes only
      pending: number;             // not yet indexed
    };
    partial: boolean;              // true if the answer could change as coverage grows
    pendingFiles?: string[];       // files relevant to this answer still indexing
    notes?: string[];              // honesty notes (e.g. "3 ambiguous refs omitted")
  };
}
```

Formatters render `meta` as a banner (MCP), a footer line (CLI), or a badge (Web). The progressive-indexing behavior per tool is in [docs/progressive-indexing.md §4](progressive-indexing.md#4-what-works-progressively-and-what-doesnt).

## 4. The tools (V1 — mirror of codegraph's 10)

Shared field types referenced below: `NodeRef` = `{ id, name, kind, qualifiedName, filePath, range, signature? }`; `EdgeRef` = `{ kind, line?, col?, confidence?, resolutionState? }`; `CodeBlock` = `{ filePath, startLine, endLine, language, content }`.

---

### 4.1 `astrograph_search`
- **Purpose.** Find symbols by name across the codebase. Locations only, no code.
- **Utility.** The entry point for almost everything; replaces wide `grep` for symbol discovery.
- **Offline.** FTS5 query over `nodes_fts`. ✅
- **Inputs.** `query: string`, `kind?: NodeKind`, `limit?: number = 10`, `projectPath?: string`.
- **Result.** `SearchResult[]` = `{ node: NodeRef, score: number, highlights?: string[] }`.
- **Progressive.** ✅ results grow with coverage; label as partial.
- **Core method.** `search()`.

### 4.2 `astrograph_context`  ⭐ primary
- **Purpose.** Build relevant code context for a task — composes search + node + callers + callees + ranking in one call. The main agent-facing surface.
- **Utility.** Usually answers a "how does X work / where is Y" question in one call with no further `Read`/`Grep`.
- **Offline.** Deterministic assembly: search → traverse bounded neighborhood → rank → slice. No prose. ✅
- **Inputs.** `task: string`, `maxSymbols?: number = 20`, `includeCode?: boolean = true`, `tokenBudget?: number`.
- **Result.** `TaskContext` = `{ entryPoints: NodeRef[], subgraph: { nodes: NodeRef[], edges: EdgeRef[] }, codeBlocks: CodeBlock[], inclusionReasons: Record<id, string>, relatedFiles: string[], stats }`.
- **Notes.** Must support **token budgets, ranking, bounded neighborhoods, and inclusion reasons** (ROADMAP §11 "Context quality"). `inclusionReasons` is what makes it explainable rather than a dump.
- **Progressive.** ✅ local; on-demand boost resolves the focused zone instantly.
- **Core method.** `buildContext()`.

### 4.3 `astrograph_trace`
- **Purpose.** Trace the call path between two symbols ("how does X reach Y") in one call — each hop with its body inlined, following dynamic-dispatch hops (callbacks, interface→impl, re-render) that grep can't.
- **Utility.** Flow questions (request→handler, update→render) that are expensive to reconstruct by hand.
- **Offline.** Graph traversal over `calls`/`references` edges + verbatim slicing. ✅
- **Inputs.** `from: string`, `to: string`, `maxDepth?: number`.
- **Result.** `TracePath` = `{ found: boolean, hops: { node: NodeRef, via: EdgeRef, body: CodeBlock }[], destinationCallees?: NodeRef[], endpoints?: { node: NodeRef, body: CodeBlock }[] }`. On `found:false`, `endpoints` inlines both endpoints + their TO-file siblings (the chain broke at dynamic dispatch).
- **Progressive.** ⚠️ partial — works once `from`, `to`, and the path are covered; otherwise demand-index them.
- **Core method.** `trace()` (BFS over the call graph).

### 4.4 `astrograph_callers`
- **Purpose.** List functions that call `<symbol>`.
- **Utility.** "Who uses this?" before reading/editing.
- **Offline.** Reverse edge query `(target, kind='calls')`. ✅
- **Inputs.** `symbol: string`, `limit?: number = 20`, `includeExternal?: boolean = false`.
- **Result.** `{ caller: NodeRef, callSite: EdgeRef }[]`.
- **Progressive.** ❌ global reverse — a caller may live in a `pending` file. Report coverage + mark partial until full coverage.
- **Core method.** `callers()`.

### 4.5 `astrograph_callees`
- **Purpose.** List functions that `<symbol>` calls.
- **Utility.** "What does this depend on?" without reading the body.
- **Offline.** Forward edge query `(source, kind='calls')`. ✅
- **Inputs.** `symbol: string`, `limit?: number = 20`, `includeExternal?: boolean = false`.
- **Result.** `{ callee: NodeRef, callSite: EdgeRef }[]`.
- **Progressive.** ✅ mostly local (outgoing from the symbol's file once parsed).
- **Core method.** `callees()`.

### 4.6 `astrograph_impact`
- **Purpose.** List symbols affected by changing `<symbol>`. Use before a refactor.
- **Utility.** Blast-radius analysis; safer edits.
- **Offline.** Reverse-transitive traversal bounded by `depth`. ✅
- **Inputs.** `symbol: string`, `depth?: number = 2`.
- **Result.** `{ node: NodeRef, distance: number, viaPath: EdgeRef[] }[]`.
- **Progressive.** ❌ global reverse — same caveat as `callers`; report partiality.
- **Core method.** `impact()`.

### 4.7 `astrograph_node`
- **Purpose.** Details about one specific symbol; optionally the verbatim source.
- **Utility.** Pinpoint one symbol's location, signature, and immediate callers/callees trail.
- **Offline.** Node lookup + optional slice. ✅
- **Inputs.** `symbol: string` (name or id), `includeCode?: boolean = false`.
- **Result.** `{ node: NodeRef, docstring?, callersPreview: NodeRef[], calleesPreview: NodeRef[], code?: CodeBlock }`.
- **Progressive.** ✅ local; demand-boost.
- **Core method.** `getNode()`.

### 4.8 `astrograph_explore`
- **Purpose.** Return source for several related symbols **grouped by file**, plus a relationship map, in one capped call. Query is a bag of names/terms (not a question). Returned source is **verbatim, Read-equivalent** — don't re-open shown files.
- **Utility.** Surveys an area in one call; collapses redundant interchangeable implementations to signatures so the payload is sized to the *answer*, not the file count (codegraph's adaptive sizing).
- **Offline.** Lookup + grouping + slicing. ✅
- **Inputs.** `query: string` (e.g. `"AuthService loginUser session-manager"`), `maxFiles?: number = 12`.
- **Result.** `{ files: { filePath, blocks: CodeBlock[] }[], relationshipMap: EdgeRef[] }`.
- **Progressive.** ✅ local; demand-boost the named symbols + 1 hop.
- **Core method.** `explore()`.

### 4.9 `astrograph_files`
- **Purpose.** Indexed file tree with language + symbol counts. Faster than filesystem scanning / `Glob`.
- **Utility.** Project layout at a glance, already filtered to indexed source.
- **Offline.** Query over the `files` table. ✅
- **Inputs.** `path?: string`, `pattern?: string` (glob), `format?: 'tree' | 'flat' | 'grouped' = 'tree'`, `includeMetadata?: boolean = true`, `maxDepth?: number`.
- **Result.** Tree/flat/grouped of `{ filePath, language, nodeCount, coverageState }`.
- **Progressive.** ✅ reflects what's indexed; surface `coverageState` per file.
- **Core method.** `getFiles()`.

### 4.10 `astrograph_status`
- **Purpose.** Index health check (files / nodes / edges) + coverage. Skip unless debugging.
- **Utility.** Verify freshness; see what's pending. This is *how you inspect coverage*.
- **Offline.** Stats queries. ✅
- **Inputs.** `projectPath?: string`.
- **Result.** `GraphStats` = `{ nodeCount, edgeCount, fileCount, nodesByKind, edgesByKind, filesByLanguage, dbSizeBytes, lastUpdated }` + `coverage` summary + `pendingSync?: string[]` + `backend`/`journalMode`.
- **Progressive.** ✅ the introspection tool for coverage itself.
- **Core method.** `getStats()` + coverage query.

---

## 5. Summary

| Tool | Purpose | Offline-viable | Progressive |
|---|---|---|---|
| `astrograph_search` | Find symbols by name | ✅ FTS5 | ✅ |
| `astrograph_context` ⭐ | Compose relevant task context | ✅ assembly | ✅ local |
| `astrograph_trace` | Call path A→B with bodies | ✅ traversal | ⚠️ partial |
| `astrograph_callers` | What calls X | ✅ reverse edges | ❌ global |
| `astrograph_callees` | What X calls | ✅ forward edges | ✅ local |
| `astrograph_impact` | Blast radius of changing X | ✅ reverse-transitive | ❌ global |
| `astrograph_node` | One symbol's details/source | ✅ lookup+slice | ✅ local |
| `astrograph_explore` | Source of N symbols by file + map | ✅ group+slice | ✅ local |
| `astrograph_files` | Indexed file tree | ✅ files table | ✅ |
| `astrograph_status` | Index health + coverage | ✅ stats | ✅ |

All 10 are deterministic and offline — none calls a model. ✅

## 6. Out of scope for V1 (candidate future tools)

These only get added if they clear the same two bars (utility + offline viability). Tracked under ROADMAP §13 (Stage 4 / v1.5, Stage 5 / v2):

- `astrograph_coverage` — explicit index-debt view (stale/partial/ambiguous zones). *Viable offline.*
- `astrograph_diff` — what changed in the graph between commit A and B / a PR's impact. *Viable offline (needs git read).*
- `astrograph_explain_context` — why each symbol was included in a context payload. *Viable offline (introspection).*
- Architecture-rule checks (forbidden deps, cycles, layers). *Viable offline.*

Anything requiring generated prose, embeddings, or network stays out while Astrograph is local-first.

## 7. References
- Tool shapes/descriptions to mirror: [`codegraph/src/mcp/tools.ts`](../../codegraph/src/mcp/tools.ts), [`server-instructions.ts`](../../codegraph/src/mcp/server-instructions.ts).
- Core query layer to back the contract: [`codegraph/src/index.ts`](../../codegraph/src/index.ts) (the `CodeGraph` facade), [`src/context/`](../../codegraph/src/context), [`src/graph/`](../../codegraph/src/graph), [`src/search/`](../../codegraph/src/search).
- Progressive behavior + coverage envelope: [docs/progressive-indexing.md](progressive-indexing.md).
- Stage 2 framing: [ROADMAP §5](../ROADMAP.md#5-stage-2--mcp-support).
