# Installation Guide

Astrograph comes as a **pre-compiled binary** for macOS and Linux, or can be built from source for development.

> 🌐 Languages: **English** (this file)

---

## Quick install (binary)

The easiest way: fetch and run the installer script.

```bash
curl -fsSL https://www.chofito.dev/astrograph/install.sh | sh
```

> Keep the `-f`. Without it, curl pipes an HTTP error page straight into your shell.

This downloads the appropriate binary for your platform (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`), verifies its checksum, and installs it to `~/.local/bin/astrograph`.

The script is strict POSIX `sh`, so `| sh` works on macOS, Debian/Ubuntu (dash), and Alpine alike.

**What it does:**
1. Detects your OS and architecture (on Apple Silicon it picks `arm64` even from a Rosetta shell)
2. Downloads the binary from GitHub Releases
3. Verifies the SHA256 checksum — **aborts** if `SHA256SUMS` is missing or has no entry for the asset
4. Installs the binary to `~/.local/bin` with mode `755`
5. Runs `astrograph --version` to confirm the binary actually executes
6. Prints next steps

**After install:**
```bash
export PATH="$HOME/.local/bin:$PATH"
astrograph --version
```

Add the `PATH` export to your `.bashrc`, `.zshrc`, or equivalent shell config to make it permanent.

### Installer environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ASTROGRAPH_VERSION` | `latest` | Release tag to install, e.g. `v0.1.0` |
| `ASTROGRAPH_INSTALL_DIR` | `$HOME/.local/bin` | Where the binary is written |
| `ASTROGRAPH_REPO` | `chofito/astrograph` | Source GitHub repo (forks, mirrors) |
| `ASTROGRAPH_UNINSTALL` | unset | Set to `1` to remove the binary and exit |
| `ASTROGRAPH_SKIP_CHECKSUM` | unset | Set to `1` to install **without** verification (not recommended; prints a loud warning) |

```bash
# Pin a version and install somewhere else
curl -fsSL https://www.chofito.dev/astrograph/install.sh \
  | ASTROGRAPH_VERSION=v0.1.0 ASTROGRAPH_INSTALL_DIR=/usr/local/bin sh
```

The installer source of truth lives at `apps/site/public/install.sh` in this repo.

---

## Manual download

If you prefer, download the binary directly from [GitHub Releases](https://github.com/chofito/astrograph/releases):

```bash
# Example: darwin-arm64 (Apple Silicon)
curl -fL -o astrograph https://github.com/chofito/astrograph/releases/download/v0.1.0/astrograph-darwin-arm64
chmod +x astrograph          # release assets download as mode 644
mv astrograph ~/.local/bin/
```

**Available binaries:**
- `astrograph-darwin-arm64` — macOS, Apple Silicon
- `astrograph-darwin-x64` — macOS, Intel
- `astrograph-linux-x64` — Linux, x86-64
- `astrograph-linux-arm64` — Linux, ARM64

Verify checksums against the `SHA256SUMS` file published with each release.

---

## Verification

Each release includes a `SHA256SUMS` file. Verify the binary:

```bash
# Download checksums (next to the downloaded asset)
curl -fL -o SHA256SUMS https://github.com/chofito/astrograph/releases/download/v0.1.0/SHA256SUMS

# Verify (macOS)
shasum -a 256 --ignore-missing -c SHA256SUMS

# Or (Linux)
sha256sum --ignore-missing -c SHA256SUMS
```

`SHA256SUMS` lists all four assets, so `--ignore-missing` keeps the check green when you only downloaded one.

---

## Upgrade, pinning, and rollback

Astrograph is a **public preview** (`v0.1.0`). CLI, MCP, and config surfaces may change deliberately between `0.x` releases; every change is listed in [CHANGELOG.md](../CHANGELOG.md). Read the changelog before upgrading a machine other people depend on.

### Upgrade

```bash
curl -fsSL https://www.chofito.dev/astrograph/install.sh | sh
astrograph --version          # confirm the new version
cd your/project && astrograph sync
```

The installer replaces the existing binary in `~/.local/bin`. Run `astrograph sync` in each indexed project afterwards: a new grammar, enricher, or extraction-contract version changes the index identity, and `sync` re-extracts the affected files. `astrograph index --force` does the same thing explicitly. **Your project source is never modified.**

If the changelog for the release carries an *Index compatibility* note, do a full rebuild instead:

```bash
rm -f .astrograph/graph.db && astrograph index
```

### Pin a version

Pin whenever you need two machines to behave identically, or you want a known-good fallback:

```bash
ASTROGRAPH_VERSION=v0.1.0 curl -fsSL https://www.chofito.dev/astrograph/install.sh | sh
```

Keep a copy of the binary you trust before upgrading, so rollback needs no network:

```bash
cp ~/.local/bin/astrograph ~/.local/bin/astrograph-known-good
```

### Roll back

```bash
ASTROGRAPH_VERSION=v0.1.0 curl -fsSL https://www.chofito.dev/astrograph/install.sh | sh
# or, from the copy you kept:
install -m 755 ~/.local/bin/astrograph-known-good ~/.local/bin/astrograph
```

### Incompatible index after a downgrade

The index is disposable local state, not a contract. If you roll back to a binary that cannot read an index a newer one wrote, Astrograph **refuses to open it** rather than guessing:

```text
This .astrograph index was written by a newer Astrograph (schema v2); this binary
supports up to v1. Upgrade Astrograph, or delete .astrograph/graph.db and re-run
`astrograph index` to rebuild.
```

That is deliberate: reading rows whose meaning changed would produce confident, wrong answers. Two ways out — reinstall the newer version, or rebuild:

```bash
rm -f .astrograph/graph.db
astrograph index
```

Rebuilding costs time, never data: the graph is derived entirely from source files that Astrograph only ever reads. Only `.astrograph/graph.db` is removed; `.astrograph/config.json` is yours and is left alone.

---

## Uninstall

Astrograph has three independent pieces. Remove them in this order.

### 1. Agent host config (MCP + agent guide)

```bash
astrograph uninstall
```

This removes the Astrograph MCP server entry and the Astrograph-owned agent guide
from Claude Code, Cursor, Codex, and opencode. It does **not** remove the binary
and does **not** touch any project's index. Run it *before* deleting the binary —
it needs the binary to run.

Add `-t <ids>` to limit targets and `-l local` to clean a project-scoped install.

### 2. Binary

```bash
rm ~/.local/bin/astrograph
```

Or let the installer do it:

```bash
curl -fsSL https://www.chofito.dev/astrograph/install.sh | ASTROGRAPH_UNINSTALL=1 sh
```

### 3. Project index

Per-project `.astrograph/` directories are independent. Remove each with the CLI:

```bash
astrograph uninit /path/to/project
```

Or by hand:

```bash
rm -rf /path/to/project/.astrograph
```

---

## Build from source (for development)

If you want to build the binary yourself or modify Astrograph:

```bash
git clone https://github.com/chofito/astrograph.git
cd astrograph
bun install
bun run build
```

The compiled binary is written to `dist/astrograph` (host platform only).

To reproduce a full release build locally — all four target binaries plus checksums:

```bash
bun run build:all          # dist/astrograph-{darwin,linux}-{arm64,x64}
bun run release:checksums  # dist/SHA256SUMS
```

**Install locally:**

```bash
bun run install:local
```

This builds, installs `dist/astrograph` to `~/.local/bin/astrograph` with mode 755
(the same way the installer script does), and prints the version.

**Requirements:**
- **Bun** (1.0+) — [install](https://bun.sh)
- **Node.js** 18+ (for TypeScript, as a dev dependency)
- C/C++ build tools (for tree-sitter and SQLite compilation)

---

## Configuration

After install, initialize a project:

```bash
astrograph init /path/to/my/project
```

This creates `.astrograph/` and indexes the project. See [docs/cli.md](cli.md) for full command reference.

### Optional: agent setup

To configure Astrograph in your coding agents (Claude Code, Cursor, etc.):

```bash
astrograph install
```

This sets up the MCP server configuration and agent guide. It does **not** install
the binary — that is the `curl … | sh` step above. See
[docs/cli.md](cli.md#agent-setup) for details.

---

## Troubleshooting

### "astrograph: command not found"

Ensure `~/.local/bin` is in your `PATH`:

```bash
echo $PATH
# If ~/.local/bin is missing:
export PATH="$HOME/.local/bin:$PATH"
```

Add the export to your shell config file (`.bashrc`, `.zshrc`, etc.) to make it permanent.

### Checksum mismatch

The installer aborts rather than installing an unverified binary. Download again and compare by hand:

```bash
curl -fL -o astrograph-darwin-arm64 https://github.com/chofito/astrograph/releases/download/v0.1.0/astrograph-darwin-arm64
shasum -a 256 astrograph-darwin-arm64
# Compare against SHA256SUMS
```

If it still mismatches, do not run the binary — open an issue.

### "SHA256SUMS not found" / "no entry for …"

The release is missing its checksum file, or you pinned a tag that predates it.
The installer refuses to continue. Pin a known-good tag with `ASTROGRAPH_VERSION`,
or as a last resort `ASTROGRAPH_SKIP_CHECKSUM=1` (you are then trusting the network).

### Agent host says "astrograph: ENOENT" / "command not found"

GUI-launched hosts (Claude Desktop, Cursor.app) often do not inherit your shell's
`PATH`, so `~/.local/bin` is invisible to them. `astrograph install` writes the
**absolute path** of the running binary into the MCP config to avoid this. If you
have an old config with a bare `astrograph`, re-run `astrograph install`, or pin
it explicitly:

```bash
astrograph install --command "$HOME/.local/bin/astrograph"
```

### Permission denied

Ensure the binary is executable:

```bash
chmod +x ~/.local/bin/astrograph
astrograph --version
```

### Installation script hangs

The installer script downloads a ~15–30 MB binary depending on platform. If it seems stuck, check your network connection or try a manual download.

---

## Platform support

**Officially supported:**
- **macOS** — 10.13+ (Intel and Apple Silicon)
- **Linux** — glibc 2.28+ (x86-64 and ARM64)

**Not yet supported:**
- Windows — out of scope for the `0.1` and `0.2` roadmap

---

## See also

- [CHANGELOG.md](../CHANGELOG.md) — what changed, and when a rebuild is required
- [contracts §12](contracts.md#12-release-identity-and-compatibility) — what is a public preview surface and what is internal
- [docs/cli.md](cli.md) — full CLI command reference
- [ROADMAP.md](../ROADMAP.md) — project roadmap and staged plan
- [README.md](../README.md) — overview and quick start
