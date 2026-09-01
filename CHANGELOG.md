# Changelog

All notable changes to Astrograph are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as scoped by [contracts §12](docs/contracts.md#12-release-identity-and-compatibility).

Astrograph is currently a **public preview**. `0.x` releases may change CLI, MCP, and config surfaces deliberately; every such change appears here. Preview does not waive correctness, honesty, local-only, or source-safety requirements.

**The index is disposable.** The SQLite schema and the extraction identity may change in any release. When they do, this file says so under *Index compatibility* and the affected release requires a rebuild.

## [Unreleased]

### Added

- Release identity and compatibility contract: public preview surfaces, experimental surfaces, and internals that are explicitly not a public SDK ([contracts §12](docs/contracts.md#12-release-identity-and-compatibility), `ROADMAP.md` §0).
- `CHANGELOG.md`, `SECURITY.md`, and `CONTRIBUTING.md`.
- Index compatibility policy plus a forward-compatibility guard: a database written by a newer binary is refused with a rebuild instruction instead of being opened as current.
- `bun run docs:check` — a static documentation drift guard (links and anchors, architecture metadata, fence balance, duplicate deviation IDs, required-document inventory), a per-PR documentation checklist, and a PR template.
- Registration validation for language backends: duplicate backend IDs, an extension claimed twice, and capabilities that do not match what the configured backend can emit are rejected at construction.
- One runtime-free configuration parser shared by core, CLI, and MCP, so all three normalize and report diagnostics identically.

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
- `bun run docs:check` still reports one error (a `Status:` line owned by `DEV-006`), so the documentation guard runs in warning mode in CI rather than as a gate.

[Unreleased]: https://github.com/chofito/astrograph/compare/main...HEAD
