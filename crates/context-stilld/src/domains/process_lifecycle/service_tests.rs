use super::service::*;
use crate::domains::daemon::repository::{self, ProcessState};
use crate::shared::config::MapEnv;
use crate::shared::process::{MockSupervisor, ProcessSupervisor};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

const SPEC: ManagedProcessSpec = ManagedProcessSpec {
    state_name: "test-process",
    display_name: "test-process",
    command: "bun",
    args: &["run", "test.ts"],
    log_file: "test-process.log",
};

fn temp_app_dir() -> std::path::PathBuf {
    let rand_num = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp_id = NEXT_TEMP_ID.fetch_add(1, Ordering::SeqCst);
    let path = std::env::temp_dir().join(format!(
        "context_still_lifecycle_{}_{}_{}",
        std::process::id(),
        rand_num,
        temp_id
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn managed_process_start_status_stop_roundtrip() {
    let app_dir = temp_app_dir();
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
    ]);
    let supervisor = MockSupervisor::new();

    assert_eq!(
        status(&SPEC, &env, &supervisor).unwrap(),
        "test-process status: stopped"
    );

    let started = start(&SPEC, &env, &supervisor).unwrap();
    assert!(started.contains("test-process started"));

    let spawned = supervisor.spawned.lock().unwrap();
    let call = spawned.get(&1000).unwrap();
    assert_eq!(call.command, "bun");
    assert_eq!(call.args, vec!["run".to_string(), "test.ts".to_string()]);
    assert_eq!(call.log_path, app_dir.join("logs/test-process.log"));
    drop(spawned);

    assert!(status(&SPEC, &env, &supervisor)
        .unwrap()
        .contains("test-process status: running"));
    assert_eq!(
        stop(&SPEC, &env, &supervisor).unwrap(),
        "test-process stopped"
    );
    assert_eq!(
        status(&SPEC, &env, &supervisor).unwrap(),
        "test-process status: stopped"
    );

    std::fs::remove_dir_all(&app_dir).unwrap();
}

#[test]
fn start_cleans_up_spawned_process_when_state_persist_fails() {
    let app_dir = temp_app_dir();
    std::fs::write(app_dir.join("run"), "not a directory").unwrap();
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
    ]);
    let supervisor = MockSupervisor::new();

    let error = start_report(&SPEC, &env, &supervisor).expect_err("state write should fail");

    assert!(error
        .to_string()
        .contains("failed to write test-process state"));
    assert!(!supervisor.is_alive(1000));

    std::fs::remove_dir_all(&app_dir).unwrap();
}

#[test]
fn lifecycle_report_serializes_json_without_changing_text_contract() {
    let app_dir = temp_app_dir();
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
    ]);
    let supervisor = MockSupervisor::new();

    let report = status_report(&SPEC, &env, &supervisor).unwrap();
    assert_eq!(report.to_text(), "test-process status: stopped");

    let json: serde_json::Value = serde_json::from_str(&report.to_json()).unwrap();
    assert_eq!(json["process"], "test-process");
    assert_eq!(json["action"], "status");
    assert_eq!(json["status"], "stopped");
    assert_eq!(json["message"], "test-process status: stopped");

    std::fs::remove_dir_all(&app_dir).unwrap();
}

#[test]
fn status_report_preserves_state_status_in_json() {
    let app_dir = temp_app_dir();
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
    ]);
    let supervisor = MockSupervisor::new();
    let pid = supervisor
        .spawn(
            "bun",
            &["run", "test.ts"],
            &app_dir.join("logs/test.log"),
            &app_dir,
        )
        .unwrap();
    let run_dir = app_dir.join("run");
    repository::write_state(
        &run_dir,
        SPEC.state_name,
        &ProcessState {
            pid: Some(pid),
            status: "degraded".to_string(),
            log_path: app_dir.join("logs/test.log").to_string_lossy().into_owned(),
            ..ProcessState::default()
        },
    )
    .unwrap();

    let report = status_report(&SPEC, &env, &supervisor).unwrap();
    assert!(report.to_text().contains("status: degraded"));
    let json: serde_json::Value = serde_json::from_str(&report.to_json()).unwrap();
    assert_eq!(json["status"], "degraded");

    std::fs::remove_dir_all(&app_dir).unwrap();
}

#[test]
fn start_repairs_pid_file_running_state_when_state_lost_pid() {
    let app_dir = temp_app_dir();
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
    ]);
    let supervisor = MockSupervisor::new();
    let pid = supervisor
        .spawn(
            "bun",
            &["run", "test.ts"],
            &app_dir.join("logs/test.log"),
            &app_dir,
        )
        .unwrap();
    let run_dir = app_dir.join("run");
    repository::write_pid(&run_dir, SPEC.state_name, pid).unwrap();
    repository::write_state(
        &run_dir,
        SPEC.state_name,
        &ProcessState {
            pid: None,
            status: "scheduled".to_string(),
            log_path: app_dir.join("logs/test.log").to_string_lossy().into_owned(),
            ..ProcessState::default()
        },
    )
    .unwrap();

    let report = start_report(&SPEC, &env, &supervisor).unwrap();

    assert_eq!(report.status, "already_running");
    assert_eq!(report.pid, Some(pid));
    let state = repository::read_state(&run_dir, SPEC.state_name)
        .unwrap()
        .unwrap();
    assert_eq!(state.pid, Some(pid));
    assert_eq!(state.status, "running");

    std::fs::remove_dir_all(&app_dir).unwrap();
}
