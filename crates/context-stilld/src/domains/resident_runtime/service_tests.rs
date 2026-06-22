use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use crate::domains::{mcp_lifecycle, resident_runtime};
use crate::shared::config::MapEnv;
use crate::shared::process::{MockSupervisor, ProcessSupervisor};

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
fn resident_run_once_stops_already_running_owned_mcp_surface() {
    let app_dir = temp_app_dir();
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
        ("CONTEXT_STILL_RESIDENT_QUEUE", "0"),
        ("CONTEXT_STILL_RESIDENT_AGENT_LOG_SYNC", "0"),
    ]);
    let supervisor = MockSupervisor::new();

    let preexisting = mcp_lifecycle::service::start_report(&env, &supervisor).unwrap();
    let pid = preexisting.pid.unwrap();

    let report = resident_runtime::service::run(&env, &supervisor, true).unwrap();

    assert!(report.surfaces.iter().any(|surface| {
        surface.name == "mcp-server"
            && surface.status == "already_running"
            && surface.pid == Some(pid)
    }));
    assert!(report
        .surfaces
        .iter()
        .any(|surface| surface.name == "mcp-server" && surface.status == "stopped"));
    assert!(!supervisor.is_alive(pid));

    std::fs::remove_dir_all(&app_dir).unwrap();
}
