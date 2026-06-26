use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::domains::bootstrap::service::resolve_paths;
use crate::domains::process_lifecycle::service::now_timestamp;
use crate::shared::{config::EnvProvider, errors::CliError};

use super::types::{
    AgentLogSource, ChatMessage, IngestCursor, IngestCursorEntry, IngestResult, StoreSourceResult,
};

static NEXT_ID: AtomicU64 = AtomicU64::new(0);
const DISTILLATION_VERSION: &str = "select-distillation-target-v1";

pub(crate) fn open_database<E: EnvProvider>(env: &E) -> Result<Connection, CliError> {
    let paths = resolve_paths(env);
    if let Some(parent) = paths.sqlite_core_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| CliError::io(format!("failed to create sqlite dir: {error}")))?;
    }
    let connection = Connection::open(&paths.sqlite_core_path)
        .map_err(|error| CliError::io(format!("failed to open sqlite core db: {error}")))?;
    ensure_schema(&connection)?;
    Ok(connection)
}

pub(crate) fn read_cursor(
    connection: &Connection,
    source_id: &str,
) -> Result<IngestCursor, CliError> {
    let raw: Option<String> = connection
        .query_row(
            "select cursor from sync_states where id = ?",
            params![source_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql_error)?;
    Ok(parse_cursor(raw.as_deref()))
}

pub(crate) fn store_source_result(
    connection: &mut Connection,
    source: &AgentLogSource,
    result: IngestResult,
    min_distillable_chars: usize,
) -> Result<StoreSourceResult, CliError> {
    if result.skipped {
        return Ok(StoreSourceResult {
            inserted_memories: 0,
            inserted_diffs: 0,
            last_synced_at: None,
        });
    }

    let source_id = source.id.id();
    let mut inserted_memories = 0;
    let tx = connection.transaction().map_err(sql_error)?;
    let grouped = group_messages(source_id, result.messages);
    for (memory_session_id, messages) in grouped {
        let chunks = chunk_messages(&messages, 120, 12_000);
        for (chunk_index, chunk) in chunks.iter().enumerate() {
            let readable = build_readable_transcript(chunk);
            if readable.trim().len() <= min_distillable_chars {
                continue;
            }
            let raw = build_transcript(chunk);
            let content = if readable.trim().is_empty() {
                raw
            } else {
                readable
            };
            let dedupe_key = format!("{source_id}:{memory_session_id}:{chunk_index}");
            let existing: Option<String> = tx
                .query_row(
                    "select id from vibe_memories where session_id = ? and dedupe_key = ? limit 1",
                    params![memory_session_id, dedupe_key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(sql_error)?;
            if existing.is_some() {
                continue;
            }

            let memory_id = next_id("vibe-memory");
            let now = now_timestamp();
            let metadata = build_memory_metadata(source, chunk, chunk_index, &dedupe_key);
            tx.execute(
                "
                insert into vibe_memories (
                  id, session_id, content, memory_type, dedupe_key, metadata, created_at
                ) values (?, ?, ?, 'chat', ?, ?, ?)
                ",
                params![
                    memory_id,
                    memory_session_id,
                    content,
                    dedupe_key,
                    metadata.to_string(),
                    now
                ],
            )
            .map_err(sql_error)?;
            tx.execute(
                "insert into vibe_memories_fts(id, content) values (?, ?)",
                params![memory_id, content],
            )
            .ok();
            enqueue_episode_distiller(
                &tx,
                &memory_id,
                source_id,
                &memory_session_id,
                chunk_index,
                &dedupe_key,
            )?;
            inserted_memories += 1;
        }
    }

    let synced_at = now_timestamp();
    tx.execute(
        "
        insert into sync_states (id, last_synced_at, cursor, metadata, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          last_synced_at = excluded.last_synced_at,
          cursor = excluded.cursor,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at
        ",
        params![
            source_id,
            synced_at,
            cursor_to_json(&result.cursor).to_string(),
            json!({
                "checkedFiles": result.checked_files,
                "warnings": result.warnings,
                "skipped": result.skipped,
                "messageCount": grouped_message_count(&result.cursor),
                "maxObservedMtimeMs": result.max_observed_mtime_ms,
                "formatVersion": "rust-1.0"
            })
            .to_string(),
            synced_at,
            synced_at
        ],
    )
    .map_err(sql_error)?;
    tx.commit().map_err(sql_error)?;

    Ok(StoreSourceResult {
        inserted_memories,
        inserted_diffs: 0,
        last_synced_at: Some(synced_at),
    })
}

fn enqueue_episode_distiller(
    tx: &rusqlite::Transaction<'_>,
    memory_id: &str,
    source_id: &str,
    memory_session_id: &str,
    chunk_index: usize,
    dedupe_key: &str,
) -> Result<(), CliError> {
    let id = next_id("episode-job");
    let now = now_timestamp();
    tx.execute(
        "
        insert into episode_distiller_queue (
          id, source_kind, source_key, source_uri, distillation_version,
          payload, metadata, priority, provider_policy, status, created_at, updated_at
        ) values (?, 'vibe_memory', ?, ?, ?, ?, ?, 50, 'default', 'pending', ?, ?)
        on conflict(source_kind, source_key, distillation_version) do nothing
        ",
        params![
            id,
            memory_id,
            format!("vibe_memory:{memory_id}"),
            DISTILLATION_VERSION,
            json!({"sourceType":"agent_log_sync","sourceId":source_id,"memorySessionId":memory_session_id,"chunkIndex":chunk_index,"dedupeKey":dedupe_key}).to_string(),
            json!({"sourceType":"agent_log_sync","sourceId":source_id,"memorySessionId":memory_session_id,"chunkIndex":chunk_index,"dedupeKey":dedupe_key}).to_string(),
            now,
            now
        ],
    )
    .map_err(sql_error)?;
    append_queue_event(
        tx,
        "episodeDistiller",
        &id,
        "episode distiller enqueued from Rust agent log sync",
    )
}

fn append_queue_event(
    tx: &rusqlite::Transaction<'_>,
    queue_name: &str,
    queue_job_id: &str,
    message: &str,
) -> Result<(), CliError> {
    tx.execute(
        "
        insert into distillation_queue_events (id, queue_name, queue_job_id, event_type, message, metadata, created_at)
        values (?, ?, ?, 'enqueued', ?, '{}', ?)
        ",
        params![next_id("queue-event"), queue_name, queue_job_id, message, now_timestamp()],
    )
    .map_err(sql_error)?;
    Ok(())
}

fn group_messages(
    source_id: &str,
    messages: Vec<ChatMessage>,
) -> BTreeMap<String, Vec<ChatMessage>> {
    let mut grouped = BTreeMap::new();
    for message in messages {
        let session = metadata_string(&message.metadata, "sessionId")
            .unwrap_or_else(|| "default".to_string());
        let project = metadata_string(&message.metadata, "projectName")
            .or_else(|| metadata_string(&message.metadata, "projectRoot"))
            .unwrap_or_else(|| "default".to_string());
        grouped
            .entry(format!("{source_id}:{project}:{session}"))
            .or_insert_with(Vec::new)
            .push(message);
    }
    grouped
}

fn chunk_messages(
    messages: &[ChatMessage],
    max_messages: usize,
    max_chars: usize,
) -> Vec<Vec<ChatMessage>> {
    let mut chunks = Vec::new();
    let mut current = Vec::new();
    let mut current_chars = 0;
    for message in messages {
        if !current.is_empty()
            && (current.len() >= max_messages || current_chars + message.content.len() > max_chars)
        {
            chunks.push(current);
            current = Vec::new();
            current_chars = 0;
        }
        current.push(message.clone());
        current_chars += message.content.len();
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn build_transcript(messages: &[ChatMessage]) -> String {
    messages
        .iter()
        .map(|message| format!("{}: {}", message.role.to_uppercase(), message.content))
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn build_readable_transcript(messages: &[ChatMessage]) -> String {
    messages
        .iter()
        .filter(|message| {
            metadata_string(&message.metadata, "messageKind").as_deref() != Some("tool_call")
        })
        .map(|message| format!("{}: {}", message.role.to_uppercase(), message.content))
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn build_memory_metadata(
    source: &AgentLogSource,
    messages: &[ChatMessage],
    chunk_index: usize,
    dedupe_key: &str,
) -> Value {
    let project_name = messages
        .iter()
        .find_map(|message| metadata_string(&message.metadata, "projectName"));
    json!({
        "source": source.id.label(),
        "sourceId": source.id.id(),
        "sources": [source.id.label()],
        "projectName": project_name,
        "chunkIndex": chunk_index,
        "dedupeKey": dedupe_key,
        "messageCount": messages.len(),
        "roles": messages.iter().map(|message| message.role).collect::<Vec<_>>(),
        "kind": "agent_log_chunk",
        "memoryPipeline": "raw_for_distillation",
        "rustAgentLogSync": true
    })
}

fn ensure_schema(connection: &Connection) -> Result<(), CliError> {
    connection
        .execute_batch(include_str!("schema_agent_log_sync.sql"))
        .map_err(sql_error)
}

fn parse_cursor(raw: Option<&str>) -> IngestCursor {
    let Some(raw) = raw else {
        return IngestCursor::new();
    };
    let Ok(Value::Object(entries)) = serde_json::from_str::<Value>(raw) else {
        return IngestCursor::new();
    };
    entries
        .into_iter()
        .filter_map(|(path, value)| {
            let offset = value.get("offset").and_then(Value::as_u64)?;
            let mtime_ms = value.get("mtimeMs").and_then(Value::as_u64).unwrap_or(0);
            Some((path, IngestCursorEntry { offset, mtime_ms }))
        })
        .collect()
}

fn cursor_to_json(cursor: &IngestCursor) -> Value {
    Value::Object(
        cursor
            .iter()
            .map(|(path, entry)| {
                (
                    path.clone(),
                    json!({"offset": entry.offset, "mtimeMs": entry.mtime_ms}),
                )
            })
            .collect(),
    )
}

fn metadata_string(metadata: &Value, key: &str) -> Option<String> {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn grouped_message_count(cursor: &IngestCursor) -> usize {
    cursor.len()
}

fn next_id(prefix: &str) -> String {
    format!(
        "rust-{prefix}-{}-{}",
        now_timestamp(),
        NEXT_ID.fetch_add(1, Ordering::SeqCst)
    )
}

fn sql_error(error: rusqlite::Error) -> CliError {
    CliError::runtime(format!("sqlite agent-log-sync failed: {error}"))
}

#[allow(dead_code)]
fn _path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
