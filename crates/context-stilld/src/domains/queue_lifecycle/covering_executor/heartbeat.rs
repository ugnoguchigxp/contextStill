use super::super::provider_execution::ProviderExecutionHeartbeatGuard;
use super::types::CoveringExecution;
use crate::shared::errors::CliError;
use std::path::Path;

pub(crate) struct CoveringHeartbeatGuard {
    _guard: ProviderExecutionHeartbeatGuard,
}
impl CoveringHeartbeatGuard {
    pub(crate) fn start(path: &Path, execution: &CoveringExecution) -> Result<Self, CliError> {
        Ok(Self {
            _guard: ProviderExecutionHeartbeatGuard::start(path, &execution.provider_lease)?,
        })
    }
}
