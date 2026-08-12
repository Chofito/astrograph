---
name: astrograph
description: Use Astrograph's local code graph before grep/read loops. Covers JS/TS (TypeScript Compiler enricher) and PHP (name-resolution enricher); other languages need a backend first. Prefer for architecture/call flow, dependency, impact, and symbol lookup questions.
---

# Astrograph

Astrograph is a **pre-built local code graph** powered by tree-sitter (structural extraction, per registered language backend) + language-specific enrichers (JS/TS gets the TypeScript Compiler enricher for semantic depth). Use it to answer structural code questions with fewer broad searches and fewer file reads.

## First Check

If Astrograph MCP tools are available, prefer them over shelling out to the CLI.
If only the CLI is available, use the matching `astrograph <command>`.

Before relying on the graph in a project, check freshness:

- MCP: call `astrograph_status`.
- CLI: run `astrograph status`.
- If there is no `.astrograph/` index, offer to run `astrograph init`.
- If the daemon is running, trust it as the freshness owner.
- Always read the coverage/staleness banner before deciding whether to inspect
  files directly.

## Language Support

Astrograph indexes a file only if a **language backend** claims its extension. What ships today:

| Files | Coverage | Edge provenance |
|---|---|---|
| `.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs` | structural **+ semantic** — exact import/call/type resolution via the TypeScript Compiler enricher | `ts-compiler` |
| `.php` | structural **+ name resolution** — heritage, `use` imports, types, calls/`new` (honest `external`/`unresolved`) | `tree-sitter` |

**Anything else is not in the graph.** Python, Go, Rust, Java and friends have no backend yet, so
`astrograph` will not find their symbols — use `rg` and direct reads for those files. This is the
extension path, not a current capability: adding a language means registering a backend, and it becomes
useful as soon as its tree-sitter parser lands, with an enricher optional and later.

Check `astrograph_status` (or `astrograph status`) if unsure — it lists the active backends and the
extensions they claim. "Astrograph found nothing" and "that language isn't indexed" are different
answers, and only status tells them apart.

## Tool Choice

Pick by intent:

| Intent | Use |
|---|---|
| "How does this feature/module work?" | `astrograph_context` |
| "How does X reach Y?" | `astrograph_trace` |
| "Find the symbol named X" | `astrograph_search` |
| "Who calls X?" | `astrograph_callers` |
| "What does X call?" | `astrograph_callees` |
| "What breaks if I change X?" | `astrograph_impact` |
| "Show this one symbol and maybe its code" | `astrograph_node` |
| "Show related code for these names/terms" | `astrograph_explore` |
| "Which files are indexed?" | `astrograph_files` |
| "Is the graph healthy/fresh?" | `astrograph_status` |

CLI equivalents:

```bash
astrograph context "how does auth refresh work?"
astrograph trace LoginScreen refreshToken
astrograph search useAccount
astrograph callers useAccount
astrograph callees AccountScreen
astrograph impact updateSession
astrograph node useAccount --code
astrograph explore session refresh token
astrograph files
astrograph status
```

## Prefer Astrograph Before Grep

Use Astrograph first for:

- cross-file control flow
- callers/callees
- imports and dependencies
- impact analysis before editing
- symbol lookup when the name is approximate
- architecture questions
- task context for an implementation or bug

Use `rg`, glob, or direct file reads when:

- the graph is missing and the user does not want to initialize it
- the file's language has no backend (see Language Support) — the graph simply has nothing for it
- the coverage banner says a specific file is pending or partial
- you need raw text not modeled by the graph, such as comments, copy, env var
  names, config keys, or test snapshots
- the user explicitly asks for literal text search
- Astrograph gives no useful result after one focused retry

## Query Style

Make graph queries precise:

- Prefer symbol names when known: `useAccount`, `CheckoutScreen`, `AuthService.login`.
- For `context`, use a natural task phrase: "how does checkout submit an order".
- For `trace`, provide endpoints, not prose.
- For `explore`, pass a compact bag of related symbols or terms.
- If results are noisy, narrow by symbol name, file area, or node kind instead of
  immediately falling back to broad grep.

## Source Blocks Are Already Read

When `astrograph_context`, `astrograph_trace`, `astrograph_node`, or
`astrograph_explore` returns code blocks, treat those blocks as already read.
Do not re-open the same files just to verify them unless the banner says the file
is pending/partial or the answer still lacks necessary detail.

## External Symbols

Project symbols are the default. External `node_modules` and `.d.ts` symbols can
be useful, but they often drown out project results.

Use external results only when needed:

```bash
astrograph callers someSymbol --include-external
astrograph callees someSymbol --include-external
```

## After Editing

If the daemon is running, it should sync changes in the background.

If not using the daemon:

```bash
astrograph sync
```

After edits that affect a question, check `astrograph_status` or the next tool's
coverage banner before trusting old graph results.

## Answering Users

When Astrograph answers the question, cite the symbols and files it returned and
avoid narrating a separate grep/read expedition. If the graph is partial, say what
may be missing and inspect only the pending or relevant files directly.
