#!/usr/bin/env bash
set -euo pipefail

# memory-router Database Backup Script
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-${ROOT_DIR}/backup}"
TIMESTAMP="$(date +"%Y%m%d_%H%M%S")"
CONTAINER_NAME="${CONTAINER_NAME:-memory-router-db}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-memory_router}"
DB_PASSWORD="${DB_PASSWORD:-postgres}"
DUMP_FILE="${BACKUP_DIR}/db_dump_${TIMESTAMP}.sql"
ZIP_FILE="${BACKUP_DIR}/db_backup_${TIMESTAMP}.zip"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "エラー: 必要なコマンドが見つかりません: $1" >&2
    exit 1
  fi
}

require_command docker
require_command zip

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

echo "--- データベースのバックアップを開始します: $DB_NAME ---"

docker exec -e "PGPASSWORD=$DB_PASSWORD" "$CONTAINER_NAME" \
  pg_dump -U "$DB_USER" "$DB_NAME" >"$DUMP_FILE"
echo "ダンプ完了: $DUMP_FILE"

zip -j "$ZIP_FILE" "$DUMP_FILE" >/dev/null
echo "圧縮完了: $ZIP_FILE"

echo "------------------------------------------------"
echo "バックアップが完了しました。"
echo "ファイルパス: $ZIP_FILE"
echo "------------------------------------------------"
