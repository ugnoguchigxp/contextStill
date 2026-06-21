use crate::domains::process_lifecycle::service::{self, LifecycleReport, ManagedProcessSpec};
use crate::shared::{config::EnvProvider, errors::CliError, process::ProcessSupervisor};

const QUEUE_SUPERVISOR: ManagedProcessSpec = ManagedProcessSpec {
    state_name: "queue-supervisor",
    display_name: "queue-supervisor",
    command: "bun",
    args: &[
        "run",
        "src/cli/queue-supervisor.ts",
        "--continuous",
        "--limit",
        "1",
    ],
    log_file: "queue-supervisor.log",
};

pub fn start<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    service::start(&QUEUE_SUPERVISOR, env, supervisor)
}

pub fn start_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::start_report(&QUEUE_SUPERVISOR, env, supervisor)
}

pub fn stop<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    service::stop(&QUEUE_SUPERVISOR, env, supervisor)
}

pub fn stop_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::stop_report(&QUEUE_SUPERVISOR, env, supervisor)
}

pub fn status<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    service::status(&QUEUE_SUPERVISOR, env, supervisor)
}

pub fn status_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::status_report(&QUEUE_SUPERVISOR, env, supervisor)
}
