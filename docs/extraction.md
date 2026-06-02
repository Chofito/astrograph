# Extraction spec (TS Compiler API → graph)

> 🌐 Languages: **English** (this file) · _ES mirror pending (see backlog)_

> Design document. The concrete mapping from the **TypeScript Compiler API** to Astrograph's graph. This is the **highest-risk, most divergent** part (ROADMAP premortem #1/#2) — so it is specified exactly, to keep three coding models producing the *same* graph. Implements the `Extractor` interface in [docs/contracts.md §5](contracts.md#5-adapter-interfaces-the-seams--core-depends-only-on-these). Produces the nodes/edges of [docs/graph-model.md](graph-model.md).

---

## 0. Non-negotiables

- **Determinism.** Same source + same TS version ⇒ identical nodes, edges, and IDs. No timestamps in IDs; sort outputs.
- **Two passes, level-separable.** Pass A (`extractNodes`) is per-file, no cross-file resolution → nodes (`state='parsed'`). Pass B (`resolveEdges`) uses the `TypeChecker` → edges (`state='resolved'`). This is what makes progressive indexing possible.
- **Project nodes only.** Files under `node_modules`/`.d.ts` lib files never become project nodes; they become **external nodes** only when referenced (graph-model §5).
- **V1 scope.** Primary `tsconfig.json`/`jsconfig.json` only. Multi-`tsconfig`/project references = Stage 4.

---

## 1. Program & LanguageService construction

1. **Discover config.** From the project root, find `tsconfig.json`, else `jsconfig.json`, else synthesize sane defaults (`allowJs:true, checkJs:false, target:ESNext, moduleResolution:Bundler, jsx:preserve, skipLibCheck:true`). Honor `AstrographConfig.tsconfigPath` override.
2. **Parse config** with `ts.parseJsonConfigFileContent` (tolerant of comments/trailing commas) → `compilerOptions` + file list. Always set `skipLibCheck:true` (perf) and keep `paths`/`baseUrl` (alias resolution is the whole point).
3. **File set.** Intersect the config's file list with `GlobScanner` results (honors `include`/`exclude` + `.gitignore`). Skip files over `maxFileSizeBytes` (record an `ExtractionError`).
4. **Service.** Build a `ts.LanguageService` backed by a `ts.DocumentRegistry` and a custom `LanguageServiceHost` whose `getScriptVersion` returns the file's content hash (so edits invalidate exactly one file). Get the `Program`/`TypeChecker` from the service lazily.
5. **External resolution still works** because the Program loads `.d.ts`/`node_modules` for the checker — we just don't emit project nodes for them.

---

## 2. Declarations → nodes (Pass A)

Walk each `SourceFile` with `ts.forEachChild`. Map AST node kinds → `NodeKind`. The **file itself** is a `file` node (root of `contains`).

| TS AST | NodeKind | Notes |
|---|---|---|
| `SourceFile` | `file` | one per file; parent of all top-level decls |
| `FunctionDeclaration` | `function` | |
| `MethodDeclaration` / `MethodSignature` | `method` | parent = class/interface |
| `ClassDeclaration` / `ClassExpression` | `class` | |
| `InterfaceDeclaration` | `interface` | |
| `EnumDeclaration` | `enum` | members → `enum_member` |
| `EnumMember` | `enum_member` | |
| `TypeAliasDeclaration` | `type_alias` | |
| `ModuleDeclaration` (namespace) | `namespace` | |
| `PropertyDeclaration`/`PropertySignature` | `property` | class/interface member |
| `GetAccessor`/`SetAccessor` | `property` | merge by name; metadata.accessor |
| `VariableDeclaration` | `constant` if `const` & literal/arrow, else `variable` | see §2.1 |
| `Parameter` | `parameter` | only when useful (skip in V1 unless needed by type_of) |
| `ImportDeclaration` / `ImportEqualsDeclaration` | `import` | also drives `imports` edges (§3) |
| `ExportDeclaration` / `ExportAssignment` | `export` | also drives `exports` edges |
| Arrow/Function **expression assigned to a binding** | `function` | name = binding name (§2.1) |
| Function/arrow returning JSX, or `React.FC`-typed | `component` | heuristic (§2.2) |

Skip: statements, expressions that aren't declarations, blocks. Anonymous callbacks are *not* nodes unless they earn one via §2.1.

### 2.1 Variables, arrow functions, anonymous
- `const x = () => {}` / `const x = function(){}` → **`function`** node named `x` (not `variable`). This is the common case; treat assigned function expressions as functions.
- `const C = class {}` → `class` named `C`.
- `const N = 1` (literal/const) → `constant`; `let y` → `variable`.
- Truly anonymous functions (callback args) get a node **only** if they are a call/reference target we must point at; then `qualifiedName = <enclosing>::<arg-ordinal>` and `locator = ordinal`, emitted with `confidence:'medium'` (positional, less stable).

### 2.2 JSX components (heuristic, `kind:'component'`)
A `function`/arrow is *also* tagged `component` when: name is `PascalCase` **and** (returns JSX `*.tsx`/`*.jsx` **or** is typed `React.FC`/`FunctionComponent`). It remains a single node with `kind:'component'`; `metadata.componentOf` may note the framework. HOCs (`const X = withFoo(Bar)`) → `function`/`component` named `X` with a `references` edge to `withFoo` and `Bar`.

### 2.3 qualifiedName format
```
<repo-relative-file>::<Outer>.<Inner>...
```
- Top-level: `src/auth/service.ts::AuthService`.
- Member: `src/auth/service.ts::AuthService.login`.
- Namespaced: `src/x.ts::NS.Sub.fn`.
- Overloads: same qualifiedName; disambiguated by `locator` (signature hash or ordinal) in the ID, not the name.

### 2.4 Flags
`isExported` (has `export` modifier or is in an export statement), `isAsync`, `isStatic`, `isAbstract` from modifiers. `isExternal=false` always in Pass A (project files). `isGenerated`/`isTest` from path classifier (§6). `signature` = printed declaration signature (params + return) via `checker.signatureToString` (Pass B can enrich); `docstring` = leading JSDoc.

---

## 3. References → edges (Pass B)

For each project file, resolve references using the checker. Edge detection rules:

| EdgeKind | Found at | How to resolve target |
|---|---|---|
| `contains` | AST nesting (Pass A) | parent decl node id (no checker needed) |
| `calls` | `CallExpression.expression` | `checker.getSymbolAtLocation` → declaration → node id (§4) |
| `instantiates` | `NewExpression` | symbol of the constructed class |
| `imports` | `ImportDeclaration` module + named bindings | `checker.getSymbolAtLocation` on the import specifier / `resolveModuleName` |
| `exports` | `ExportDeclaration`/`ExportAssignment` | symbol being exported (re-exports resolve through, §5) |
| `extends` | `HeritageClause` `extends` | symbol of the base type |
| `implements` | `HeritageClause` `implements` | symbol of the interface |
| `overrides` | method whose name matches a base-class method | base method node (walk `extends` chain) |
| `type_of` | type annotation of var/param/property | symbol of the referenced type (skip primitives) |
| `returns` | function return type | symbol of the return type (skip primitives) |
| `references` | other identifier uses (incl. JSX `<Comp/>`, decorator refs not via `decorates`) | symbol at location |
| `decorates` | `Decorator` on a decl | symbol of the decorator expression |

`source` is always the **enclosing project node** at the reference site (the function/method/class that owns the line). `line`/`col` = the reference location.

> Keep V1 focused: prioritize `contains`, `imports`, `calls`/`instantiates`, `extends`, `implements`, `references`. `type_of`/`returns`/`overrides`/`decorates` are valuable but add them once the core five are golden-tested.

---

## 4. Resolution decision tree (→ resolutionState + confidence)

For a reference at location `L` with enclosing node `S`:

```
sym = checker.getSymbolAtLocation(L)
if (!sym) → if (literal-resolvable, e.g. require('x')) treat as import; else
            edge{ target:null, targetName:text(L), resolutionState:'unresolved', confidence:'low' }

decls = sym.getDeclarations()
if (decls.length === 0) → unresolved (as above)

primary = pickDeclaration(decls)          // §4.1
file = primary.getSourceFile().fileName
if (isProjectFile(file)) {
   target = makeNodeId(of primary)         // must match Pass A id exactly (§4.2)
   resolutionState = 'resolved'
   confidence = isAnyTyped(L) ? 'medium' : 'high'
} else {                                   // node_modules / .d.ts / lib
   target = ensureExternalNode(sym, file)  // graph-model §5
   resolutionState = 'external'
   confidence = 'high'
}

if (decls.length > 1 && !overloadSet(decls))   // genuine ambiguity (e.g. merged/union)
   resolutionState = 'ambiguous'
   metadata.candidates = decls.map(makeNodeId)
   confidence = 'medium'
```

### 4.1 `pickDeclaration`
- Overload set → the implementation signature (or first if none).
- Aliased import (`import { x }`) → follow `checker.getAliasedSymbol` to the real declaration.
- Re-export barrels → follow through to the original (§5).

### 4.2 ID parity (critical)
The `target` id computed in Pass B **must byte-match** the id Pass A assigned to that declaration. Both call `makeNodeId` with the same `{project, filePath, kind, qualifiedName, locator}`. Centralize this in one function used by both passes — a mismatch silently breaks every edge. **This is the #1 integration bug to guard with a test** (docs/testing.md).

### 4.3 Dynamic / loose cases
- `import('x')` / `require(expr)` with **non-literal** arg → `unresolved`, `targetName` = printed expr.
- `any`/`unknown`-typed receiver call → resolve if possible but `confidence:'medium'`.
- `// @ts-ignore`/`@ts-expect-error` above the line → drop confidence one notch.

---

## 5. JS/TS edge cases checklist (must be golden-tested)

| Case | Expected behavior |
|---|---|
| `export default function Foo` | node `Foo` (or `default` name w/ metadata), `isExported`, `exports` edge |
| `export { a as b } from './m'` | re-export: `exports` edge resolving through to `m`'s `a` |
| `export * from './m'` | re-export edges for each public symbol of `m` (resolve via checker) |
| `import type { T }` | `imports` edge, `metadata.typeOnly=true` |
| dynamic `import('./m')` (literal) | `imports` edge resolved; non-literal → unresolved |
| CommonJS `require('m')` / `module.exports =` | `imports`/`exports` edges; treat `module.exports` as default export |
| arrow assigned `const f = () => …` | `function` node `f` |
| decorators `@Injectable()` | `decorates` edge to the decorator symbol |
| `namespace N { … }` | `namespace` node, members `contains` |
| `enum E { A }` | `enum` + `enum_member` |
| JSX `<MyComp/>` | `references` edge to component; component node tagged `component` |
| HOC `const X = withAuth(Page)` | `function` `X` + `references` to `withAuth` and `Page` |
| path alias `@/lib/x` | resolved natively by TS `paths` (no special code) |
| barrel `index.ts` re-exports | resolve through to originals |

---

## 6. Generated / test classification (path-based)

Set flags at extraction time (fast ranking filter, graph-model §0). Still indexed — just flagged.

- `isGenerated`: matches `\.(generated|gen)\.[jt]sx?$`, `\.pb\.[jt]s$`, files with a leading `// @generated` / `// Code generated` header, common codegen dirs (`__generated__/`).
- `isTest`: `\.(test|spec)\.[jt]sx?$`, `__tests__/`, `e2e/`.

---

## 7. Incremental re-extraction

On change to `B.ts` (graph-model §11):
1. Delete `B`'s nodes (cascade drops their out-edges + FTS).
2. Pass A on `B` → nodes (`parsed`).
3. Pass B on `B` → its out-edges (`resolved`).
4. **Re-resolve referrers:** (a) edges with `target` ∈ old `B` ids → recompute; (b) `unresolved` edges whose `targetName` matches a new `B` symbol → heal (index `edges(resolution_state, target_name)`).
5. Update `files.state`, `node_count`, `content_hash`.

---

## 8. References
- Contracts (Extractor, Node, Edge): [docs/contracts.md](contracts.md).
- Data model (IDs, external nodes, states, sync): [docs/graph-model.md](graph-model.md).
- Golden expectations for every case here: [docs/testing.md](testing.md).
- codegraph for contrast (tree-sitter approach, *not* copied): [`src/extraction/`](../../codegraph/src/extraction), [`src/resolution/`](../../codegraph/src/resolution).
