#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TIMESTAMP="$(date +"%Y%m%d_%H%M%S")"

SOURCE_DATABASE_URL="${SOURCE_DATABASE_URL:-postgres://postgres:postgres@localhost:7889/context_still}"
TARGET_DATABASE_NAME="${TARGET_DATABASE_NAME:-context_still_import_roundtrip}"
TARGET_DATABASE_URL="${TARGET_DATABASE_URL:-postgres://postgres:postgres@localhost:7889/${TARGET_DATABASE_NAME}}"
MAINTENANCE_DATABASE_URL="${MAINTENANCE_DATABASE_URL:-postgres://postgres:postgres@localhost:7889/postgres}"
EXPORT_DIR="${EXPORT_DIR:-${ROOT_DIR}/exports/context-still-roundtrip-${TIMESTAMP}}"
REPORT_FILE="${REPORT_FILE:-${EXPORT_DIR}/roundtrip-report.txt}"
RUN_FULL_BACKUP="${RUN_FULL_BACKUP:-0}"
ALLOW_DROP_TARGET="${ALLOW_DROP_TARGET:-0}"
KEEP_TARGET_DB="${KEEP_TARGET_DB:-0}"
target_created="0"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "エラー: 必要なコマンドが見つかりません: $1" >&2
    exit 1
  fi
}

run_step() {
  local label="$1"
  shift
  echo "--- ${label} ---"
  "$@"
}

append_report() {
  mkdir -p "$(dirname "$REPORT_FILE")"
  printf "%s\n" "$*" >>"$REPORT_FILE"
}

redact_url() {
  printf "%s" "$1" | sed -E 's#(://[^:/@]+:)[^@]*@#\1***@#'
}

query_scalar() {
  psql "$MAINTENANCE_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "$1"
}

target_query() {
  psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "$1"
}

cleanup_target_db() {
  local status=$?
  if [[ "$target_created" == "1" && "$KEEP_TARGET_DB" != "1" ]]; then
    echo "--- cleanup-target-db ---"
    psql "$MAINTENANCE_DATABASE_URL" -v ON_ERROR_STOP=1 -c "drop database if exists \"${TARGET_DATABASE_NAME}\" with (force);" || true
    append_report "target_cleanup=dropped"
  elif [[ "$target_created" == "1" ]]; then
    append_report "target_cleanup=kept"
  fi
  exit "$status"
}

if [[ ! "$TARGET_DATABASE_NAME" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
  echo "エラー: TARGET_DATABASE_NAME は PostgreSQL identifier として安全な名前にしてください: $TARGET_DATABASE_NAME" >&2
  exit 1
fi

require_command bun
require_command psql

cd "$ROOT_DIR"
mkdir -p "$EXPORT_DIR"
: >"$REPORT_FILE"
trap cleanup_target_db EXIT

append_report "context-still portable Knowledge roundtrip trial"
append_report "started_at=${TIMESTAMP}"
append_report "source_database_url=$(redact_url "$SOURCE_DATABASE_URL")"
append_report "target_database_url=$(redact_url "$TARGET_DATABASE_URL")"
append_report "export_dir=${EXPORT_DIR}"
append_report "keep_target_db=${KEEP_TARGET_DB}"
append_report ""

if [[ "$RUN_FULL_BACKUP" == "1" ]]; then
  run_step "full-db-backup" ./scripts/backup-db.sh
else
  echo "--- full-db-backup ---"
  echo "skip: set RUN_FULL_BACKUP=1 to run ./scripts/backup-db.sh"
fi

existing_target="$(query_scalar "select 1 from pg_database where datname = '${TARGET_DATABASE_NAME}' limit 1;")"
if [[ "$existing_target" == "1" ]]; then
  if [[ "$ALLOW_DROP_TARGET" != "1" ]]; then
    echo "エラー: target DB already exists: ${TARGET_DATABASE_NAME}" >&2
    echo "別名を TARGET_DATABASE_NAME に指定するか、破棄してよい場合のみ ALLOW_DROP_TARGET=1 を指定してください。" >&2
    exit 1
  fi
  run_step "drop-existing-target" psql "$MAINTENANCE_DATABASE_URL" -v ON_ERROR_STOP=1 -c "drop database \"${TARGET_DATABASE_NAME}\" with (force);"
fi

run_step "create-target-db" psql "$MAINTENANCE_DATABASE_URL" -v ON_ERROR_STOP=1 -c "create database \"${TARGET_DATABASE_NAME}\";"
target_created="1"
connected_target_db="$(target_query "select current_database();")"
if [[ "$connected_target_db" != "$TARGET_DATABASE_NAME" ]]; then
  echo "エラー: TARGET_DATABASE_URL points to ${connected_target_db}, expected ${TARGET_DATABASE_NAME}" >&2
  echo "TARGET_DATABASE_URL と TARGET_DATABASE_NAME を一致させてください。" >&2
  exit 1
fi
run_step "migrate-target-db" env DATABASE_URL="$TARGET_DATABASE_URL" bun run db:migrate
run_step "export-source" env DATABASE_URL="$SOURCE_DATABASE_URL" bun run export:knowledge -- --out "$EXPORT_DIR"
run_step "dry-run-target" env DATABASE_URL="$TARGET_DATABASE_URL" bun run import:knowledge -- --from "$EXPORT_DIR" --dry-run
run_step "insert-only-target" env DATABASE_URL="$TARGET_DATABASE_URL" bun run import:knowledge -- --from "$EXPORT_DIR" --mode insert-only

append_report "target_counts:"
target_query "
select 'knowledge_items=' || count(*) from knowledge_items
union all select 'sources=' || count(*) from sources
union all select 'source_fragments=' || count(*) from source_fragments
union all select 'knowledge_source_links=' || count(*) from knowledge_source_links
union all select 'knowledge_origin_links=' || count(*) from knowledge_origin_links
union all select 'knowledge_quality_adjustments=' || count(*) from knowledge_quality_adjustments
order by 1;
" | tee -a "$REPORT_FILE"
append_report ""

echo "--- duplicate-conflict-check ---"
before_retry_counts="$(target_query "
select json_build_object(
  'knowledge_items', (select count(*) from knowledge_items),
  'sources', (select count(*) from sources),
  'source_fragments', (select count(*) from source_fragments),
  'knowledge_source_links', (select count(*) from knowledge_source_links),
  'knowledge_origin_links', (select count(*) from knowledge_origin_links),
  'knowledge_quality_adjustments', (select count(*) from knowledge_quality_adjustments)
)::text;
")"

set +e
env DATABASE_URL="$TARGET_DATABASE_URL" bun run import:knowledge -- --from "$EXPORT_DIR" --mode insert-only
retry_status=$?
set -e

after_retry_counts="$(target_query "
select json_build_object(
  'knowledge_items', (select count(*) from knowledge_items),
  'sources', (select count(*) from sources),
  'source_fragments', (select count(*) from source_fragments),
  'knowledge_source_links', (select count(*) from knowledge_source_links),
  'knowledge_origin_links', (select count(*) from knowledge_origin_links),
  'knowledge_quality_adjustments', (select count(*) from knowledge_quality_adjustments)
)::text;
")"

if [[ "$retry_status" == "0" ]]; then
  echo "エラー: duplicate import unexpectedly succeeded" >&2
  exit 1
fi
if [[ "$before_retry_counts" != "$after_retry_counts" ]]; then
  echo "エラー: duplicate import changed target row counts" >&2
  exit 1
fi
append_report "duplicate_conflict_check=passed"
append_report ""

run_step "doctor-target" env DATABASE_URL="$TARGET_DATABASE_URL" bun run doctor
append_report "doctor=completed"

echo "------------------------------------------------"
echo "Roundtrip trial completed."
echo "Export dir: $EXPORT_DIR"
echo "Report: $REPORT_FILE"
echo "Target DB: $TARGET_DATABASE_NAME"
if [[ "$KEEP_TARGET_DB" == "1" ]]; then
  echo "Target cleanup: kept because KEEP_TARGET_DB=1"
else
  echo "Target cleanup: will be dropped automatically"
fi
echo "------------------------------------------------"
