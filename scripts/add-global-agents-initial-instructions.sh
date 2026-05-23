#!/bin/bash
set -euo pipefail

RULE_LINE='このプロジェクトでの作業を開始する際、最初に一度だけ `initial_instructions` MCP ツールを実行してください。以降の個別のタスクごとに実行する必要はありません。'
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
AGENTS_FILE="$CODEX_HOME_DIR/AGENTS.md"

mkdir -p "$CODEX_HOME_DIR"
touch "$AGENTS_FILE"

if grep -Fxq "$RULE_LINE" "$AGENTS_FILE"; then
  echo "already present: $AGENTS_FILE"
  exit 0
fi

if [ -s "$AGENTS_FILE" ] && [ "$(tail -c 1 "$AGENTS_FILE" | wc -l | tr -d ' ')" = "0" ]; then
  printf '\n' >> "$AGENTS_FILE"
fi

printf '%s\n' "$RULE_LINE" >> "$AGENTS_FILE"
echo "added: $AGENTS_FILE"
