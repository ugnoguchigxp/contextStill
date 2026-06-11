#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_FILE="${OUT_FILE:-${ROOT_DIR}/src/db/seeds/knowledge-seed.json}"
CONTAINER_NAME="${CONTAINER_NAME:-context-still-db}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-context_still}"
DB_PASSWORD="${DB_PASSWORD:-postgres}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "エラー: 必要なコマンドが見つかりません: $1" >&2
    exit 1
  fi
}

require_command docker

if ! docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  echo "エラー: コンテナが見つかりません: $CONTAINER_NAME" >&2
  exit 1
fi

if [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME")" != "true" ]]; then
  echo "エラー: コンテナが起動していません: $CONTAINER_NAME" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT_FILE")"
tmp_file="$(mktemp)"

docker exec -e "PGPASSWORD=$DB_PASSWORD" "$CONTAINER_NAME" psql -U "$DB_USER" -d "$DB_NAME" -Atc "
with linked_fragments as (
  select distinct source_fragment_id from knowledge_source_links
),
linked_sources as (
  select distinct sf.source_id
  from source_fragments sf
  join linked_fragments lf on lf.source_fragment_id = sf.id
)
select json_build_object(
  'schemaVersion', 1,
  'generatedAt', now(),
  'knowledgeItems',
  coalesce((
    select json_agg(row_to_json(t) order by t.created_at, t.id)
    from (
      select
        id,
        type,
        status,
        scope,
        polarity,
        intent_tags,
        title,
        body,
        applies_to,
        confidence,
        importance,
        compile_select_count,
        last_compiled_at,
        agentic_accept_count,
        explicit_upvote_count,
        explicit_downvote_count,
        dynamic_score,
        metadata,
        created_at,
        updated_at,
        last_verified_at
      from knowledge_items
    ) t
  ), '[]'::json),
  'sources',
  coalesce((
    select json_agg(row_to_json(t) order by t.created_at, t.id)
    from (
      select
        id,
        source_kind,
        uri,
        title,
        body,
        metadata,
        created_at,
        updated_at,
        last_indexed_at
      from sources
      where id in (select source_id from linked_sources)
    ) t
  ), '[]'::json),
  'sourceFragments',
  coalesce((
    select json_agg(row_to_json(t) order by t.created_at, t.id)
    from (
      select
        id,
        source_id,
        locator,
        heading,
        content,
        metadata,
        created_at
      from source_fragments
      where id in (select source_fragment_id from linked_fragments)
    ) t
  ), '[]'::json),
  'knowledgeSourceLinks',
  coalesce((
    select json_agg(row_to_json(t) order by t.created_at, t.id)
    from (
      select
        id,
        knowledge_id,
        source_fragment_id,
        link_type,
        confidence,
        metadata,
        created_at
      from knowledge_source_links
    ) t
  ), '[]'::json),
  'knowledgeTagDefinitions',
  coalesce((
    select json_agg(row_to_json(t) order by t.created_at, t.id)
    from (
      select
        id,
        kind,
        slug,
        label,
        description,
        aliases,
        status,
        sort_order,
        created_at,
        updated_at
      from knowledge_tag_definitions
    ) t
  ), '[]'::json),
  'knowledgeCommunityLabels',
  coalesce((
    select json_agg(row_to_json(t) order by t.updated_at, t.community_key)
    from (
      select
        community_key,
        label,
        note,
        updated_at
      from knowledge_community_labels
    ) t
  ), '[]'::json)
);
" >"$tmp_file"

if command -v jq >/dev/null 2>&1; then
  jq "." "$tmp_file" >"$OUT_FILE"
else
  mv "$tmp_file" "$OUT_FILE"
  tmp_file=""
fi

if [[ -n "${tmp_file:-}" && -f "$tmp_file" ]]; then
  rm -f "$tmp_file"
fi

echo "seed snapshot exported: $OUT_FILE"
