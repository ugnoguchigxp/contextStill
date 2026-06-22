use crate::domains::cli::routing::McpAction;
use crate::shared::{config::EnvProvider, errors::CliError, process::ProcessSupervisor};

pub fn handle_command<E: EnvProvider, S: ProcessSupervisor>(
    action: McpAction,
    json: bool,
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    match action {
        McpAction::Start => {
            let report = super::service::start_report(env, supervisor)?;
            if json {
                Ok(report.to_json())
            } else {
                Ok(report.to_text())
            }
        }
        McpAction::Stop => {
            let report = super::service::stop_report(env, supervisor)?;
            if json {
                Ok(report.to_json())
            } else {
                Ok(report.to_text())
            }
        }
        McpAction::Status => {
            let report = super::service::status_report(env, supervisor)?;
            if json {
                Ok(report.to_json())
            } else {
                Ok(report.to_text())
            }
        }
        McpAction::Endpoint => {
            let report = super::service::endpoint_report(env);
            if json {
                Ok(report.to_json())
            } else {
                Ok(report.to_text())
            }
        }
        McpAction::Sessions => {
            let report = super::service::sessions_report(env)?;
            if json {
                Ok(report.to_json())
            } else {
                Ok(report.to_text())
            }
        }
        McpAction::Smoke => {
            let report = super::service::smoke_report(env);
            if json {
                Ok(report.to_json())
            } else {
                Ok(report.to_text())
            }
        }
    }
}
