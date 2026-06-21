use crate::domains::cli::routing::AdminApiAction;
use crate::shared::{config::EnvProvider, errors::CliError, process::ProcessSupervisor};

pub fn handle_command<E: EnvProvider, S: ProcessSupervisor>(
    action: AdminApiAction,
    json: bool,
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    let report = match action {
        AdminApiAction::Start => super::service::start_report(env, supervisor)?,
        AdminApiAction::Stop => super::service::stop_report(env, supervisor)?,
        AdminApiAction::Status => super::service::status_report(env, supervisor)?,
    };
    if json {
        Ok(report.to_json())
    } else {
        Ok(report.to_text())
    }
}
