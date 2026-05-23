#!/bin/bash
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done

PROJECT_ROOT="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"
KIND="${1:-wiki}"

if [ "$KIND" != "wiki" ] && [ "$KIND" != "vibe" ]; then
  echo "usage: scripts/monitor-distillation-lock.sh [wiki|vibe]" >&2
  exit 1
fi

cd "$PROJECT_ROOT"

echo "[distill-monitor] checked_at=$(date -u +%Y-%m-%dT%H:%M:%SZ) kind=$KIND"

echo ""
echo "== launchctl print gui/$(id -u)/com.memory-router.distill-pipeline =="
if [ "$(uname)" = "Darwin" ]; then
  launchctl print "gui/$(id -u)/com.memory-router.distill-pipeline"
else
  echo "skipped: launchctl is macOS-only"
fi

echo ""
echo "== bun run src/cli/distillation-target.ts status --json =="
bun run src/cli/distillation-target.ts status --json

echo ""
echo "== bun run distill:repair -- --kind $KIND --json =="
bun run distill:repair -- --kind "$KIND" --json
