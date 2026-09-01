# Contributing to Astrograph

Astrograph is a public preview (`v0.1.0`). Contributions are welcome, and the bar is specific rather than high: the graph must never claim to know something it does not.

## Before you start

Read [`ROADMAP.md`](ROADMAP.md) — it is the source of truth for scope and non-goals. A change that adds a language, a surface, or a dependency outside the roadmap needs agreement first; open an issue before writing it.

The documentation set has a precedence order and canonical owners. [`docs/architecture/README.md`](docs/architecture/README.md) explains it, and [`docs/architecture/documentation-checklist.md`](docs/architecture/documentation-checklist.md) maps a changed path to the document that owns it.

## Setup

Astrograph uses [Bun](https://bun.sh) (>= 1.1) for everything — runtime, test runner, bundler, package manager. There is no Node, npm, jest, or webpack in this repo.

```bash
bun install
bun run typecheck
bun run check        # Biome lint + format
bun test
bun run build        # compiles dist/astrograph
```

## The rules that actually matter

**Pass A is the floor.** tree-sitter always runs and owns structural nodes. An enricher may update a matching node, insert a declaration Pass A deliberately omitted, and add semantic edges. It may **never delete a Pass A node** — a `PASS_A_NODE_DROPPED` warning is an identity bug in the backend, not a reason to drop the row. See [ADR-001](docs/architecture/decisions/ADR-001-pass-a-authority.md) and [ADR-002](docs/architecture/decisions/ADR-002-enricher-contract.md).

**Honesty over coverage.** An edge whose target cannot be proven stays `unresolved`, `external`, or `ambiguous`. An answer that may be incomplete says so in its `ToolMeta`. Inventing a `resolved` edge to make a result look better is the one change that will always be rejected.

**Local only.** No network calls at runtime, no telemetry, no API keys, no LLM calls. The installer is the only thing that touches the network.

**Never write outside `.astrograph/`.** Indexing must not modify the repository it indexes.

**Provenance is declared by the producer.** A backend states where its facts come from; core does not guess from a language name.

## Tests

**Tests are run by the author and the reviewer, not by an automated agent.** If you are using an AI assistant on this repo, it must not run the suite on your behalf — it proposes the commands, you run them and paste the results. This is a deliberate policy: the evidence in a PR should be something a human actually saw.

Add tests next to what they cover, using `bun:test`. New backend or contract behavior needs a stub-backend test, not only a TypeScript-specific one — see `packages/core/src/extraction/backend-contract.test.ts` for the pattern.

## Documentation

A behavior change is incomplete until its canonical document is updated in the same review. That is enforced in two halves:

- The mechanical half is `bun run docs:check` — links and anchors, architecture metadata, fence balance, duplicate deviation IDs, required-document inventory. It runs in CI in warning mode while pre-existing debt is cleared.
- The judgement half is the [documentation checklist](docs/architecture/documentation-checklist.md): which document owns your change, and whether your claims still cite real evidence.

An AS-IS statement cites a path or a symbol. A TO-BE statement cites `ROADMAP.md`, `docs/contracts.md`, an accepted ADR, or an approved spec. If you change a public preview surface ([contracts §12.1](docs/contracts.md#121-public-preview-surfaces)), add a `CHANGELOG.md` entry under `Unreleased`. If you change the SQLite schema or the extraction identity, add an *Index compatibility* note saying users must rebuild.

Spanish `*.es.md` files are stale mirrors. Do not resynchronize them until the English contract is stable; they cannot outrank the English documents.

## Pull requests

The [PR template](.github/pull_request_template.md) has the short version. In summary:

1. Branch from `main`. Keep the change scoped to one concern.
2. `bun run typecheck && bun run check && bun test && bun run docs:check` — paste what you ran and what happened.
3. Update the canonical document for every changed path family.
4. Commit messages: `type(scope): imperative summary`, then a body explaining *why*. Explain a known-broken state in the commit that introduces it rather than leaving it for the reader to discover.

Reviewers will ask, in this order: does it lie about what it knows, does it break Pass A authority, is the documentation true, and only then is the code good.

## Security

Do not report vulnerabilities in a pull request or a public issue. See [SECURITY.md](SECURITY.md).

## License

Contributions are licensed under Apache-2.0, matching [LICENSE](LICENSE).
