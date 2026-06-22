use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use crate::domains::{mcp_lifecycle, resident_runtime};
use crate::shared::config::MapEnv;
use crate::shared::process::{MockSupervisor, ProcessSupervisor};
use rusqlite::Connection;

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

fn temp_app_dir() -> std::path::PathBuf {
    let rand_num = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp_id = NEXT_TEMP_ID.fetch_add(1, Ordering::SeqCst);
    let path = std::env::temp_dir().join(format!(
        "context_still_resident_runtime_{}_{}_{}",
        std::process::id(),
        rand_num,
        temp_id
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn resident_run_once_replaces_legacy_mcp_child_with_in_process_endpoint() {
    let app_dir = temp_app_dir();
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
        ("CONTEXT_STILL_MCP_PORT", "0"),
        ("CONTEXT_STILL_RESIDENT_QUEUE", "0"),
        ("CONTEXT_STILL_RESIDENT_AGENT_LOG_SYNC", "0"),
    ]);
    let supervisor = MockSupervisor::new();

    let preexisting = mcp_lifecycle::service::start_report(&env, &supervisor).unwrap();
    let pid = preexisting.pid.unwrap();

    let report = resident_runtime::service::run(&env, &supervisor, true).unwrap();

    assert!(report.surfaces.iter().any(|surface| {
        surface.name == "mcp-server"
            && surface.status == "running"
            && surface.pid == Some(std::process::id())
    }));
    assert!(report
        .surfaces
        .iter()
        .any(|surface| surface.name == "mcp-server" && surface.status == "stopped"));
    assert!(!supervisor.is_alive(pid));

    std::fs::remove_dir_all(&app_dir).unwrap();
}

#[test]
fn resident_run_once_invokes_queue_executor_for_pending_sqlite_jobs() {
    let app_dir = temp_app_dir();
    let sqlite_path = app_dir.join("queue.sqlite");
    let connection = Connection::open(&sqlite_path).unwrap();
    connection
        .execute_batch(
            r#"
            create table finding_candidate_queue (
              id text primary key,
              status text not null,
              priority integer not null default 0,
              attempt_count integer not null default 0,
              created_at text not null,
              updated_at text not null,
              completed_at text,
              next_run_at text,
              locked_by text,
              locked_at text,
              heartbeat_at text,
              last_error text,
              last_outcome_kind text,
              provider_policy text,
              payload text,
              metadata text
            );
            insert into finding_candidate_queue (
              id, status, priority, created_at, updated_at, next_run_at
            ) values (
              'job-pending', 'pending', 10, '2026-06-22 01:00:00', '2026-06-22 01:00:00', null
            );
            "#,
        )
        .unwrap();
    drop(connection);

    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
        (
            "CONTEXT_STILL_SQLITE_CORE_PATH",
            sqlite_path.to_str().unwrap(),
        ),
        ("CONTEXT_STILL_RESIDENT_MCP", "0"),
        ("CONTEXT_STILL_RESIDENT_AGENT_LOG_SYNC", "0"),
    ]);
    let supervisor = MockSupervisor::new();

    let report = resident_runtime::service::run(&env, &supervisor, true).unwrap();

    let queue_surface = report
        .surfaces
        .iter()
        .find(|surface| surface.name == "queue-supervisor")
        .expect("queue surface");
    assert_eq!(queue_surface.status, "scheduled");
    assert!(queue_surface
        .message
        .contains("Rust-managed one-shot tick completed"));

    let spawned = supervisor.spawned.lock().unwrap();
    assert!(spawned.values().any(|call| {
        call.command == "bun"
            && call.args
                == vec![
                    "run".to_string(),
                    "src/cli/queue-supervisor.ts".to_string(),
                    "--once".to_string(),
                    "--limit".to_string(),
                    "1".to_string(),
                    "--json".to_string(),
                ]
    }));

    std::fs::remove_dir_all(&app_dir).unwrap();
}
