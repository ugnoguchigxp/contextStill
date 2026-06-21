use serde::Serialize;
use std::path::Path;

use crate::{
    domains::bootstrap::service::{resolve_paths, PathReport},
    shared::{
        config::EnvProvider,
        process::{OsSupervisor, ProcessSupervisor},
    },
};

use super::repository;

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub runtime_host: &'static str,
    pub version: &'static str,
    pub hono_admin_api: String,
    pub mcp_server: String,
    pub queue_supervisor: String,
    pub agent_log_sync: String,
    pub paths: PathReport,
}

pub fn status<E: EnvProvider>(env: &E) -> RuntimeStatus {
    let supervisor = OsSupervisor;
    status_with_supervisor(env, &supervisor)
}

pub fn status_with_supervisor<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> RuntimeStatus {
    let paths = resolve_paths(env);
    let run_dir = &paths.run_dir;

    let hono_admin_api = resolve_process_status(run_dir, "admin-api", supervisor);
    let mcp_server = resolve_process_status(run_dir, "mcp-server", supervisor);
    let queue_supervisor = resolve_process_status(run_dir, "queue-supervisor", supervisor);
    let agent_log_sync = resolve_process_status(run_dir, "agent-log-sync", supervisor);

    RuntimeStatus {
        runtime_host: "rust-skeleton",
        version: repository::runtime_version(),
        hono_admin_api,
        mcp_server,
        queue_supervisor,
        agent_log_sync,
        paths,
    }
}

fn resolve_process_status<S: ProcessSupervisor>(
    run_dir: &Path,
    name: &str,
    supervisor: &S,
) -> String {
    if let Ok(Some(state)) = repository::read_state(run_dir, name) {
        if let Some(pid) = state.pid {
            if supervisor.is_alive(pid) {
                return state.status;
            }
        }
        return "stopped".to_string();
    }

    if let Ok(Some(pid)) = repository::read_pid(run_dir, name) {
        if supervisor.is_alive(pid) {
            return "running".to_string();
        }
    }

    "stopped".to_string()
}

impl RuntimeStatus {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        [
            format!("runtimeHost={}", self.runtime_host),
            format!("version={}", self.version),
            format!("honoAdminApi={}", self.hono_admin_api),
            format!("mcpServer={}", self.mcp_server),
            format!("queueSupervisor={}", self.queue_supervisor),
            format!("agentLogSync={}", self.agent_log_sync),
            self.paths.to_text(),
        ]
        .join("\n")
    }
}
