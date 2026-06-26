use crate::domains::cli::routing::VectorAction;
use crate::shared::{config::EnvProvider, errors::CliError};

pub fn handle_command<E: EnvProvider>(
    action: VectorAction,
    json: bool,
    env: &E,
) -> Result<String, CliError> {
    match action {
        VectorAction::Health => {
            let report = super::service::health(env);
            if json {
                Ok(report.to_json())
            } else {
                Ok(report.to_text())
            }
        }
        VectorAction::Smoke => {
            let report = super::service::smoke();
            if json {
                Ok(report.to_json())
            } else {
                Ok(report.to_text())
            }
        }
    }
}
