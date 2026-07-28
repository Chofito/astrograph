# TypeScript Compiler enricher (Pass B)

> Design document. The concrete mapping from the **TypeScript Compiler API** to Astrograph's refined graph edges. This is **Pass B enrichment** for JS/TS, adding semantic depth (type resolution, exact calls, imports) on top of tree-sitter's structural Pass A. Implements the `Enricher` interface in [docs/contracts.md](../contracts.md).
>
> For **Pass A** (tree-sitter structural), see [docs/extraction/tree-sitter.md](tree-sitter.md). For **architecture overview**, see [docs/extraction/overview.md](overview.md).
>
> 🌐 Languages: **English** (this file)

---

## 0. Non-negotiables (Pass B)

- **Determinism.** Same source + same TS version ⇒ identical refined edges. No timestamps; sort outputs.
- **Enriches, not replaces.** Refines Pass A edges with exact symbols, confidence, resolution states. Creates external nodes for `node_modules`/`.d.ts` symbols only when needed.
- **Project nodes only.** Project files are indexed as nodes; external code stays external.
- **Lazy resolution.** Enricher runs on demand (progressive indexing) or once per full index. Resolves cross-file imports, calls, type relationships via `TypeChecker`.
- **V1 scope.** Primary `tsconfig.json`/`jsconfig.json` only. Multi-`tsconfig`, project references → Stage 4.

---

## 1. LanguageService setup

1. **Discover config.** From project root: find `tsconfig.json`, else `jsconfig.json`, else synthesize defaults (`allowJs:true, checkJs:false, target:ESNext, moduleResolution:Bundler, jsx:preserve, skipLibCheck:true`). Honor `AstrographConfig.tsconfigPath` override.
2. **Parse config** with `ts.parseJsonConfigFileContent` (tolerant of comments/trailing commas) → `compilerOptions` + file list. Always set `skipLibCheck:true` (perf) and preserve `paths`/`baseUrl` (alias resolution).
3. **File set.** Intersect the config's file list with glob results (honors `include`/`exclude` + `.gitignore`). Skip files over `maxFileSizeBytes`.
4. **LanguageService.** Build `ts.LanguageService` backed by `ts.DocumentRegistry` + custom `LanguageServiceHost` with `getScriptVersion` returning file content hash (invalidates exactly one file on edit). Get `Program`/`TypeChecker` lazily from the service.
5. **External resolution.** The Program loads `.d.ts`/`node_modules` for the checker — we just don't emit project nodes for them.

---

## 2. Resolution decision tree (→ resolutionState + confidence)

For a reference at location `L` with enclosing node `S`:

```
sym = checker.getSymbolAtLocation(L)
if (!sym) → if (literal-resolvable, e.g. require('x')) treat as import; 
             else edge{ targetName: text(L), resolutionState: 'unresolved', confidence: 'low' }

decls = sym.getDeclarations()
if (decls.length === 0) → unresolved

primary = pickDeclaration(decls)              // §2.1
file = primary.getSourceFile().fileName
if (isProjectFile(file)) {
   target = makeNodeId(primary)               // must match Pass A id (§2.2)
   resolutionState = 'resolved'
   confidence = isAnyTyped(L) ? 'medium' : 'high'
} else {                                      // node_modules / .d.ts / lib
   target = ensureExternalNode(sym, file)    // create minimal external node
   resolutionState = 'external'
   confidence = 'high'
}

if (decls.length > 1 && !overloadSet(decls))  // genuine ambiguity
   resolutionState = 'ambiguous'
   metadata.candidates = decls.map(makeNodeId)
   confidence = 'medium'
```

### 2.1 `pickDeclaration` rules

- **Overload set** → pick the implementation signature (or first if none).
- **Aliased import** (`import { x }`) → follow `checker.getAliasedSymbol` to the real declaration.
- **Re-export barrels** (`export * from './module'`) → follow through to the original module.
- **Merged declarations** (interface + implementation) → pick the binding/implementation.

### 2.2 ID parity (CRITICAL)

The `target` id computed in **Pass B must byte-match** the id **Pass A** assigned. Both call `makeNodeId` with `{project, filePath, kind, qualifiedName, locator}`. **Centralize this function; a mismatch silently breaks every edge.** Test this in `docs/testing.md`.

### 2.3 Dynamic and loose cases

- **`import('x')`** or **`require(expr)`** with non-literal arg → `unresolved`, `targetName` = printed expr.
- **`any`-typed receiver call** → resolve if possible but `confidence:'medium'`.
- **`// @ts-ignore` above** → drop confidence one notch.

---

## 3. Edge types resolved by Pass B

### 3.1 `imports`

Enhanced from Pass A syntactic import edges.

```
for each import_statement in source:
  targetModule = resolveModuleName(importPath, checker)  // exact path resolution
  for each imported name N:
    symbol = resolveImportSymbol(N, targetModule, checker)
    target = symbol ? makeNodeIdOrExternal(symbol) : null
    
    edges.push( Edge{
      kind: 'imports',
      source: enclosingFile.id,
      target: target,
      targetName: N,
      metadata: { module: targetModule },
      provenance: 'ts-compiler',
      resolutionState: target ? (isExternal ? 'external' : 'resolved') : 'unresolved',
      confidence: 'high'
    } )
```

**Handles:**
- `import { x } from 'module'` — resolves `x` to its declaration
- `import * as M from 'module'` — creates a namespace `import` node
- `import default` — resolves the default export
- `import type` — marks as type import (metadata)
- `require('x')` — treats like `import 'x'`
- Path aliases (`@/utils`) — resolved via `compilerOptions.paths`

### 3.2 `calls`

Refined from Pass A syntactic `calls`.

```
for each call_expression in source:
  calleeSymbol = checker.getSymbolAtLocation(callee)
  target = calleeSymbol ? makeNodeIdOrExternal(calleeSymbol) : null
  
  edges.push( Edge{
    kind: 'calls',
    source: enclosingDecl.id,
    target: target,
    targetName: getText(callExpr.expression),
    provenance: 'ts-compiler',
    resolutionState: classifyResolution(target, isAnyTyped),
    confidence: isAnyTyped ? 'medium' : 'high',
    line: callExpr.pos
  } )
```

**Handles:**
- Direct calls: `foo()`, `obj.method()`
- Higher-order calls: `compose(f, g)()`
- Constructor calls: `new MyClass()`
- Dynamic/dynamic calls: `any` receiver; lower confidence
- Callbacks passed as arguments (optional; can defer)

### 3.3 `extends` / `implements`

```
for each class_declaration in source:
  if (class has extends clause):
    baseSymbol = checker.getSymbolAtLocation(baseClause)
    target = makeNodeIdOrExternal(baseSymbol)
    edges.push( Edge{ kind: 'extends', source: class.id, target: target, … } )
  
  if (class has implements clause):
    for each interface I:
      interfaceSymbol = checker.getSymbolAtLocation(I)
      target = makeNodeIdOrExternal(interfaceSymbol)
      edges.push( Edge{ kind: 'implements', source: class.id, target: target, … } )
```

### 3.4 `exports`

Enhanced from Pass A syntactic exports.

```
for each export_statement in source:
  exportedName = extractExportName(stmt)
  if (named export of a decl):
    exported symbol is in this file → target = local node id
  else if (re-export: export { x } from 'module'):
    followthrough:
    symbol = resolveFromModule(x, 'module', checker)
    target = makeNodeIdOrExternal(symbol)
  else if (default export):
    symbol = checker.getSymbolAtLocation(defaultExportExpr)
    target = makeNodeIdOrExternal(symbol)
  
  edges.push( Edge{
    kind: 'exports',
    source: enclosingFile.id,
    target: target,
    targetName: exportedName,
    metadata: { isDefault: stmt.isDefaultExport },
    resolutionState: target ? classify(target) : 'unresolved',
    provenance: 'ts-compiler'
  } )
```

### 3.5 `type_of`, `returns`, `overrides` (optional V1)

**`type_of`:** var/param/property type annotations.

```
for each variable/parameter/property with type annotation:
  typeSymbol = checker.getTypeAtLocation(annotation)
  target = makeNodeIdOrExternal(typeSymbol)
  if (not primitive):
    edges.push( Edge{ kind: 'type_of', source: var.id, target: target, … } )
```

**`returns`:** function return types.

```
for each function with return type:
  returnTypeSymbol = checker.getReturnTypeAtLocation(decl)
  target = makeNodeIdOrExternal(returnTypeSymbol)
  edges.push( Edge{ kind: 'returns', source: fn.id, target: target, … } )
```

**`overrides`:** methods with same name as base class method.

```
for each method M in class C:
  if (C extends Base):
    for each base M':
      if (M.name === M'.name):
        edges.push( Edge{ kind: 'overrides', source: M.id, target: M'.id, … } )
```

---

## 4. External nodes (from `node_modules` / `.d.ts`)

When enricher resolves a symbol to `node_modules` or a `.d.ts` file:

External nodes use the **same `makeNodeId` policy as every other node** ([contracts §4](../contracts.md#4-node-id),
[graph-model §2](../graph-model.md#2-node-identity-nodesid)). There is no separate external-id scheme —
a second hashing rule would break id parity, dedup, and the `contains`/`calls` FK invariants.

```
function ensureExternalNode(symbol, sourceFile) {
  id = makeNodeId({
    project,                       // same scope key as project nodes ('root' in V1)
    filePath: sourceFile,          // repo-relative if inside the repo, else the module specifier path
    kind: classifyKind(symbol),
    qualifiedName: buildQualifiedName(symbol),   // e.g. 'lodash::debounce'
    locator,                       // only when needed (overloads) — same rule as project nodes
  })
  if (!db.nodes[id]):
    node = Node{
      id,
      project, kind, name: symbol.name,
      qualifiedName,
      filePath: sourceFile,
      language: 'typescript',      // or detect from the .d.ts
      range: ZERO_RANGE,           // required field; externals have no meaningful position
      isExternal: true,
      isExported: true, isAsync: false, isStatic: false, isAbstract: false,
      isGenerated: false, isTest: false,
      metadata: { provenance: 'ts-compiler' },
      updatedAt: now(),
    }
    db.insert(node)
  return id
}
```

Every non-optional field of `Node` is set — `project`, `qualifiedName`, `range`, all five boolean
flags, and `updatedAt` — because storage rejects a partial node and goldens compare whole records.

**Properties:**
- External nodes are **minimal** (name, kind, file only; no position, docstring, etc.).
- Created on-demand (only if referenced).
- Marked `isExternal=true`; never become project nodes.
- Edges to external nodes have `resolutionState='external'`.

---

## 5. JS/TS edge cases checklist (golden-test)

| Case | Expected edge behavior |
|---|---|
| Default export | `exports` edge from file, `imports` from consumers |
| Re-export barrel (`export * from './x'`) | Traced through to original; edges honor the tracing |
| Dynamic `import('x')` | Best-effort `imports` edge; low confidence if not literal |
| Aliased path (`@/utils`) | Resolved via `compilerOptions.paths` |
| Relative imports | `../` resolved correctly relative to importer |
| CommonJS `require` | Treated like `import` |
| Overloads | Same `qualifiedName`, disambiguated by id's `locator` |
| Merged interfaces/declarations | `pickDeclaration` picks the right one |
| `any`-typed receiver | `confidence:'medium'` on edges |
| Circular imports | No loops in edges; cyclic structure is data, not algorithm |
| Namespace / module | Members are contained; uses are `references` edges |
| JSX components | Calls to `<Component />` are `calls` edges to the function |
| Decorator usage (`@Decorator class X`) | `references` or `decorates` edge to decorator |
| Type-only imports (`import type { X }`) | Marked in metadata; still `imports` edge |
| Generics (`Map<K, V>`) | Resolved to `Map` symbol; type parameters not separate nodes (unless needed) |
| Property accessors (`get foo() {}`) | Treated as property node, not separate get/set nodes |

---

## 6. Confidence and provenance tagging

Every edge carries:
- **`provenance`**: `'ts-compiler'` (Pass B from this enricher)
- **`confidence`**: `'high'` (resolved via exact checker), `'medium'` (any-typed or ambiguous), `'low'` (unresolved fallback)

This tells agents/clients which edges to trust.

---

## 7. Determinism and schema versioning

- **TS version tracking:** `configHash` includes TypeScript version. Re-indexing with a different TS version is detected and re-resolved.
- **`skipLibCheck:true`:** keeps indexing fast; we still resolve `.d.ts` symbols exactly when needed.
- **Sorted output:** all resolved edges in stable file/position order.

---

## 8. See also

- [docs/extraction/overview.md](overview.md) — full Pass A/B architecture
- [docs/extraction/tree-sitter.md](tree-sitter.md) — tree-sitter Pass A (structural extraction)
- [docs/contracts.md](../contracts.md) — canonical Enricher, Node, Edge types
- [docs/graph-model.md](../graph-model.md) — graph schema, external nodes detail
- [ROADMAP.md](../../ROADMAP.md) §2, §4 — architecture decisions, Stage 1 scope
