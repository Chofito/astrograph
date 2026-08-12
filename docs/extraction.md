# Extraction documentation

> 🌐 Languages: **English** (this folder)

Astrograph's extraction uses a **two-pass architecture**:
- **Pass A (tree-sitter):** Structural extraction for extensions claimed by a registered backend
- **Pass B (enrichers):** Language-specific semantic depth (e.g. TS Compiler for JS/TS)

For frozen AS-IS/TO-BE boundaries, evidence, and diagrams, start with the canonical [backend contract](architecture/extraction/backend-contract.md). The older documents below retain detailed design history.

## Core documentation

- **[docs/extraction/overview.md](extraction/overview.md)** — architecture overview, two-pass design, pluggable enrichers
- **[docs/extraction/tree-sitter.md](extraction/tree-sitter.md)** — Pass A (structural extraction, CST → nodes/edges)
- **[docs/extraction/typescript.md](extraction/typescript.md)** — Pass B for JS/TS (TypeScript Compiler enricher, semantic resolution)

## Related

- **[docs/contracts.md](contracts.md)** — canonical types for `LanguageBackend`, `Parser`, `Enricher`
- **[docs/graph-model.md](graph-model.md)** — graph schema, node IDs, resolution states, coverage
- **[ROADMAP.md](../ROADMAP.md)** — Stage 1–2 scope, architecture decisions (§1–2)
