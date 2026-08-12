# Glossary

Status: mixed
Baseline: `8c6e9ad004a491886fb396cddca0dd617c67f495`
Canonical owner: architecture documentation

| Term | Precise meaning |
|---|---|
| Astrograph | Local repository symbol graph exposed through a TypeScript facade, CLI, MCP, and an agent skill. |
| Project root | Absolute directory whose tracked/indexable files and `.astrograph/` state belong to one graph. |
| Backend | A registered `LanguageBackend`: extension ownership, parser, optional enricher, capabilities, and version keys. |
| Registry | `LanguageRegistry`, the authority that routes a file extension to at most one backend. |
| Pass A | Per-file Tree-sitter structural extraction. At the baseline it emits project nodes and `contains` edges only. |
| Pass B | Optional language-specific enrichment for semantic/name resolution and optional node enrichment. |
| Complement | Enricher mode in which Pass A nodes are a conservative subset and matching IDs are updated in place. |
| Replace | Implemented mode that skips Pass A. It conflicts with the current target that Pass A always owns structural nodes; see `DEV-007`. |
| None | Status/config representation for a backend without an enricher. In code this is normally `enricher === undefined`. |
| Reconciliation | ID-based comparison of Pass A and enricher node sets: update matches, insert enricher-only nodes, report Pass-A-only drops. |
| Project node | Symbol whose `filePath` is inside the indexed project and is not marked external. |
| External node | Minimal symbol outside the project boundary, persisted only when path-hygiene policy permits. |
| Resolution state | Trust classification on an edge: `resolved`, `external`, `ambiguous`, or `unresolved`. |
| Confidence | Independent edge certainty: `high`, `medium`, or `low`. It does not replace resolution state. |
| Provenance | Producer of graph evidence, currently `tree-sitter`, `ts-compiler`, or `heuristic`. |
| Coverage state | Per-file pipeline state: `pending`, `parsed`, or `resolved`. It is not a claim of type-checker quality. |
| Partial result | A result whose relevant coverage/capability is insufficient to claim completeness. |
| Scoped query | Query whose completeness can be determined from a known set of files. |
| Global query | Search or traversal for which an omitted pending file could change the answer. |
| Healing | Reconnecting unresolved edges after a target appears. The current bare-name implementation is a deviation. |
| Config identity | Hash of relevant project config, ignore/lock files, and backend/grammar versions used to invalidate an index. |
| Full index | `Indexer.indexAll`: scan, Pass A, reconciliation, Pass B, then project metadata. |
| Delta sync | `sync` or `syncFiles`: calculate changed/removed files and update affected graph rows. |
| Tool envelope | `ToolResult<T>`, containing `data` plus coverage/partiality/notes in `meta`. |
| Surface | A consumer-facing adapter such as CLI, MCP, agent skill, or docs site. |
| AS-IS | Behavior proven by source at the frozen baseline. |
| TO-BE | Desired behavior backed by roadmap, contract, accepted ADR, or approved spec. |
| Deviation | Explicit mismatch between AS-IS and TO-BE, tracked with a stable `DEV-nnn` identifier. |

