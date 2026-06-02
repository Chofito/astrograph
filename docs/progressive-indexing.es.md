# Indexación progresiva (streaming, estilo "WoW")

> 🌐 Idiomas: **Español** (este archivo) · [English](progressive-indexing.md)

> Documento de diseño. Pertenece a la **Etapa 2 (daemon MCP)** del [ROADMAP](../ROADMAP.es.md), pero impone **requisitos al core de V1** (ver §6). El ROADMAP solo referencia este documento; el detalle vive aquí para no saturarlo.

## 1. Idea

En vez de bloquear hasta terminar de indexar todo el repo, Astrograph se comporta como un juego que *streamea el mundo*: arranca al instante, indexa en background, **disponibiliza lo que ya está listo**, y si consultas algo aún no indexado, **prioriza esa zona, la termina, responde, y vuelve** al background.

Flujo objetivo:

1. El usuario hace `astrograph init` (o el agente conecta el MCP).
2. Arranca la indexación en background y el **MCP queda disponible de inmediato**.
3. Las consultas funcionan sobre lo ya indexado; la cobertura crece sola.
4. Si una consulta toca una zona `pending`/parcial, esa zona **salta al frente**, se indexa sincrónicamente, se responde, y el background continúa.

Efecto: parece instantáneo, la memoria pico baja (si se evictan unidades frías), y el día a día se siente como un IDE.

Es un patrón conocido (LSP servers, IntelliJ). **Diferenciador frente a codegraph**, que indexa todo en `init -i` antes de servir.

## 2. Por qué nuestro stack encaja

- **`bun:sqlite` + WAL** → un escritor (el indexador) + muchos lectores (queries MCP) concurrentes sin bloqueo. Es el modelo exacto que necesitamos.
- **`ts.LanguageService` es lazy / demand-driven por diseño** — está hecho para pedir símbolos de un archivo sin chequear el resto. La indexación progresiva *es* su modo natural de uso, no una pelea contra la herramienta.

## 3. Diseño

### 3.1 Estado de cobertura por archivo
Columna de estado en la tabla `files`: **`pending → parsed → resolved`**.
- `pending`: conocido (descubierto por el walker) pero sin tocar.
- `parsed`: AST + nodos extraídos y persistidos (los símbolos ya existen).
- `resolved`: edges resueltos (imports/calls/extends…). Cobertura "completa" de ese archivo.

Es el "nivel de detalle" estilo WoW por archivo.

### 3.2 Cola de jobs con un solo consumidor
Una cola de prioridad de archivos; **un único consumidor** (el indexador) la drena y escribe a la DB. Un job de **demanda** es simplemente un job de prioridad máxima que la query `await`-ea. Un solo escritor evita corrupción (coordinado con el `Mutex`/`FileLock` que codegraph ya usa).

### 3.3 Boost por demanda (+ 1 salto)
Cuando una query toca archivos `pending`, encolamos **esos archivos + sus vecinos a 1 salto** al frente, esperamos a que lleguen a `resolved`, respondemos, y el background sigue donde iba. El "1 salto" es el "WoW también streamea la zona adyacente" — necesario por la cascada de resolución (§5.2).

### 3.4 Indexador en Worker (o yield entre archivos)
Correr el indexador en un **Worker de Bun** mantiene el event loop del MCP libre. Alternativa más simple: correr en main thread **cediendo entre archivos** (`await`), ya que parsear un archivo es cuestión de ms → el *interleaving a granularidad de archivo* se siente instantáneo. **No hace falta preempción real a mitad de un parse.**

### 3.5 Señalización de parcialidad
Cada respuesta MCP declara cobertura: `"cobertura 60% · N archivos pendientes"`. Extiende el banner de staleness de codegraph. **Nunca devolver algo incompleto haciéndolo pasar por completo.**

## 4. Qué funciona progresivamente y qué no

| Tipo de query | ¿Progresivo? | Nota |
|---|---|---|
| `node`, `context` (local a un símbolo), `files` | ✅ perfecto | Local: el boost por demanda lo resuelve al instante |
| `search` (FTS) | ✅ con cobertura creciente | Resultados crecen; etiquetar como parcial |
| `trace` (A→B) | ⚠️ parcial | Funciona si A, B y el camino están cubiertos; si no, demanda |
| `callers`, `impact` (inverso, global) | ❌ no garantizado hasta cobertura completa | Un caller puede vivir en un archivo `pending` → reportar cobertura y marcar "parcial, N pendientes" |

**Regla:** queries *locales* brillan en progresivo; queries *globales inversas* solo son completas con cobertura total — y se deben etiquetar honestamente mientras tanto.

## 5. Partes difíciles (matices reales)

1. **Queries globales inversas necesitan cobertura completa** (ver tabla §4). Sutileza #1.
2. **Cascada de resolución.** Resolver un edge a un símbolo de B exige que B esté al menos `parsed`. TS resuelve la *ruta* del módulo sin parsear B, pero el *edge a símbolo* sí lo requiere → por eso el boost a 1 salto. Hay que acotarlo o se dispara.
3. **"Menos memoria" no es gratis.** Solo baja la RAM pico si **evictas** los Programs de TS fríos (LRU por proyecto/archivo). Tensión: streaming-con-liberación = poca RAM pero re-parsea en incremental; servicio persistente = más RAM pero incremental instantáneo. Se tunea. **Sinergia con monorepos:** esto es justo lo que acota la RAM de un monorepo grande (indexar por `tsconfig`, evictar los fríos).
4. **Coordinación de escritura.** Un solo escritor, sí o sí. Cola de un consumidor + lock.
5. **Resultados que "crecen".** OK para un agente *si va etiquetado*; peligroso si se presenta como completo.

Dificultad global: **media, no alta.** Casi todo el riesgo está en (a) señalar bien la parcialidad y (b) las queries globales inversas. Nada bloqueante.

## 6. Requisitos que esto impone al core de V1

Aunque el daemon que lo "enciende" es de Etapa 2, el core de V1 debe nacer preparado, o el refactor será feo:

- **Estado de cobertura por archivo** (`files.state: pending|parsed|resolved`) en el esquema desde el día 1.
- **Cola de prioridad de indexación** como abstracción (aunque en V1 el CLI la drene de una sola pasada).
- **Modelo de un solo escritor** para la DB (background + demanda nunca escriben a la vez).
- **Resolución separable en niveles**: extracción de nodos (`parsed`) desacoplada de resolución de edges (`resolved`), para poder disponibilizar nodos antes que edges.
- **Cobertura consultable**: poder responder "¿qué % / qué archivos faltan?" para la señalización de parcialidad.

## 7. Fase

- **V1 (Etapa 1, CLI):** indexación de una sola pasada, pero respetando los requisitos §6. No se expone el modo streaming todavía.
- **Etapa 2 (MCP daemon):** se enciende el modelo completo — background + demanda + señalización de parcialidad. Aquí es donde la feature brilla.
