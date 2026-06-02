# Astrograph — Roadmap & Alcance

> Grafo de código local-first para JS/TS que potencia agentes de IA (Claude Code, Cursor, etc.) con inteligencia semántica del código — y que, además, te deja **ver la "constelación" de tu código** en 3D.
>
> Inspirado en [`codegraph`](../codegraph) (que vive junto a este repo), pero con nuestras propias decisiones técnicas y un foco **deliberadamente estrecho en JS/TS** para ganar en profundidad y exactitud.

> 🌐 Idiomas: **Español** (este archivo) · [English](ROADMAP.md)

Este documento es la **fuente de verdad** del proyecto. Se construye por etapas ("vibecodeando"), y cada etapa se promptea por separado usando este roadmap como contexto.

---

## 1. Visión y objetivos

**Astrograph** indexa un repositorio JS/TS en un grafo de símbolos (funciones, clases, tipos…) y relaciones (contiene, llama, importa, extiende…), guardado localmente, y lo expone por tres superficies:

1. **CLI** — para humanos y scripts (Etapa 1).
2. **MCP** — para agentes de IA, que consultan el grafo en vez de hacer grep/Read (Etapa 2).
3. **Web UI 3D** — la "constelación" navegable del código (Etapa 3).

**¿Para quién?**
- **Agentes de IA**: responden preguntas de arquitectura/flujo con menos tokens y menos tool calls (el grafo ya hizo el trabajo de exploración).
- **Humanos**: entienden un codebase nuevo, miden impacto antes de refactorizar, y exploran visualmente.

**Principios de diseño:**
- **100% local.** Nada sale de tu máquina. Sin API keys, sin servicios externos. Solo SQLite.
- **Performance-friendly.** Complejidad **~lineal respecto al tamaño del repo** en la extracción; reindexado **incremental por deltas** al cambiar archivos.
- **Solo JS/TS al inicio** (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`). Arquitectura abierta a más lenguajes después, pero sin sacrificar la profundidad en JS/TS ahora.
- **Desacoplado del runtime.** Lo específico de Bun vive detrás de adapters; el core no debe quedar casado con Bun.

---

## 2. Decisiones de arquitectura

| Tema | Decisión | Razón |
|---|---|---|
| Runtime + driver SQLite | **Bun + `bun:sqlite`** | Nativo, rápido, soporta FTS5/WAL; coherente con el `CLAUDE.md` del monorepo |
| Motor de extracción | **TypeScript Compiler API** | Type-checker real → resolución de imports/tipos/símbolos exacta; sin resolver heurístico |
| Estructura del repo | **Monorepo con workspaces de Bun** | `packages/core`, `packages/cli`, luego `packages/mcp`, `apps/web` |
| Alcance Etapa 1 | **Completo** | Grafo con `contains/imports/calls/extends/implements/references` + queries `search/context/callers/callees/impact/trace/node/files/status` |
| Lenguajes | **Solo JS/TS/JSX/TSX** | Foco; arquitectura abierta a más después |
| Dependencias del core | **Built-ins de Bun + mínimas libs** (`typescript`, `ignore`) | Lo Bun-specific detrás de interfaces/adapters para poder migrar sin reescribir el core |
| CLI | **Híbrida**: args clásico + **opentui** | One-shot scriptable/pipe-able; opentui solo para vistas interactivas |
| Estado | **Híbrido**: SQL + FS | Grafo en `.astrograph/graph.db`; runtime/config en `.astrograph/` (config, lock, daemon) |
| MCP (Etapa 2) | **SDK oficial `@modelcontextprotocol/sdk`** | Menos plomería; foco en las tools |
| Web (Etapa 3) | **3D con three.js** (`react-force-graph-3d` + `@react-three/postprocessing`) + React/Tailwind/shadcn | Máxima personalización tipo constelación (glow, partículas) |

### Storage
`bun:sqlite` con **WAL + FTS5**. Esquema inspirado en codegraph (`nodes`, `edges`, `files`, `nodes_fts`, `project_metadata`, `schema_versions`), con una diferencia importante: **eliminamos la tabla `unresolved_refs`** de codegraph, porque el TS Compiler API resuelve referencias directamente (codegraph la necesita porque tree-sitter no resuelve y difiere la resolución a una segunda pasada).

### Extracción e incrementalidad
- **TS Compiler API** vía `ts.LanguageService` + `ts.DocumentRegistry`: cachea ASTs por archivo y re-typechequea solo lo afectado.
- Extraemos símbolos recorriendo el AST por archivo; resolvemos tipos/imports/llamadas con el `TypeChecker` **solo donde haga falta (lazy)** para acotar el costo.
- **Detección de deltas:** hash de contenido por archivo (`Bun.hash`/wyhash) comparado contra la tabla `files`. Solo se re-extraen los archivos cambiados.
- **File watcher** con debounce que dispara `sync` automáticamente.

### Desacoplamiento (clave)
Todo lo dependiente de Bun va detrás de interfaces/adapters:
- `StorageAdapter` — impl. con `bun:sqlite` (shape `prepare/run/get/all/exec/transaction/pragma`, estilo el `sqlite-adapter.ts` de codegraph).
- `FileSystem` / `Hasher` / `Glob` — impl. con `Bun.file` / `Bun.hash` / `Bun.Glob`.
- `Watcher` — impl. con el watcher de Bun.
- `Extractor` — impl. con TS Compiler API (futuras impls. por lenguaje encajarían aquí).

El core **no importa `bun:*` directamente**. Dependencias externas mínimas: `typescript` (parser, obligatoria) e `ignore` (.gitignore). El resto (traversal BFS/DFS/impact/trace, formatters, parser de query FTS) es propio.

### ¿Por qué cumple "lineal + deltas"?
- La **extracción** de cada archivo es ~lineal en su tamaño (un recorrido de AST).
- El **indexado completo** es la suma sobre archivos → lineal en el total de código fuente del proyecto.
- El **sync** solo toca archivos cambiados (+ sus referrers entrantes) → costo proporcional al cambio, no al repo.
- ⚠️ Matiz honesto: la **resolución** del type-checker es perezosa pero puede ser superlineal en casos patológicos (tipos recursivos enormes). Mitigaciones: resolución lazy, caché por `DocumentRegistry`, `skipLibCheck`, batching y métricas.

---

## 3. Modelo del grafo (contrato de datos)

Adaptamos los tipos de codegraph (ver [`codegraph/src/types.ts`](../codegraph/src/types.ts)).

**Nodos** (`kind`): `file`, `module`, `class`, `interface`, `function`, `method`, `property`, `field`, `variable`, `constant`, `enum`, `enum_member`, `type_alias`, `namespace`, `parameter`, `import`, `export`, `component`.

Cada nodo: `id`, `kind`, `name`, `qualifiedName`, `filePath`, `language`, posición (`startLine/endLine/startColumn/endColumn`), `docstring?`, `signature?`, `visibility?`, flags (`isExported/isAsync/isStatic/isAbstract`), `decorators?`, `typeParameters?`, `updatedAt`.

**Edges** (`kind`): `contains`, `calls`, `imports`, `exports`, `extends`, `implements`, `references`, `type_of`, `returns`, `instantiates`, `overrides`. Cada edge: `source`, `target`, `kind`, `metadata?`, `line?`, `column?`, `provenance?` (`ts-compiler` por defecto).

**`id` de nodo:** hash estable de `filePath::qualifiedName` (p. ej. `Bun.hash`). Debe ser **estable entre reindexados** (ver §11).

**Esquema SQL:** basado en [`codegraph/src/db/schema.sql`](../codegraph/src/db/schema.sql) — tablas `nodes`, `edges`, `files`, virtual `nodes_fts` (FTS5 con triggers de sync), `project_metadata`, `schema_versions`. Índices: por `kind`, `name`, `qualified_name`, `file_path`, `(source, kind)`, `(target, kind)`, `lower(name)`.

> La tabla `files` incluye desde el día 1 una columna de **estado de cobertura** (`pending → parsed → resolved`) que habilita la indexación progresiva de la Etapa 2. Ver [docs/progressive-indexing.es.md](docs/progressive-indexing.es.md).

---

## 4. Etapa 1 — Grafo + CLI + tests (V1)

Objetivo: un grafo JS/TS correcto y rápido, consultable por CLI, con tests sólidos.

> **Recomendación de secuencia (ver §14):** empezar por un **slice vertical (1.0)** antes de abrir en amplitud.

### 1.0 — Slice vertical (primer hito de valor)
`index → search → context` funcionando de punta a punta sobre **un repo real** (no solo fixtures), con un **eval harness** que mida calidad. Responde la pregunta "¿esto realmente sirve?".

### 1.1 — Scaffolding
Monorepo Bun (`packages/core`, `packages/cli`), `tsconfig`, esquema SQLite, `StorageAdapter` sobre `bun:sqlite`, capa de `DatabaseConnection`/`QueryBuilder`.

### 1.2 — Extracción JS/TS
Integrar TS Compiler API; extraer nodos/edges de un archivo. Carpeta de **fixtures** (`packages/core/__fixtures__/`) cubriendo: clases + herencia, imports relativos y por alias (`tsconfig paths`), funciones / arrow functions, re-exports / barrels, JSX/TSX (componentes), `async`, decoradores, enums, namespaces, default exports, CommonJS.

### 1.3 — Resolución
Imports y llamadas vía `TypeChecker`; path aliases y barrels (`index.ts`) resueltos por TS nativamente. Marcar refs a `node_modules`/`.d.ts` como **externas** (no crean nodos).

### 1.4 — Indexado completo + sync incremental por deltas
`indexAll`, `sync` (added/modified/removed por hash de contenido), file watcher con debounce. Al cambiar un archivo: borrar sus nodos+edges, re-extraer, **re-resolver referrers entrantes**.
La extracción se diseña en **dos niveles separables** — nodos (`parsed`) desacoplados de edges (`resolved`) — con un **modelo de un solo escritor** y una **cola de indexación** como abstracción. En V1 el CLI la drena de una sola pasada, pero estos requisitos dejan al core listo para la indexación progresiva de la Etapa 2 (ver [docs/progressive-indexing.es.md](docs/progressive-indexing.es.md)).

### 1.5 — Queries del grafo
Traversal BFS/DFS, `search` (FTS5), `callers`, `callees`, `impact`, `trace`, `context` (constructor de contexto), `node`, `files`, `status`.

### 1.6 — CLI (híbrida)
Parser de args clásico (`util.parseArgs` de Bun/Node o `commander`). Comandos espejando la UX de [`codegraph/src/bin/codegraph.ts`](../codegraph/src/bin/codegraph.ts):
`init [-i] · uninit · index · sync · status · query · callers · callees · impact · trace · context · files · unlock`.
Comandos one-shot en **texto plano scriptable**; **opentui** reservado para vistas interactivas (progreso de indexado en vivo, `explore` navegable). El layer opentui va aislado para no acoplar la lógica de comandos a la UI.

### 1.7 — Tests (`bun test`)
Unitarios de extracción y resolución sobre las fixtures; tests de grafo/queries; test del **ciclo de sync incremental** (añadir/modificar/borrar y verificar que no quedan edges colgantes).
> Nota: los tests los corre el usuario, no el agente.

### Criterios de aceptación (Etapa 1)
- Indexa un repo JS/TS real sin crashear; tiempos razonables y ~lineales.
- `search`/`context`/`trace` devuelven resultados correctos verificados por el eval harness.
- `sync` tras editar un archivo refleja el cambio sin edges colgantes.
- CLI usable y scriptable; todos los tests verdes (corridos por el usuario).

---

## 5. Etapa 2 — Soporte MCP

Servidor MCP (`packages/mcp`) sobre el **SDK oficial `@modelcontextprotocol/sdk`** (transport stdio).

- **Tools** equivalentes a codegraph: `astrograph_search/context/callers/callees/impact/trace/node/explore/files/status`. Referenciar [`codegraph/src/mcp/tools.ts`](../codegraph/src/mcp/tools.ts) y [`server-instructions.ts`](../codegraph/src/mcp/server-instructions.ts) para forma/descripciones — pero la plomería del protocolo la pone el SDK. **Contrato completo de tools (agnóstico del transporte): inputs, resultados estructurados, viabilidad offline, formateo por superficie:** [docs/tools.es.md](docs/tools.es.md).
- **Instrucciones de uso** entregadas en el `initialize` del MCP (sin tocar el `CLAUDE.md` del usuario).
- **Auto-sync vivo:** watcher + banner de staleness por archivo + catch-up al reconectar (ver sección "How auto-syncing works" del [README de codegraph](../codegraph/README.md)).
- **Indexación progresiva (estilo streaming/"WoW"):** el MCP queda disponible al instante e indexa en background; las consultas a zonas aún no indexadas **priorizan esa parte por demanda** y luego el background continúa; cada respuesta declara su **cobertura/parcialidad**. Es el modo donde brilla el daemon, y un diferenciador frente a codegraph. **Diseño completo y requisitos para el core:** [docs/progressive-indexing.es.md](docs/progressive-indexing.es.md).
- **Comandos** `install/uninstall/serve --mcp` y config para Claude Code / Cursor.
- **Referencias:** `modelcontextprotocol.io` (docs + spec) y el repo del SDK TypeScript.

### Criterios de aceptación (Etapa 2)
- Un agente (Claude Code) carga el MCP, ve las tools y responde una pregunta de arquitectura usándolas.
- Editar un archivo y volver a preguntar refleja el cambio (auto-sync + banner de staleness).

---

## 6. Etapa 3 — Web UI ("constelación")

`apps/web` con `Bun.serve()` + HTML imports + React + **Tailwind + shadcn/ui** para el chrome (según `CLAUDE.md`; sin Vite).

- **Visualización 3D tipo constelación:** render con **three.js** vía `react-force-graph-3d` (force-directed) + `@react-three/postprocessing` para bloom/glow — o react-three-fiber directo si necesitamos control total de shaders/efectos. Estética: nodos como estrellas con color por kind/lenguaje, edges como líneas luminosas por tipo de relación, efectos vistosos (glow, partículas, profundidad).
- **Performance:** aceptable en grafos grandes (LOD/culling, instancing); degradar a 2D si el grafo es enorme.
- **Interacción:** navegación 3D, búsqueda, selección de nodo con panel de detalle (código, callers/callees), filtros por kind/lenguaje/relación.
- **Datos:** endpoint(s) que sirvan el grafo desde `.astrograph/` local, reutilizando `packages/core`.

### Criterios de aceptación (Etapa 3)
- Renderiza la constelación de un repo real con interacción fluida.
- Click en un nodo muestra su código y relaciones; la búsqueda enfoca el grafo.

---

## 7. Layout del repo final (objetivo)

```
astrograph/
├── packages/
│   ├── core/            # grafo, DB (adapters), extracción TS, resolución, queries, traversal
│   │   └── __fixtures__/ # casos de prueba JS/TS
│   ├── cli/             # comandos (args clásico + opentui aislado)
│   └── mcp/             # servidor MCP (SDK oficial)   [Etapa 2]
├── apps/
│   └── web/             # UI 3D (Bun.serve + React + three.js)  [Etapa 3]
├── docs/
│   ├── tools.md / tools.es.md                       # contrato de tools hacia el agente
│   ├── progressive-indexing.md      # diseño de indexación streaming (E2) — EN
│   └── progressive-indexing.es.md   # idem — ES
├── ROADMAP.md           # EN
├── ROADMAP.es.md        # ES
└── package.json         # workspaces de Bun
```

Directorio de índice por proyecto: **`.astrograph/`** (espejo de `.codegraph/`) → `graph.db`, `config.json`, lockfile, metadata del daemon/watcher.

---

## 8. No-objetivos (por ahora)

Otros lenguajes · embeddings / búsqueda semántica vectorial · frameworks-aware routes · bridging iOS/RN/Expo · instaladores multi-agente más allá de lo básico. (Varios de estos están en "futuro", §13.)

---

## 9. Referencias de diseño (en `../codegraph`)

| Archivo | Para qué nos sirve |
|---|---|
| [`src/types.ts`](../codegraph/src/types.ts) | Modelo de Node/Edge/Subgraph/Context |
| [`src/db/schema.sql`](../codegraph/src/db/schema.sql) | Esquema SQL + FTS5 + índices |
| [`src/db/sqlite-adapter.ts`](../codegraph/src/db/sqlite-adapter.ts) | Patrón de wrapper de DB (a replicar con `bun:sqlite`) |
| [`src/db/migrations.ts`](../codegraph/src/db/migrations.ts) | Versionado/migraciones de esquema |
| [`src/bin/codegraph.ts`](../codegraph/src/bin/codegraph.ts) | Superficie de comandos CLI a replicar |
| [`src/mcp/tools.ts`](../codegraph/src/mcp/tools.ts) · [`server-instructions.ts`](../codegraph/src/mcp/server-instructions.ts) | Tools MCP e instrucciones (Etapa 2) |
| [`src/sync/`](../codegraph/src/sync) | Sync incremental + watcher + staleness |
| [`src/extraction/`](../codegraph/src/extraction) · [`src/resolution/`](../codegraph/src/resolution) | Cómo lo hacían con tree-sitter (para contrastar) |
| [`src/extraction/generated-detection.ts`](../codegraph/src/extraction/generated-detection.ts) | Detección de archivos generados |
| [`__tests__/evaluation/`](../codegraph/__tests__/evaluation) | Modelo de eval harness |
| [`README.md`](../codegraph/README.md) | Features, benchmarks, "How auto-syncing works" |

---

## 10. Diferenciador clave vs codegraph

**El TS Compiler API es nuestra ventaja, no solo una elección de parser.** codegraph usa tree-sitter (estructural) y por eso tuvo que construir mucho andamiaje de *resolución heurística*: `path-aliases.ts`, `import-resolver.ts` (~42KB), `name-matcher.ts`, sintetizadores de callbacks/frameworks. Con el type-checker real de TS, gran parte de eso es **gratis y exacto**: resolución de módulos (incl. `@/...`, `exports` maps, `node_modules`, `.d.ts`), tipos, herencia, sobrecargas, re-exports/barrels. Resultado esperado: **menos código de resolución y mayor fidelidad** en JS/TS.

| Dimensión | codegraph | astrograph (V1) |
|---|---|---|
| Lenguajes | 20+ | **Solo JS/TS/JSX/TSX** (foco) |
| Parser | tree-sitter (wasm) | **TS Compiler API** |
| Resolución de refs | heurística + tabla `unresolved_refs` | **type-checker real** (sin `unresolved_refs`) |
| Path aliases / module res. | reimplementado a mano (scope limitado) | **nativo de TS** (exacto) |
| Runtime / DB | Node + `node:sqlite` | **Bun + `bun:sqlite`** |
| MCP | transport/daemon propio | **SDK oficial** |
| Frameworks-aware routes | sí (14 frameworks) | **fuera de V1** (re-añadible sobre resolución exacta) |
| iOS/RN/Expo bridging | sí | **N/A** (no aplica a JS/TS puro) |
| Web UI | sitio docs (Astro) | **app 3D "constelación"** |
| Multi-lenguaje futuro | ya hecho | requiere capa de extracción por lenguaje |

**Tradeoff explícito:** cambiamos *amplitud* (lenguajes, frameworks, bridging) por *profundidad y exactitud* en JS/TS. Si algún día queremos multi-lenguaje, volveríamos a un modelo tipo tree-sitter para esos lenguajes — por eso la extracción queda detrás de una interfaz `Extractor`, con la impl. TS como la primera.

---

## 11. Aspectos críticos a no pasar por alto en V1

- **Configuración multi-`tsconfig` / project references / workspaces.** Repos reales tienen varios `tsconfig.json`, `references`, monorepos. Elegir el `tsconfig` correcto por archivo o caemos en resolución pobre. **Probablemente el mayor riesgo de calidad.**
- **Alcance de nodos vs alcance de resolución.** Indexar **solo archivos del proyecto** como nodos; permitir que las refs resuelvan hacia `node_modules`/`.d.ts` (marcadas "externas") sin crear nodos para ellas.
- **IDs de nodo estables** ante reindex/movimientos de archivo, para sync incremental correcto y para que la constelación 3D no "salte" entre reindexados.
- **Edges colgantes en sync incremental.** Al cambiar un archivo: borrar nodos+edges, re-extraer, y **re-resolver referrers entrantes** (no solo el archivo cambiado).
- **Archivos generados/vendored/minificados.** Excluir o down-rankear (`.generated.ts`, `.gen.ts`, etc.).
- **Casos JS/TS a extraer bien:** default exports, re-exports/barrels (`export * from`), `import type`, dynamic `import()`, CommonJS `require`/`module.exports`, arrow functions asignadas, decoradores, namespaces, enums, JSX/TSX, HOCs.
- **Concurrencia/locking.** CLI + daemon MCP pueden tocar la misma DB → `FileLock` + WAL.
- **Migraciones de esquema desde el día 1.** `schema_versions` + migraciones versionadas.
- **Core preparado para indexación progresiva.** Estado de cobertura por archivo, extracción separable (nodos vs edges), un solo escritor y cola de indexación — aunque el modo streaming se "encienda" recién en E2. Detalle: [docs/progressive-indexing.es.md](docs/progressive-indexing.es.md).
- **Config del proyecto:** `include/exclude`, `.gitignore` (lib `ignore`), tamaño máx de archivo, qué kinds indexar — en `.astrograph/config.json`.
- **Honestidad sobre "lineal".** Extracción ~lineal; resolución del type-checker perezosa pero potencialmente superlineal en casos patológicos. Documentar realidad + mitigaciones.

---

## 12. Premortem (por qué podría fracasar y mitigación)

- **#1 — Calidad de resolución en monorepos reales** (tsconfig/alias/project refs) peor que en fixtures → contextos malos → no supera a `grep`. **Mitigación:** eval harness desde temprano (espejo de `codegraph/__tests__/evaluation/`); validar en repos reales (Excalidraw, VS Code) antes de declarar V1.
- **#2 — Memoria/tiempo del TS Program en repos enormes** (~10k archivos) → indexado frío lento, no "lineal". **Mitigación:** `LanguageService`/incremental, resolución lazy, `skipLibCheck`, awareness de project references, batching y métricas.
- **#3 — Corrección del sync incremental** (edges colgantes, refs entrantes obsoletas). **Mitigación:** test dedicado del ciclo de deltas; re-resolver referrers.
- **#4 — Sobre-scope de E1 "completo"** retrasa la validación. **Mitigación:** slice vertical primero (§14).
- **#5 — Bleeding edge** (opentui, three.js, APIs nuevas de Bun) consume tiempo sin valor de core. **Mitigación:** opentui y 3D aislados/opcionales y en etapas posteriores.
- **#6 — El valor real aparece en E2 (MCP).** Un V1 solo-CLI puede parecer "poco impresionante". **Mitigación:** tener claro que E1 valida la **calidad del grafo**; no sobre-invertir en pulido de CLI antes de eso.

---

## 13. Ideas creativas y futuro (post-V1)

- **Grafo diff-aware:** "qué cambió en el grafo entre commit A y B" / impacto de un PR. Útil para review y agentes; diferenciador frente a codegraph.
- **Constelación viva:** WebSocket (`Bun.serve`) que empuja deltas del watcher a la web UI en tiempo real mientras editas.
- **Detección de comunidades/clusters** (módulos) para dibujar constelaciones reales (agrupar estrellas por cohesión); color por cluster/lenguaje/kind.
- **Exportadores:** grafo a JSON, **Mermaid**, **DOT/Graphviz**.
- **Capa semántica opcional (embeddings)** para "código similar" / búsqueda por significado — explícitamente fuera de V1.
- **Frameworks-aware routes para JS/TS** (Express/Nest/Next/Remix) reconstruidos *sobre* resolución exacta — más fácil que en codegraph.
- **`astrograph why <A> <B>`:** explicación narrada del camino (alias amigable de `trace`).

---

## 14. Recomendación de scoping de V1

Mantener el alcance **"completo"** elegido, pero **secuenciado como slice vertical primero** para validar calidad antes que amplitud:

- **1.0 (slice vertical):** `index → search → context` de punta a punta sobre **un repo real**, con eval harness midiendo calidad. El "¿esto realmente sirve?".
- Luego abrir en amplitud (1.1–1.7) hacia el set completo de queries/edges.

Así "V1 = Etapa 1 completa" sigue en pie, pero el primer hito demuestra valor en días, no al final.
