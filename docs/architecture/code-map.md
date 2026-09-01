# Production code map

Status: current
Baseline: `8c6e9ad004a491886fb396cddca0dd617c67f495`
Canonical owner: architecture documentation

## Purpose and inventory rule

This is the ownership inventory for non-test runtime, tooling, site, workflow, schema, and public content files. Test files and fixtures are catalogued by [testing and evaluation](operations/testing-and-evaluation.md), not repeated here. Generated outputs and declarations (`*.d.ts`) are implementation support rather than architectural components.

Every row assigns one canonical document. “Reusable” means language/runtime neutral inside this repository, not a promise of a separately published package.

## Core facade and contracts

| Files | Responsibility | Layer / reuse | Stability / lifecycle | Canonical doc |
|---|---|---|---|---|
| `packages/core/src/index.ts`, `packages/core/src/types.ts` | Public core exports and graph/tool/adapter contracts | core / reusable | public contract; process lifetime | [System](system-overview.md) |
| `packages/core/src/astrograph.ts` | Facade delegating index/sync/query operations | core / reusable | public facade; closes indexer | [Lifecycle](project-lifecycle.md) |
| `packages/core/src/ids.ts` | Deterministic node identity hashing | core / reusable | internal invariant | [Backend contract](extraction/backend-contract.md) |
| `packages/core/src/indexer.ts` | Full and delta orchestration, persistence and reconciliation | core / reusable | internal seam; owns storage close | [Indexing](indexing-pipeline.md) |
| `packages/core/src/freshness.ts` | Watch filtering, debounce and serialized sync queue | core / reusable behind Watcher | public class; explicit close | [Resources](operations/lifecycle-and-resources.md) |

## Storage, search and graph algorithms

| Files | Responsibility | Layer / reuse | Stability / lifecycle | Canonical doc |
|---|---|---|---|---|
| `packages/core/src/db/schema.sql`, `packages/core/src/db/migrations.ts` | SQLite schema and migrations | storage / reusable model | persistent compatibility boundary | [Storage](storage-and-graph-model.md) |
| `packages/core/src/db/queries.ts` | Typed SQL reads/writes, FTS and aggregate status | storage / reusable through adapter | internal high-impact seam | [Storage](storage-and-graph-model.md) |
| `packages/core/src/search/fts-query.ts` | Safe FTS tokenization/match expressions | query / reusable | internal pure helper | [Queries](query-and-honesty.md) |
| `packages/core/src/graph/symbol-lookup.ts` | Deterministic best-candidate symbol resolution | graph / reusable | internal query seam | [Queries](query-and-honesty.md) |
| `packages/core/src/graph/traversal.ts` | Bounded incoming/outgoing traversal and path search | graph / reusable | internal algorithm | [Queries](query-and-honesty.md) |
| `packages/core/src/query/graph-queries.ts` | Ten structured read tools, ranking and result shaping | query / reusable | public behavior via facade | [Queries](query-and-honesty.md) |
| `packages/core/src/query/meta.ts` | Coverage, partiality and notes envelope | query / reusable | public trust contract | [Queries](query-and-honesty.md) |
| `packages/core/src/query/code-blocks.ts` | Bounded source slices for nodes | query / reusable via FileSystem | internal helper | [Queries](query-and-honesty.md) |

## Bun composition and adapters

| Files | Responsibility | Layer / reuse | Stability / lifecycle | Canonical doc |
|---|---|---|---|---|
| `packages/core/src/adapters/bun/index.ts`, `packages/core/src/adapters/bun/project.ts` | Bun public adapter exports and composition root | adapter / Bun-specific | exported subpath; creates project resources | [Lifecycle](project-lifecycle.md) |
| `packages/core/src/adapters/bun/fs.ts` | Concrete filesystem reads/stats/existence | adapter / Bun-specific | adapter implementation | [System](system-overview.md) |
| `packages/core/src/adapters/bun/glob.ts` | Git-aware file scanning for registry extensions | adapter / Bun-specific | adapter implementation | [Configuration](configuration-and-invalidation.md) |
| `packages/core/src/adapters/bun/hasher.ts` | Concrete content/identity hashing | adapter / Bun-specific | adapter implementation | [Storage](storage-and-graph-model.md) |
| `packages/core/src/adapters/bun/sqlite.ts` | Bun SQLite connection/statements/transactions | adapter / Bun-specific | owns DB handle and close | [Storage](storage-and-graph-model.md) |
| `packages/core/src/adapters/bun/watcher.ts` | Concrete recursive filesystem watch | adapter / Bun-specific | owns watcher handles | [Resources](operations/lifecycle-and-resources.md) |

## Extraction registry and shared seams

| Files | Responsibility | Layer / reuse | Stability / lifecycle | Canonical doc |
|---|---|---|---|---|
| `packages/core/src/extraction/index.ts` | Extraction exports | extraction / reusable | internal/public re-export seam | [Backend contract](extraction/backend-contract.md) |
| `packages/core/src/extraction/registry.ts` | Backend registration, routing, versions and status | extraction / reusable | primary extension seam | [Backend contract](extraction/backend-contract.md) |
| `packages/core/src/extraction/reconcile.ts` | Pass A/complement node-set reconciliation | extraction / reusable | identity-critical pure logic | [Backend contract](extraction/backend-contract.md) |
| `packages/core/src/extraction/shared/classify.ts` | Generated/test classification | extraction / shared | pure helper | [Pass A](extraction/tree-sitter-pass-a.md) |
| `packages/core/src/extraction/shared/language.ts` | File-path language/extension helpers | extraction / shared | pure helper; registry must remain authority | [Backend contract](extraction/backend-contract.md) |
| `packages/core/src/extraction/shared/qualified-name.ts` | File-relative qualified name construction | extraction / shared | identity-critical pure helper | [Backend contract](extraction/backend-contract.md) |

## Tree-sitter structural extraction

| Files | Responsibility | Layer / reuse | Stability / lifecycle | Canonical doc |
|---|---|---|---|---|
| `packages/core/src/extraction/tree-sitter/grammars.ts` | Initialize WASM runtime, load grammar assets and create parsers | extraction / shared runtime with language assets | module caches grammar status; parser caller disposes | [Pass A](extraction/tree-sitter-pass-a.md) |
| `packages/core/src/extraction/tree-sitter/parser.ts` | JS/TS/PHP CST mapping to stable nodes and `contains` | extraction / shared orchestrator, language-specific mappings | Parser implementation; per-call Tree lifecycle | [Pass A](extraction/tree-sitter-pass-a.md) |

## TypeScript backend

| Files | Responsibility | Layer / reuse | Stability / lifecycle | Canonical doc |
|---|---|---|---|---|
| `packages/core/src/extraction/typescript/backend.ts` | Compose Tree-sitter parser and optional TS enricher/capabilities | backend / TypeScript-specific | registry-owned backend | [TypeScript](extraction/typescript-enricher.md) |
| `packages/core/src/extraction/typescript/extractor.ts` | Build TS Program, extract enriched nodes, coordinate edge resolver | backend / TypeScript-specific | project-pass cache lifetime | [TypeScript](extraction/typescript-enricher.md) |
| `packages/core/src/extraction/typescript/identity.ts` | Compiler-AST identity, kinds, signatures, flags and docs | backend / TypeScript-specific | identity-critical helpers | [TypeScript](extraction/typescript-enricher.md) |
| `packages/core/src/extraction/typescript/resolver.ts`, `packages/core/src/extraction/typescript/resolver/utils.ts` | Compiler symbol/module/call/type edge resolution and deterministic helpers | backend / TypeScript-specific | per-file resolution | [TypeScript](extraction/typescript-enricher.md) |

## PHP backend

| Files | Responsibility | Layer / reuse | Stability / lifecycle | Canonical doc |
|---|---|---|---|---|
| `packages/core/src/extraction/php/backend.ts` | Compose PHP Pass A, AST cache and optional name enricher | backend / PHP-specific | registry-owned; project-pass state | [PHP](extraction/php-enricher.md) |
| `packages/core/src/extraction/php/ast-cache.ts` | Load source and retain at most one live PHP Tree | backend / PHP-specific | explicit release/dispose | [PHP](extraction/php-enricher.md) |
| `packages/core/src/extraction/php/names.ts` | Namespace/FQN/alias and type-name helpers | backend / PHP-specific | pure/tree helpers | [PHP](extraction/php-enricher.md) |
| `packages/core/src/extraction/php/resolve.ts` | Project FQN/method index and heritage/import/type edges | backend / PHP-specific | project index + per-file result | [PHP](extraction/php-enricher.md) |
| `packages/core/src/extraction/php/calls.ts` | Type table, receiver/method lookup and call/new edges | backend / PHP-specific | per-file tree walk | [PHP](extraction/php-enricher.md) |

## Core testing support (production-exported today)

| Files | Responsibility | Layer / reuse | Stability / lifecycle | Canonical doc |
|---|---|---|---|---|
| `packages/core/src/testing/graph-assertions.ts`, `packages/core/src/testing/normalize.ts` | Integrity assertions and stable graph normalization | test support / reusable | internal test helpers; currently under source | [Testing](operations/testing-and-evaluation.md) |

## CLI entry, dispatch and commands

| Files | Responsibility | Layer / reuse | Stability / lifecycle | Canonical doc |
|---|---|---|---|---|
| `packages/cli/src/bin/astrograph.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/help.ts` | Process entry, command dispatch, exit result and help/version | transport / CLI-specific | binary public surface | [CLI](surfaces/cli.md) |
| `packages/cli/src/root.ts`, `packages/cli/src/runtime.ts` | Project-root and compiled/self-command discovery | transport / CLI-specific | internal environment seam | [CLI](surfaces/cli.md) |
| `packages/cli/src/commands/parse.ts`, `packages/cli/src/commands/shared.ts` | Common argument/config parsing and graph opening | transport / CLI-specific | internal shared command seam | [CLI](surfaces/cli.md) |
| `packages/cli/src/commands/search.ts`, `context.ts`, `node.ts`, `callers.ts`, `callees.ts`, `impact.ts`, `trace.ts`, `explore.ts`, `files.ts`, `status.ts` | Read-tool command adapters | transport / CLI-specific | public CLI behavior | [CLI](surfaces/cli.md) |
| `packages/cli/src/commands/init.ts`, `index.ts`, `sync.ts`, `uninit.ts`, `unlock.ts` | Index lifecycle commands | transport / CLI-specific | filesystem/DB mutations | [CLI](surfaces/cli.md) |
| `packages/cli/src/commands/daemon.ts`, `daemon-utils.ts`, `stop.ts`, `serve.ts` | Watch daemon and MCP process commands | transport / CLI-specific | process/metadata lifecycle | [CLI](surfaces/cli.md) |
| `packages/cli/src/commands/install.ts`, `uninstall.ts` | Agent host integration commands | transport/distribution specific | modifies host config | [Distribution](operations/distribution.md) |
| `packages/cli/src/ui/init-reporter.ts` | Init progress/receipt formatting | transport / CLI-specific | ephemeral UI | [CLI](surfaces/cli.md) |

## CLI formatting and installer internals

| Files | Responsibility | Layer / reuse | Stability / lifecycle | Canonical doc |
|---|---|---|---|---|
| `packages/cli/src/format/search.ts`, `context.ts`, `node.ts`, `callers.ts`, `callees.ts`, `impact.ts`, `trace.ts`, `explore.ts`, `files.ts`, `status.ts` | Human-readable tool formatters | transport / CLI-specific | output contract for humans | [CLI](surfaces/cli.md) |
| `packages/cli/src/format/footer.ts`, `json.ts`, `shared.ts`, `style.ts` | Coverage footer, JSON envelope, shared locations and terminal style | transport / CLI-specific | shared formatting seam | [CLI](surfaces/cli.md) |
| `packages/cli/src/install/agent-guide.ts`, `prompt.ts`, `resolve-command.ts`, `target.ts` | Agent guide materialization, confirmation, binary command and target contracts | distribution / host-specific | host config lifecycle | [Distribution](operations/distribution.md) |
| `packages/cli/src/install/targets/all.ts`, `claude.ts`, `codex.ts`, `cursor.ts`, `opencode.ts` | Supported host definitions | distribution / host-specific | extension data | [Distribution](operations/distribution.md) |
| `packages/cli/src/install/writers/json.ts`, `jsonc.ts`, `toml.ts` | Format-preserving host config readers/writers | distribution / reusable within installer | file mutation helpers | [Distribution](operations/distribution.md) |

## MCP server and project session

| Files | Responsibility | Layer / reuse | Stability / lifecycle | Canonical doc |
|---|---|---|---|---|
| `packages/mcp/src/index.ts`, `packages/mcp/src/instructions.ts` | Public MCP exports and server instructions | transport / MCP-specific | package public contract | [MCP](surfaces/mcp.md) |
| `packages/mcp/src/server.ts` | SDK server, handlers, stdio transport and signal shutdown | transport / MCP-specific | process/server lifecycle | [MCP](surfaces/mcp.md) |
| `packages/mcp/src/tools.ts` | Ten tool schemas, input parsing and core dispatch | transport / MCP-specific | protocol tool contract | [MCP](surfaces/mcp.md) |
| `packages/mcp/src/project.ts`, `packages/mcp/src/daemon.ts` | Root selection, graph/freshness session and daemon detection | transport / MCP-specific | owns graph/freshness | [MCP](surfaces/mcp.md) |
| `packages/mcp/src/format/index.ts`, `search.ts`, `context.ts`, `node.ts`, `callers.ts`, `callees.ts`, `impact.ts`, `trace.ts`, `explore.ts`, `files.ts`, `status.ts`, `shared.ts` | MCP text payload formatting and honesty banner | transport / MCP-specific | human/agent text projection | [MCP](surfaces/mcp.md) |

## Evaluation and benchmark tooling

| Files | Responsibility | Layer / reuse | Stability / lifecycle | Canonical doc |
|---|---|---|---|---|
| `eval/types.ts`, `eval/cases.ts` | Eval case/report contracts and repository-specific expectations | tooling / Astrograph-specific | opt-in evaluation data | [Testing](operations/testing-and-evaluation.md) |
| `eval/scoring.ts`, `eval/runner.ts` | Recall/MRR scoring, backend arms, execution and gates | tooling / reusable shape with repo-specific cases | opens temporary/reused graphs | [Testing](operations/testing-and-evaluation.md) |
| `bench/rss.ts` | Index timing and RSS sampling | tooling / reusable runner | opt-in process measurement | [Testing](operations/testing-and-evaluation.md) |

## Documentation site

| Files | Responsibility | Layer / reuse | Stability / lifecycle | Canonical doc |
|---|---|---|---|---|
| `apps/site/app/layout.tsx`, `app/layout.config.tsx`, `app/global.css` | Global Next/Fumadocs layout, metadata, fonts and styling | app / product-specific | web request/build lifetime | [Distribution](operations/distribution.md) |
| `apps/site/app/(home)/layout.tsx`, `app/(home)/page.tsx`, `app/not-found.tsx` | Landing and fallback pages | app / product-specific | public website | [Distribution](operations/distribution.md) |
| `apps/site/app/docs/layout.tsx`, `app/docs/[[...slug]]/page.tsx` | Documentation routes and page rendering | app / product-specific | public website | [Distribution](operations/distribution.md) |
| `apps/site/app/api/search/route.ts` | Static docs search endpoint | app / product-specific | route handler | [Distribution](operations/distribution.md) |
| `apps/site/app/llms.txt/route.ts`, `app/llms-full.txt/route.ts`, `app/llms.mdx/docs/[[...slug]]/route.ts` | LLM-readable documentation projections | app / product-specific | route handlers | [Agent skill](surfaces/agent-skill.md) |
| `apps/site/app/opengraph-image.tsx`, `app/og/docs/[...slug]/route.tsx` | OpenGraph images | app / product-specific | route handlers | [Distribution](operations/distribution.md) |
| `apps/site/components/constellation.tsx`, `icons.tsx`, `mdx.tsx`, `parallax.tsx`, `provider.tsx`, `reveal.tsx`, `search.tsx`, `term.tsx` | Site-only visual, MDX, search and interaction components | app / product-specific | React component lifecycle | [Distribution](operations/distribution.md) |
| `apps/site/lib/cn.ts`, `apps/site/lib/shared.ts`, `apps/site/lib/source.ts`, `apps/site/source.config.ts` | Site utilities, constants and Fumadocs source | app / product-specific | build/request helpers | [Distribution](operations/distribution.md) |
| `apps/site/content/docs/index.mdx`, `install.mdx`, `quick-start.mdx`, `concepts.mdx`, `commands.mdx`, `mcp.mdx`, `meta.json` | Published user documentation | content / product-specific | public docs contract | [Distribution](operations/distribution.md) |
| `apps/site/public/install.sh` | Public binary installer | distribution / platform-specific | executable external entrypoint | [Distribution](operations/distribution.md) |

## Agent guidance, workflows and scripts

| Files | Responsibility | Layer / reuse | Stability / lifecycle | Canonical doc |
|---|---|---|---|---|
| `agents/astrograph/SKILL.md` | Agent routing and safe use of Astrograph tools | integration / agent-specific | installed guide contract | [Agent skill](surfaces/agent-skill.md) |
| `scripts/link-agent-guide.sh` | Local development link for the agent guide | tooling / developer-specific | local setup script | [Distribution](operations/distribution.md) |
| `scripts/docs-check.ts` | Static documentation guard: links/anchors, architecture metadata, fence balance, deviation IDs, required-document inventory | tooling / reusable | `bun run docs:check`, CI and release gates | [Documentation checklist](documentation-checklist.md) |
| `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/site.yml` | Static/test CI, binary release and site deployment | operations / GitHub-specific | automation lifecycle | [Distribution](operations/distribution.md) |

## Manifests and build configuration

| Files | Responsibility | Layer / reuse | Stability / lifecycle | Canonical doc |
|---|---|---|---|---|
| `package.json`, `bun.lock`, `biome.json`, `tsconfig.json`, `tsconfig.base.json`, `tsconfig.eval.json` | Workspace dependencies, scripts, formatting and compiler roots | build / workspace-wide | build contract | [Testing](operations/testing-and-evaluation.md) |
| `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/mcp/package.json`, `packages/mcp/tsconfig.json` | Package exports, binaries and typecheck config | build / package-specific | publish/build contract | [Distribution](operations/distribution.md) |
| `apps/site/package.json`, `apps/site/tsconfig.json`, `apps/site/next.config.mjs`, `apps/site/postcss.config.mjs` | Site build/runtime configuration | build / site-specific | deployment contract | [Distribution](operations/distribution.md) |
| `apps/web/package.json`, `apps/web/tsconfig.json` | Parked web explorer placeholder | historical / product-specific | no current runtime | [System](system-overview.md) |

## Exact baseline inventory manifest

The tables above group files by architectural responsibility. This manifest makes the same baseline machine-checkable without relying on abbreviated path context. It excludes test files, fixtures, generated declarations, and documentation; those are owned by [Testing and evaluation](operations/testing-and-evaluation.md) and the architecture index.

- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `.github/workflows/site.yml`
- `apps/site/app/(home)/layout.tsx`
- `apps/site/app/(home)/page.tsx`
- `apps/site/app/api/search/route.ts`
- `apps/site/app/docs/[[...slug]]/page.tsx`
- `apps/site/app/docs/layout.tsx`
- `apps/site/app/global.css`
- `apps/site/app/layout.config.tsx`
- `apps/site/app/layout.tsx`
- `apps/site/app/llms-full.txt/route.ts`
- `apps/site/app/llms.mdx/docs/[[...slug]]/route.ts`
- `apps/site/app/llms.txt/route.ts`
- `apps/site/app/not-found.tsx`
- `apps/site/app/og/docs/[...slug]/route.tsx`
- `apps/site/app/opengraph-image.tsx`
- `apps/site/components/constellation.tsx`
- `apps/site/components/icons.tsx`
- `apps/site/components/mdx.tsx`
- `apps/site/components/parallax.tsx`
- `apps/site/components/provider.tsx`
- `apps/site/components/reveal.tsx`
- `apps/site/components/search.tsx`
- `apps/site/components/term.tsx`
- `apps/site/content/docs/commands.mdx`
- `apps/site/content/docs/concepts.mdx`
- `apps/site/content/docs/index.mdx`
- `apps/site/content/docs/install.mdx`
- `apps/site/content/docs/mcp.mdx`
- `apps/site/content/docs/meta.json`
- `apps/site/content/docs/quick-start.mdx`
- `apps/site/lib/cn.ts`
- `apps/site/lib/shared.ts`
- `apps/site/lib/source.ts`
- `apps/site/next.config.mjs`
- `apps/site/package.json`
- `apps/site/postcss.config.mjs`
- `apps/site/public/install.sh`
- `apps/site/source.config.ts`
- `apps/site/tsconfig.json`
- `apps/web/package.json`
- `apps/web/tsconfig.json`
- `bench/rss.ts`
- `biome.json`
- `bun.lock`
- `eval/cases.ts`
- `eval/runner.ts`
- `eval/scoring.ts`
- `eval/types.ts`
- `package.json`
- `packages/cli/package.json`
- `packages/cli/src/bin/astrograph.ts`
- `packages/cli/src/cli.ts`
- `packages/cli/src/commands/callees.ts`
- `packages/cli/src/commands/callers.ts`
- `packages/cli/src/commands/context.ts`
- `packages/cli/src/commands/daemon-utils.ts`
- `packages/cli/src/commands/daemon.ts`
- `packages/cli/src/commands/explore.ts`
- `packages/cli/src/commands/files.ts`
- `packages/cli/src/commands/impact.ts`
- `packages/cli/src/commands/index.ts`
- `packages/cli/src/commands/init.ts`
- `packages/cli/src/commands/install.ts`
- `packages/cli/src/commands/node.ts`
- `packages/cli/src/commands/parse.ts`
- `packages/cli/src/commands/search.ts`
- `packages/cli/src/commands/serve.ts`
- `packages/cli/src/commands/shared.ts`
- `packages/cli/src/commands/status.ts`
- `packages/cli/src/commands/stop.ts`
- `packages/cli/src/commands/sync.ts`
- `packages/cli/src/commands/trace.ts`
- `packages/cli/src/commands/uninit.ts`
- `packages/cli/src/commands/uninstall.ts`
- `packages/cli/src/commands/unlock.ts`
- `packages/cli/src/format/callees.ts`
- `packages/cli/src/format/callers.ts`
- `packages/cli/src/format/context.ts`
- `packages/cli/src/format/explore.ts`
- `packages/cli/src/format/files.ts`
- `packages/cli/src/format/footer.ts`
- `packages/cli/src/format/impact.ts`
- `packages/cli/src/format/json.ts`
- `packages/cli/src/format/node.ts`
- `packages/cli/src/format/search.ts`
- `packages/cli/src/format/shared.ts`
- `packages/cli/src/format/status.ts`
- `packages/cli/src/format/style.ts`
- `packages/cli/src/format/trace.ts`
- `packages/cli/src/help.ts`
- `packages/cli/src/install/agent-guide.ts`
- `packages/cli/src/install/prompt.ts`
- `packages/cli/src/install/resolve-command.ts`
- `packages/cli/src/install/target.ts`
- `packages/cli/src/install/targets/all.ts`
- `packages/cli/src/install/targets/claude.ts`
- `packages/cli/src/install/targets/codex.ts`
- `packages/cli/src/install/targets/cursor.ts`
- `packages/cli/src/install/targets/opencode.ts`
- `packages/cli/src/install/writers/json.ts`
- `packages/cli/src/install/writers/jsonc.ts`
- `packages/cli/src/install/writers/toml.ts`
- `packages/cli/src/root.ts`
- `packages/cli/src/runtime.ts`
- `packages/cli/src/ui/init-reporter.ts`
- `packages/cli/tsconfig.json`
- `packages/core/package.json`
- `packages/core/src/adapters/bun/fs.ts`
- `packages/core/src/adapters/bun/glob.ts`
- `packages/core/src/adapters/bun/hasher.ts`
- `packages/core/src/adapters/bun/index.ts`
- `packages/core/src/adapters/bun/project.ts`
- `packages/core/src/adapters/bun/sqlite.ts`
- `packages/core/src/adapters/bun/watcher.ts`
- `packages/core/src/astrograph.ts`
- `packages/core/src/db/migrations.ts`
- `packages/core/src/db/queries.ts`
- `packages/core/src/db/schema.sql`
- `packages/core/src/extraction/index.ts`
- `packages/core/src/extraction/php/ast-cache.ts`
- `packages/core/src/extraction/php/backend.ts`
- `packages/core/src/extraction/php/calls.ts`
- `packages/core/src/extraction/php/names.ts`
- `packages/core/src/extraction/php/resolve.ts`
- `packages/core/src/extraction/reconcile.ts`
- `packages/core/src/extraction/registry.ts`
- `packages/core/src/extraction/shared/classify.ts`
- `packages/core/src/extraction/shared/language.ts`
- `packages/core/src/extraction/shared/qualified-name.ts`
- `packages/core/src/extraction/tree-sitter/grammars.ts`
- `packages/core/src/extraction/tree-sitter/parser.ts`
- `packages/core/src/extraction/typescript/backend.ts`
- `packages/core/src/extraction/typescript/extractor.ts`
- `packages/core/src/extraction/typescript/identity.ts`
- `packages/core/src/extraction/typescript/resolver.ts`
- `packages/core/src/extraction/typescript/resolver/utils.ts`
- `packages/core/src/freshness.ts`
- `packages/core/src/graph/symbol-lookup.ts`
- `packages/core/src/graph/traversal.ts`
- `packages/core/src/ids.ts`
- `packages/core/src/index.ts`
- `packages/core/src/indexer.ts`
- `packages/core/src/query/code-blocks.ts`
- `packages/core/src/query/graph-queries.ts`
- `packages/core/src/query/meta.ts`
- `packages/core/src/search/fts-query.ts`
- `packages/core/src/testing/graph-assertions.ts`
- `packages/core/src/testing/normalize.ts`
- `packages/core/src/types.ts`
- `packages/core/tsconfig.json`
- `packages/mcp/package.json`
- `packages/mcp/src/daemon.ts`
- `packages/mcp/src/format/callees.ts`
- `packages/mcp/src/format/callers.ts`
- `packages/mcp/src/format/context.ts`
- `packages/mcp/src/format/explore.ts`
- `packages/mcp/src/format/files.ts`
- `packages/mcp/src/format/impact.ts`
- `packages/mcp/src/format/index.ts`
- `packages/mcp/src/format/node.ts`
- `packages/mcp/src/format/search.ts`
- `packages/mcp/src/format/shared.ts`
- `packages/mcp/src/format/status.ts`
- `packages/mcp/src/format/trace.ts`
- `packages/mcp/src/index.ts`
- `packages/mcp/src/instructions.ts`
- `packages/mcp/src/project.ts`
- `packages/mcp/src/server.ts`
- `packages/mcp/src/tools.ts`
- `packages/mcp/tsconfig.json`
- `scripts/link-agent-guide.sh`
- `scripts/docs-check.ts`
- `tsconfig.base.json`
- `tsconfig.eval.json`
- `tsconfig.json`

## Ownership checks

- New production files must be added to this map in the same review.
- Moving a responsibility updates both this map and the canonical document.
- A wildcard or directory name alone is not sufficient inventory evidence; every baseline production file is named in a row above.
