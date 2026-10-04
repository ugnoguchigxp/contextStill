//! covering executor entry points; implementation is separated by responsibility.
pub(crate) mod applicability;
mod deduplication;
mod execution;
mod external_evidence;
mod external_fetch;
mod heartbeat;
mod helpers;
pub(crate) mod negative_response;
mod persistence;
pub(crate) mod positive_response;
mod provider;
pub(crate) mod source;
mod tests;
mod types;
pub(crate) use execution::{
    agent_result, capture_agent_input, execute_covering, load_claimed_covering_execution,
};
pub(crate) use heartbeat::CoveringHeartbeatGuard;
pub(crate) use persistence::persist_covering_result;
pub(crate) use types::{
    CoveringExecution, CoveringExternalSearchConfig, CoveringPersistStatus, CoveringResult,
};
