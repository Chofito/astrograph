# Distribution and delivery

Status: mixed
Baseline: `8c6e9ad004a491886fb396cddca0dd617c67f495`
Canonical owner: CLI distribution and documentation site

## Purpose

This document records how Astrograph is built, released, installed, and published at the baseline. It supplements the user-facing [installation guide](../../install.md); it does not assert that the current pipeline is release-ready.

## Current behavior (AS-IS)

### Build outputs

The root package exposes a host build (`bun run build`) and an all-target build (`bun run build:all`). Both compile `packages/cli/src/bin/astrograph.ts` into standalone Bun binaries. The all-target command names four assets:

| Asset | Target |
|---|---|
| `astrograph-darwin-arm64` | Apple Silicon macOS |
| `astrograph-darwin-x64` | Intel macOS |
| `astrograph-linux-x64` | x86-64 Linux |
| `astrograph-linux-arm64` | ARM64 Linux |

`bun run release:checksums` writes SHA-256 entries for `dist/astrograph-*`. The normal build only produces the host `dist/astrograph`; it is the artifact used by CI smoke testing and `install:local`.

### Release workflow

The release workflow starts on a `v*` tag or a manually supplied existing tag. It validates a `v`-prefixed semver form, runs every quality gate against that tag, then checks it out in a native four-platform matrix, installs with the frozen lockfile, stamps package versions from the tag in the CI workspace, compiles one binary per runner, and verifies its exact `astrograph --version` output.

```mermaid
flowchart LR
    A[v-prefixed tag] --> B[validate and resolve tag]
    B --> G0[gates on the exact tag]
    G0 --> G1[typecheck, biome, tests]
    G1 --> G2[docs guard, installer shellcheck]
    G2 --> G3[version identity vs CHANGELOG]
    G3 --> C{four native targets}
    C --> D[checkout exact tag]
    D --> E[bun install frozen lockfile]
    E --> F[stamp package versions in CI workspace]
    F --> G[compile target binary]
    G --> H[verify exact version]
    H --> I[upload artifact]
    I --> J[stage assets and SHA256SUMS]
    J --> K[publish GitHub Release]
```

Before anything is built, a `gates` job checks out the same tag and runs typecheck, Biome, the test suite, the documentation guard, the installer shell checks, and a version-identity check that refuses to proceed unless `CHANGELOG.md` contains a section for the tagged version. `build` and `release` both depend on it, so no artifact is produced or published from a commit that has not passed its own gates. This replaces the earlier assumption that a green `main` run vouched for a tag — CI does not trigger on tag pushes, and a tag can point at a different commit than the branch that was verified.

Artifacts lose their executable bit during upload, so the release job restores mode `755` before generating checksums and publishing.

Source evidence: `.github/workflows/release.yml`, `.github/workflows/ci.yml`, `CHANGELOG.md`, `package.json`.

### Installer

`apps/site/public/install.sh` is the single installer source. It is strict POSIX `sh`, and CI parses it with `dash` plus ShellCheck. It obtains the latest GitHub Release tag unless `ASTROGRAPH_VERSION` is pinned, detects Darwin/Linux and x64/arm64 (including Rosetta on Apple Silicon), downloads the corresponding binary, verifies `SHA256SUMS` by default, then installs to `${HOME}/.local/bin/astrograph` with mode `755`.

```mermaid
flowchart TD
    A[curl installer pipe to sh] --> B{uninstall requested?}
    B -->|yes| C[remove installed binary only]
    B -->|no| D[detect OS and architecture]
    D --> E[resolve release tag]
    E --> F[download binary into mktemp directory]
    F --> G{checksum skipped?}
    G -->|no| H[download SHA256SUMS and verify asset]
    G -->|yes| I[loud warning]
    H --> J[install or copy to final path]
    I --> J
    J --> K[run installed binary --version]
    K --> L[print PATH and next steps]
```

Failures during download, empty asset detection, unsupported OS/architecture, absent/mismatched checksum, or failed post-install smoke test terminate the script. Temporary downloads are removed via traps. `ASTROGRAPH_SKIP_CHECKSUM=1` intentionally permits an unverified install with a conspicuous warning.

The final installation path is overwritten before the smoke test. Therefore a failed smoke test can leave a bad replacement in place rather than the prior working binary. This is an operational limitation, not a claim that checksum verification failed.

Source evidence: `apps/site/public/install.sh`, `docs/install.md`.

### Documentation site

The static documentation/landing site is built from `apps/site` and deployed to GitHub Pages. Its workflow runs on `main` when site/workflow/root-lockfile inputs change, runs `bun install` without `--frozen-lockfile`, builds the site, ensures `out/.nojekyll`, uploads the static output, and deploys it through GitHub Pages.

The site delivers `public/install.sh`, so the site deployment and the installer source share one tracked file. Publishing the site does not create a binary release; releasing a binary does not deploy the site.

### Index compatibility, upgrade, and rollback

`.astrograph/graph.db` is **disposable local state**, never a public contract ([contracts §12.4](../../contracts.md#124-compatibility-rules)). Two independent identities decide whether an existing index is still usable:

| Identity | Where it lives | Effect when it changes |
|---|---|---|
| SQLite schema version | `schema_versions` table, `LATEST_SCHEMA_VERSION` in `db/migrations.ts` | forward migrations apply; a **newer** version than the binary knows is refused |
| Extraction identity + config hash | `project_metadata` `version:*` and `configHash`, from `LanguageRegistry.versionKeys()` | the next `astrograph sync` treats every file as modified and re-derives the graph |

**Upgrade.** Install the new binary, then run `astrograph sync` (or `astrograph index --force` to be explicit). A changed grammar, enricher, or `extraction:contract` version changes the config hash, so the affected files are re-extracted. The project source is never modified.

**Downgrade to a binary that cannot read the index.** `runMigrations` throws `IncompatibleIndexError` (`code: "INCOMPATIBLE_INDEX"`) when the database reports a schema version above `LATEST_SCHEMA_VERSION`. Migrations only move forward, so there is nothing to apply and a best-effort open would read rows whose meaning has changed while the coverage banner still looked clean. The error names both versions and tells the user to upgrade again or delete `.astrograph/graph.db` and re-index.

**Recovery is always a rebuild.** For the preview there is no semantic migration path, deliberately: `rm -rf .astrograph/graph.db && astrograph index`. Because the index is derived entirely from source that Astrograph never writes to, a rebuild cannot lose user data — only time.

```mermaid
flowchart TD
    A[open .astrograph/graph.db] --> B{schema version > binary?}
    B -->|yes| C[IncompatibleIndexError: upgrade or rebuild]
    B -->|no| D[apply forward migrations]
    D --> E{configHash or version keys changed?}
    E -->|yes| F[sync re-extracts affected files]
    E -->|no| G[index reused as current]
```

Not yet implemented, and owned by `NEW-007`: rebuilding into a temporary database and swapping only after the replacement validates, so a failed rebuild cannot leave a project without a working index. Today the rebuild is destructive-then-rebuild, which is safe for correctness but costs a full re-index if it is interrupted.

### Delivery invariants

- Release assets are generated from the tagged source, not the default branch during manual dispatch.
- Every published binary has a release checksum entry; the installer refuses a missing entry by default.
- The installer does not modify agent configuration or project indexes. Those remain explicit CLI actions.
- Binary removal is limited to the configured installation path; project `.astrograph/` directories are independent state.
- CI validates the installer as POSIX shell syntax; it does not perform a live network installation.

## Failure and recovery states

| Stage | AS-IS failure response | Recovery owner |
|---|---|---|
| Invalid tag | release workflow stops before build | release author fixes/creates tag |
| Native build/smoke failure | that matrix leg fails; release job cannot run | release author investigates target |
| Checksum unavailable/mismatch | installer refuses installation unless explicitly overridden | installer user fixes source/tag or knowingly opts out |
| Unsupported host | installer exits before download | installer user builds from source or uses supported host |
| Post-install smoke failure | installer exits after final path was overwritten | installer user must restore/reinstall a known-good binary |
| Site build/deploy failure | Pages deployment does not advance | site maintainer fixes build/workflow |

## Target behavior (TO-BE)

The target delivery path treats the artifact as verified before it replaces a working install, and gives release workflows the same quality evidence as the commit they publish.

```mermaid
flowchart LR
    A[download temp binary] --> B[verify checksum]
    B --> C[smoke test temp binary]
    C --> D[atomic rename or recoverable backup swap]
    D --> E[confirm installed version]
```

Recommended target controls are:

- smoke-test the downloaded temporary binary before replacing the final path, then perform an atomic rename or preserve a rollback copy;
- pin or otherwise govern third-party GitHub Action revisions as part of supply-chain policy;
- make the site installation page and `docs/install.md` part of a link/content consistency check.

These controls are recommendations, not current behavior. They must not be represented as shipped guarantees.

## Known deviations

- **DEV-017 — static quality:** baseline static checks are not green. Tag publishing now re-runs `bun run check` on the exact tag, so this is a blocker for the first release rather than an unenforced claim.
- **DEV-013 — resource lifecycle:** distribution invokes a compiled process which must still follow the core close/cleanup contract; backend disposal remains incomplete in the current runtime.
- **DEV-015 — eval validity:** release/installer confidence is independent from the current eval harness. Eval output is not release certification.

## Related documents

- [Installation guide](../../install.md)
- [Release identity and compatibility](../../contracts.md#12-release-identity-and-compatibility)
- [Changelog](../../../CHANGELOG.md)
- [Site design](../../site.md) — supporting design history
- [Testing and evaluation](testing-and-evaluation.md)
- [Lifecycle and resources](lifecycle-and-resources.md)
- [Known deviations](../deviations.md)
