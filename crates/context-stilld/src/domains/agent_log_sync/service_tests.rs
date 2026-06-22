use rusqlite::Connection;

use super::service::run_sync;
use crate::shared::config::MapEnv;

fn temp_app_dir() -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "context_still_agent_log_sync_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn rust_agent_log_sync_imports_codex_jsonl_into_sqlite() {
    let app_dir = temp_app_dir();
    let codex_dir = app_dir.join("codex-sessions");
    std::fs::create_dir_all(&codex_dir).unwrap();
    let sqlite_path = app_dir.join("core.sqlite");
    let session_path = codex_dir.join("session.jsonl");
    let long_text = "x".repeat(2100);
    std::fs::write(
        &session_path,
        format!(
            "{}\n{}\n{}\n",
            r#"{"type":"session_meta","payload":{"id":"session-1","cwd":"/tmp/project","timestamp":"2026-06-22T00:00:00.000Z"}}"#,
            r#"{"type":"response_item","timestamp":"2026-06-22T00:00:01.000Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Please review this code."}]}}"#,
            format!(r#"{{"type":"response_item","timestamp":"2026-06-22T00:00:02.000Z","payload":{{"type":"message","role":"assistant","content":[{{"type":"output_text","text":"{long_text}"}}]}}}}"#)
        ),
    )
    .unwrap();
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        (
            "CONTEXT_STILL_SQLITE_CORE_PATH",
            sqlite_path.to_str().unwrap(),
        ),
        ("CODEX_SESSION_DIR", codex_dir.to_str().unwrap()),
        (
            "CODEX_ARCHIVED_SESSION_DIR",
            app_dir.join("missing").to_str().unwrap(),
        ),
        (
            "ANTIGRAVITY_LOG_DIR",
            app_dir.join("missing").to_str().unwrap(),
        ),
        ("CLAUDE_LOG_DIRS", ""),
    ]);

    let summary = run_sync(&env).unwrap();

    assert_eq!(summary.imported, 1);
    let connection = Connection::open(&sqlite_path).unwrap();
    let count: i64 = connection
        .query_row("select count(*) from vibe_memories", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);
    let queue_count: i64 = connection
        .query_row("select count(*) from finding_candidate_queue", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(queue_count, 1);

    std::fs::remove_dir_all(&app_dir).unwrap();
}
