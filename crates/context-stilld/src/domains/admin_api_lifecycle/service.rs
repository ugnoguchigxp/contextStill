use std::{
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    time::{Duration, Instant},
};

use crate::domains::{
    bootstrap::service::resolve_paths,
    daemon::repository::ProcessState,
    process_lifecycle::service::{self, LifecycleReport, ManagedProcessSpec},
};
use crate::shared::{config::EnvProvider, errors::CliError, process::ProcessSupervisor};

const ADMIN_API: ManagedProcessSpec = ManagedProcessSpec {
    state_name: "admin-api",
    display_name: "admin-api",
    command: "bun",
    args: &["run", "api/index.ts"],
    log_file: "admin-api.log",
};

pub fn start<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    service::start(&ADMIN_API, env, supervisor)
}

pub fn start_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    let report = service::start_report(&ADMIN_API, env, supervisor)?;
    if !matches!(report.status.as_str(), "started" | "already_running") {
        return Ok(report);
    }
    if env.var("CONTEXT_STILL_ADMIN_API_SKIP_READINESS").as_deref() == Some("1") {
        return Ok(report);
    }

    let ready_url = readiness_url(env);
    let timeout = readiness_timeout(env);
    match wait_for_ready(&ready_url, timeout) {
        Ok(()) => Ok(report),
        Err(error) => {
            if report.status == "started" {
                if let Some(pid) = report.pid {
                    if supervisor.is_alive(pid) {
                        let _ = supervisor.kill(pid, "SIGTERM");
                    }
                }
            }
            let paths = resolve_paths(env);
            let now = service::now_timestamp();
            let state = ProcessState {
                pid: report.pid,
                status: "failed".to_string(),
                log_path: report.log_path.clone().unwrap_or_else(|| {
                    paths
                        .logs_dir
                        .join(ADMIN_API.log_file)
                        .to_string_lossy()
                        .into_owned()
                }),
                started_at: report.started_at.clone(),
                updated_at: Some(now),
                last_error: Some(format!("admin API readiness failed: {error}")),
                command: Some(ADMIN_API.command.to_string()),
                args: Some(
                    ADMIN_API
                        .args
                        .iter()
                        .map(|arg| (*arg).to_string())
                        .collect(),
                ),
                ..ProcessState::default()
            };
            service::write_process_state(&ADMIN_API, &paths.run_dir, &state)?;
            Err(CliError::runtime(format!(
                "admin API did not become ready at {ready_url}: {error}"
            )))
        }
    }
}

pub fn stop<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    service::stop(&ADMIN_API, env, supervisor)
}

pub fn stop_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::stop_report(&ADMIN_API, env, supervisor)
}

pub fn status<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    service::status(&ADMIN_API, env, supervisor)
}

pub fn status_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::status_report(&ADMIN_API, env, supervisor)
}

fn readiness_url<E: EnvProvider>(env: &E) -> String {
    if let Some(url) = env.var("CONTEXT_STILL_ADMIN_API_READY_URL") {
        return url;
    }
    let host = env
        .var("CONTEXT_STILL_ADMIN_API_HOST")
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let port = env
        .var("PORT")
        .or_else(|| env.var("CONTEXT_STILL_ADMIN_API_PORT"))
        .unwrap_or_else(|| "39170".to_string());
    format!("http://{host}:{port}/api/health/ready")
}

fn readiness_timeout<E: EnvProvider>(env: &E) -> Duration {
    env.var("CONTEXT_STILL_ADMIN_API_READY_TIMEOUT_MS")
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_millis(5_000))
}

fn wait_for_ready(url: &str, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let mut last_error = "not checked".to_string();
    while Instant::now() < deadline {
        match http_get_ok(url) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = error,
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(last_error)
}

fn http_get_ok(url: &str) -> Result<(), String> {
    let (host, port, path) = parse_http_url(url)?;
    let mut addrs = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|error| error.to_string())?;
    let addr = addrs
        .next()
        .ok_or_else(|| format!("could not resolve {host}:{port}"))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500))
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| error.to_string())?;
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| error.to_string())?;
    if response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200") {
        Ok(())
    } else {
        Err(response
            .lines()
            .next()
            .unwrap_or("non-200 response")
            .to_string())
    }
}

fn parse_http_url(url: &str) -> Result<(String, u16, String), String> {
    let without_scheme = url
        .strip_prefix("http://")
        .ok_or_else(|| "only http:// readiness URLs are supported locally".to_string())?;
    let (host_port, path) = without_scheme
        .split_once('/')
        .map(|(host_port, path)| (host_port, format!("/{path}")))
        .unwrap_or_else(|| (without_scheme, "/".to_string()));
    let (host, port) = host_port
        .rsplit_once(':')
        .ok_or_else(|| "missing readiness URL port".to_string())?;
    let port = port
        .parse::<u16>()
        .map_err(|error| format!("invalid readiness URL port: {error}"))?;
    Ok((host.to_string(), port, path))
}
