# tree-sitter structural extraction (Pass A)

> Design document. The concrete mapping from **tree-sitter CST → Astrograph graph nodes and structural edges**. This is **Pass A** (structural extraction, all languages). For semantic enrichment, see [docs/extraction/typescript.md](typescript.md) (TS Compiler Pass B).
>
> Implements the `Parser` interface in [docs/contracts.md](../contracts.md). Produces nodes (`state='parsed'`) and structural edges of [docs/graph-model.md](../graph-model.md).
>
> 🌐 Languages: **English** (this file)

---

## 0. Non-negotiables (Pass A)

- **Determinism.** Same source + same tree-sitter grammar version ⇒ identical nodes and structural edges. No timestamps in IDs; sort outputs.
- **Per-file, no cross-file resolution.** Each file is parsed independently. Edges only within/immediately around the file (syntactic imports, no symbol resolution).
- **Project nodes only.** Files under `node_modules` / `.d.ts` never become project nodes in Pass A; they're handled by Pass B enrichers or marked external.
- **All tree-sitter languages.** The logic applies generically to any tree-sitter-supported language. Language-specific naming conventions (e.g. `__init__.py` for Python) are handled separately.

---

## 1. tree-sitter setup

1. **Load grammar.** Per-language tree-sitter grammar (e.g. `tree-sitter-javascript`, `tree-sitter-python`).
2. **Create parser.** `new Parser(); parser.setLanguage(language)`.
3. **Parse source.** `tree = parser.parse(sourceString)`.
4. **Walk CST.** Root is `tree.rootNode`; traverse with `.child(i)`, `.namedChildren`, etc.

**Properties:**
- Fast, works for all languages
- Tolerant of incomplete/broken code (best-effort parse)
- Preserves exact position (`node.startIndex` → line/column via source map)
- Deterministic: same source → same tree

---

## 2. CST → nodes (generic pattern)

For a language, **identify declaration kinds** (class, function, type alias, etc.) and map them to `NodeKind`.

**Generic pattern — walk the CST:**

```
for each node in tree:
  if node is a declaration (e.g., class_declaration, function_declaration):
    create Node{
      kind: classifyNodeKind(node),
      name: extractName(node),
      qualifiedName: buildQualifiedName(node),
      filePath: file.path,
      language: language,
      startLine/endLine: node.startPosition.row + 1, node.endPosition.row + 1,
      startColumn/endColumn: node.startPosition.column, node.endPosition.column,
      visibility: extractModifiers(node),
      isExported: hasExportModifier(node),
      … other attributes …
    }
  
  recursively walk children (nesting → `contains` edges)
```

**The file itself** is a `file` node (root of `contains`).

### 2.1 Language-specific node kind mapping

**JavaScript/TypeScript** (via tree-sitter-javascript):

| CST node type | NodeKind | Notes |
|---|---|---|
| `program` | `file` | root; top-level decls are children |
| `function_declaration` | `function` | |
| `method_definition` / `class_body > function_declaration` | `method` | parent = class |
| `class_declaration` | `class` | |
| `interface_declaration` (TS) | `interface` | |
| `enum_declaration` (TS) | `enum` | members → `enum_member` |
| `type_alias_declaration` (TS) | `type_alias` | |
| `module` / `namespace` (TS) | `namespace` | |
| `property_signature` / `public_field_definition` | `property` | class/interface member |
| `variable_declarator` inside `const` / `let` / `var` | `constant` or `variable` | see §2.2 |
| `import_statement` / `import_clause` | `import` | also drives `imports` edges |
| `export_statement` / `export_clause` | `export` | also drives `exports` edges |

**Python** (via tree-sitter-python):

| CST node type | NodeKind | Notes |
|---|---|---|
| `module` | `file` | root |
| `function_definition` | `function` | |
| `class_definition` | `class` | members are children |
| `decorated_definition` | (pass through to wrapped node) | decorator is separate edge |
| `import_statement` / `import_from_statement` | `import` | |

### 2.2 Variables, functions, anonymous

- **`const x = () => {}`** / **`function x(){}`** → `function` node named `x` (not `variable`).
- **`class C {}`** assigned to a binding → `class` named `C`.
- **`const X = 1`** (literal) → `constant`; **`let y`** → `variable`.
- **Anonymous functions** as callbacks → get a node **only** if necessary (deferred; in V1 skip unless Pass B needs it).
- **Arrow functions returning JSX** → `kind:'component'` if name is PascalCase (heuristic; JSX detection is language-specific).

### 2.3 qualifiedName format

```
<repo-relative-file>::<Outer>.<Inner>...
```

- Top-level: `src/auth/service.ts::AuthService`.
- Member: `src/auth/service.ts::AuthService.login`.
- Nested: `src/x.py::OuterClass.InnerClass.method`.

Walk the CST parent chain to build the chain of enclosing names.

### 2.4 Flags and attributes

Extract modifiers from the CST:
- `isExported` — has `export` keyword or in an export statement
- `isAsync` — (JS/TS) `async` keyword
- `isStatic` — `static` keyword
- `isAbstract` — (TS/C++) `abstract` keyword
- `visibility` — `public`, `private`, `protected` from modifiers
- `signature` — (optional in Pass A; Pass B can populate)
- `docstring` — leading comment block (if extractable; language-specific)

---

## 3. Structural edges (Pass A)

### 3.1 `contains`

Parent → child nesting in the CST.

```
for each declaration node D:
  if D has nested declarations (class members, function body, etc.):
    for each child decl C:
      edges.push( Edge{ kind:'contains', source:D.id, target:C.id, … } )
```

### 3.2 `imports`

From `import_statement` or `import_from_statement` nodes.

```
for each import node I:
  targetModule = extractModulePath(I)  // 'react', '../utils', '@/types', etc.
  for each imported name N:
    edges.push( Edge{ 
      kind:'imports', 
      source: enclosingFile.id, 
      targetName: N,
      metadata: { module: targetModule },
      resolutionState: 'unresolved'  // Pass B will resolve or confirm
    } )
```

**Note:** No target node yet; `targetName` is a string. Pass B will resolve to a node (or keep `unresolved`).

### 3.3 `exports`

From `export_statement` / `export_clause`.

```
for each export node E:
  exportedName = extractExportName(E)
  edges.push( Edge{
    kind: 'exports',
    source: enclosingFile.id,
    targetName: exportedName,
    metadata: { isDefault: E.isDefaultExport? },
    resolutionState: 'unresolved'  // Pass B confirms/resolves
  } )
```

### 3.4 `references` (optional in V1)

All other uses of identifiers (e.g., in expressions, calls, type annotations).

```
for each identifier in source not covered above:
  edges.push( Edge{
    kind: 'references',
    source: enclosingDecl.id,
    targetName: identifierText,
    resolutionState: 'unresolved'  // Pass B resolves or confirms
  } )
```

**Note:** This can be noisy; in V1 focus on `contains`, `imports`, `exports` and defer detailed `references` to Pass B.

### 3.5 Syntactic `calls` (best-effort)

A simple heuristic: if an identifier is immediately followed by `(`, it's likely a call.

```
for each call_expression in CST:
  calleeIdent = extractCalleeIdentifier(callExpr)  // e.g., 'foo', 'obj.method'
  edges.push( Edge{
    kind: 'calls',
    source: enclosingDecl.id,
    targetName: calleeIdent,
    resolutionState: 'unresolved'  // Pass B refines
  } )
```

**Caveat:** tree-sitter gives us the syntactic structure, not semantic binding. `foo()` is a call to something named `foo`, but we don't know which `foo` yet — that's a Pass B job. We emit the edge with low confidence.

---

## 4. Determinism and reproducibility

- **Same grammar version + same source** → byte-identical CST.
- **Consistent node ID generation:** `hash(project + filePath + kind + qualifiedName + locator)`. No randomness.
- **Sorted output:** all nodes and edges are emitted in a stable order (by file, then by source position).
- **Grammar version tracking:** the `configHash` or `provenance` includes the tree-sitter grammar version so re-parsing with a different grammar is detected.

---

## 5. Language-specific handling

### File extensions and language selection

Extensions are mapped to a grammar by the **backend that claims them** (`LanguageBackend.extensions`) —
there is no global extension table. What ships:

| Extension | Backend | Grammar |
|---|---|---|
| `.js` `.jsx` `.mjs` `.cjs` | `typescript` | tree-sitter-javascript |
| `.ts` `.tsx` | `typescript` | tree-sitter-typescript / -tsx |
| `.php` | `php` | tree-sitter-php |

An extension no backend claims is **not indexed at all** — it is not a fallback-parsed file. Adding
`.py` or `.go` means adding a backend that claims them, which is the extension path, not current
behavior.

### Language-specific quirks

**JavaScript/TypeScript:**
- Hoisting: not modeled explicitly in Pass A; both `function f() {}` and `var f = function() {}` are treated as declarations.
- Re-exports: `export { x as y } from './module'` — emit an `exports` edge, Pass B will trace it.
- Dynamic imports: `import('x')` — treat like a call to a special function; Edge is low-confidence.

**PHP** (no enricher — Pass A output is final for these files):
- A file may open and close PHP mode repeatedly; only `php`-mode regions carry declarations, the rest is inline HTML text.
- `namespace` declarations feed `qualifiedName`; `use` statements emit `imports` edges resolved as far as the syntax allows and left `unresolved` beyond that, never guessed.
- Visibility modifiers (`public`/`protected`/`private`) map directly to `Node.visibility`; there is no inference to do.
- Because nothing runs after Pass A, its edges are the ones that ship — mark anything cross-file it cannot pin as `unresolved` rather than optimistically `resolved`.

---

## 6. Completeness and coverage states

Pass A takes a file to **`parsed`**. Edges it emits are structural only; semantic enrichment (call targets, import symbols, type relationships) is deferred to Pass B.

For progressive indexing:
- A file at `state='parsed'` has all its nodes extracted (symbols exist).
- Edges are syntactic (`contains`, attempted `imports`/`exports`/`calls`/`references`), all with `provenance: 'tree-sitter'`.
- Clients can use parsed nodes for basic search, explore, structure questions.
- If the backend has an enricher, Pass B then refines edges and the file becomes `resolved`.
- **If it doesn't** (`mode: 'none'`), the file goes straight to `resolved` after Pass A — Pass A *is* the pipeline for that language. It does not sit at `parsed` forever. See [graph-model §6.1](../graph-model.md#61-what-resolved-means-per-backend-language-agnostic).

In `complement` mode Pass A must emit a **conservative subset** whose node ids are byte-identical to the
enricher's, and emit **nothing** where it cannot guarantee that (overloads, ambiguous `component` vs
`function`). The rule and its rationale live in [overview.md](overview.md#complement-reconciliation-the-rule-that-keeps-ids-stable);
a Pass-A-only node is a bug, and [docs/testing.md §2.2](../testing.md#22-pass-a--pass-b-id-parity-golden-the-seam-test) is the test that catches it.

---

## 7. See also

- [docs/extraction/overview.md](overview.md) — architecture overview, Pass A vs Pass B
- [docs/extraction/typescript.md](typescript.md) — TS Compiler enricher (Pass B) for JS/TS semantic depth
- [docs/contracts.md](../contracts.md) — canonical Node/Edge/Parser types
- [ROADMAP.md](../../ROADMAP.md) §1–2 — why tree-sitter + enrichers
