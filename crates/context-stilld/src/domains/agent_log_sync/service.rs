use crate::domains::process_lifecycle::service::{self, LifecycleReport, ManagedProcessSpec};
use crate::shared::{config::EnvProvider, errors::CliError, process::ProcessSupervisor};
use std::time::Duration;

const AGENT_LOG_SYNC: ManagedProcessSpec = ManagedProcessSpec {
    state_name: "agent-log-sync",
    display_name: "agent-log-sync",
    command: "bun",
    args: &["run", "src/cli/sync-agent-logs.ts"],
    log_file: "agent-log-sync.log",
};

pub fn run<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    service::start(&AGENT_LOG_SYNC, env, supervisor)
}

pub fn run_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    let mut report = service::start_report(&AGENT_LOG_SYNC, env, supervisor)?;
    report.action = "run".to_string();
    Ok(report)
}

pub fn run_and_wait_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
    timeout: Duration,
) -> Result<LifecycleReport, CliError> {
    service::run_and_wait_report(&AGENT_LOG_SYNC, env, supervisor, timeout)
}

pub fn stop<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    service::stop(&AGENT_LOG_SYNC, env, supervisor)
}

pub fn stop_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::stop_report(&AGENT_LOG_SYNC, env, supervisor)
}

pub fn status<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    service::status(&AGENT_LOG_SYNC, env, supervisor)
}

pub fn status_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::status_report(&AGENT_LOG_SYNC, env, supervisor)
}
