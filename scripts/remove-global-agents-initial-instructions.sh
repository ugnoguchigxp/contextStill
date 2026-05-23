#!/bin/bash
set -euo pipefail

RULE_LINE='このプロジェクトでの作業を開始する際、最初に一度だけ `initial_instructions` MCP ツールを実行してください。以降の個別のタスクごとに実行する必要はありません。'
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
AGENTS_FILE="$CODEX_HOME_DIR/AGENTS.md"

if [ ! -f "$AGENTS_FILE" ]; then
  echo "not found: $AGENTS_FILE"
  exit 0
fi

TMP_FILE="$(mktemp "${TMPDIR:-/tmp}/agents-md.XXXXXX")"
trap 'rm -f "$TMP_FILE"' EXIT

grep -Fvx "$RULE_LINE" "$AGENTS_FILE" > "$TMP_FILE" || true
cat "$TMP_FILE" > "$AGENTS_FILE"

echo "removed matching line from: $AGENTS_FILE"
