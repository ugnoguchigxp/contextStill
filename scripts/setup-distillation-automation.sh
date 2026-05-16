#!/bin/bash
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done

PROJECT_ROOT="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"
PLIST_DIR="$PROJECT_ROOT/scripts/automation"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST="com.memory-router.vibe-distillation.plist"
LABEL="${PLIST%.plist}"
INTERVAL_SECONDS="${MEMORY_ROUTER_VIBE_DISTILLATION_INTERVAL_SECONDS:-3600}"

mkdir -p "$PROJECT_ROOT/logs"
mkdir -p "$LAUNCH_AGENTS_DIR"

resolve_bun_path() {
  local bun_path
  bun_path="$(command -v bun || true)"
  if [ -z "$bun_path" ]; then
    bun_path="$HOME/.bun/bin/bun"
  fi
  echo "$bun_path"
}

install() {
  local bun_path
  bun_path="$(resolve_bun_path)"
  sed \
    -e "s|{{PROJECT_ROOT}}|$PROJECT_ROOT|g" \
    -e "s|{{BUN_PATH}}|$bun_path|g" \
    -e "s|{{INTERVAL_SECONDS}}|$INTERVAL_SECONDS|g" \
    "$PLIST_DIR/$PLIST" > "$LAUNCH_AGENTS_DIR/$PLIST"
  chmod 644 "$LAUNCH_AGENTS_DIR/$PLIST"
  echo "installed: $LAUNCH_AGENTS_DIR/$PLIST"
}

load_job() {
  local target="$LAUNCH_AGENTS_DIR/$PLIST"
  if [ ! -f "$target" ]; then
    install
  fi
  launchctl bootout "gui/$UID" "$target" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$UID" "$target"
  echo "loaded: $LABEL"
}

unload_job() {
  local target="$LAUNCH_AGENTS_DIR/$PLIST"
  launchctl bootout "gui/$UID" "$target" >/dev/null 2>&1 || true
  echo "unloaded: $LABEL"
}

uninstall() {
  unload_job
  rm -f "$LAUNCH_AGENTS_DIR/$PLIST"
  echo "removed: $LAUNCH_AGENTS_DIR/$PLIST"
}

status() {
  local target="$LAUNCH_AGENTS_DIR/$PLIST"
  if [ ! -f "$target" ]; then
    echo "$LABEL: not installed"
    return 0
  fi
  if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
    echo "$LABEL: loaded"
    launchctl print "gui/$UID/$LABEL" | grep -E "state =|last exit code|pid =|path =|program =|program arguments =" || true
  else
    echo "$LABEL: installed but not loaded"
  fi
}

run_once() {
  cd "$PROJECT_ROOT"
  "$(resolve_bun_path)" run db:migrate
  "$(resolve_bun_path)" run src/cli/distill-vibe-memory.ts --apply
}

case "${1:-}" in
  install)
    install
    ;;
  load)
    load_job
    ;;
  unload)
    unload_job
    ;;
  uninstall)
    uninstall
    ;;
  status)
    status
    ;;
  run-once)
    run_once
    ;;
  *)
    echo "Usage: $0 {install|load|unload|uninstall|status|run-once}"
    exit 1
    ;;
esac
