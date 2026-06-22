use std::{
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub(crate) struct DispatchConfig {
    pub(crate) project_root: PathBuf,
    pub(crate) timeout: Duration,
}

pub(crate) fn dispatch_json(
    method: &str,
    params: Value,
    config: &DispatchConfig,
) -> Result<Value, String> {
    let payload = serde_json::to_vec(&json!({ "method": method, "params": params }))
        .map_err(|error| error.to_string())?;
    let mut child = Command::new("bun")
        .args(["run", "src/cli/mcp-dispatch-once.ts"])
        .current_dir(&config.project_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;

    child
        .stdin
        .take()
        .ok_or_else(|| "failed to open MCP dispatcher stdin".to_string())?
        .write_all(&payload)
        .map_err(|error| error.to_string())?;

    let deadline = Instant::now() + config.timeout;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "MCP TypeScript dispatcher timed out after {}ms",
                config.timeout.as_millis()
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    };

    let stdout = read_pipe(child.stdout.take())?;
    let stderr = read_pipe(child.stderr.take())?;
    if !status.success() {
        let stderr_text = String::from_utf8_lossy(&stderr);
        let message = stderr_text.trim();
        if message.is_empty() {
            return Err(format!("MCP TypeScript dispatcher exited with {status}"));
        }
        return Err(message.to_string());
    }
    serde_json::from_slice::<Value>(&stdout).map_err(|error| error.to_string())
}

fn read_pipe<R: Read>(pipe: Option<R>) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    if let Some(mut pipe) = pipe {
        pipe.read_to_end(&mut output)
            .map_err(|error| error.to_string())?;
    }
    Ok(output)
}
