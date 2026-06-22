use std::{
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::Path,
    time::Duration,
};

use serde::{Deserialize, Serialize};

use crate::domains::{
    bootstrap::service::resolve_paths,
    process_lifecycle::service::{self, LifecycleReport, ManagedProcessSpec},
};
use crate::shared::{config::EnvProvider, errors::CliError, process::ProcessSupervisor};

const MCP_ENDPOINT: ManagedProcessSpec = ManagedProcessSpec {
    state_name: "mcp-server",
    display_name: "mcp-endpoint",
    command: "bun",
    args: &["run", "src/mcp/http-server.ts"],
    log_file: "mcp-endpoint.log",
};

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointReport {
    pub server: &'static str,
    pub url: String,
    pub transport: &'static str,
    pub ready: bool,
    pub auth: &'static str,
    pub active_session_count: usize,
    pub metadata_path: String,
    pub session_state_path: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSession {
    pub session_id: String,
    pub client_name: Option<String>,
    pub client_version: Option<String>,
    pub remote_address: Option<String>,
    pub created_at: String,
    pub last_activity_at: String,
    pub in_flight_request_count: u32,
    pub worker_id: Option<String>,
    pub route: String,
    pub close_reason: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsReport {
    pub sessions: Vec<McpSession>,
    pub active_session_count: usize,
    pub session_state_path: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmokeReport {
    pub ok: bool,
    pub endpoint: EndpointReport,
    pub tool_count: usize,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    ok: bool,
    tool_count: Option<usize>,
}

pub fn start<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    Ok(start_report(env, supervisor)?.to_text())
}

pub fn start_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::start_report(&MCP_ENDPOINT, env, supervisor)
}

pub fn stop<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    Ok(stop_report(env, supervisor)?.to_text())
}

pub fn stop_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::stop_report(&MCP_ENDPOINT, env, supervisor)
}

pub fn status<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    Ok(status_report(env, supervisor)?.to_text())
}

pub fn status_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::status_report(&MCP_ENDPOINT, env, supervisor)
}

pub fn endpoint_report<E: EnvProvider>(env: &E) -> EndpointReport {
    let paths = resolve_paths(env);
    let url = endpoint_url(env);
    let metadata_path = paths.run_dir.join("mcp-endpoint.json");
    let session_state_path = paths.run_dir.join("mcp-sessions.json");
    let sessions = read_sessions_file(&session_state_path).unwrap_or_default();
    let active_session_count = sessions
        .iter()
        .filter(|session| session.close_reason.is_none())
        .count();
    let health = read_health(&url).ok();
    let mut warnings = Vec::new();

    if health.as_ref().is_none_or(|health| !health.ok) {
        warnings.push("MCP endpoint is not reachable; start context-stilld managed endpoint before registering clients.".to_string());
    }

    EndpointReport {
        server: "context-still",
        url,
        transport: "streamable-http",
        ready: health.is_some_and(|health| health.ok),
        auth: "none",
        active_session_count,
        metadata_path: path_to_string(&metadata_path),
        session_state_path: path_to_string(&session_state_path),
        warnings,
    }
}

pub fn sessions_report<E: EnvProvider>(env: &E) -> Result<SessionsReport, CliError> {
    let paths = resolve_paths(env);
    let session_state_path = paths.run_dir.join("mcp-sessions.json");
    let sessions = read_sessions_file(&session_state_path)?;
    let active_session_count = sessions
        .iter()
        .filter(|session| session.close_reason.is_none())
        .count();

    Ok(SessionsReport {
        sessions,
        active_session_count,
        session_state_path: path_to_string(&session_state_path),
    })
}

pub fn smoke_report<E: EnvProvider>(env: &E) -> SmokeReport {
    let endpoint = endpoint_report(env);
    let health = read_health(&endpoint.url);
    match health {
        Ok(health) if health.ok => SmokeReport {
            ok: true,
            endpoint,
            tool_count: health.tool_count.unwrap_or(0),
            message: "MCP endpoint health check passed; tool list is available.".to_string(),
        },
        Ok(_) => SmokeReport {
            ok: false,
            endpoint,
            tool_count: 0,
            message: "MCP endpoint responded but is not ready.".to_string(),
        },
        Err(error) => SmokeReport {
            ok: false,
            endpoint,
            tool_count: 0,
            message: format!("MCP endpoint is not reachable: {error}"),
        },
    }
}

fn endpoint_url<E: EnvProvider>(env: &E) -> String {
    let host = env
        .var("CONTEXT_STILL_MCP_HOST")
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let port = env
        .var("CONTEXT_STILL_MCP_PORT")
        .unwrap_or_else(|| "39172".to_string());
    format!("http://{host}:{port}/mcp")
}

fn read_sessions_file(path: &Path) -> Result<Vec<McpSession>, CliError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(path)
        .map_err(|e| CliError::io(format!("failed to read MCP sessions: {e}")))?;
    serde_json::from_str(&content)
        .map_err(|e| CliError::io(format!("failed to parse MCP sessions: {e}")))
}

fn read_health(endpoint_url: &str) -> Result<HealthResponse, String> {
    let (host, port) = parse_http_endpoint(endpoint_url)?;
    let mut addrs = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|error| error.to_string())?;
    let addr = addrs
        .next()
        .ok_or_else(|| format!("could not resolve {host}:{port}"))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(800))
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;

    let request = format!(
        "GET /mcp/health HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| error.to_string())?;
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return Err("invalid HTTP response".to_string());
    };
    if !headers.starts_with("HTTP/1.1 200") && !headers.starts_with("HTTP/1.0 200") {
        return Err(headers
            .lines()
            .next()
            .unwrap_or("non-200 response")
            .to_string());
    }
    serde_json::from_str(body.trim()).map_err(|error| error.to_string())
}

fn parse_http_endpoint(endpoint_url: &str) -> Result<(String, u16), String> {
    let without_scheme = endpoint_url
        .strip_prefix("http://")
        .ok_or_else(|| "only http:// MCP endpoints are supported locally".to_string())?;
    let host_port = without_scheme
        .split('/')
        .next()
        .ok_or_else(|| "missing endpoint host".to_string())?;
    let (host, port) = host_port
        .rsplit_once(':')
        .ok_or_else(|| "missing endpoint port".to_string())?;
    let parsed_port = port
        .parse::<u16>()
        .map_err(|error| format!("invalid endpoint port: {error}"))?;
    Ok((host.to_string(), parsed_port))
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

impl EndpointReport {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        let mut lines = vec![
            format!("server={}", self.server),
            format!("url={}", self.url),
            format!("transport={}", self.transport),
            format!("ready={}", self.ready),
            format!("auth={}", self.auth),
            format!("activeSessionCount={}", self.active_session_count),
            format!("metadataPath={}", self.metadata_path),
            format!("sessionStatePath={}", self.session_state_path),
        ];
        lines.extend(
            self.warnings
                .iter()
                .map(|warning| format!("warning={warning}")),
        );
        lines.join("\n")
    }
}

impl SessionsReport {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        if self.sessions.is_empty() {
            return format!(
                "activeSessionCount=0\nsessionStatePath={}",
                self.session_state_path
            );
        }

        let mut lines = vec![
            format!("activeSessionCount={}", self.active_session_count),
            format!("sessionStatePath={}", self.session_state_path),
        ];
        lines.extend(self.sessions.iter().map(|session| {
            format!(
                "session={} route={} inFlight={} closeReason={}",
                session.session_id,
                session.route,
                session.in_flight_request_count,
                session
                    .close_reason
                    .clone()
                    .unwrap_or_else(|| "active".to_string())
            )
        }));
        lines.join("\n")
    }
}

impl SmokeReport {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        [
            format!("ok={}", self.ok),
            format!("url={}", self.endpoint.url),
            format!("toolCount={}", self.tool_count),
            format!("message={}", self.message),
        ]
        .join("\n")
    }
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
    fn mcp_lifecycle_spawns_http_endpoint_worker_not_stdio_server() {
        let app_dir = temp_app_dir();
        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
        ]);
        let supervisor = MockSupervisor::new();

        let start_res = start(&env, &supervisor).unwrap();
        assert!(start_res.contains("mcp-endpoint started"));

        let spawned = supervisor.spawned.lock().unwrap();
        let call = spawned.values().next().unwrap();
        assert_eq!(call.command, "bun");
        assert_eq!(call.args, vec!["run", "src/mcp/http-server.ts"]);

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn endpoint_report_uses_loopback_streamable_http_url() {
        let app_dir = temp_app_dir();
        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_MCP_PORT", "45678"),
        ]);

        let report = endpoint_report(&env);

        assert_eq!(report.url, "http://127.0.0.1:45678/mcp");
        assert_eq!(report.transport, "streamable-http");
        assert_eq!(report.auth, "none");
        assert!(!report.ready);
        assert!(report.metadata_path.ends_with("mcp-endpoint.json"));
        assert!(report.session_state_path.ends_with("mcp-sessions.json"));

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn sessions_report_reads_daemon_session_state() {
        let app_dir = temp_app_dir();
        let run_dir = app_dir.join("run");
        std::fs::create_dir_all(&run_dir).unwrap();
        let session_file = run_dir.join("mcp-sessions.json");
        std::fs::write(
            &session_file,
            r#"[{
              "sessionId": "s1",
              "clientName": "codex",
              "clientVersion": "1.0",
              "remoteAddress": "127.0.0.1",
              "createdAt": "2026-06-22T00:00:00.000Z",
              "lastActivityAt": "2026-06-22T00:01:00.000Z",
              "inFlightRequestCount": 0,
              "workerId": "typescript-mcp-worker",
              "route": "typescript-mcp-server",
              "closeReason": null
            }]"#,
        )
        .unwrap();
        let env = MapEnv::from_pairs(vec![(
            "CONTEXT_STILL_APP_DATA_DIR",
            app_dir.to_str().unwrap(),
        )]);

        let report = sessions_report(&env).unwrap();

        assert_eq!(report.active_session_count, 1);
        assert_eq!(report.sessions[0].session_id, "s1");

        std::fs::remove_dir_all(&app_dir).unwrap();
    }
}
