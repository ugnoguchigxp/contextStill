use std::{fs, io::Read, path::Path};

use serde_json::{json, Value};

use super::types::{AgentLogSource, AgentLogSourceId, ChatMessage, IngestCursor, IngestResult};

struct MessageParams<'a> {
    role: &'static str,
    content: &'a str,
    source: &'a str,
    source_id: &'a str,
    session_id: &'a str,
    file_path: &'a Path,
    timestamp: Option<&'a str>,
    extra: Value,
}

pub(crate) fn ingest_source(
    source: &AgentLogSource,
    cursor: IngestCursor,
) -> Result<IngestResult, String> {
    if source.roots.is_empty() {
        return Ok(empty_result(cursor, true));
    }

    match source.id {
        AgentLogSourceId::Codex => ingest_codex(source, cursor),
        AgentLogSourceId::Antigravity => ingest_antigravity(source, cursor),
        AgentLogSourceId::Claude => ingest_claude(source, cursor),
    }
}

fn ingest_codex(source: &AgentLogSource, cursor: IngestCursor) -> Result<IngestResult, String> {
    ingest_jsonl_files(source, cursor, |file_path, text, start_offset| {
        parse_codex_delta(file_path, text, start_offset)
    })
}

fn ingest_antigravity(
    source: &AgentLogSource,
    cursor: IngestCursor,
) -> Result<IngestResult, String> {
    ingest_jsonl_files(source, cursor, |file_path, text, _| {
        parse_antigravity_delta(file_path, text)
    })
}

fn ingest_claude(source: &AgentLogSource, cursor: IngestCursor) -> Result<IngestResult, String> {
    ingest_jsonl_files(source, cursor, |file_path, text, _| {
        parse_claude_delta(file_path, text)
    })
}

fn ingest_jsonl_files<F>(
    source: &AgentLogSource,
    mut cursor: IngestCursor,
    parse: F,
) -> Result<IngestResult, String>
where
    F: Fn(&Path, &str, u64) -> Vec<ChatMessage>,
{
    let mut messages = Vec::new();
    let mut warnings = Vec::new();
    let mut checked_files = 0;
    let mut max_observed_mtime_ms = 0;
    let threshold_ms = first_sync_threshold_ms(source.initial_lookback_hours);

    for root in &source.roots {
        let files = match list_jsonl_files(root) {
            Ok(files) => files,
            Err(error) if optional_fs_error(&error) => continue,
            Err(error) => {
                warnings.push(format!(
                    "{} root ingest failed ({}): {error}",
                    source.id.label(),
                    root.to_string_lossy()
                ));
                continue;
            }
        };

        for file_path in files {
            checked_files += 1;
            let stat = match fs::metadata(&file_path) {
                Ok(stat) => stat,
                Err(error) if optional_fs_error(&error) => continue,
                Err(error) => {
                    warnings.push(format!(
                        "{} file stat failed ({}): {error}",
                        source.id.label(),
                        file_path.to_string_lossy()
                    ));
                    continue;
                }
            };
            let size = stat.len();
            let mtime_ms = mtime_ms(&stat);
            max_observed_mtime_ms = max_observed_mtime_ms.max(mtime_ms);
            let key = file_path.to_string_lossy().to_string();
            let previous = cursor.get(&key).cloned();

            if previous.is_none() && mtime_ms < threshold_ms {
                cursor.insert(key, cursor_entry(size, mtime_ms));
                continue;
            }
            let mut start_offset = previous.map(|entry| entry.offset).unwrap_or(0);
            if start_offset > size {
                start_offset = 0;
            }
            if start_offset == size {
                cursor.insert(key, cursor_entry(size, mtime_ms));
                continue;
            }

            match read_delta(&file_path, start_offset) {
                Ok(text) => {
                    messages.extend(parse(&file_path, &text, start_offset));
                    cursor.insert(key, cursor_entry(size, mtime_ms));
                }
                Err(error) => warnings.push(format!(
                    "{} file ingest failed ({}): {error}",
                    source.id.label(),
                    file_path.to_string_lossy()
                )),
            }
        }
    }

    Ok(IngestResult {
        ok: true,
        errors: Vec::new(),
        warnings,
        messages,
        cursor,
        max_observed_mtime_ms,
        checked_files,
        skipped: false,
    })
}

fn parse_codex_delta(file_path: &Path, text: &str, _start_offset: u64) -> Vec<ChatMessage> {
    let mut messages = Vec::new();
    let mut session_id = session_id_from_file(file_path);
    let mut cwd: Option<String> = None;
    let mut session_started_at: Option<String> = None;
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("session_meta") {
            if let Some(payload) = value.get("payload") {
                if let Some(id) = payload.get("id").and_then(Value::as_str) {
                    session_id = id.to_string();
                }
                if let Some(value) = payload.get("cwd").and_then(Value::as_str) {
                    cwd = Some(value.to_string());
                }
                if let Some(value) = payload.get("timestamp").and_then(Value::as_str) {
                    session_started_at = Some(value.to_string());
                }
            }
            continue;
        }
        if value.get("type").and_then(Value::as_str) != Some("response_item") {
            continue;
        }
        let payload = value.get("payload").unwrap_or(&Value::Null);
        if matches!(
            payload.get("type").and_then(Value::as_str),
            Some("custom_tool_call" | "function_call")
        ) && payload.get("name").and_then(Value::as_str) == Some("apply_patch")
        {
            let content = payload
                .get("input")
                .or_else(|| payload.get("arguments"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            if !content.is_empty() {
                messages.push(message(MessageParams {
                    role: "assistant",
                    content,
                    source: "Codex",
                    source_id: "codex_logs",
                    session_id: &session_id,
                    file_path,
                    timestamp: value.get("timestamp").and_then(Value::as_str),
                    extra: json!({"messageKind":"tool_call","toolName":"apply_patch","cwd":cwd,"sessionStartedAt":session_started_at}),
                }));
            }
            continue;
        }
        if payload.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let role = payload
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if role != "user" && role != "assistant" {
            continue;
        }
        let content = extract_codex_text(payload.get("content").unwrap_or(&Value::Null));
        if !content.trim().is_empty() {
            messages.push(message(MessageParams {
                role: if role == "user" { "user" } else { "assistant" },
                content: content.trim(),
                source: "Codex",
                source_id: "codex_logs",
                session_id: &session_id,
                file_path,
                timestamp: value.get("timestamp").and_then(Value::as_str),
                extra: json!({"cwd":cwd,"sessionStartedAt":session_started_at}),
            }));
        }
    }
    messages
}

fn parse_claude_delta(file_path: &Path, text: &str) -> Vec<ChatMessage> {
    parse_simple_jsonl(file_path, text, "Claude", "claude_logs")
}

fn parse_antigravity_delta(file_path: &Path, text: &str) -> Vec<ChatMessage> {
    parse_simple_jsonl(file_path, text, "Antigravity", "antigravity_logs")
}

fn parse_simple_jsonl(
    file_path: &Path,
    text: &str,
    source: &str,
    source_id: &str,
) -> Vec<ChatMessage> {
    let mut messages = Vec::new();
    let session_id = session_id_from_file(file_path);
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let role = value
            .get("type")
            .or_else(|| value.get("role"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if role != "user" && role != "assistant" {
            continue;
        }
        let content = value
            .get("message")
            .and_then(|message| message.get("content"))
            .or_else(|| value.get("content"))
            .map(extract_codex_text)
            .unwrap_or_default();
        if content.trim().is_empty() {
            continue;
        }
        messages.push(message(MessageParams {
            role: if role == "user" { "user" } else { "assistant" },
            content: content.trim(),
            source,
            source_id,
            session_id: &session_id,
            file_path,
            timestamp: value
                .get("timestamp")
                .or_else(|| value.get("created_at"))
                .and_then(Value::as_str),
            extra: json!({}),
        }));
    }
    messages
}

fn message(params: MessageParams<'_>) -> ChatMessage {
    let mut metadata = serde_json::Map::new();
    metadata.insert("source".to_string(), json!(params.source));
    metadata.insert("sourceId".to_string(), json!(params.source_id));
    metadata.insert("sessionId".to_string(), json!(params.session_id));
    metadata.insert(
        "sessionFile".to_string(),
        json!(params.file_path.to_string_lossy().to_string()),
    );
    if let Some(timestamp) = params.timestamp {
        metadata.insert("timestamp".to_string(), json!(timestamp));
    }
    if let Some(extra) = params.extra.as_object() {
        for (key, value) in extra {
            if !value.is_null() {
                metadata.insert(key.clone(), value.clone());
            }
        }
    }
    ChatMessage {
        role: params.role,
        content: params.content.to_string(),
        metadata: Value::Object(metadata),
    }
}

fn extract_codex_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn list_jsonl_files(root: &Path) -> std::io::Result<Vec<std::path::PathBuf>> {
    let mut files = Vec::new();
    visit_jsonl(root, &mut files)?;
    files.sort();
    Ok(files)
}

fn visit_jsonl(dir: &Path, files: &mut Vec<std::path::PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            visit_jsonl(&path, files)?;
        } else if metadata.is_file()
            && path
                .extension()
                .is_some_and(|extension| extension == "jsonl")
        {
            files.push(path);
        }
    }
    Ok(())
}

fn read_delta(path: &Path, start_offset: u64) -> std::io::Result<String> {
    let mut file = fs::File::open(path)?;
    if start_offset > 0 {
        use std::io::Seek;
        file.seek(std::io::SeekFrom::Start(start_offset))?;
    }
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    Ok(text)
}

fn cursor_entry(offset: u64, mtime_ms: u64) -> super::types::IngestCursorEntry {
    super::types::IngestCursorEntry { offset, mtime_ms }
}

fn mtime_ms(stat: &fs::Metadata) -> u64 {
    stat.modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn first_sync_threshold_ms(lookback_hours: u64) -> u64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    now.saturating_sub(lookback_hours.saturating_mul(60 * 60 * 1000))
}

fn optional_fs_error(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
    )
}

fn empty_result(cursor: IngestCursor, skipped: bool) -> IngestResult {
    IngestResult {
        ok: true,
        errors: Vec::new(),
        warnings: Vec::new(),
        messages: Vec::new(),
        cursor,
        max_observed_mtime_ms: 0,
        checked_files: 0,
        skipped,
    }
}

fn session_id_from_file(path: &Path) -> String {
    path.file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "default".to_string())
}
