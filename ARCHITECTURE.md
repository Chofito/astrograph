# Architecture

One package, one binary, one SQLite file per project. This page is the whole design; if it
disagrees with the code, the code wins and this page gets fixed.

```
src/
  bin.ts              entry point
  cli/                argument parsing; install/ writes agent-host configs
  mcp.ts              MCP server (stdio)
  tools.ts            the tool catalog shared by CLI and MCP
  format.ts           plain-text rendering of query results, fitted to token budgets
  core/
    project.ts        find/open a project, sync on demand
    scan.ts           which files to index (git ls-files, excludes, size cap)
    parser.ts         web-tree-sitter runtime + grammars (WASM embedded in the binary)
    extract/          tree → symbols, references, imports   (typescript.ts, php.ts)
    indexer.ts        incremental sync: stat → hash → extract → write
    link.ts           resolve every reference to a symbol
    resolve.ts        JS/TS module specifier → indexed file
    graph.ts          read-only queries
    db.ts             schema
```

## Pipeline

1. **Scan.** `git ls-files --cached --others --exclude-standard` (a manual walk with the root
   `.gitignore` outside git), filtered by extension, default excludes, `config.exclude` and
   `maxFileSize`.
2. **Diff.** Files whose size and mtime match the index are skipped without being read. The rest
   are read and hashed; an unchanged hash only refreshes the mtime.
3. **Extract.** Each changed file is parsed and walked once. The extractor emits:
   - *symbols*: top-level declarations and class/interface members. Code nested inside a function
     is not a symbol; its references belong to the enclosing symbol.
   - *references*: `call`, `new`, `extends`, `implements`, `render` (JSX), each with the called
     name, a receiver (`this`, `$this->repo`, an identifier, or `?` when it is an expression), and
     optional type hints computed in the file (see below).
   - *imports* (JS/TS): bindings and re-exports, all in one table.
   The tree is freed immediately, and each batch of 100 files is written in one transaction.
4. **Link.** If anything changed, every reference is re-resolved (see Resolution). It is a linear
   pass over in-memory maps of symbols and imports, paged through the refs table.

The MCP server runs steps 1–4 before each tool call (at most every 2 s); a sync with no changes
is a stat walk. There is no daemon, no watcher, no lock file: SQLite (WAL, busy timeout)
serializes concurrent writers.

## Data model

`files` (path, lang, size, mtime, hash, error) → `symbols` (name, qualified_name, kind,
parent_id, lines, signature, return_type) and `refs` (from_id, kind, name, receiver, hints,
target_id, resolution) and `imports`. Deleting a file cascades. Source code is **not** stored:
code shown in results is read from disk at query time.

Qualified names: JS/TS `Class.member` (unique per file), PHP `Ns\Class::member` (global).

The index is a disposable cache. When `SCHEMA_VERSION` in `db.ts` changes, old indexes are
deleted and rebuilt; there are no migrations. Bump it whenever schema or extraction output changes.

## Resolution

Each reference ends up as one of:

| | meaning |
|---|---|
| `exact` | resolved through a binding: local declaration, import, namespace, `this`, or a known receiver type |
| `inferred` | receiver type unknown, but exactly one project method has that name |
| `ambiguous` | receiver type unknown and several project methods share the name |
| `external` | leaves the project: package import, PHP class not in the index, runtime global, builtin method |
| `unresolved` | none of the above (local closures, untyped values with no matching method) |

Rules, in order:

- **Bare call `f()`**: a top-level declaration in the file; else an import binding, followed
  through re-export chains (`export *`, `export { a as b } from`); else a runtime global →
  `external`. Files without imports are scripts, so they fall back to a unique project-wide name.
- **`this.m()` / `$this->m()` / `self::` / `static::`**: the enclosing class, then its parents
  (resolved `extends` and trait `use`). If an ancestor is outside the project → `external`.
- **`super.m()` / `parent::m()`**: the parents only.
- **Receiver with a type hint** (`x: Foo`, `new Foo()`, `$p` typed param, `catch (E $e)`): the
  type is resolved like a bare name, then the member is looked up through inheritance.
- **`this.field.m()` / `$this->field->m()`**: the field's declared type, found on the class or an
  ancestor (typed fields, TS parameter properties, PHP promoted params and constructor
  assignments `$this->x = $typedParam`, `@var`).
- **`x = f()`**: typed by `f`'s declared return type (`Promise<T>` unwraps to `T`).
- **PHP names** are made fully qualified at extraction time from the namespace and `use`
  imports; unqualified function calls try `Ns\f` then the global `f`, as PHP does.
- **Anything else**: the unique-method-name fallback (`inferred` / `ambiguous`), except for
  names that are almost always builtins (`map`, `push`, `then`, `get`…), which are `external`.

JS/TS specifiers resolve against the set of indexed files only: relative paths (with extension
swapping `.js`→`.ts` and `index.*`), the nearest `tsconfig.json`/`jsconfig.json` `paths` and
`baseUrl` (following relative `extends`), and workspace packages found through `package.json`
`name` fields. A miss means the import is external.

## Rules of thumb

- **No compiler.** Type information comes only from what is written in the file. That keeps
  memory bounded and indexing fast; anything needing real inference stays `inferred`/`ambiguous`.
- **Measure memory.** Peak RSS is dominated by the parser runtime and JSC's allocator high-water
  mark (~250 MB for a few hundred files, ~500 MB for ~4k files). Workers do not help: Bun does not
  return a terminated worker's memory. Check `/usr/bin/time -l astrograph index --force` before
  and after changes to the indexing path.
- **One tool catalog.** A new query is added once in `tools.ts`; it becomes a CLI command and an
  MCP tool.
- **Output is for agents.** Results are compact text with `path:line` and `#id`s that can be fed
  back into another call. Every renderer in `format.ts` writes through `Out`, a token-budgeted
  buffer: content that does not fit is counted and the answer says how to get it (`offset=`,
  a narrower target, a larger `maxTokens`). Code is line-numbered and cut at line boundaries.
