//! Agent transports used by queue workers; queue ownership stays in the Rust executor.
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::blocking::Client;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

use super::episode_executor::LocalLlmTargetConfig;
use crate::shared::agent_session::{run_agent_session_chat, AgentSessionRequest};

pub(super) const QUOTA_NAMESPACE: &str = "runtime.provider-quota";
pub(super) const SPARK_MODEL: &str = "gpt-5.3-codex-spark";
const OUTPUT_LIMIT: u64 = 4_000_000;

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// Only explicit quota codes exclude a provider. Generic 429/busy is a short retry.
fn quota_retry_at(error: &str) -> Option<i64> {
    if ![
        "quota_exhausted",
        "runtime_quota_exceeded",
        "quota_exceeded",
        "usage_limit_reached",
        "Subscription quota exhausted.",
    ]
    .iter()
    .any(|code| error.contains(code))
    {
        return None;
    }
    let payload = error
        .find('{')
        .and_then(|start| serde_json::from_str::<Value>(&error[start..]).ok());
    fn timestamp(v: &Value) -> Option<i64> {
        v.get("retryAt")
            .or_else(|| v.get("resetsAt"))
            .or_else(|| v.get("reset_at"))
            .and_then(Value::as_i64)
            .or_else(|| {
                v.as_object()
                    .and_then(|o| o.values().filter_map(timestamp).max())
            })
    }
    Some(
        payload
            .as_ref()
            .and_then(timestamp)
            .or_else(|| {
                let reset = error
                    .split("Your usage window resets at ")
                    .nth(1)?
                    .split_whitespace()
                    .next()?
                    .trim_end_matches('.');
                Connection::open_in_memory()
                    .ok()?
                    .query_row("select unixepoch(?1)", [reset], |row| {
                        row.get::<_, Option<i64>>(0)
                    })
                    .ok()
                    .flatten()
            })
            .unwrap_or_else(|| now() + 300)
            .max(now() + 60),
    )
}

pub(super) fn save_quota(
    connection: &Connection,
    target: &str,
    retry_at: i64,
) -> Result<(), String> {
    connection.execute(
        "insert into settings (id, namespace, key, value) values (?1, ?2, ?3, ?4)
         on conflict(namespace,key) do update set value=excluded.value, updated_at=CURRENT_TIMESTAMP",
        params![format!("provider-quota:{target}"), QUOTA_NAMESPACE, target, json!({"retryAt":retry_at,"reason":"quota_exhausted"}).to_string()],
    ).map(|_| ()).map_err(|e| e.to_string())
}

impl LocalLlmTargetConfig {
    pub(crate) fn run_agent_chat(
        &self,
        client: &Client,
        timeout_seconds: u64,
        request: AgentSessionRequest<'_>,
    ) -> Result<String, String> {
        let result = if self.codex {
            run_codex(&request, timeout_seconds)
        } else {
            run_agent_session_chat(client, request)
        };
        if let Err(error) = &result {
            if let Some(retry_at) = quota_retry_at(error) {
                if let Some(db) = &self.quota_db {
                    let target = self.target_id.clone();
                    crate::domains::sqlite_writer::execute_for_path(
                        db,
                        "queue.provider_quota",
                        move |c| save_quota(c, &target, retry_at),
                    )?;
                }
                // Existing executor retry classifiers understand HTTP 429. The durable exclusion
                // above controls the target; the job can be reclaimed by a different provider.
                return Err(format!(
                    "local-llm HTTP 429 quota_exhausted retry_at={retry_at}: {error}"
                ));
            }
        }
        result
    }
}

fn adapter_path() -> PathBuf {
    std::env::var_os("CONTEXT_STILL_PROJECT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .join("src/cli/codex-queue-chat.ts")
}

fn run_codex(request: &AgentSessionRequest<'_>, timeout_seconds: u64) -> Result<String, String> {
    if request.model != SPARK_MODEL {
        return Err("Codex queue target must use gpt-5.3-codex-spark".into());
    }
    let timeout_seconds = timeout_seconds.clamp(1, 3600);
    let payload = json!({"model":request.model,"messages":request.messages,"maxTokens":request.max_tokens,
        "responseFormat":if request.json_response {"json"} else {"text"},"timeoutMs":timeout_seconds.clamp(1,3600)*1000});
    let bun = std::env::var_os("CONTEXT_STILL_BUN_PATH").unwrap_or_else(|| "bun".into());
    run_adapter(
        &bun,
        &adapter_path(),
        &payload,
        Duration::from_secs(timeout_seconds + 40),
    )
}

fn run_adapter(
    bun: &std::ffi::OsStr,
    script: &Path,
    payload: &Value,
    timeout: Duration,
) -> Result<String, String> {
    let mut command = Command::new(bun);
    command
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("local-llm HTTP 503 Codex adapter start failed: {e}"))?;
    let input = payload.to_string();
    let mut stdin = child
        .stdin
        .take()
        .ok_or("Codex adapter stdin unavailable")?;
    let writer = thread::spawn(move || stdin.write_all(input.as_bytes()));
    let stdout = child
        .stdout
        .take()
        .ok_or("Codex adapter stdout unavailable")?;
    let oversized = Arc::new(AtomicBool::new(false));
    let output_oversized = Arc::clone(&oversized);
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(OUTPUT_LIMIT + 1).read_to_end(&mut bytes)?;
        output_oversized.store(bytes.len() as u64 > OUTPUT_LIMIT, Ordering::Release);
        Ok::<_, std::io::Error>(bytes)
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if oversized.load(Ordering::Acquire) {
            break Err("Codex adapter response too large".to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            Ok(None) => break Err("local-llm HTTP 503 Codex adapter timed out".to_string()),
            Err(e) => break Err(format!("local-llm HTTP 503 Codex adapter wait failed: {e}")),
        }
    };
    // Also stop descendants (SDK CLI) before joining pipe readers, including on timeout.
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
    let written = writer
        .join()
        .map_err(|_| "Codex adapter input thread failed")?;
    let bytes = reader
        .join()
        .map_err(|_| "Codex adapter output thread failed")?
        .map_err(|e| e.to_string())?;
    let status = status?;
    written.map_err(|e| format!("Codex adapter input failed: {e}"))?;
    if bytes.len() as u64 > OUTPUT_LIMIT {
        return Err("Codex adapter response too large".into());
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Codex adapter returned invalid JSON")?;
    if let Some(error) = value.get("error") {
        return Err(format!("local-llm HTTP 503 Codex adapter: {error}"));
    }
    if !status.success() {
        return Err("local-llm HTTP 503 Codex adapter exited unsuccessfully".into());
    }
    if value.get("model").and_then(Value::as_str) != Some(SPARK_MODEL) {
        return Err("Codex adapter model mismatch".into());
    }
    value
        .get("content")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "Codex adapter returned no content".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_explicit_quota_excludes_target() {
        assert!(quota_retry_at("HTTP 429 busy").is_none());
        assert!(quota_retry_at("runtime_auth_required").is_none());
        assert!(quota_retry_at("turn.failed: {\"code\":\"runtime_quota_exceeded\"}").is_some());
        assert_eq!(quota_retry_at("turn.failed: Subscription quota exhausted. Your usage window resets at 2099-09-14T00:00:00Z. (rate_limit_error)"), Some(4093027200));
        let reset = now() + 3600;
        assert_eq!(
            quota_retry_at(&format!(
                "adapter: {{\"code\":\"quota_exhausted\",\"retryAt\":{reset}}}"
            )),
            Some(reset)
        );
    }
    #[cfg(unix)]
    #[test]
    fn adapter_timeout_stops_descendants_holding_pipes() {
        let directory =
            crate::domains::queue_lifecycle::test_support::temp_app_dir("adapter-timeout");
        let script = directory.join("adapter.sh");
        std::fs::write(&script, "sleep 30 &\nwait\n").unwrap();
        let start = Instant::now();
        // Large stdin also exercises cleanup of a blocked input writer.
        let result = run_adapter(
            std::ffi::OsStr::new("/bin/sh"),
            &script,
            &json!({"input":"x".repeat(1_000_000)}),
            Duration::from_millis(100),
        );
        assert!(result.unwrap_err().contains("timed out"));
        assert!(start.elapsed() < Duration::from_secs(3));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn oversized_adapter_output_is_stopped_before_request_timeout() {
        let directory =
            crate::domains::queue_lifecycle::test_support::temp_app_dir("adapter-output");
        let script = directory.join("adapter.sh");
        std::fs::write(&script, "head -c 4000001 /dev/zero\nsleep 30\n").unwrap();
        let start = Instant::now();
        let result = run_adapter(
            std::ffi::OsStr::new("/bin/sh"),
            &script,
            &json!({}),
            Duration::from_secs(10),
        );
        assert!(result.unwrap_err().contains("response too large"));
        assert!(start.elapsed() < Duration::from_secs(3));
        std::fs::remove_dir_all(directory).unwrap();
    }
}
