use std::path::PathBuf;

use serde::Serialize;

use crate::domains::bootstrap::service::resolve_paths;
use crate::domains::daemon::repository::{self, ProcessState};
use crate::shared::{config::EnvProvider, errors::CliError, process::ProcessSupervisor};

#[derive(Debug, Clone)]
pub struct ManagedProcessSpec {
    pub state_name: &'static str,
    pub display_name: &'static str,
    pub command: &'static str,
    pub args: &'static [&'static str],
    pub log_file: &'static str,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleReport {
    pub process: &'static str,
    pub action: String,
    pub status: String,
    pub message: String,
    pub pid: Option<u32>,
    pub log_path: Option<String>,
}

pub fn start<E: EnvProvider, S: ProcessSupervisor>(
    spec: &ManagedProcessSpec,
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    Ok(start_report(spec, env, supervisor)?.to_text())
}

pub fn start_report<E: EnvProvider, S: ProcessSupervisor>(
    spec: &ManagedProcessSpec,
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    let paths = resolve_paths(env);
    let run_dir = &paths.run_dir;

    if let Ok(Some(state)) = repository::read_state(run_dir, spec.state_name) {
        if let Some(pid) = state.pid {
            if supervisor.is_alive(pid) {
                let message = format!("{} already running (pid={})", spec.display_name, pid);
                return Ok(LifecycleReport {
                    process: spec.state_name,
                    action: "start".to_string(),
                    status: "already_running".to_string(),
                    message,
                    pid: Some(pid),
                    log_path: Some(state.log_path),
                });
            }
        }
    }

    if let Ok(Some(pid)) = repository::read_pid(run_dir, spec.state_name) {
        if supervisor.is_alive(pid) {
            let message = format!("{} already running (pid={})", spec.display_name, pid);
            return Ok(LifecycleReport {
                process: spec.state_name,
                action: "start".to_string(),
                status: "already_running".to_string(),
                message,
                pid: Some(pid),
                log_path: Some(
                    paths
                        .logs_dir
                        .join(spec.log_file)
                        .to_string_lossy()
                        .into_owned(),
                ),
            });
        }
    }

    let project_root = resolve_project_root(env);
    let log_path = paths.logs_dir.join(spec.log_file);
    let pid = supervisor
        .spawn(spec.command, spec.args, &log_path, &project_root)
        .map_err(|e| CliError::io(format!("failed to spawn {}: {e}", spec.display_name)))?;

    let state = ProcessState {
        pid: Some(pid),
        status: "running".to_string(),
        log_path: log_path.to_string_lossy().into_owned(),
    };

    if let Err(error) = repository::write_state(run_dir, spec.state_name, &state) {
        cleanup_spawn_after_persist_failure(spec, run_dir, pid, supervisor);
        return Err(CliError::io(format!(
            "failed to write {} state: {error}",
            spec.display_name
        )));
    }

    if let Err(error) = repository::write_pid(run_dir, spec.state_name, pid) {
        cleanup_spawn_after_persist_failure(spec, run_dir, pid, supervisor);
        return Err(CliError::io(format!(
            "failed to write {} pid: {error}",
            spec.display_name
        )));
    }

    let message = format!("{} started (pid={})", spec.display_name, pid);
    Ok(LifecycleReport {
        process: spec.state_name,
        action: "start".to_string(),
        status: "started".to_string(),
        message,
        pid: Some(pid),
        log_path: Some(state.log_path),
    })
}

pub fn stop<E: EnvProvider, S: ProcessSupervisor>(
    spec: &ManagedProcessSpec,
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    Ok(stop_report(spec, env, supervisor)?.to_text())
}

pub fn stop_report<E: EnvProvider, S: ProcessSupervisor>(
    spec: &ManagedProcessSpec,
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    let paths = resolve_paths(env);
    let run_dir = &paths.run_dir;
    let state = repository::read_state(run_dir, spec.state_name)
        .ok()
        .flatten();

    let pid = match repository::read_pid(run_dir, spec.state_name) {
        Ok(Some(pid)) => Some(pid),
        _ => state.as_ref().and_then(|state| state.pid),
    };

    let Some(pid) = pid else {
        let message = format!("{} is not running", spec.display_name);
        return Ok(LifecycleReport {
            process: spec.state_name,
            action: "stop".to_string(),
            status: "not_running".to_string(),
            message,
            pid: None,
            log_path: state.map(|state| state.log_path),
        });
    };

    if supervisor.is_alive(pid) {
        supervisor
            .kill(pid, "SIGTERM")
            .map_err(|e| CliError::io(format!("failed to stop {}: {e}", spec.display_name)))?;
    }

    repository::clear_pid(run_dir, spec.state_name)
        .map_err(|e| CliError::io(format!("failed to clear {} pid: {e}", spec.display_name)))?;
    repository::clear_state(run_dir, spec.state_name)
        .map_err(|e| CliError::io(format!("failed to clear {} state: {e}", spec.display_name)))?;

    let message = format!("{} stopped", spec.display_name);
    Ok(LifecycleReport {
        process: spec.state_name,
        action: "stop".to_string(),
        status: "stopped".to_string(),
        message,
        pid: Some(pid),
        log_path: state.map(|state| state.log_path),
    })
}

pub fn status<E: EnvProvider, S: ProcessSupervisor>(
    spec: &ManagedProcessSpec,
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    Ok(status_report(spec, env, supervisor)?.to_text())
}

pub fn status_report<E: EnvProvider, S: ProcessSupervisor>(
    spec: &ManagedProcessSpec,
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    let paths = resolve_paths(env);
    let run_dir = &paths.run_dir;

    if let Ok(Some(state)) = repository::read_state(run_dir, spec.state_name) {
        if let Some(pid) = state.pid {
            if supervisor.is_alive(pid) {
                let message = format!(
                    "{} status: {} (pid={})",
                    spec.display_name, state.status, pid
                );
                return Ok(LifecycleReport {
                    process: spec.state_name,
                    action: "status".to_string(),
                    status: state.status,
                    message,
                    pid: Some(pid),
                    log_path: Some(state.log_path),
                });
            }
        }
    }

    if let Ok(Some(pid)) = repository::read_pid(run_dir, spec.state_name) {
        if supervisor.is_alive(pid) {
            let log_path = paths
                .logs_dir
                .join(spec.log_file)
                .to_string_lossy()
                .into_owned();
            let message = format!("{} status: running (pid={})", spec.display_name, pid);
            return Ok(LifecycleReport {
                process: spec.state_name,
                action: "status".to_string(),
                status: "running".to_string(),
                message,
                pid: Some(pid),
                log_path: Some(log_path),
            });
        }
    }

    let message = format!("{} status: stopped", spec.display_name);
    Ok(LifecycleReport {
        process: spec.state_name,
        action: "status".to_string(),
        status: "stopped".to_string(),
        message,
        pid: None,
        log_path: None,
    })
}

fn cleanup_spawn_after_persist_failure<S: ProcessSupervisor>(
    spec: &ManagedProcessSpec,
    run_dir: &std::path::Path,
    pid: u32,
    supervisor: &S,
) {
    if supervisor.is_alive(pid) {
        let _ = supervisor.kill(pid, "SIGTERM");
    }
    let _ = repository::clear_pid(run_dir, spec.state_name);
    let _ = repository::clear_state(run_dir, spec.state_name);
}

impl LifecycleReport {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        self.message.clone()
    }
}

fn resolve_project_root<E: EnvProvider>(env: &E) -> PathBuf {
    env.var("CONTEXT_STILL_PROJECT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::config::MapEnv;
    use crate::shared::process::MockSupervisor;
    use std::time::SystemTime;

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
        let path = std::env::temp_dir().join(format!(
            "context_still_lifecycle_{}_{}",
            std::process::id(),
            rand_num
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
            },
        )
        .unwrap();

        let report = status_report(&SPEC, &env, &supervisor).unwrap();
        assert!(report.to_text().contains("status: degraded"));
        let json: serde_json::Value = serde_json::from_str(&report.to_json()).unwrap();
        assert_eq!(json["status"], "degraded");

        std::fs::remove_dir_all(&app_dir).unwrap();
    }
}
