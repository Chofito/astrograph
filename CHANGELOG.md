# Changelog

All notable changes to Astrograph are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as scoped by [contracts §12](docs/contracts.md#12-release-identity-and-compatibility).

Astrograph is currently a **public preview**. `0.x` releases may change CLI, MCP, and config surfaces deliberately; every such change appears here. Preview does not waive correctness, honesty, local-only, or source-safety requirements.

**The index is disposable.** The SQLite schema and the extraction identity may change in any release. When they do, this file says so under *Index compatibility* and the affected release requires a rebuild.

## [Unreleased]

### Added

- `ToolMeta.evidence` reports the relations an answer considered but could not show as nodes — exact counts by resolution state and kind, plus a bounded, deterministically ordered sample with target name, location and provenance. An empty `callees` can no longer look identical to "this calls nothing", and a "no path found" explains what blocked it. `external` stays a complete answer about a target outside the project, not a failure.
- `ToolMeta.partial` is now evaluated over each query's completeness domain instead of the files the payload happened to return, and carries structured `reasons` distinguishing incomplete coverage, an unsupported capability, a truncated search, and semantic uncertainty. A `resolved` file with a coverage gap makes a global answer partial; a genuinely local answer stays complete despite unrelated problems; a backend with no files in the project penalizes nothing.
- `indexAll`, `sync` and `syncFiles` now share one reconciler and one fixed phase order (classify, capture, retire, Pass A, load backend projects, re-resolve, persist), so a full index, a scanner sync and a watch batch reach the same graph for the same project state. `syncFiles` refreshes index metadata like `sync` does, and `unlink` deterministically dominates a stale `change` for the same path.
- A full index over an existing database now converges: it retires deleted files, newly excluded paths, files that grew past the size limit, and rows owned by a backend the user disabled, instead of leaving them to keep answering queries. An interrupted pass is detectable through `status.indexInterrupted` and never presents itself as complete.
- A single index-membership decision (`IndexEligibility`). Which files belong to the graph and which backend owns each is computed once per pass and reused by the scanner boundary, `indexAll`, `sync`, `syncFiles`, `loadProject`, Pass A, both Pass B phases, and coverage. A non-eligible file can no longer reach a parser or an enricher.
- A persisted trust taxonomy, separate from lifecycle state. `pending`/`parsed`/`resolved` now mean only how far the pipeline got; every diagnostic code is classified by a versioned, exhaustive registry into `coverage_gap`, `semantic_uncertainty`, `configuration`, or `diagnostic`. A file can be `resolved` and still report a coverage gap, which is what stops a confident empty result. `status` gains `diagnostics` counts and `filesWithCoverageGap`.
- Release identity and compatibility contract: public preview surfaces, experimental surfaces, and internals that are explicitly not a public SDK ([contracts §12](docs/contracts.md#12-release-identity-and-compatibility), `ROADMAP.md` §0).
- `CHANGELOG.md`, `SECURITY.md`, and `CONTRIBUTING.md`.
- Index compatibility policy plus a forward-compatibility guard: a database written by a newer binary is refused with a rebuild instruction instead of being opened as current.
- `bun run docs:check` — a static documentation drift guard (links and anchors, architecture metadata, fence balance, duplicate deviation IDs, required-document inventory), a per-PR documentation checklist, and a PR template. It is a required gate in CI and in the release workflow.
- Registration validation for language backends: duplicate backend IDs, an extension claimed twice, and capabilities that do not match what the configured backend can emit are rejected at construction.
- One runtime-free configuration parser shared by core, CLI, and MCP, so all three normalize and report diagnostics identically.

### Fixed

- A file that crossed the eligibility boundary through the file watcher — growing past `maxFileSizeBytes`, leaving the scan scope, or belonging to a backend that was just disabled — had its rows deleted directly instead of retired, so relations pointing into it disappeared rather than becoming `unresolved`. Watch, scanner and full index now agree on what such a transition means. A configuration change is treated as a project-wide fact, so a watch batch stops being path-scoped when the identity moves.
- A demoted relation could report an internal node id as its `targetName`. It now keeps whatever the extractor recorded, and otherwise the retired node's qualified name, captured before deletion.
- A successful `trace` dropped the destination's unresolved callees from `meta.evidence`, and a failed `trace` gathered blockers through a traversal that discards target-null edges — so it could never see the hop that blocked the path. Both now collect evidence before filtering, and a failed trace distinguishes an exhausted search from one that was cut short.
- `openProject` leaked its SQLite handle when initialization failed after the database was opened — most visibly when refusing an index written by a newer build. The handle is released exactly once, without masking the original error.
- The CLI could not be imported at all. `commands/shared.ts` declared `class InvalidCliConfigJsonError extends CliError` at module scope inside the `cli.ts → commands/* → shared.ts → cli.ts` import cycle, and an `extends` clause evaluates eagerly, so every invocation died with "Cannot access 'CliError' before initialization". The result vocabulary now lives in a leaf module, `packages/cli/src/result.ts`.
- `daemon.json` was cast to `DaemonMetadata` without validation, so a truncated or hand-edited file could surface later as `pid: undefined` in `status`. It is now validated before use.

### Removed

- Name-based edge healing. `healUnresolvedEdges` matched a bare `node.name` against every unresolved edge in the graph and promoted whatever it found, which could link a PHP `save()` to a TypeScript call, or two same-named symbols in different namespaces to each other, and present the result as `resolved`. Invalidation is now owned by the producing backend, and storage no longer offers a lookup from a target name to edges.

  Adding or removing a file re-resolves the owning backend's whole file set, because an importer written before its module exists holds an unresolved edge that points nowhere.

  **Behavior change:** adding a declaration named `laterFn` no longer resolves an unproven `laterFn()` call elsewhere. Only a real module or name-resolution relationship does. Some edges that previously read `resolved` will now correctly read `unresolved`; per contracts §12.4 that is a correctness fix, not a breaking promise.

### Changed

- Version language is unified on `v0.1.0` preview. The roadmap previously described the same cut as both "v1.0 stabilization" and a `v0.1.0` tag; `v1.0.0` is now explicitly reserved for the first stable public contract.
- The enricher contract is complement-only. A backend has either no enricher or exactly one complementary enricher; `replace` and object-valued `none` are gone, Pass A always runs, and reconciled nodes carry provenance declared by the producing backend instead of a hardcoded `ts-compiler`.
- The release workflow runs the full gate set — typecheck, static check, tests, documentation check, build, and binary smoke — against the exact tagged commit before any artifact is published.

### Index compatibility

- **Rebuild required.** The extraction identity gained an `extraction:contract` key and reconciled-node provenance changed, so indexes written by earlier builds are stale. Run `astrograph index --force`, or delete `.astrograph/graph.db` and run `astrograph index`. Project source is never touched by either.

### Known limitations

- JS/TS and PHP only, and single-app repositories only. Monorepos, multiple `tsconfig.json` files, and project references are not supported.
- PHP resolution is name-based: no `di.xml`, factories/proxies, return-type chaining, `__call`, or traits as method bodies.
- Static analysis limits are reported, not hidden: unresolved and ambiguous edges stay visible rather than being guessed into `resolved`.
- macOS and Linux on x64/arm64. No Windows binary.
- The `@astrograph/*` packages are private workspace source. There is no published npm SDK.

[Unreleased]: https://github.com/chofito/astrograph/compare/main...HEAD
