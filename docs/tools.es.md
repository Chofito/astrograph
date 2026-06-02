# Contrato de tools (superficie hacia el agente)

> 🌐 Idiomas: **Español** (este archivo) · [English](tools.md)

> Documento de diseño. Define el **contrato de tools agnóstico del transporte** que Astrograph expone a sus consumidores. El contrato (nombre, inputs, **resultado estructurado**) vive en `packages/core`; **MCP** (Etapa 2), la **CLI** (Etapa 1) y la **Web UI** (Etapa 3) son formatters finos sobre los mismos resultados estructurados. Ver [ROADMAP §5](../ROADMAP.es.md#5-stage-2--mcp-support).

## 1. Por qué un contrato, no "MCP tools"

codegraph mantiene la lógica pesada en un core facade que su CLI y su capa MCP consumen — pero las **definiciones de tool y el formateo hacia el agente viven dentro de su capa MCP** (`mcp/tools.ts`), y el CLI re-formatea por su cuenta. Astrograph da un paso más: el **resultado estructurado** de cada tool es parte del contrato del core, así que las tres superficies (CLI, MCP, Web) reusan el mismo resultado y solo difieren en presentación.

```
packages/core
  ├── queries (search, buildContext, trace, callers, …)   ← lógica
  └── contrato de tool (nombre + input schema + StructuredResult)  ← única fuente de verdad
        ↓ formatters finos
   CLI (texto terminal) · MCP (texto agente + envelope) · Web (JSON → 3D)
```

Importa porque la Web UI de la Etapa 3 consume *los mismos* resultados (context, callers, impact…). Un resultado estructurado compartido significa que la lógica de ensamblado se construye una sola vez.

## 2. Barras de diseño de una tool

Toda tool debe pasar dos barras antes de ganarse su lugar:

1. **Utilidad real.** Responde una pregunta que un agente/humano realmente hace, y lo hace mejor/más barato que `grep` + `Read`.
2. **Viabilidad real (offline, local-first).** Es **determinística** y corre **sin LLM y sin red**. Astrograph es 100% local — **ninguna tool puede generar prosa en lenguaje natural.** Las tools *ensamblan* (rankean, recortan, mapean); nunca *escriben*.

> `context` y `explore` parecen "inteligentes" pero son ensamblado puro: ranking + recortes de código verbatim + un mapa de relaciones. No se llama a ningún modelo. Pasan la barra.

Reglas adicionales:
- **Resultados honestos.** Todo resultado lleva cobertura/parcialidad y, donde aplique, `resolutionState` (`resolved|external|unresolved|ambiguous`) y `confidence` de edge (`high|medium|low`) — ver [ROADMAP §3](../ROADMAP.es.md#3-graph-model-data-contract). Nunca presentar datos parciales/stale/baja-confianza como hecho completo.
- **Consciente del presupuesto de tokens.** Las tools tipo contexto aceptan un budget y devuelven payloads *compactos y explicables*, no volcados de grafo crudo.
- **Naming MCP.** Expuestas sobre MCP como `astrograph_<tool>`.

## 3. Envelope de resultado compartido

El resultado estructurado de cada tool se envuelve con un `meta` para que la parcialidad sea uniforme entre superficies:

```ts
interface ToolResult<T> {
  data: T;                         // el payload estructurado específico de la tool
  meta: {
    coverage: {                    // de docs/progressive-indexing.es.md
      total: number;               // archivos en alcance
      resolved: number;            // indexados completos (edges hechos)
      parsed: number;              // solo nodos
      pending: number;             // aún sin indexar
    };
    partial: boolean;              // true si la respuesta podría cambiar al crecer la cobertura
    pendingFiles?: string[];       // archivos relevantes a esta respuesta aún indexándose
    notes?: string[];              // notas de honestidad (p.ej. "3 refs ambiguas omitidas")
  };
}
```

Los formatters renderizan `meta` como banner (MCP), línea de footer (CLI) o badge (Web). El comportamiento progresivo por tool está en [docs/progressive-indexing.es.md §4](progressive-indexing.es.md#4-what-works-progressively-and-what-doesnt).

## 4. Las tools (V1 — espejo de las 10 de codegraph)

Tipos de campos compartidos referenciados abajo: `NodeRef` = `{ id, name, kind, qualifiedName, filePath, range, signature? }`; `EdgeRef` = `{ kind, line?, col?, confidence?, resolutionState? }`; `CodeBlock` = `{ filePath, startLine, endLine, language, content }`.

---

### 4.1 `astrograph_search`
- **Propósito.** Encontrar símbolos por nombre en el codebase. Solo ubicaciones, sin código.
- **Utilidad.** Punto de entrada para casi todo; reemplaza el `grep` amplio para descubrir símbolos.
- **Offline.** Query FTS5 sobre `nodes_fts`. ✅
- **Inputs.** `query: string`, `kind?: NodeKind`, `limit?: number = 10`, `projectPath?: string`.
- **Resultado.** `SearchResult[]` = `{ node: NodeRef, score: number, highlights?: string[] }`.
- **Progresivo.** ✅ los resultados crecen con la cobertura; etiquetar como parcial.
- **Método core.** `search()`.

### 4.2 `astrograph_context`  ⭐ primaria
- **Propósito.** Construir contexto de código relevante para una tarea — compone search + node + callers + callees + ranking en una llamada. La superficie principal hacia el agente.
- **Utilidad.** Suele responder un "cómo funciona X / dónde está Y" en una llamada sin más `Read`/`Grep`.
- **Offline.** Ensamblado determinístico: search → recorrer vecindad acotada → rankear → recortar. Sin prosa. ✅
- **Inputs.** `task: string`, `maxSymbols?: number = 20`, `includeCode?: boolean = true`, `tokenBudget?: number`.
- **Resultado.** `TaskContext` = `{ entryPoints: NodeRef[], subgraph: { nodes: NodeRef[], edges: EdgeRef[] }, codeBlocks: CodeBlock[], inclusionReasons: Record<id, string>, relatedFiles: string[], stats }`.
- **Notas.** Debe soportar **presupuestos de tokens, ranking, vecindades acotadas y razones de inclusión** (ROADMAP §11 "Context quality"). `inclusionReasons` es lo que la hace explicable en vez de un volcado.
- **Progresivo.** ✅ local; el boost por demanda resuelve la zona enfocada al instante.
- **Método core.** `buildContext()`.

### 4.3 `astrograph_trace`
- **Propósito.** Trazar el camino de llamadas entre dos símbolos ("cómo X llega a Y") en una llamada — cada salto con su cuerpo inline, siguiendo saltos de dispatch dinámico (callbacks, interface→impl, re-render) que grep no puede.
- **Utilidad.** Preguntas de flujo (request→handler, update→render) caras de reconstruir a mano.
- **Offline.** Recorrido del grafo sobre edges `calls`/`references` + recorte verbatim. ✅
- **Inputs.** `from: string`, `to: string`, `maxDepth?: number`.
- **Resultado.** `TracePath` = `{ found: boolean, hops: { node: NodeRef, via: EdgeRef, body: CodeBlock }[], destinationCallees?: NodeRef[] }`. Con `found:false`, inline ambos extremos + sus hermanos de archivo (la cadena se rompió en dispatch dinámico).
- **Progresivo.** ⚠️ parcial — funciona una vez que `from`, `to` y el camino están cubiertos; si no, se indexan por demanda.
- **Método core.** `trace()` (BFS sobre el call graph).

### 4.4 `astrograph_callers`
- **Propósito.** Listar funciones que llaman a `<symbol>`.
- **Utilidad.** "¿Quién usa esto?" antes de leer/editar.
- **Offline.** Query de edge inverso `(target, kind='calls')`. ✅
- **Inputs.** `symbol: string`, `limit?: number = 20`.
- **Resultado.** `{ caller: NodeRef, callSite: EdgeRef }[]`.
- **Progresivo.** ❌ inverso global — un caller puede vivir en un archivo `pending`. Reportar cobertura + marcar parcial hasta cobertura completa.
- **Método core.** `callers()`.

### 4.5 `astrograph_callees`
- **Propósito.** Listar funciones que `<symbol>` llama.
- **Utilidad.** "¿De qué depende esto?" sin leer el cuerpo.
- **Offline.** Query de edge directo `(source, kind='calls')`. ✅
- **Inputs.** `symbol: string`, `limit?: number = 20`.
- **Resultado.** `{ callee: NodeRef, callSite: EdgeRef }[]`.
- **Progresivo.** ✅ mayormente local (salientes desde el archivo del símbolo una vez parseado).
- **Método core.** `callees()`.

### 4.6 `astrograph_impact`
- **Propósito.** Listar símbolos afectados por cambiar `<symbol>`. Usar antes de un refactor.
- **Utilidad.** Análisis de radio de impacto; ediciones más seguras.
- **Offline.** Recorrido inverso-transitivo acotado por `depth`. ✅
- **Inputs.** `symbol: string`, `depth?: number = 2`.
- **Resultado.** `{ node: NodeRef, distance: number, viaPath: EdgeRef[] }[]`.
- **Progresivo.** ❌ inverso global — mismo caveat que `callers`; reportar parcialidad.
- **Método core.** `impact()`.

### 4.7 `astrograph_node`
- **Propósito.** Detalles de un símbolo específico; opcionalmente el código verbatim.
- **Utilidad.** Ubicar un símbolo: posición, firma, y su rastro inmediato de callers/callees.
- **Offline.** Lookup de nodo + recorte opcional. ✅
- **Inputs.** `symbol: string` (nombre o id), `includeCode?: boolean = false`.
- **Resultado.** `{ node: NodeRef, docstring?, callersPreview: NodeRef[], calleesPreview: NodeRef[], code?: CodeBlock }`.
- **Progresivo.** ✅ local; boost por demanda.
- **Método core.** `getNode()`.

### 4.8 `astrograph_explore`
- **Propósito.** Devolver el código de varios símbolos relacionados **agrupado por archivo**, más un mapa de relaciones, en una llamada acotada. El query es una bolsa de nombres/términos (no una pregunta). El código devuelto es **verbatim, equivalente a Read** — no reabrir archivos ya mostrados.
- **Utilidad.** Sondea un área en una llamada; colapsa implementaciones redundantes/intercambiables a firmas para que el payload se dimensione a la *respuesta*, no al número de archivos (el sizing adaptativo de codegraph).
- **Offline.** Lookup + agrupado + recorte. ✅
- **Inputs.** `query: string` (p.ej. `"AuthService loginUser session-manager"`), `maxFiles?: number = 12`.
- **Resultado.** `{ files: { filePath, blocks: CodeBlock[] }[], relationshipMap: EdgeRef[] }`.
- **Progresivo.** ✅ local; boost por demanda de los símbolos nombrados + 1 salto.
- **Método core.** `explore()`.

### 4.9 `astrograph_files`
- **Propósito.** Árbol de archivos indexados con lenguaje + conteo de símbolos. Más rápido que escanear el filesystem / `Glob`.
- **Utilidad.** El layout del proyecto de un vistazo, ya filtrado a fuente indexada.
- **Offline.** Query sobre la tabla `files`. ✅
- **Inputs.** `path?: string`, `pattern?: string` (glob), `format?: 'tree' | 'flat' | 'grouped' = 'tree'`, `includeMetadata?: boolean = true`, `maxDepth?: number`.
- **Resultado.** Tree/flat/grouped de `{ filePath, language, nodeCount, coverageState }`.
- **Progresivo.** ✅ refleja lo indexado; expone `coverageState` por archivo.
- **Método core.** `getFiles()`.

### 4.10 `astrograph_status`
- **Propósito.** Chequeo de salud del índice (files / nodes / edges) + cobertura. Saltar salvo para debug.
- **Utilidad.** Verificar frescura; ver qué falta. Es *cómo se inspecciona la cobertura*.
- **Offline.** Queries de stats. ✅
- **Inputs.** `projectPath?: string`.
- **Resultado.** `GraphStats` = `{ nodeCount, edgeCount, fileCount, nodesByKind, edgesByKind, filesByLanguage, dbSizeBytes, lastUpdated }` + resumen de `coverage` + `pendingSync?: string[]` + `backend`/`journalMode`.
- **Progresivo.** ✅ la herramienta de introspección de la cobertura misma.
- **Método core.** `getStats()` + query de cobertura.

---

## 5. Resumen

| Tool | Propósito | Viable offline | Progresivo |
|---|---|---|---|
| `astrograph_search` | Encontrar símbolos por nombre | ✅ FTS5 | ✅ |
| `astrograph_context` ⭐ | Componer contexto relevante de tarea | ✅ ensamblado | ✅ local |
| `astrograph_trace` | Camino de llamadas A→B con cuerpos | ✅ recorrido | ⚠️ parcial |
| `astrograph_callers` | Qué llama a X | ✅ edges inversos | ❌ global |
| `astrograph_callees` | Qué llama X | ✅ edges directos | ✅ local |
| `astrograph_impact` | Radio de impacto de cambiar X | ✅ inverso-transitivo | ❌ global |
| `astrograph_node` | Detalle/código de un símbolo | ✅ lookup+recorte | ✅ local |
| `astrograph_explore` | Código de N símbolos por archivo + mapa | ✅ agrupar+recortar | ✅ local |
| `astrograph_files` | Árbol de archivos indexados | ✅ tabla files | ✅ |
| `astrograph_status` | Salud del índice + cobertura | ✅ stats | ✅ |

Las 10 son determinísticas y offline — ninguna llama a un modelo. ✅

## 6. Fuera de alcance para V1 (tools candidatas a futuro)

Solo se agregan si pasan las mismas dos barras (utilidad + viabilidad offline). Rastreadas bajo ROADMAP §13 (Etapa 4 / v1.5, Etapa 5 / v2):

- `astrograph_coverage` — vista explícita de deuda de índice (zonas stale/parciales/ambiguas). *Viable offline.*
- `astrograph_diff` — qué cambió en el grafo entre commit A y B / impacto de un PR. *Viable offline (lee git).*
- `astrograph_explain_context` — por qué cada símbolo entró en un payload de contexto. *Viable offline (introspección).*
- Chequeos de reglas de arquitectura (deps prohibidas, ciclos, capas). *Viable offline.*

Cualquier cosa que requiera prosa generada, embeddings o red queda fuera mientras Astrograph sea local-first.

## 7. Referencias
- Formas/descripciones de tool a espejar: [`codegraph/src/mcp/tools.ts`](../../codegraph/src/mcp/tools.ts), [`server-instructions.ts`](../../codegraph/src/mcp/server-instructions.ts).
- Capa de queries del core que respalda el contrato: [`codegraph/src/index.ts`](../../codegraph/src/index.ts) (el facade `CodeGraph`), [`src/context/`](../../codegraph/src/context), [`src/graph/`](../../codegraph/src/graph), [`src/search/`](../../codegraph/src/search).
- Comportamiento progresivo + envelope de cobertura: [docs/progressive-indexing.es.md](progressive-indexing.es.md).
- Framing de la Etapa 2: [ROADMAP §5](../ROADMAP.es.md#5-stage-2--mcp-support).
