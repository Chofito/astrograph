#!/bin/sh
# Astrograph installer — downloads a prebuilt binary from GitHub Releases.
#
# This file is the SINGLE SOURCE OF TRUTH for the installer. It is served at
# https://www.chofito.dev/astrograph/install.sh by the site deploy workflow.
# Do not fork a second copy elsewhere in the repo.
#
# Usage:
#   curl -fsSL https://www.chofito.dev/astrograph/install.sh | sh
#
# Environment variables:
#   ASTROGRAPH_VERSION          Release tag to install (default: latest), e.g. v0.1.0
#   ASTROGRAPH_INSTALL_DIR      Install directory (default: $HOME/.local/bin)
#   ASTROGRAPH_REPO             GitHub repo (default: chofito/astrograph)
#   ASTROGRAPH_UNINSTALL=1      Remove the installed binary and exit
#   ASTROGRAPH_SKIP_CHECKSUM=1  Install without SHA256 verification (NOT recommended)
#
# NOTE: strictly POSIX sh. This script is piped into `sh`, so the shebang is
# ignored and it must run under dash (/bin/sh on Debian/Ubuntu). No `pipefail`,
# no `[[ ]]`, no arrays, no `local`.
set -eu

REPO="${ASTROGRAPH_REPO:-chofito/astrograph}"
VERSION="${ASTROGRAPH_VERSION:-latest}"
INSTALL_DIR="${ASTROGRAPH_INSTALL_DIR:-${HOME}/.local/bin}"
BINARY_NAME="astrograph"
SKIP_CHECKSUM="${ASTROGRAPH_SKIP_CHECKSUM:-0}"
UNINSTALL="${ASTROGRAPH_UNINSTALL:-0}"

WORKDIR=""
CURL_FLAGS="-fsSL"

die() {
  echo "astrograph: $*" >&2
  exit 1
}

cleanup() {
  if [ -n "${WORKDIR}" ]; then
    rm -rf "${WORKDIR}"
    WORKDIR=""
  fi
}

# curl >= 7.83 deletes a partial -o target on error. Without it a 404 leaves a
# zero-byte file behind, which is how unverified installs used to slip through.
detect_curl_flags() {
  if curl --help all 2>/dev/null | grep -q -- '--remove-on-error'; then
    CURL_FLAGS="-fsSL --remove-on-error"
  fi
}

# download <url> <dest> — never leaves a partial or empty file behind.
download() {
  # shellcheck disable=SC2086
  if curl ${CURL_FLAGS} -o "$2" "$1"; then
    if [ -s "$2" ]; then
      return 0
    fi
  fi
  rm -f "$2"
  return 1
}

detect_os() {
  os_value="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "${os_value}" in
    darwin) echo "darwin" ;;
    linux) echo "linux" ;;
    *) die "Unsupported OS: ${os_value}. Supported: macOS, Linux." ;;
  esac
}

# Under a Rosetta 2 shell on Apple Silicon `uname -m` reports x86_64, which
# would install the slower Intel build. Detect the real hardware.
is_apple_silicon() {
  command -v sysctl >/dev/null 2>&1 || return 1
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
    return 0
  fi
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
    return 0
  fi
  return 1
}

detect_arch() {
  arch_os="$1"
  arch_value="$(uname -m)"
  case "${arch_value}" in
    x86_64 | amd64)
      if [ "${arch_os}" = "darwin" ] && is_apple_silicon; then
        echo "arm64"
      else
        echo "x64"
      fi
      ;;
    arm64 | aarch64) echo "arm64" ;;
    *) die "Unsupported architecture: ${arch_value}" ;;
  esac
}

resolve_tag() {
  if [ "${VERSION}" = "latest" ]; then
    curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" |
      sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' |
      head -n 1
  else
    echo "${VERSION}"
  fi
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    die "Neither shasum nor sha256sum found; cannot verify the download.
Install one of them, or re-run with ASTROGRAPH_SKIP_CHECKSUM=1 to install unverified."
  fi
}

verify_checksum() {
  want_asset="$1"
  want_file="$2"
  sums_file="$3"

  expected="$(
    awk -v want="${want_asset}" '
      { name = $2; sub(/^\*/, "", name); if (name == want) { print $1; exit } }
    ' "${sums_file}"
  )"

  if [ -z "${expected}" ]; then
    die "SHA256SUMS has no entry for ${want_asset}. Refusing to install an unverified binary.
Set ASTROGRAPH_SKIP_CHECKSUM=1 to override (not recommended)."
  fi

  actual="$(sha256_of "${want_file}")"
  if [ "${expected}" != "${actual}" ]; then
    echo "astrograph: checksum mismatch for ${want_asset}" >&2
    echo "  expected: ${expected}" >&2
    echo "  actual:   ${actual}" >&2
    die "Aborting. The download may be corrupt or tampered with."
  fi
  echo "Checksum OK"
}

do_uninstall() {
  if [ -e "${INSTALL_DIR}/${BINARY_NAME}" ]; then
    rm -f "${INSTALL_DIR}/${BINARY_NAME}"
    echo "Removed ${INSTALL_DIR}/${BINARY_NAME}"
  else
    echo "Nothing to remove at ${INSTALL_DIR}/${BINARY_NAME}"
  fi
  echo ""
  echo "This removed the binary only. It did not touch:"
  echo "  - agent host config (run 'astrograph uninstall' BEFORE removing the binary)"
  echo "  - per-project .astrograph/ indexes (remove with 'astrograph uninit <path>')"
}

main() {
  if [ "${UNINSTALL}" = "1" ]; then
    do_uninstall
    return 0
  fi

  command -v curl >/dev/null 2>&1 || die "curl is required but was not found in PATH."
  detect_curl_flags

  os="$(detect_os)"
  arch="$(detect_arch "${os}")"
  asset="astrograph-${os}-${arch}"

  case "${asset}" in
    astrograph-darwin-arm64 | astrograph-darwin-x64 | astrograph-linux-x64 | astrograph-linux-arm64) ;;
    *) die "No prebuilt binary for ${os}-${arch}" ;;
  esac

  tag="$(resolve_tag)"
  [ -n "${tag}" ] || die "Could not resolve a release tag for ${REPO}.
Check your network, or pin one with ASTROGRAPH_VERSION=v0.1.0."

  base_url="https://github.com/${REPO}/releases/download/${tag}"

  echo "Installing Astrograph ${tag} (${asset})…"
  mkdir -p "${INSTALL_DIR}"

  WORKDIR="$(mktemp -d)"
  trap cleanup EXIT
  trap 'cleanup; exit 130' INT
  trap 'cleanup; exit 143' TERM
  trap 'cleanup; exit 129' HUP

  download "${base_url}/${asset}" "${WORKDIR}/${asset}" ||
    die "Failed to download ${base_url}/${asset}
Is ${tag} a published release with a ${asset} asset?"

  if [ "${SKIP_CHECKSUM}" = "1" ]; then
    echo "" >&2
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
    echo "!! ASTROGRAPH_SKIP_CHECKSUM=1 — installing WITHOUT verifying  !!" >&2
    echo "!! the SHA256 checksum. You are trusting the network.         !!" >&2
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
    echo "" >&2
  else
    download "${base_url}/SHA256SUMS" "${WORKDIR}/SHA256SUMS" ||
      die "Could not download SHA256SUMS for ${tag}. Refusing to install an unverified binary.
Set ASTROGRAPH_SKIP_CHECKSUM=1 to override (not recommended)."
    verify_checksum "${asset}" "${WORKDIR}/${asset}" "${WORKDIR}/SHA256SUMS"
  fi

  if command -v install >/dev/null 2>&1; then
    install -m 755 "${WORKDIR}/${asset}" "${INSTALL_DIR}/${BINARY_NAME}"
  else
    cp "${WORKDIR}/${asset}" "${INSTALL_DIR}/${BINARY_NAME}"
    chmod 755 "${INSTALL_DIR}/${BINARY_NAME}"
  fi
  echo "Installed ${INSTALL_DIR}/${BINARY_NAME}"

  # Post-install smoke test. A binary that cannot execute here (arch mismatch,
  # old glibc, quarantine) must fail loudly now, not at first use.
  if ! installed_version="$("${INSTALL_DIR}/${BINARY_NAME}" --version 2>&1)"; then
    echo "${installed_version}" >&2
    die "Installed ${asset} to ${INSTALL_DIR}/${BINARY_NAME}, but '${BINARY_NAME} --version' failed.
This usually means an architecture or libc mismatch. Please report it at
https://github.com/${REPO}/issues with the output above."
  fi
  echo "Verified: ${installed_version}"

  case ":${PATH}:" in
    *":${INSTALL_DIR}:"*) ;;
    *)
      echo ""
      echo "${INSTALL_DIR} is not on your PATH. Add to your shell profile:"
      echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
      ;;
  esac

  echo ""
  echo "Next steps:"
  echo "  1. astrograph install     # configure agent hosts (MCP + agent guide)"
  echo "  2. cd your-repo && astrograph init"
  echo ""
  echo "Note: 'astrograph install' configures agents — it does not install this binary."
}

main "$@"
