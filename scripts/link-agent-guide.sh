#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$ROOT/agents/astrograph"

if [[ ! -f "$SOURCE_DIR/SKILL.md" ]]; then
  echo "Missing $SOURCE_DIR/SKILL.md" >&2
  exit 1
fi

mkdir -p "$ROOT/.claude/skills"
mkdir -p "$ROOT/.codex/skills"
mkdir -p "$ROOT/.cursor/rules"
mkdir -p "$ROOT/.opencode"

ln -sfn "../../agents/astrograph" "$ROOT/.claude/skills/astrograph"
ln -sfn "../../agents/astrograph" "$ROOT/.codex/skills/astrograph"
ln -sfn "../../agents/astrograph/SKILL.md" "$ROOT/.cursor/rules/astrograph.mdc"
ln -sfn "../agents/astrograph/SKILL.md" "$ROOT/.opencode/AGENTS.md"

echo "Linked Astrograph agent guide:"
echo "  .claude/skills/astrograph -> ../../agents/astrograph"
echo "  .codex/skills/astrograph -> ../../agents/astrograph"
echo "  .cursor/rules/astrograph.mdc -> ../../agents/astrograph/SKILL.md"
echo "  .opencode/AGENTS.md -> ../agents/astrograph/SKILL.md"

