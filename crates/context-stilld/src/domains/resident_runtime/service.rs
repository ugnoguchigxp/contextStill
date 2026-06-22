use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::Duration;

use serde::Serialize;

use crate::domains::{
    bootstrap::service::resolve_paths,
    daemon::repository::{self, ProcessState},
    mcp_lifecycle, process_lifecycle, queue_lifecycle,
};
use crate::shared::{config::EnvProvider, errors::CliError, process::ProcessSupervisor};

const RESIDENT_STATE_NAME: &str = "context-stilld";

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResidentRunReport {
    pub action: String,
    pub status: String,
    pub message: String,
    pub pid: u32,
    pub surfaces: Vec<ManagedSurfaceReport>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSurfaceReport {
    pub name: &'static str,
    pub enabled: bool,
    pub status: String,
    pub pid: Option<u32>,
    pub message: String,
}

#[derive(Debug, Default, Clone, Eq, PartialEq)]
struct SurfaceOwnership {
    mcp: bool,
    queue: bool,
}

impl ResidentRunReport {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        self.message.clone()
    }
}

pub fn run<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
    once: bool,
) -> Result<ResidentRunReport, CliError> {
    write_resident_state(env, "running")?;
    let mut surfaces = ensure_surfaces(env, supervisor)?;
    let mut ownership = SurfaceOwnership::from_reports(&surfaces);
    let pid = std::process::id();

    if once {
        let mut shutdown_surfaces = stop_owned_surfaces(env, supervisor, &ownership)?;
        surfaces.append(&mut shutdown_surfaces);
        write_resident_state(env, "exited")?;
        return Ok(ResidentRunReport {
            action: "run".to_string(),
            status: "exited".to_string(),
            message: "context-stilld resident supervisor completed one reconciliation pass"
                .to_string(),
            pid,
            surfaces,
        });
    }

    let running = Arc::new(AtomicBool::new(true));
    let signal_running = Arc::clone(&running);
    ctrlc::set_handler(move || {
        signal_running.store(false, Ordering::SeqCst);
    })
    .map_err(|error| CliError::io(format!("failed to install signal handler: {error}")))?;

    while running.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_secs(5));
        surfaces = ensure_surfaces(env, supervisor)?;
        ownership.merge_started(&surfaces);
    }

    let mut shutdown_surfaces = stop_owned_surfaces(env, supervisor, &ownership)?;
    surfaces.append(&mut shutdown_surfaces);
    write_resident_state(env, "stopped")?;

    Ok(ResidentRunReport {
        action: "run".to_string(),
        status: "stopped".to_string(),
        message: "context-stilld resident supervisor stopped".to_string(),
        pid,
        surfaces,
    })
}

fn ensure_surfaces<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<Vec<ManagedSurfaceReport>, CliError> {
    let mut reports = Vec::new();
    if env_flag_default(env, "CONTEXT_STILL_RESIDENT_MCP", true) {
        let report = mcp_lifecycle::service::start_report(env, supervisor)?;
        reports.push(surface_report("mcp-server", true, report));
    } else {
        reports.push(disabled_surface("mcp-server"));
    }

    if env_flag_default(env, "CONTEXT_STILL_RESIDENT_QUEUE", true) {
        let report = queue_lifecycle::service::start_report(env, supervisor)?;
        reports.push(surface_report("queue-supervisor", true, report));
    } else {
        reports.push(disabled_surface("queue-supervisor"));
    }
    Ok(reports)
}

fn stop_owned_surfaces<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
    ownership: &SurfaceOwnership,
) -> Result<Vec<ManagedSurfaceReport>, CliError> {
    let mut reports = Vec::new();
    if ownership.queue && env_flag_default(env, "CONTEXT_STILL_RESIDENT_QUEUE", true) {
        let report = queue_lifecycle::service::stop_report(env, supervisor)?;
        reports.push(surface_report("queue-supervisor", true, report));
    }
    if ownership.mcp && env_flag_default(env, "CONTEXT_STILL_RESIDENT_MCP", true) {
        let report = mcp_lifecycle::service::stop_report(env, supervisor)?;
        reports.push(surface_report("mcp-server", true, report));
    }
    Ok(reports)
}

fn surface_report(
    name: &'static str,
    enabled: bool,
    report: process_lifecycle::service::LifecycleReport,
) -> ManagedSurfaceReport {
    ManagedSurfaceReport {
        name,
        enabled,
        status: report.status,
        pid: report.pid,
        message: report.message,
    }
}

fn disabled_surface(name: &'static str) -> ManagedSurfaceReport {
    ManagedSurfaceReport {
        name,
        enabled: false,
        status: "disabled".to_string(),
        pid: None,
        message: format!("{name} disabled by resident runtime env"),
    }
}

impl SurfaceOwnership {
    fn from_reports(reports: &[ManagedSurfaceReport]) -> Self {
        let mut ownership = Self::default();
        ownership.merge_started(reports);
        ownership
    }

    fn merge_started(&mut self, reports: &[ManagedSurfaceReport]) {
        for report in reports {
            if report.status != "started" {
                continue;
            }
            match report.name {
                "mcp-server" => self.mcp = true,
                "queue-supervisor" => self.queue = true,
                _ => {}
            }
        }
    }
}

fn write_resident_state<E: EnvProvider>(env: &E, status: &str) -> Result<(), CliError> {
    let paths = resolve_paths(env);
    let now = process_lifecycle::service::now_timestamp();
    let running = status == "running";
    let state = ProcessState {
        pid: running.then_some(std::process::id()),
        status: status.to_string(),
        log_path: paths
            .logs_dir
            .join("context-stilld.log")
            .to_string_lossy()
            .into_owned(),
        started_at: Some(now.clone()),
        updated_at: Some(now),
        command: Some("context-stilld".to_string()),
        args: Some(vec!["run".to_string()]),
        ..ProcessState::default()
    };
    repository::write_state(&paths.run_dir, RESIDENT_STATE_NAME, &state).map_err(|error| {
        CliError::io(format!(
            "failed to write resident supervisor state: {error}"
        ))
    })?;
    if running {
        repository::write_pid(&paths.run_dir, RESIDENT_STATE_NAME, std::process::id()).map_err(
            |error| CliError::io(format!("failed to write resident supervisor pid: {error}")),
        )?;
    } else {
        let _ = repository::clear_pid(&paths.run_dir, RESIDENT_STATE_NAME);
    }
    Ok(())
}

fn env_flag_default<E: EnvProvider>(env: &E, key: &str, default: bool) -> bool {
    match env.var(key).as_deref() {
        Some("0") | Some("false") | Some("FALSE") | Some("no") | Some("off") => false,
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("on") => true,
        Some(_) => default,
        None => default,
    }
}
