use crate::domains::cli::routing::AgentLogSyncAction;
use crate::shared::{config::EnvProvider, errors::CliError, process::ProcessSupervisor};
use std::time::Duration;

pub fn handle_command<E: EnvProvider, S: ProcessSupervisor>(
    action: AgentLogSyncAction,
    json: bool,
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    let report = match action {
        AgentLogSyncAction::Run { wait, timeout_ms } => {
            if wait {
                super::service::run_and_wait_report(
                    env,
                    supervisor,
                    Duration::from_millis(timeout_ms),
                )?
            } else {
                super::service::run_report(env, supervisor)?
            }
        }
        AgentLogSyncAction::BackfillCodex {
            dry_run,
            limit,
            max_bytes,
        } => {
            let report = super::service::backfill_codex_historical_report(
                env,
                super::service::CodexHistoricalBackfillOptions {
                    dry_run,
                    limit,
                    max_bytes,
                },
            )?;
            return if json {
                Ok(report.to_json())
            } else {
                Ok(report.to_text())
            };
        }
        AgentLogSyncAction::Stop => super::service::stop_report(env, supervisor)?,
        AgentLogSyncAction::Status => super::service::status_report(env, supervisor)?,
    };
    if json {
        Ok(report.to_json())
    } else {
        Ok(report.to_text())
    }
}
