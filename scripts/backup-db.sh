#!/usr/bin/env bash
set -euo pipefail

# context-still Database Backup Script
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-${ROOT_DIR}/backup}"
TIMESTAMP="$(date +"%Y%m%d_%H%M%S")"
DEFAULT_CONTAINER_NAME="context-still-db"
LEGACY_CONTAINER_NAME="memory-router-db"
CONTAINER_NAME="${CONTAINER_NAME:-$DEFAULT_CONTAINER_NAME}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-context_still}"
DB_PASSWORD="${DB_PASSWORD:-postgres}"
DUMP_FILE="${BACKUP_DIR}/db_dump_${TIMESTAMP}.sql"
ZIP_FILE="${BACKUP_DIR}/db_backup_${TIMESTAMP}.zip"
SQLITE_BACKUP_FILE="${SQLITE_BACKUP_FILE:-${OUTPUT_FILE:-${BACKUP_DIR}/sqlite_backup_${TIMESTAMP}.sqlite}}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "エラー: 必要なコマンドが見つかりません: $1" >&2
    exit 1
  fi
}

normalize_lower() {
  printf "%s" "$1" | tr '[:upper:]' '[:lower:]'
}

is_sqlite_backend() {
  local backend
  backend="$(normalize_lower "${CONTEXT_STILL_DB_BACKEND:-${DB_BACKEND:-}}")"
  case "$backend" in
    sqlite | sqlite3)
      return 0
      ;;
  esac

  case "${DATABASE_URL:-}" in
    sqlite | sqlite://* | file:*)
      return 0
      ;;
  esac

  if [[ -z "${DATABASE_URL:-}" ]] &&
    [[ -n "${CONTEXT_STILL_SQLITE_CORE_PATH:-${SQLITE_CORE_PATH:-${DB_SQLITE_PATH:-}}}" ]]; then
    return 0
  fi

  return 1
}

resolve_backend_kind() {
  if command -v bun >/dev/null 2>&1; then
    local resolved
    resolved="$(
      cd "$ROOT_DIR"
      bun --silent --eval 'import { resolveDatabaseBackendConfig } from "./src/db/backend.ts"; console.log(resolveDatabaseBackendConfig().kind);' 2>/dev/null
    )" || resolved=""
    if [[ -n "$resolved" ]]; then
      normalize_lower "$resolved"
      return 0
    fi
  fi

  if is_sqlite_backend; then
    printf "sqlite"
  else
    printf "postgres"
  fi
}

backup_sqlite() {
  require_command bun

  mkdir -p "$BACKUP_DIR"

  echo "--- SQLite データベースのバックアップを開始します ---"
  (
    cd "$ROOT_DIR"
    CONTEXT_STILL_DB_BACKEND=sqlite bun run src/cli/sqlite-backup.ts --output "$SQLITE_BACKUP_FILE"
  )
  echo "------------------------------------------------"
  echo "バックアップが完了しました。"
  echo "ファイルパス: $SQLITE_BACKUP_FILE"
  echo "------------------------------------------------"
}

backup_postgres() {
  require_command docker
  require_command zip

  if ! docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    if [[ -z "${CONTAINER_NAME:-}" || "$CONTAINER_NAME" == "$DEFAULT_CONTAINER_NAME" ]] &&
      docker inspect "$LEGACY_CONTAINER_NAME" >/dev/null 2>&1; then
      echo "情報: $DEFAULT_CONTAINER_NAME が見つからないため、既存移行環境の $LEGACY_CONTAINER_NAME を使用します。"
      CONTAINER_NAME="$LEGACY_CONTAINER_NAME"
    fi
  fi

  if ! docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    echo "エラー: コンテナが見つかりません: $CONTAINER_NAME" >&2
    exit 1
  fi

  if [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME")" != "true" ]]; then
    echo "エラー: コンテナが起動していません: $CONTAINER_NAME" >&2
    exit 1
  fi

  mkdir -p "$BACKUP_DIR"

  cleanup() {
    [[ -f "$DUMP_FILE" ]] && rm -f "$DUMP_FILE"
  }
  trap cleanup EXIT

  echo "--- PostgreSQL データベースのバックアップを開始します: $DB_NAME ---"

  docker exec -e "PGPASSWORD=$DB_PASSWORD" "$CONTAINER_NAME" \
    pg_dump -U "$DB_USER" "$DB_NAME" >"$DUMP_FILE"
  echo "ダンプ完了: $DUMP_FILE"

  zip -j "$ZIP_FILE" "$DUMP_FILE" >/dev/null
  echo "圧縮完了: $ZIP_FILE"

  echo "------------------------------------------------"
  echo "バックアップが完了しました。"
  echo "ファイルパス: $ZIP_FILE"
  echo "------------------------------------------------"
}

if [[ "$(resolve_backend_kind)" == "sqlite" ]]; then
  backup_sqlite
else
  backup_postgres
fi
