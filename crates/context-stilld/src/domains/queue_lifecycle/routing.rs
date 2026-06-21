use crate::domains::cli::routing::QueueAction;
use crate::shared::{config::EnvProvider, errors::CliError, process::ProcessSupervisor};

pub fn handle_command<E: EnvProvider, S: ProcessSupervisor>(
    action: QueueAction,
    json: bool,
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    let report = match action {
        QueueAction::Start => super::service::start_report(env, supervisor)?,
        QueueAction::Stop => super::service::stop_report(env, supervisor)?,
        QueueAction::Status => super::service::status_report(env, supervisor)?,
    };
    if json {
        Ok(report.to_json())
    } else {
        Ok(report.to_text())
    }
}
