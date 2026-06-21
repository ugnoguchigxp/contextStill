use crate::domains::process_lifecycle::service::{self, LifecycleReport, ManagedProcessSpec};
use crate::shared::{config::EnvProvider, errors::CliError, process::ProcessSupervisor};

const MCP_SERVER: ManagedProcessSpec = ManagedProcessSpec {
    state_name: "mcp-server",
    display_name: "mcp-server",
    command: "bun",
    args: &["run", "src/index.ts"],
    log_file: "mcp.log",
};

pub fn start<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    service::start(&MCP_SERVER, env, supervisor)
}

pub fn start_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::start_report(&MCP_SERVER, env, supervisor)
}

pub fn stop<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    service::stop(&MCP_SERVER, env, supervisor)
}

pub fn stop_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::stop_report(&MCP_SERVER, env, supervisor)
}

pub fn status<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    service::status(&MCP_SERVER, env, supervisor)
}

pub fn status_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::status_report(&MCP_SERVER, env, supervisor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::config::MapEnv;
    use crate::shared::process::MockSupervisor;
    use std::time::SystemTime;

    fn temp_app_dir() -> std::path::PathBuf {
        let rand_num = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "context_still_mcp_test_{}_{}",
            std::process::id(),
            rand_num
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn test_mcp_lifecycle() {
        let app_dir = temp_app_dir();
        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
        ]);
        let supervisor = MockSupervisor::new();

        // 1. Initially stopped
        let res = status(&env, &supervisor).unwrap();
        assert_eq!(res, "mcp-server status: stopped");

        // 2. Start
        let start_res = start(&env, &supervisor).unwrap();
        assert!(start_res.contains("mcp-server started"));

        let res = status(&env, &supervisor).unwrap();
        assert!(res.contains("mcp-server status: running"));

        // 3. Stop
        let stop_res = stop(&env, &supervisor).unwrap();
        assert_eq!(stop_res, "mcp-server stopped");

        let res = status(&env, &supervisor).unwrap();
        assert_eq!(res, "mcp-server status: stopped");

        std::fs::remove_dir_all(&app_dir).unwrap();
    }
}
