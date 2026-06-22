use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::domains::doctor;
use crate::shared::process::OsSupervisor;

use super::native_common::{open_database, parse_json_or_empty, table_exists, HandlerEnv};
use super::native_tools::NativeToolContext;

const SCHEME: &str = "context-still://";

pub(crate) fn list_resources() -> Value {
    json!({
        "resources": [
            resource("context-compiler-summary", "summary/context-compiler", "contextStill Context Compiler summary and retrieval modes.", "text/plain"),
            resource("context-pack-runs-list", "packs/list", "Recent context_compile run summaries.", "application/json"),
            resource("context-pack-latest", "packs/latest", "Latest context_compile run with selected items.", "application/json"),
            resource("doctor-health", "health/doctor", "Doctor health report including DB, table, and run-health diagnostics.", "application/json")
        ]
    })
}

pub(crate) fn read_resource(params: &Value, context: &NativeToolContext) -> Value {
    let uri = params
        .get("uri")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let canonical = normalize_uri(uri);
    match canonical.strip_prefix(SCHEME).unwrap_or(&canonical) {
        "summary/context-compiler" => text_content(uri, summary_text()),
        "packs/list" => json_content(uri, recent_runs(context, 20)),
        "packs/latest" => json_content(uri, latest_run_snapshot(context)),
        "health/doctor" => {
            let env = HandlerEnv::new(context);
            json_content(uri, json!(doctor::service::summary(&env, &OsSupervisor)))
        }
        path if path.starts_with("packs/run/") => {
            let run_id = path.trim_start_matches("packs/run/").trim();
            if run_id.is_empty() {
                json_content(uri, json!({"error": "run id is required"}))
            } else {
                json_content(uri, run_snapshot(context, run_id))
            }
        }
        _ => json_content(uri, json!({"error": "resource not found", "uri": uri})),
    }
}

fn resource(name: &str, path: &str, description: &str, mime_type: &str) -> Value {
    json!({
        "name": name,
        "uri": format!("{SCHEME}{path}"),
        "description": description,
        "mimeType": mime_type
    })
}

fn text_content(uri: &str, text: String) -> Value {
    json!({"contents":[{"uri":uri,"mimeType":"text/plain","text":text}]})
}

fn json_content(uri: &str, value: Value) -> Value {
    json!({"contents":[{"uri":uri,"mimeType":"application/json","text":serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string())}]})
}

fn summary_text() -> String {
    [
        "# contextStill context compiler",
        "",
        "- tool: context_compile",
        "- retrieval modes: sqlite_text",
        "- instructions are selected from active knowledge by default",
        "- source refs are stored per selected pack item and at pack-level",
        "- runtime: Rust-native MCP endpoint without TypeScript sidecar",
    ]
    .join("\n")
}

fn recent_runs(context: &NativeToolContext, limit: usize) -> Value {
    let connection = match open_database(context) {
        Ok(connection) => connection,
        Err(error) => return json!({"error": error, "runs": []}),
    };
    if !table_exists(&connection, "context_compile_runs") {
        return json!({"runs": []});
    }
    let mut statement = match connection.prepare(
        r#"
        select id, goal, intent, session_id, repo_path, retrieval_mode, status,
               degraded_reasons, token_budget, duration_ms, source, created_at
        from context_compile_runs
        order by created_at desc, rowid desc
        limit ?1
        "#,
    ) {
        Ok(statement) => statement,
        Err(error) => return json!({"error": error.to_string(), "runs": []}),
    };
    let rows = statement
        .query_map([i64::try_from(limit).unwrap_or(20)], run_summary_from_row)
        .map(|rows| rows.flatten().collect::<Vec<_>>())
        .unwrap_or_default();
    json!({"runs": rows})
}

fn latest_run_snapshot(context: &NativeToolContext) -> Value {
    let connection = match open_database(context) {
        Ok(connection) => connection,
        Err(error) => return json!({"error": error}),
    };
    if !table_exists(&connection, "context_compile_runs") {
        return json!({"message": "No context_compile run found yet."});
    }
    let run_id = connection
        .query_row(
            "select id from context_compile_runs order by created_at desc, rowid desc limit 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten();
    match run_id {
        Some(run_id) => snapshot_from_connection(&connection, &run_id),
        None => json!({"message": "No context_compile run found yet."}),
    }
}

fn run_snapshot(context: &NativeToolContext, run_id: &str) -> Value {
    let connection = match open_database(context) {
        Ok(connection) => connection,
        Err(error) => return json!({"error": error, "runId": run_id}),
    };
    snapshot_from_connection(&connection, run_id)
}

fn snapshot_from_connection(connection: &Connection, run_id: &str) -> Value {
    let snapshot = connection
        .query_row(
            "select pack_snapshot from context_compile_runs where id = ?1 limit 1",
            [run_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .ok()
        .flatten()
        .flatten();
    match snapshot {
        Some(value) => parse_json_or_empty(&value),
        None => json!({"error": "run not found", "runId": run_id}),
    }
}

fn run_summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let degraded_reasons: String = row.get(7)?;
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "goal": row.get::<_, String>(1)?,
        "intent": row.get::<_, String>(2)?,
        "sessionId": row.get::<_, Option<String>>(3)?,
        "repoPath": row.get::<_, Option<String>>(4)?,
        "retrievalMode": row.get::<_, String>(5)?,
        "status": row.get::<_, String>(6)?,
        "degradedReasons": serde_json::from_str::<Value>(&degraded_reasons).unwrap_or_else(|_| json!([])),
        "tokenBudget": row.get::<_, i64>(8)?,
        "durationMs": row.get::<_, i64>(9)?,
        "source": row.get::<_, String>(10)?,
        "createdAt": row.get::<_, String>(11)?
    }))
}

fn normalize_uri(uri: &str) -> String {
    uri.strip_prefix("memory-router://")
        .map(|tail| format!("{SCHEME}{tail}"))
        .unwrap_or_else(|| uri.to_string())
}
