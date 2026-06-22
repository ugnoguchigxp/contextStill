use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::domains::bootstrap::service::resolve_paths;
use crate::domains::daemon::repository::{self, ProcessState};
use crate::shared::{
    config::EnvProvider,
    errors::CliError,
    process::{ProcessSupervisor, WaitOutcome},
};

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_signal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
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

    if let Some(state) = read_reconciled_state(spec, run_dir, supervisor) {
        if let Some(pid) = state.pid {
            if supervisor.is_alive(pid) {
                let message = format!("{} already running (pid={})", spec.display_name, pid);
                return Ok(report_from_state(
                    spec,
                    "start",
                    "already_running",
                    message,
                    state,
                ));
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
                started_at: None,
                updated_at: Some(now_timestamp()),
                exit_code: None,
                exit_signal: None,
                last_error: None,
                command: Some(spec.command.to_string()),
                args: Some(args_vec(spec)),
            });
        }
    }

    let project_root = resolve_project_root(env);
    let log_path = paths.logs_dir.join(spec.log_file);
    let pid = supervisor
        .spawn(spec.command, spec.args, &log_path, &project_root)
        .map_err(|e| CliError::io(format!("failed to spawn {}: {e}", spec.display_name)))?;

    let state = running_state(spec, pid, log_path.to_string_lossy().into_owned());

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
        log_path: Some(state.log_path.clone()),
        started_at: state.started_at.clone(),
        updated_at: state.updated_at.clone(),
        exit_code: None,
        exit_signal: None,
        last_error: None,
        command: state.command.clone(),
        args: state.args.clone(),
    })
}

pub fn run_and_wait_report<E: EnvProvider, S: ProcessSupervisor>(
    spec: &ManagedProcessSpec,
    env: &E,
    supervisor: &S,
    timeout: Duration,
) -> Result<LifecycleReport, CliError> {
    let paths = resolve_paths(env);
    let run_dir = &paths.run_dir;
    let project_root = resolve_project_root(env);
    let log_path = paths.logs_dir.join(spec.log_file);
    let started_at = now_timestamp();
    let outcome = supervisor
        .run_and_wait(spec.command, spec.args, &log_path, &project_root, timeout)
        .map_err(|e| CliError::io(format!("failed to run {}: {e}", spec.display_name)))?;
    let updated_at = now_timestamp();
    let status = wait_status(&outcome);
    let last_error = wait_error(&outcome);
    let state = ProcessState {
        pid: Some(outcome.pid),
        status: status.to_string(),
        log_path: log_path.to_string_lossy().into_owned(),
        started_at: Some(started_at),
        updated_at: Some(updated_at),
        exit_code: outcome.exit_code,
        exit_signal: outcome.exit_signal,
        last_error,
        command: Some(spec.command.to_string()),
        args: Some(args_vec(spec)),
    };

    write_process_state(spec, run_dir, &state)?;
    repository::clear_pid(run_dir, spec.state_name).map_err(|e| {
        CliError::io(format!(
            "failed to clear {} pid after run: {e}",
            spec.display_name
        ))
    })?;

    let message = match status {
        "exited" => format!(
            "{} exited successfully (pid={}, exitCode=0)",
            spec.display_name, outcome.pid
        ),
        "failed" => format!(
            "{} failed (pid={}, exitCode={})",
            spec.display_name,
            outcome.pid,
            outcome
                .exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        ),
        _ => format!("{} completed with status {status}", spec.display_name),
    };

    Ok(report_from_state(spec, "run", status, message, state))
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
            log_path: state.as_ref().map(|state| state.log_path.clone()),
            started_at: state.as_ref().and_then(|state| state.started_at.clone()),
            updated_at: Some(now_timestamp()),
            exit_code: state.as_ref().and_then(|state| state.exit_code),
            exit_signal: state.as_ref().and_then(|state| state.exit_signal.clone()),
            last_error: state.as_ref().and_then(|state| state.last_error.clone()),
            command: Some(spec.command.to_string()),
            args: Some(args_vec(spec)),
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
        log_path: state.as_ref().map(|state| state.log_path.clone()),
        started_at: state.as_ref().and_then(|state| state.started_at.clone()),
        updated_at: Some(now_timestamp()),
        exit_code: state.as_ref().and_then(|state| state.exit_code),
        exit_signal: state.as_ref().and_then(|state| state.exit_signal.clone()),
        last_error: state.as_ref().and_then(|state| state.last_error.clone()),
        command: Some(spec.command.to_string()),
        args: Some(args_vec(spec)),
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

    if let Some(state) = read_reconciled_state(spec, run_dir, supervisor) {
        let message = if let Some(pid) = state.pid {
            format!(
                "{} status: {} (pid={})",
                spec.display_name, state.status, pid
            )
        } else {
            format!("{} status: {}", spec.display_name, state.status)
        };
        return Ok(report_from_state(
            spec,
            "status",
            state.status.clone(),
            message,
            state,
        ));
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
                started_at: None,
                updated_at: Some(now_timestamp()),
                exit_code: None,
                exit_signal: None,
                last_error: None,
                command: Some(spec.command.to_string()),
                args: Some(args_vec(spec)),
            });
        }
        let state = ProcessState {
            pid: Some(pid),
            status: "stale".to_string(),
            log_path: paths
                .logs_dir
                .join(spec.log_file)
                .to_string_lossy()
                .into_owned(),
            updated_at: Some(now_timestamp()),
            last_error: Some("pid file exists but process is not alive".to_string()),
            command: Some(spec.command.to_string()),
            args: Some(args_vec(spec)),
            ..ProcessState::default()
        };
        let _ = repository::write_state(run_dir, spec.state_name, &state);
        let message = format!("{} status: stale (pid={})", spec.display_name, pid);
        return Ok(report_from_state(spec, "status", "stale", message, state));
    }

    let message = format!("{} status: stopped", spec.display_name);
    Ok(LifecycleReport {
        process: spec.state_name,
        action: "status".to_string(),
        status: "stopped".to_string(),
        message,
        pid: None,
        log_path: None,
        started_at: None,
        updated_at: Some(now_timestamp()),
        exit_code: None,
        exit_signal: None,
        last_error: None,
        command: Some(spec.command.to_string()),
        args: Some(args_vec(spec)),
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

pub fn now_timestamp() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("unix-ms:{millis}")
}

fn args_vec(spec: &ManagedProcessSpec) -> Vec<String> {
    spec.args.iter().map(|arg| (*arg).to_string()).collect()
}

fn running_state(spec: &ManagedProcessSpec, pid: u32, log_path: String) -> ProcessState {
    let now = now_timestamp();
    ProcessState {
        pid: Some(pid),
        status: "running".to_string(),
        log_path,
        started_at: Some(now.clone()),
        updated_at: Some(now),
        command: Some(spec.command.to_string()),
        args: Some(args_vec(spec)),
        ..ProcessState::default()
    }
}

fn wait_status(outcome: &WaitOutcome) -> &'static str {
    if outcome.timed_out {
        return "failed";
    }
    match outcome.exit_code {
        Some(0) => "exited",
        _ => "failed",
    }
}

fn wait_error(outcome: &WaitOutcome) -> Option<String> {
    if outcome.timed_out {
        return Some("process timed out and was terminated".to_string());
    }
    match outcome.exit_code {
        Some(0) => None,
        Some(code) => Some(format!("process exited with code {code}")),
        None => outcome
            .exit_signal
            .as_ref()
            .map(|signal| format!("process exited from signal {signal}")),
    }
}

fn is_terminal_status(status: &str) -> bool {
    matches!(status, "exited" | "failed" | "stopped" | "stale")
}

fn read_reconciled_state<S: ProcessSupervisor>(
    spec: &ManagedProcessSpec,
    run_dir: &std::path::Path,
    supervisor: &S,
) -> Option<ProcessState> {
    let mut state = match repository::read_state(run_dir, spec.state_name) {
        Ok(state) => state?,
        Err(error) => {
            return Some(ProcessState {
                pid: None,
                status: "degraded".to_string(),
                log_path: String::new(),
                updated_at: Some(now_timestamp()),
                last_error: Some(format!("failed to parse state file: {error}")),
                command: Some(spec.command.to_string()),
                args: Some(args_vec(spec)),
                ..ProcessState::default()
            })
        }
    };

    if let Some(pid) = state.pid {
        if supervisor.is_alive(pid) || is_terminal_status(&state.status) {
            return Some(state);
        }
        state.status = "stale".to_string();
        state.updated_at = Some(now_timestamp());
        state.last_error = Some("recorded pid is not alive".to_string());
        let _ = repository::write_state(run_dir, spec.state_name, &state);
        return Some(state);
    }

    Some(state)
}

pub fn write_process_state(
    spec: &ManagedProcessSpec,
    run_dir: &std::path::Path,
    state: &ProcessState,
) -> Result<(), CliError> {
    repository::write_state(run_dir, spec.state_name, state)
        .map_err(|e| CliError::io(format!("failed to write {} state: {e}", spec.display_name)))
}

pub fn report_from_state(
    spec: &ManagedProcessSpec,
    action: &str,
    status: impl Into<String>,
    message: String,
    state: ProcessState,
) -> LifecycleReport {
    LifecycleReport {
        process: spec.state_name,
        action: action.to_string(),
        status: status.into(),
        message,
        pid: state.pid,
        log_path: if state.log_path.is_empty() {
            None
        } else {
            Some(state.log_path)
        },
        started_at: state.started_at,
        updated_at: state.updated_at,
        exit_code: state.exit_code,
        exit_signal: state.exit_signal,
        last_error: state.last_error,
        command: state.command.or_else(|| Some(spec.command.to_string())),
        args: state.args.or_else(|| Some(args_vec(spec))),
    }
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
}
