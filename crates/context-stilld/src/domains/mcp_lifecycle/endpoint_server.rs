use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};

use crate::{
    domains::bootstrap::service::resolve_paths,
    shared::{config::EnvProvider, errors::CliError},
    VERSION,
};

use super::dispatch::{dispatch_json, DispatchConfig};
use super::native_tools::{exposed_tool_count, handle_native_dispatch, tool_owner_inventory};
use super::service::McpSession;

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
struct EndpointConfig {
    host: String,
    port: u16,
    url: String,
}

#[derive(Debug)]
struct HttpRequest {
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    body: String,
}

#[derive(Debug)]
struct ServerState {
    sessions: Vec<McpSession>,
    sessions_path: std::path::PathBuf,
}

pub fn serve<E: EnvProvider>(env: &E) -> Result<(), CliError> {
    let paths = resolve_paths(env);
    let endpoint = endpoint_config(env)?;
    let dispatch = Arc::new(dispatch_config(env));
    std::fs::create_dir_all(&paths.run_dir)
        .map_err(|error| CliError::io(format!("failed to create MCP run dir: {error}")))?;

    let endpoint_path = paths.run_dir.join("mcp-endpoint.json");
    let sessions_path = paths.run_dir.join("mcp-sessions.json");
    let state = Arc::new(Mutex::new(ServerState {
        sessions: Vec::new(),
        sessions_path: sessions_path.clone(),
    }));
    persist_sessions(&state)?;
    persist_endpoint(&endpoint_path, &endpoint, &sessions_path)?;

    let listener = TcpListener::bind((endpoint.host.as_str(), endpoint.port))
        .map_err(|error| CliError::io(format!("failed to bind MCP endpoint: {error}")))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| CliError::io(format!("failed to configure MCP listener: {error}")))?;

    let running = Arc::new(AtomicBool::new(true));
    let signal_running = Arc::clone(&running);
    ctrlc::set_handler(move || {
        signal_running.store(false, Ordering::SeqCst);
    })
    .map_err(|error| CliError::io(format!("failed to install MCP signal handler: {error}")))?;

    while running.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let state = Arc::clone(&state);
                let dispatch = Arc::clone(&dispatch);
                thread::spawn(move || {
                    let _ = handle_stream(stream, state, dispatch);
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => return Err(CliError::io(format!("MCP listener failed: {error}"))),
        }
    }

    let _ = std::fs::remove_file(endpoint_path);
    Ok(())
}

fn dispatch_config<E: EnvProvider>(env: &E) -> DispatchConfig {
    DispatchConfig {
        project_root: env
            .var("CONTEXT_STILL_PROJECT_ROOT")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
            }),
        timeout: Duration::from_millis(env_u64_default(
            env,
            "CONTEXT_STILL_MCP_DISPATCH_TIMEOUT_MS",
            300_000,
        )),
    }
}

fn env_u64_default<E: EnvProvider>(env: &E, key: &str, default: u64) -> u64 {
    env.var(key)
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn endpoint_config<E: EnvProvider>(env: &E) -> Result<EndpointConfig, CliError> {
    let host = env
        .var("CONTEXT_STILL_MCP_HOST")
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let port = env
        .var("CONTEXT_STILL_MCP_PORT")
        .unwrap_or_else(|| "39172".to_string())
        .parse::<u16>()
        .map_err(|error| CliError::invalid_arguments(format!("invalid MCP port: {error}")))?;
    Ok(EndpointConfig {
        url: format!("http://{host}:{port}/mcp"),
        host,
        port,
    })
}

fn persist_endpoint(
    path: &std::path::Path,
    endpoint: &EndpointConfig,
    sessions_path: &std::path::Path,
) -> Result<(), CliError> {
    let value = json!({
        "server": "context-still",
        "url": endpoint.url,
        "transport": "streamable-http",
        "auth": "none",
        "pid": std::process::id(),
        "workerId": format!("rust-mcp-worker-{}", std::process::id()),
        "startedAt": now_timestamp(),
        "sessionStatePath": sessions_path.to_string_lossy(),
    });
    std::fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(&value).unwrap()),
    )
    .map_err(|error| CliError::io(format!("failed to write MCP endpoint metadata: {error}")))
}

fn persist_sessions(state: &Arc<Mutex<ServerState>>) -> Result<(), CliError> {
    let state = state.lock().unwrap();
    let content = serde_json::to_string_pretty(&state.sessions)
        .map_err(|error| CliError::io(format!("failed to serialize MCP sessions: {error}")))?;
    std::fs::write(&state.sessions_path, format!("{content}\n"))
        .map_err(|error| CliError::io(format!("failed to write MCP sessions: {error}")))
}

fn handle_stream(
    mut stream: TcpStream,
    state: Arc<Mutex<ServerState>>,
    dispatch: Arc<DispatchConfig>,
) -> Result<(), CliError> {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| CliError::io(format!("failed to set MCP read timeout: {error}")))?;
    let request = read_request(&mut stream)?;
    let response = handle_request(request, state, dispatch);
    stream
        .write_all(response.as_bytes())
        .map_err(|error| CliError::io(format!("failed to write MCP response: {error}")))?;
    Ok(())
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, CliError> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 1024];
    let header_end;
    loop {
        let read = stream
            .read(&mut chunk)
            .map_err(|error| CliError::io(format!("failed to read MCP request: {error}")))?;
        if read == 0 {
            return Err(CliError::io("empty MCP request"));
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(index) = find_header_end(&buffer) {
            header_end = index;
            break;
        }
        if buffer.len() > 128 * 1024 {
            return Err(CliError::invalid_arguments(
                "MCP request headers are too large",
            ));
        }
    }

    let header_text = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut lines = header_text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| CliError::invalid_arguments("missing request line"))?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let mut headers = BTreeMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let body_start = header_end + 4;
    while buffer.len().saturating_sub(body_start) < content_length {
        let read = stream
            .read(&mut chunk)
            .map_err(|error| CliError::io(format!("failed to read MCP request body: {error}")))?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    let body = String::from_utf8_lossy(
        &buffer[body_start..std::cmp::min(buffer.len(), body_start + content_length)],
    )
    .to_string();

    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn handle_request(
    request: HttpRequest,
    state: Arc<Mutex<ServerState>>,
    dispatch: Arc<DispatchConfig>,
) -> String {
    if request.path == "/mcp/health" && request.method == "GET" {
        let active_session_count = active_session_count(&state);
        let tool_count = exposed_tool_count();
        let tool_owners = tool_owner_inventory();
        return json_response(
            200,
            json!({
                "ok": true,
                "server": "context-still",
                "transport": "streamable-http",
                "toolCount": tool_count,
                "toolOwners": tool_owners,
                "activeSessionCount": active_session_count,
            }),
            &[],
        );
    }

    if request.path != "/mcp" {
        return json_response(404, json!({ "ok": false, "error": "not_found" }), &[]);
    }

    match request.method.as_str() {
        "POST" => handle_mcp_post(request, state, dispatch),
        "GET" => json_response(
            405,
            json!({
                "jsonrpc": "2.0",
                "error": { "code": -32000, "message": "Method not allowed without an active session" },
                "id": null,
            }),
            &[("Allow", "POST, DELETE".to_string())],
        ),
        "DELETE" => handle_mcp_delete(request, state),
        _ => json_response(
            405,
            json!({ "ok": false, "error": "method_not_allowed" }),
            &[("Allow", "GET, POST, DELETE".to_string())],
        ),
    }
}

fn handle_mcp_post(
    request: HttpRequest,
    state: Arc<Mutex<ServerState>>,
    dispatch: Arc<DispatchConfig>,
) -> String {
    let body = match serde_json::from_str::<Value>(&request.body) {
        Ok(body) => body,
        Err(error) => return rpc_error(400, None, -32700, &format!("Parse error: {error}")),
    };
    let id = body.get("id").cloned();
    let method = body
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    if method == "initialize" {
        let session_id = create_session(&state, &body, None);
        let result = json!({
            "protocolVersion": body
                .get("params")
                .and_then(|params| params.get("protocolVersion"))
                .cloned()
                .unwrap_or_else(|| json!("2024-11-05")),
            "capabilities": { "tools": {}, "resources": {} },
            "serverInfo": { "name": "context-still", "version": VERSION },
        });
        return rpc_response_with_headers(200, id, result, &[("Mcp-Session-Id", session_id)]);
    }

    if id.is_none() {
        return empty_response(202);
    }

    let Some(session_id) = session_id(&request) else {
        return rpc_error(
            400,
            id,
            -32000,
            "Bad Request: initialize is required before session requests",
        );
    };
    if !is_active_session(&state, &session_id) {
        return rpc_error(
            404,
            id,
            -32000,
            "MCP session is not active; initialize a new session",
        );
    }

    touch_session(&state, &session_id, 1);
    let result = match method.as_str() {
        "tools/list" => Ok(
            handle_native_dispatch("tools/list", &json!({})).unwrap_or_else(|| {
                json!({
                    "tools": []
                })
            }),
        ),
        "tools/call" => {
            let params = body.get("params").cloned().unwrap_or_else(|| json!({}));
            handle_native_dispatch("tools/call", &params)
                .map(Ok)
                .unwrap_or_else(|| dispatch_json(&method, params, &dispatch))
        }
        "resources/list" => dispatch_json(&method, json!({}), &dispatch),
        "resources/read" => dispatch_json(
            &method,
            body.get("params").cloned().unwrap_or_else(|| json!({})),
            &dispatch,
        ),
        _ => Ok(json!({
            "content": [{ "type": "text", "text": format!("[TOOL_ERROR] Unknown MCP method: {method}") }],
            "isError": true,
        })),
    };
    touch_session(&state, &session_id, -1);

    match result {
        Ok(result) => rpc_response(200, id, result),
        Err(error) => rpc_error(500, id, -32603, &error),
    }
}

fn handle_mcp_delete(request: HttpRequest, state: Arc<Mutex<ServerState>>) -> String {
    let Some(session_id) = session_id(&request) else {
        return rpc_error(404, None, -32000, "MCP session not found");
    };
    let mut state_guard = state.lock().unwrap();
    let Some(session) = state_guard
        .sessions
        .iter_mut()
        .find(|session| session.session_id == session_id && session.close_reason.is_none())
    else {
        return rpc_error(404, None, -32000, "MCP session not found");
    };
    session.close_reason = Some("client_disconnect".to_string());
    session.last_activity_at = now_timestamp();
    session.in_flight_request_count = 0;
    drop(state_guard);
    let _ = persist_sessions(&state);
    json_response(200, json!({ "ok": true, "sessionId": session_id }), &[])
}

fn create_session(state: &Arc<Mutex<ServerState>>, body: &Value, remote: Option<String>) -> String {
    let session_id = format!(
        "rust-mcp-{}-{}",
        std::process::id(),
        NEXT_SESSION_ID.fetch_add(1, Ordering::SeqCst)
    );
    let now = now_timestamp();
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
        in_flight_request_count: 0,
        worker_id: Some(format!("rust-mcp-worker-{}", std::process::id())),
        route: "rust-mcp-server".to_string(),
        close_reason: None,
    };
    state.lock().unwrap().sessions.push(session);
    let _ = persist_sessions(state);
    session_id
}

fn active_session_count(state: &Arc<Mutex<ServerState>>) -> usize {
    state
        .lock()
        .unwrap()
        .sessions
        .iter()
        .filter(|session| session.close_reason.is_none())
        .count()
}

fn is_active_session(state: &Arc<Mutex<ServerState>>, session_id: &str) -> bool {
    state
        .lock()
        .unwrap()
        .sessions
        .iter()
        .any(|session| session.session_id == session_id && session.close_reason.is_none())
}

fn touch_session(state: &Arc<Mutex<ServerState>>, session_id: &str, delta: i32) {
    if let Some(session) = state
        .lock()
        .unwrap()
        .sessions
        .iter_mut()
        .find(|session| session.session_id == session_id)
    {
        session.last_activity_at = now_timestamp();
        session.in_flight_request_count =
            (session.in_flight_request_count as i32 + delta).max(0) as u32;
    }
    let _ = persist_sessions(state);
}

fn session_id(request: &HttpRequest) -> Option<String> {
    request
        .headers
        .get("mcp-session-id")
        .filter(|value| !value.trim().is_empty())
        .cloned()
}

fn rpc_response(status: u16, id: Option<Value>, result: Value) -> String {
    rpc_response_with_headers(status, id, result, &[])
}

fn rpc_response_with_headers(
    status: u16,
    id: Option<Value>,
    result: Value,
    headers: &[(&str, String)],
) -> String {
    json_response(
        status,
        json!({ "jsonrpc": "2.0", "id": id.unwrap_or(Value::Null), "result": result }),
        headers,
    )
}

fn rpc_error(status: u16, id: Option<Value>, code: i64, message: &str) -> String {
    json_response(
        status,
        json!({
            "jsonrpc": "2.0",
            "id": id.unwrap_or(Value::Null),
            "error": { "code": code, "message": message },
        }),
        &[],
    )
}

fn json_response(status: u16, value: Value, headers: &[(&str, String)]) -> String {
    let body = value.to_string();
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let mut response = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncache-control: no-store\r\ncontent-length: {}\r\nconnection: close\r\n",
        body.len()
    );
    for (name, value) in headers {
        response.push_str(&format!("{name}: {value}\r\n"));
    }
    response.push_str("\r\n");
    response.push_str(&body);
    response
}

fn empty_response(status: u16) -> String {
    let reason = if status == 202 { "Accepted" } else { "OK" };
    format!("HTTP/1.1 {status} {reason}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
}

fn now_timestamp() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("unix-ms:{millis}")
}
