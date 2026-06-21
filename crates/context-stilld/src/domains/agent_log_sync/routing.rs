use crate::domains::cli::routing::AgentLogSyncAction;
use crate::shared::{config::EnvProvider, errors::CliError, process::ProcessSupervisor};

pub fn handle_command<E: EnvProvider, S: ProcessSupervisor>(
    action: AgentLogSyncAction,
    json: bool,
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    let report = match action {
        AgentLogSyncAction::Run => super::service::run_report(env, supervisor)?,
        AgentLogSyncAction::Stop => super::service::stop_report(env, supervisor)?,
        AgentLogSyncAction::Status => super::service::status_report(env, supervisor)?,
    };
    if json {
        Ok(report.to_json())
    } else {
        Ok(report.to_text())
    }
}
