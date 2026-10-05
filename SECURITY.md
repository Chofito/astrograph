# Security policy

## What Astrograph is, from a security standpoint

Astrograph is a **local binary**. It reads your source files, writes a SQLite index under `.astrograph/` in your project, and answers queries from that index.

- It makes **no network requests** at runtime. No API keys, no telemetry, no update checks, no LLM calls.
- It **never modifies your project source**. Indexing is read-only with respect to your code; the only files it writes are inside `.astrograph/`.
- The only network step in the whole product is the **installer**, which downloads a release binary from GitHub and verifies it against the published `SHA256SUMS`.

That shape means the realistic risk surface is small and specific: the integrity of the binary you install, and what ends up inside the index you may later share.

## Supported versions

Astrograph is pre-1.0. Only the latest published release receives security fixes. There are no long-term support branches, and older preview releases are not patched.

## Reporting a vulnerability

Report privately — **do not open a public issue**.

Use GitHub's private reporting at <https://github.com/chofito/astrograph/security/advisories/new>. If that is unavailable to you, open a minimal public issue that says only that you have a security report and asks for a private channel; do not include details.

Please include: what an attacker can do, the minimal steps to reproduce, the Astrograph version (`astrograph --version`), and your OS and architecture.

Expect an acknowledgement within about a week. This is a small project with no paid security staff, so please calibrate accordingly. Fixes ship in a normal release with a `CHANGELOG.md` entry; if a released binary must be treated as bad, the changelog says so explicitly and states whether users must rebuild their indexes.

## Things worth reporting

- Anything that makes the installer accept a binary that does not match its published checksum, or that lets it write outside the installation path.
- Any way indexing writes to, deletes, or corrupts files **outside** `.astrograph/`.
- Any network connection made by the binary at runtime.
- Path traversal or command injection reachable from a file path, project name, or configuration value.
- Anything that causes Astrograph to execute code out of the repository it is indexing. Astrograph parses source; it must never run it.

## Things that are not vulnerabilities

- **The index contains your code.** `.astrograph/graph.db` holds symbol names, qualified names, docstrings, and file paths from the repository you indexed. Treat it as source-equivalent: do not commit it, and do not attach it to a public issue. This is by design, not a leak.
- **Indexing untrusted code is a parsing operation, not a sandbox.** Astrograph parses with tree-sitter and the TypeScript compiler. Feeding it a hostile repository may produce a crash or resource exhaustion; that is a bug worth reporting, but Astrograph is not a security boundary for untrusted input.
- **Resource exhaustion from a very large repository.** Use `maxFileSizeBytes` and `exclude` in `.astrograph/config.json`. Memory budgets are a performance concern, tracked in `ROADMAP.md` §10.
- **`ASTROGRAPH_SKIP_CHECKSUM=1`** disables installer verification. It is a deliberate, loudly warned escape hatch.
- Missing hardening in the private `@astrograph/*` workspace packages. They are internal source, not a published SDK ([contracts §12.3](docs/contracts.md#123-internal--not-a-public-contract)).

## Verifying what you installed

```bash
astrograph --version                      # must match the release tag
shasum -a 256 ~/.local/bin/astrograph     # compare against the release SHA256SUMS
```

The installer performs this check by default. See [docs/install.md](docs/install.md) for manual verification and for pinning a specific version.
