use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::domains::{
    agent_log_sync,
    bootstrap::service::resolve_paths,
    daemon::repository::{self, ProcessState},
    mcp_lifecycle, queue_lifecycle,
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
    queue: bool,
}

struct ResidentRuntimeState {
    owned_surfaces: SurfaceOwnership,
    mcp_endpoint: Option<mcp_lifecycle::service::InProcessMcpEndpoint>,
    queue_last_checked_at: Option<Instant>,
    agent_log_sync_last_checked_at: Option<Instant>,
}

impl ResidentRuntimeState {
    fn new<E: EnvProvider>(env: &E) -> Self {
        Self {
            owned_surfaces: SurfaceOwnership::default(),
            mcp_endpoint: None,
            queue_last_checked_at: if env_flag_default(env, "CONTEXT_STILL_QUEUE_RUN_AT_LOAD", true)
            {
                None
            } else {
                Some(Instant::now())
            },
            agent_log_sync_last_checked_at: if env_flag_default(
                env,
                "CONTEXT_STILL_AGENT_LOG_SYNC_RUN_AT_LOAD",
                false,
            ) {
                None
            } else {
                Some(Instant::now())
            },
        }
    }
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
    let mut runtime_state = ResidentRuntimeState::new(env);
    let mut surfaces = ensure_surfaces(env, supervisor, &mut runtime_state)?;
    let pid = std::process::id();

    if once {
        let mut shutdown_surfaces = stop_owned_surfaces(env, supervisor, &mut runtime_state)?;
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

    let reconcile_interval = Duration::from_secs(5);
    let mut last_reconciled_at = Instant::now();
    while running.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(250));
        if last_reconciled_at.elapsed() >= reconcile_interval {
            surfaces = ensure_surfaces(env, supervisor, &mut runtime_state)?;
            last_reconciled_at = Instant::now();
        }
    }

    let mut shutdown_surfaces = stop_owned_surfaces(env, supervisor, &mut runtime_state)?;
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
    state: &mut ResidentRuntimeState,
) -> Result<Vec<ManagedSurfaceReport>, CliError> {
    let mut reports = Vec::new();
    if !env_flag_default(env, "CONTEXT_STILL_RESIDENT_MCP", true) {
        reports.push(disabled_surface("mcp-server"));
    } else if state
        .mcp_endpoint
        .as_ref()
        .is_some_and(|endpoint| !endpoint.is_finished())
    {
        let report = mcp_lifecycle::service::status_report(env, supervisor)?;
        reports.push(surface_report("mcp-server", true, report));
    } else {
        state.mcp_endpoint = None;
        let _ = mcp_lifecycle::service::stop_report(env, supervisor);
        let (report, endpoint) = mcp_lifecycle::service::start_in_process_report(env)?;
        state.mcp_endpoint = Some(endpoint);
        reports.push(surface_report("mcp-server", true, report));
    }

    if !env_flag_default(env, "CONTEXT_STILL_RESIDENT_QUEUE", true) {
        reports.push(disabled_surface("queue-supervisor"));
    } else {
        reports.push(reconcile_queue_once(env, supervisor, state)?);
    }

    if !env_flag_default(env, "CONTEXT_STILL_RESIDENT_AGENT_LOG_SYNC", true) {
        reports.push(disabled_surface("agent-log-sync"));
    } else {
        reports.push(reconcile_agent_log_sync(env, supervisor, state)?);
    }
    state.owned_surfaces.merge_started(&reports);
    Ok(reports)
}

fn stop_owned_surfaces<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
    state: &mut ResidentRuntimeState,
) -> Result<Vec<ManagedSurfaceReport>, CliError> {
    let mut reports = Vec::new();
    if state.owned_surfaces.queue && env_flag_default(env, "CONTEXT_STILL_RESIDENT_QUEUE", true) {
        let report = queue_lifecycle::service::stop_report(env, supervisor)?;
        reports.push(surface_report("queue-supervisor", true, report));
    }
    if let Some(endpoint) = state.mcp_endpoint.take() {
        let report = mcp_lifecycle::service::stop_in_process_report(env, endpoint)?;
        reports.push(surface_report("mcp-server", true, report));
    }
    Ok(reports)
}

fn surface_report(
    name: &'static str,
    enabled: bool,
    report: crate::domains::process_lifecycle::service::LifecycleReport,
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

fn reconcile_queue_once<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
    state: &mut ResidentRuntimeState,
) -> Result<ManagedSurfaceReport, CliError> {
    let interval = Duration::from_millis(env_u64_default(
        env,
        "CONTEXT_STILL_RESIDENT_QUEUE_INTERVAL_MS",
        5_000,
    ));
    if state
        .queue_last_checked_at
        .is_some_and(|last_checked| last_checked.elapsed() < interval)
    {
        return Ok(ManagedSurfaceReport {
            name: "queue-supervisor",
            enabled: true,
            status: "scheduled".to_string(),
            pid: None,
            message: "queue-supervisor waiting for next Rust-managed one-shot tick".to_string(),
        });
    }

    state.queue_last_checked_at = Some(Instant::now());
    let maintenance = queue_lifecycle::service::run_maintenance_once_report(env)?;
    if maintenance.status != "scheduled"
        || env_flag_default(env, "CONTEXT_STILL_RESIDENT_REQUIRE_RUST_ONLY", false)
    {
        return Ok(ManagedSurfaceReport {
            name: "queue-supervisor",
            enabled: true,
            status: maintenance.status,
            pid: None,
            message: maintenance.message,
        });
    }

    let report = match queue_lifecycle::service::run_executor_once_report(
        env,
        supervisor,
        Duration::from_millis(env_u64_default(
            env,
            "CONTEXT_STILL_RESIDENT_QUEUE_TIMEOUT_MS",
            300_000,
        )),
    ) {
        Ok(report) => report,
        Err(error) => {
            return Ok(ManagedSurfaceReport {
                name: "queue-supervisor",
                enabled: true,
                status: "failed".to_string(),
                pid: None,
                message: format!("queue-supervisor TS executor fallback failed: {error}"),
            });
        }
    };
    Ok(surface_report("queue-supervisor", true, report))
}

fn reconcile_agent_log_sync<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
    state: &mut ResidentRuntimeState,
) -> Result<ManagedSurfaceReport, CliError> {
    let interval = Duration::from_secs(env_u64_default(
        env,
        "CONTEXT_STILL_AGENT_LOG_SYNC_INTERVAL_SECONDS",
        3600,
    ));
    if state
        .agent_log_sync_last_checked_at
        .is_some_and(|last_checked| last_checked.elapsed() < interval)
    {
        return Ok(ManagedSurfaceReport {
            name: "agent-log-sync",
            enabled: true,
            status: "scheduled".to_string(),
            pid: None,
            message: "agent-log-sync waiting for next scheduled run".to_string(),
        });
    }

    state.agent_log_sync_last_checked_at = Some(Instant::now());
    let report = agent_log_sync::service::run_and_wait_report(
        env,
        supervisor,
        Duration::from_millis(env_u64_default(
            env,
            "CONTEXT_STILL_AGENT_LOG_SYNC_TIMEOUT_MS",
            300_000,
        )),
    )?;
    Ok(surface_report("agent-log-sync", true, report))
}

fn env_u64_default<E: EnvProvider>(env: &E, key: &str, default: u64) -> u64 {
    env.var(key)
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

impl SurfaceOwnership {
    fn merge_started(&mut self, reports: &[ManagedSurfaceReport]) {
        for report in reports {
            if report.status != "started" {
                continue;
            }
            if report.name == "queue-supervisor" {
                self.queue = true;
            }
        }
    }
}

fn write_resident_state<E: EnvProvider>(env: &E, status: &str) -> Result<(), CliError> {
    let paths = resolve_paths(env);
    let now = crate::domains::process_lifecycle::service::now_timestamp();
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
        project_root: env.var("CONTEXT_STILL_PROJECT_ROOT"),
        sqlite_core_path: Some(paths.sqlite_core_path.to_string_lossy().into_owned()),
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
