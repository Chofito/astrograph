---
name: astrograph
description: Use Astrograph's local code graph before grep/read loops in TypeScript, JavaScript and PHP projects. Prefer it for "how does X work", who calls what, what a change affects, how A reaches B, and finding symbols by approximate name.
---

# Astrograph

Astrograph is a pre-built graph of the project's declarations and references (TS, JS, PHP),
stored in `.astrograph/`. One call returns the relevant symbols with their location, callers,
callees and source, which usually replaces several searches and file reads.

## Pick the tool by intent

| Intent | MCP tool | CLI |
|---|---|---|
| How does this feature work? | `astrograph_context` | `astrograph context "<task>"` |
| What is in this file / directory / class? | `astrograph_outline` | `astrograph outline <path or symbol>` |
| Find a symbol | `astrograph_search` | `astrograph search <name>` |
| Who calls / instantiates / extends X? | `astrograph_callers` | `astrograph callers <symbol>` |
| What does X call? | `astrograph_callees` | `astrograph callees <symbol>` |
| What breaks if I change X? | `astrograph_impact` | `astrograph impact <symbol>` |
| How does A reach B? | `astrograph_trace` | `astrograph trace <a> <b>` |
| Show one symbol (and its code) | `astrograph_node` | `astrograph node <symbol> --include-code` |
| Source for several names at once | `astrograph_explore` | `astrograph explore <names…>` |
| Which files are indexed? | `astrograph_files` | `astrograph files [dir]` |
| Index health | `astrograph_status` | `astrograph status` |

Prefer the MCP tools when available. A symbol argument can be a name (`addItem`), a qualified
name (`Cart.addItem`, `App\Cart::add` or just `Cart::add`), `path:name`, or an `#id` copied from
earlier output; use `#id` when a result lists several symbols with the same name.

## Spend tokens deliberately

- **Outline before reading.** `astrograph_outline` on a file gives every signature with its line
  range for a fraction of the file's tokens. Then read only the lines you need, or call
  `astrograph_node` with `includeCode` for one symbol.
- Every tool takes `maxTokens`. Defaults are small; raise it only when the answer says it cut
  something you need. Lists continue with `offset`.
- The footer of each answer shows its approximate cost (`≈1.2k tokens`).

## Reading results

- Code blocks are read from disk at call time, carry source line numbers, and the index re-syncs
  changed files before every call: treat them as already read instead of opening the same file
  again, and use the line numbers for edits.
- A cut is always announced (`… 18 more … offset=20`, `… lines 74-355 not shown`). If there is no
  such line, you saw everything.
- Each reference is `exact` unless tagged. `[inferred]` means the receiver's type was unknown and
  the target was matched by a unique method name: verify it if the answer depends on it.
  `[external]` targets live in a library or the runtime.
- "Nothing references X" means nothing in **indexed** code does. Dynamic calls (`obj[name]()`,
  `$this->$method()`, string-based DI, framework magic) are invisible to the graph.

## When to use something else

- Files in other languages (Python, Go, CSS, templates, config): use search and direct reads.
- Literal text (error messages, SQL, config keys): use text search.
- No `.astrograph/` directory: offer to run `astrograph init` in the project root.
