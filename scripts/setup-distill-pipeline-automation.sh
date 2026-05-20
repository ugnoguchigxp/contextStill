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
PLIST="com.memory-router.distill-pipeline.plist"
LABEL="${PLIST%.plist}"
PIPELINE_KIND="${MEMORY_ROUTER_DISTILL_PIPELINE_KIND:-auto}"
PIPELINE_LIMIT="${MEMORY_ROUTER_DISTILL_PIPELINE_LIMIT:-1}"
PIPELINE_REFRESH="${MEMORY_ROUTER_DISTILL_PIPELINE_REFRESH:-1}"
PIPELINE_PROVIDER="${MEMORY_ROUTER_DISTILL_PIPELINE_PROVIDER:-}"
PIPELINE_VERSION="${MEMORY_ROUTER_DISTILL_PIPELINE_VERSION:-}"
LEGACY_LABELS=(
  "com.memory-router.vibe-distillation"
  "com.memory-router.source-distillation"
)

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
    "$PLIST_DIR/$PLIST" > "$LAUNCH_AGENTS_DIR/$PLIST"
  chmod 644 "$LAUNCH_AGENTS_DIR/$PLIST"
  echo "installed: $LAUNCH_AGENTS_DIR/$PLIST"
}

disable_legacy_jobs() {
  for legacy in "${LEGACY_LABELS[@]}"; do
    launchctl bootout "gui/$UID/$legacy" >/dev/null 2>&1 || true
  done
}

load_job() {
  local target="$LAUNCH_AGENTS_DIR/$PLIST"
  if [ ! -f "$target" ]; then
    install
  fi
  disable_legacy_jobs
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
  local bun_path
  bun_path="$(resolve_bun_path)"
  local args=(
    "run"
    "src/cli/distill-pipeline.ts"
    "--write"
    "--limit"
    "$PIPELINE_LIMIT"
    "--kind"
    "$PIPELINE_KIND"
  )
  if [ "$PIPELINE_REFRESH" = "0" ]; then
    args+=("--no-refresh")
  fi
  if [ -n "$PIPELINE_PROVIDER" ]; then
    args+=("--provider" "$PIPELINE_PROVIDER")
  fi
  if [ -n "$PIPELINE_VERSION" ]; then
    args+=("--version" "$PIPELINE_VERSION")
  fi

  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $LABEL run started kind=$PIPELINE_KIND limit=$PIPELINE_LIMIT"
  set +e
  "$bun_path" "${args[@]}"
  local exit_code=$?
  set -e
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $LABEL run finished exit_code=$exit_code"
  return "$exit_code"
}

run_continuous() {
  cd "$PROJECT_ROOT"
  local bun_path
  bun_path="$(resolve_bun_path)"
  local args=(
    "run"
    "src/cli/distill-pipeline.ts"
    "--write"
    "--continuous"
    "--limit"
    "$PIPELINE_LIMIT"
    "--kind"
    "$PIPELINE_KIND"
  )
  if [ "$PIPELINE_REFRESH" = "0" ]; then
    args+=("--no-refresh")
  fi
  if [ -n "$PIPELINE_PROVIDER" ]; then
    args+=("--provider" "$PIPELINE_PROVIDER")
  fi
  if [ -n "$PIPELINE_VERSION" ]; then
    args+=("--version" "$PIPELINE_VERSION")
  fi

  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $LABEL continuous run started kind=$PIPELINE_KIND"
  exec "$bun_path" "${args[@]}"
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
  run-continuous)
    run_continuous
    ;;
  *)
    echo "Usage: $0 {install|load|unload|uninstall|status|run-once|run-continuous}"
    exit 1
    ;;
esac
