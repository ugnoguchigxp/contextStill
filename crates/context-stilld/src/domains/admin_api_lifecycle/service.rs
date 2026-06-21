use crate::domains::process_lifecycle::service::{self, LifecycleReport, ManagedProcessSpec};
use crate::shared::{config::EnvProvider, errors::CliError, process::ProcessSupervisor};

const ADMIN_API: ManagedProcessSpec = ManagedProcessSpec {
    state_name: "admin-api",
    display_name: "admin-api",
    command: "bun",
    args: &["run", "api/index.ts"],
    log_file: "admin-api.log",
};

pub fn start<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    service::start(&ADMIN_API, env, supervisor)
}

pub fn start_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::start_report(&ADMIN_API, env, supervisor)
}

pub fn stop<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    service::stop(&ADMIN_API, env, supervisor)
}

pub fn stop_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::stop_report(&ADMIN_API, env, supervisor)
}

pub fn status<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    service::status(&ADMIN_API, env, supervisor)
}

pub fn status_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::status_report(&ADMIN_API, env, supervisor)
}
