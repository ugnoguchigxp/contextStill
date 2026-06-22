use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};

use crate::shared::{config::EnvProvider, errors::CliError};

use super::service::McpSession;

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(0);

pub(crate) type SharedServerState = Arc<Mutex<ServerState>>;

#[derive(Debug, Clone)]
pub(crate) struct SessionPruneConfig {
    idle_ttl_seconds: u64,
    closed_ttl_seconds: u64,
    prune_interval_seconds: u64,
}

impl SessionPruneConfig {
    pub(crate) fn from_env<E: EnvProvider>(env: &E) -> Self {
        Self {
            idle_ttl_seconds: env_u64_default(
                env,
                "CONTEXT_STILL_MCP_SESSION_IDLE_TTL_SECONDS",
                60,
            ),
            closed_ttl_seconds: env_u64_default(
                env,
                "CONTEXT_STILL_MCP_CLOSED_SESSION_TTL_SECONDS",
                0,
            ),
            prune_interval_seconds: env_u64_default(
                env,
                "CONTEXT_STILL_MCP_SESSION_PRUNE_INTERVAL_SECONDS",
                10,
            ),
        }
    }
}

#[derive(Debug)]
pub(crate) struct ServerState {
    sessions: Vec<McpSession>,
    sessions_path: PathBuf,
    prune_config: SessionPruneConfig,
    last_pruned_unix_seconds: u64,
}

pub(crate) fn new_state(
    sessions_path: PathBuf,
    prune_config: SessionPruneConfig,
) -> SharedServerState {
    Arc::new(Mutex::new(ServerState {
        sessions: Vec::new(),
        sessions_path,
        prune_config,
        last_pruned_unix_seconds: 0,
    }))
}

pub(crate) fn persist_sessions(state: &SharedServerState) -> Result<(), CliError> {
    let state = state.lock().unwrap();
    let content = serde_json::to_string_pretty(&state.sessions)
        .map_err(|error| CliError::io(format!("failed to serialize MCP sessions: {error}")))?;
    std::fs::write(&state.sessions_path, format!("{content}\n"))
        .map_err(|error| CliError::io(format!("failed to write MCP sessions: {error}")))
}

pub(crate) fn create_session(
    state: &SharedServerState,
    body: &Value,
    remote: Option<String>,
) -> String {
    prune_sessions(state, false);
    let session_id = format!(
        "rust-mcp-{}-{}",
        std::process::id(),
        NEXT_SESSION_ID.fetch_add(1, Ordering::SeqCst)
    );
    let now = now_timestamp();
    let now_unix = now_unix_seconds();
    let client_info = body
        .get("params")
        .and_then(|params| params.get("clientInfo"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let session = McpSession {
        session_id: session_id.clone(),
        client_name: client_info
            .get("name")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        client_version: client_info
            .get("version")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        remote_address: remote,
        created_at: now.clone(),
        last_activity_at: now,
        last_activity_unix_seconds: Some(now_unix),
        in_flight_request_count: 0,
        worker_id: Some(format!("rust-mcp-worker-{}", std::process::id())),
        route: "rust-mcp-server".to_string(),
        close_reason: None,
    };
    state.lock().unwrap().sessions.push(session);
    let _ = persist_sessions(state);
    session_id
}

pub(crate) fn active_session_count(state: &SharedServerState) -> usize {
    state
        .lock()
        .unwrap()
        .sessions
        .iter()
        .filter(|session| session.close_reason.is_none())
        .count()
}

pub(crate) fn is_active_session(state: &SharedServerState, session_id: &str) -> bool {
    prune_sessions(state, false);
    state
        .lock()
        .unwrap()
        .sessions
        .iter()
        .any(|session| session.session_id == session_id && session.close_reason.is_none())
}

pub(crate) fn touch_session(state: &SharedServerState, session_id: &str, delta: i32) {
    let now = now_timestamp();
    let now_unix = now_unix_seconds();
    if let Some(session) = state
        .lock()
        .unwrap()
        .sessions
        .iter_mut()
        .find(|session| session.session_id == session_id)
    {
        session.last_activity_at = now;
        session.last_activity_unix_seconds = Some(now_unix);
        session.in_flight_request_count =
            (session.in_flight_request_count as i32 + delta).max(0) as u32;
    }
    let _ = persist_sessions(state);
}

pub(crate) fn close_session(state: &SharedServerState, session_id: &str) -> bool {
    let now = now_timestamp();
    let now_unix = now_unix_seconds();
    let mut state_guard = state.lock().unwrap();
    let Some(session) = state_guard
        .sessions
        .iter_mut()
        .find(|session| session.session_id == session_id && session.close_reason.is_none())
    else {
        return false;
    };
    session.close_reason = Some("client_disconnect".to_string());
    session.last_activity_at = now;
    session.last_activity_unix_seconds = Some(now_unix);
    session.in_flight_request_count = 0;
    drop(state_guard);
    let _ = persist_sessions(state);
    true
}

pub(crate) fn prune_sessions(state: &SharedServerState, force: bool) {
    let now = now_unix_seconds();
    let mut state_guard = state.lock().unwrap();
    if !force
        && state_guard.last_pruned_unix_seconds > 0
        && now.saturating_sub(state_guard.last_pruned_unix_seconds)
            < state_guard.prune_config.prune_interval_seconds
    {
        return;
    }

    state_guard.last_pruned_unix_seconds = now;
    let before = state_guard.sessions.len();
    let config = state_guard.prune_config.clone();
    state_guard.sessions.retain(|session| {
        let age = now.saturating_sub(session.last_activity_unix_seconds.unwrap_or(now));
        if session.close_reason.is_some() {
            return config.closed_ttl_seconds > 0 && age <= config.closed_ttl_seconds;
        }
        session.in_flight_request_count > 0 || age <= config.idle_ttl_seconds
    });
    let changed = state_guard.sessions.len() != before;
    drop(state_guard);

    if changed {
        let _ = persist_sessions(state);
    }
}

pub(crate) fn now_timestamp() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("unix-ms:{millis}")
}

fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn env_u64_default<E: EnvProvider>(env: &E, key: &str, default: u64) -> u64 {
    env.var(key)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    fn temp_sessions_path() -> PathBuf {
        let temp_id = NEXT_TEMP_ID.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "context_still_mcp_sessions_{}_{}.json",
            std::process::id(),
            temp_id
        ))
    }

    fn prune_config() -> SessionPruneConfig {
        SessionPruneConfig {
            idle_ttl_seconds: 1,
            closed_ttl_seconds: 0,
            prune_interval_seconds: 30,
        }
    }

    #[test]
    fn closed_sessions_are_pruned_immediately_by_default() {
        let sessions_path = temp_sessions_path();
        let state = new_state(sessions_path.clone(), prune_config());
        let session_id = create_session(&state, &json!({}), None);

        assert!(close_session(&state, &session_id));
        prune_sessions(&state, true);

        assert_eq!(active_session_count(&state), 0);
        assert!(state.lock().unwrap().sessions.is_empty());
        let _ = std::fs::remove_file(sessions_path);
    }

    #[test]
    fn idle_sessions_are_pruned_after_ttl() {
        let sessions_path = temp_sessions_path();
        let state = new_state(sessions_path.clone(), prune_config());
        let session_id = create_session(&state, &json!({}), None);
        {
            let mut state_guard = state.lock().unwrap();
            let session = state_guard
                .sessions
                .iter_mut()
                .find(|session| session.session_id == session_id)
                .unwrap();
            session.last_activity_unix_seconds = Some(1);
        }

        prune_sessions(&state, true);

        assert_eq!(active_session_count(&state), 0);
        assert!(state.lock().unwrap().sessions.is_empty());
        let _ = std::fs::remove_file(sessions_path);
    }
}
