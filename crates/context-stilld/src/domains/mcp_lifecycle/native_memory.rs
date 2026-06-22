use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use super::native_common::{
    bool_arg, content_json, no_content, open_database, parse_json_or_empty, score_text,
    single_line, string_arg, table_exists, tool_error, truncate_chars, usize_arg,
};
use super::native_tools::NativeToolContext;

pub(crate) fn search_memory(params: &Value, context: &NativeToolContext) -> Value {
    let Some(args) = params.get("arguments").and_then(Value::as_object) else {
        return tool_error("search_memory arguments must be an object");
    };
    let query = match string_arg(args, "query") {
        Some(query) if !query.is_empty() => query,
        _ => return tool_error("query is required"),
    };
    let limit = usize_arg(args, "limit").unwrap_or(10).min(100);
    let include_content = bool_arg(args, "includeContent").unwrap_or(false);
    let preview_chars = usize_arg(args, "previewChars").unwrap_or(320);
    let session_id = string_arg(args, "sessionId");
    let connection = match open_database(context) {
        Ok(connection) => connection,
        Err(error) => return tool_error(&error),
    };
    if !table_exists(&connection, "vibe_memories") {
        return no_content();
    }

    let mut statement = match connection.prepare(
        r#"
        select id, session_id, content, memory_type, metadata, created_at
        from vibe_memories
        order by created_at desc
        limit 500
        "#,
    ) {
        Ok(statement) => statement,
        Err(error) => return tool_error(&format!("failed to search memories: {error}")),
    };
    let rows = match statement.query_map([], |row| {
        Ok(MemoryRow {
            id: row.get(0)?,
            session_id: row.get(1)?,
            content: row.get(2)?,
            memory_type: row.get(3)?,
            created_at: row.get(5)?,
        })
    }) {
        Ok(rows) => rows,
        Err(error) => return tool_error(&format!("failed to search memories: {error}")),
    };
    let mut items = Vec::new();
    for row in rows.flatten() {
        if session_id
            .as_ref()
            .is_some_and(|expected| expected != &row.session_id)
        {
            continue;
        }
        let score = score_text(&row.content, &query)
            + memory_diff_match_count(&connection, &row.id, &query).unwrap_or(0) as i64;
        if score <= 0 {
            continue;
        }
        let mut item = json!({
            "id": row.id,
            "sessionId": row.session_id,
            "memoryType": row.memory_type,
            "createdAt": row.created_at,
            "score": score,
            "title": pick_title(&row.content),
            "summary": single_line(&row.content, 180)
        });
        if include_content {
            let preview = truncate_chars(&row.content, preview_chars);
            item["contentPreview"] = json!(preview);
            item["previewChars"] = json!(preview_chars);
            item["contentTruncated"] = json!(row.content.chars().count() > preview_chars);
        }
        items.push((score, row.created_at, item));
    }
    items.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
    let values = items
        .into_iter()
        .take(limit)
        .map(|(_, _, item)| item)
        .collect::<Vec<_>>();
    if values.is_empty() {
        return no_content();
    }
    content_json(json!({ "items": values }))
}

pub(crate) fn fetch_memory(params: &Value, context: &NativeToolContext) -> Value {
    let Some(args) = params.get("arguments").and_then(Value::as_object) else {
        return tool_error("fetch_memory arguments must be an object");
    };
    let id = match string_arg(args, "id") {
        Some(id) if !id.is_empty() => id,
        _ => return tool_error("id is required"),
    };
    let connection = match open_database(context) {
        Ok(connection) => connection,
        Err(error) => return tool_error(&error),
    };
    let row = match fetch_memory_row(&connection, &id) {
        Ok(Some(row)) => row,
        Ok(None) => return tool_error("Memory not found."),
        Err(error) => return tool_error(&error),
    };
    let full_text = row.content;
    let max_chars = usize_arg(args, "maxChars");
    let mut start = usize_arg(args, "start").unwrap_or(0).min(full_text.len());
    let mut end = usize_arg(args, "end")
        .unwrap_or(full_text.len())
        .min(full_text.len());
    if let Some(query) = string_arg(args, "query") {
        if let Some(index) = full_text.to_lowercase().find(&query.to_lowercase()) {
            let window = max_chars.unwrap_or(1000);
            let half = window / 2;
            start = index.saturating_sub(half);
            end = (index + query.len() + half).min(full_text.len());
        }
    }
    if end < start {
        end = start;
    }
    let mut text = full_text[start..end].to_string();
    if let Some(max_chars) = max_chars {
        text = truncate_chars(&text, max_chars);
        end = start + text.len();
    }
    let truncated = start > 0 || end < full_text.len();
    if bool_arg(args, "returnMetaOnly").unwrap_or(false) {
        return content_json(json!({
            "id": row.id,
            "sessionId": row.session_id,
            "memoryType": row.memory_type,
            "createdAt": row.created_at,
            "contentLength": full_text.len(),
            "sliceStart": start,
            "sliceEnd": end,
            "truncated": truncated
        }));
    }
    let mut payload = json!({
        "id": row.id,
        "sessionId": row.session_id,
        "content": text,
        "memoryType": row.memory_type,
        "metadata": parse_json_or_empty(&row.metadata),
        "createdAt": row.created_at,
        "sliceStart": start,
        "sliceEnd": end,
        "truncated": truncated,
        "contentLength": full_text.len()
    });
    if bool_arg(args, "includeAgentDiffs").unwrap_or(false) {
        payload["agentDiffs"] = json!(fetch_agent_diffs(&connection, &row.id));
    }
    content_json(payload)
}

#[derive(Debug)]
struct MemoryRow {
    id: String,
    session_id: String,
    content: String,
    memory_type: String,
    created_at: String,
}

#[derive(Debug)]
struct MemoryFetchRow {
    id: String,
    session_id: String,
    content: String,
    memory_type: String,
    metadata: String,
    created_at: String,
}

fn pick_title(content: &str) -> String {
    content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| single_line(line, 100))
        .unwrap_or_else(|| "(untitled memory)".to_string())
}

fn memory_diff_match_count(
    connection: &Connection,
    memory_id: &str,
    query: &str,
) -> Result<usize, rusqlite::Error> {
    let pattern = format!("%{}%", query.to_lowercase());
    let count: i64 = connection.query_row(
        r#"
        select count(*) from agent_diff_entries
        where vibe_memory_id = ?1
          and (
            lower(file_path) like ?2
            or lower(diff_hunk) like ?2
            or lower(coalesce(symbol_name, '')) like ?2
            or lower(coalesce(symbol_kind, '')) like ?2
            or lower(coalesce(signature, '')) like ?2
          )
        "#,
        (memory_id, pattern),
        |row| row.get(0),
    )?;
    Ok(count.max(0) as usize)
}

fn fetch_memory_row(connection: &Connection, id: &str) -> Result<Option<MemoryFetchRow>, String> {
    connection
        .query_row(
            r#"
            select id, session_id, content, memory_type, metadata, created_at
            from vibe_memories
            where id = ?1
            limit 1
            "#,
            [id],
            |row| {
                Ok(MemoryFetchRow {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    content: row.get(2)?,
                    memory_type: row.get(3)?,
                    metadata: row.get(4)?,
                    created_at: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("failed to fetch memory: {error}"))
}

fn fetch_agent_diffs(connection: &Connection, memory_id: &str) -> Vec<Value> {
    let mut statement = match connection.prepare(
        r#"
        select id, file_path, diff_hunk, change_type, language, symbol_name, symbol_kind,
               signature, start_line, end_line, metadata, created_at, updated_at
        from agent_diff_entries
        where vibe_memory_id = ?1
        order by created_at desc
        "#,
    ) {
        Ok(statement) => statement,
        Err(_) => return Vec::new(),
    };
    statement
        .query_map([memory_id], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "filePath": row.get::<_, String>(1)?,
                "diffHunk": row.get::<_, String>(2)?,
                "changeType": row.get::<_, Option<String>>(3)?,
                "language": row.get::<_, Option<String>>(4)?,
                "symbolName": row.get::<_, Option<String>>(5)?,
                "symbolKind": row.get::<_, Option<String>>(6)?,
                "signature": row.get::<_, Option<String>>(7)?,
                "startLine": row.get::<_, Option<i64>>(8)?,
                "endLine": row.get::<_, Option<i64>>(9)?,
                "metadata": parse_json_or_empty(&row.get::<_, String>(10)?),
                "createdAt": row.get::<_, String>(11)?,
                "updatedAt": row.get::<_, String>(12)?
            }))
        })
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}
