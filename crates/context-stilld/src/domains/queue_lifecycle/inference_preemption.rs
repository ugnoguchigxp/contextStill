use std::fmt;

use reqwest::header::{HeaderMap, RETRY_AFTER};
use serde::Serialize;
use serde_json::{json, Value};

pub(super) const PREEMPTION_OUTCOME: &str = "inference_preempted";
pub(super) const PREEMPTION_EVENT: &str = "contextstill_inference_preempted";
pub(super) const PREEMPTION_REASON: &str = "higher_priority_foreground_task";
pub(super) const PREEMPTION_UI_MESSAGE: &str =
    "優先タスクの実行により一時停止しました。リソース解放後に自動再開します。";
pub(super) const PROVIDER_UNREACHABLE_OUTCOME: &str = "provider_unreachable";
pub(super) const PROVIDER_UNREACHABLE_EVENT: &str = "contextstill_provider_unreachable";
pub(super) const PROVIDER_UNREACHABLE_REASON: &str = "provider_unreachable";
pub(super) const PROVIDER_UNREACHABLE_UI_MESSAGE: &str =
    "処理プロバイダーに接続できないため一時停止しました。接続回復後に自動再開します。";
const DEFAULT_RETRY_AFTER_MS: u64 = 1_000;
const MAX_RETRY_AFTER_MS: u64 = 30_000;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(super) enum InferencePauseKind {
    ForegroundPreempted,
    ProviderUnreachable,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(super) struct InferencePreemption {
    pub(super) kind: InferencePauseKind,
    pub(super) retry_after_floor_ms: u64,
    pub(super) message: Option<String>,
}

impl InferencePreemption {
    pub(super) fn outcome(&self) -> &'static str {
        match self.kind {
            InferencePauseKind::ForegroundPreempted => PREEMPTION_OUTCOME,
            InferencePauseKind::ProviderUnreachable => PROVIDER_UNREACHABLE_OUTCOME,
        }
    }

    pub(super) fn event(&self) -> &'static str {
        match self.kind {
            InferencePauseKind::ForegroundPreempted => PREEMPTION_EVENT,
            InferencePauseKind::ProviderUnreachable => PROVIDER_UNREACHABLE_EVENT,
        }
    }

    pub(super) fn reason(&self) -> &'static str {
        match self.kind {
            InferencePauseKind::ForegroundPreempted => PREEMPTION_REASON,
            InferencePauseKind::ProviderUnreachable => PROVIDER_UNREACHABLE_REASON,
        }
    }

    pub(super) fn release_reason(&self) -> &'static str {
        match self.kind {
            InferencePauseKind::ForegroundPreempted => "foreground_preempted",
            InferencePauseKind::ProviderUnreachable => PROVIDER_UNREACHABLE_REASON,
        }
    }

    pub(super) fn ui_message(&self) -> &'static str {
        match self.kind {
            InferencePauseKind::ForegroundPreempted => PREEMPTION_UI_MESSAGE,
            InferencePauseKind::ProviderUnreachable => PROVIDER_UNREACHABLE_UI_MESSAGE,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(super) enum InferenceRequestError {
    Preempted(InferencePreemption),
    Other(String),
}

impl fmt::Display for InferenceRequestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Preempted(_) => formatter.write_str("LARM foreground inference preempted"),
            Self::Other(message) => formatter.write_str(message),
        }
    }
}

impl From<String> for InferenceRequestError {
    fn from(value: String) -> Self {
        Self::Other(value)
    }
}

impl From<&str> for InferenceRequestError {
    fn from(value: &str) -> Self {
        Self::Other(value.to_string())
    }
}

pub(super) fn classify_larm_foreground_preemption(
    target_id: &str,
    status: u16,
    headers: &HeaderMap,
    body: &str,
) -> Option<InferencePreemption> {
    if !target_id.starts_with("larm-agent-connection:") || status != 409 {
        return None;
    }
    let payload: Value = serde_json::from_str(body).ok()?;
    if payload.pointer("/error/code").and_then(Value::as_str) != Some("foreground_preempted") {
        return None;
    }
    let retry_after_floor_ms = headers
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|seconds| *seconds > 0)
        .and_then(|seconds| seconds.checked_mul(1_000))
        .unwrap_or(DEFAULT_RETRY_AFTER_MS)
        .clamp(DEFAULT_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS);
    let message = payload
        .pointer("/error/message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .map(|message| message.chars().take(500).collect());
    Some(InferencePreemption {
        kind: InferencePauseKind::ForegroundPreempted,
        retry_after_floor_ms,
        message,
    })
}

pub(super) fn classify_larm_provider_unreachable(
    target_id: &str,
    error: &reqwest::Error,
) -> Option<InferencePreemption> {
    if !target_id.starts_with("larm-agent-connection:") || !error.is_connect() {
        return None;
    }
    Some(InferencePreemption {
        kind: InferencePauseKind::ProviderUnreachable,
        retry_after_floor_ms: DEFAULT_RETRY_AFTER_MS,
        message: Some(error.to_string().chars().take(500).collect()),
    })
}

pub(super) fn classify_larm_provider_unreachable_message(
    target_id: &str,
    error: &str,
) -> Option<InferencePreemption> {
    let lower = error.to_ascii_lowercase();
    if !target_id.starts_with("larm-agent-connection:") || !lower.contains("connect=true") {
        return None;
    }
    Some(InferencePreemption {
        kind: InferencePauseKind::ProviderUnreachable,
        retry_after_floor_ms: DEFAULT_RETRY_AFTER_MS,
        message: Some(error.chars().take(500).collect()),
    })
}

pub(super) fn preemption_count(metadata: &Value) -> u64 {
    metadata
        .pointer("/inferencePreemption/count")
        .and_then(|value| value.as_u64().or_else(|| value.as_i64()?.try_into().ok()))
        .unwrap_or(0)
}

pub(super) fn preemption_retry_delay_ms(
    prior_preemption_count: u64,
    retry_after_floor_ms: u64,
    jitter_sample: u64,
) -> u64 {
    let floor = retry_after_floor_ms.clamp(DEFAULT_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS);
    let exponent = prior_preemption_count.min(5) as u32;
    let exponential_ceiling = DEFAULT_RETRY_AFTER_MS
        .saturating_mul(1_u64 << exponent)
        .min(MAX_RETRY_AFTER_MS);
    let ceiling = floor.max(exponential_ceiling).min(MAX_RETRY_AFTER_MS);
    if ceiling == floor {
        return floor;
    }
    floor + jitter_sample % (ceiling - floor + 1)
}

pub(super) fn random_jitter_sample() -> u64 {
    let mut bytes = [0_u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        return 0;
    }
    u64::from_le_bytes(bytes)
}

pub(super) fn preemption_metadata(
    pause: &InferencePreemption,
    prior_preemption_count: u64,
    retry_after_ms: u64,
    preempted_at: &str,
    message: Option<&str>,
) -> Value {
    json!({
        "inferencePreemption": {
            "event": pause.event(),
            "reason": pause.reason(),
            "count": prior_preemption_count.saturating_add(1),
            "retryAfterMs": retry_after_ms,
            "preemptedAt": preempted_at,
            "message": message,
            "uiMessage": pause.ui_message()
        }
    })
}

pub(super) fn log_preemption(
    pause: &InferencePreemption,
    task_id: &str,
    attempt: u64,
    retry_after_ms: u64,
) {
    eprintln!(
        "{}",
        json!({
            "level": "info",
            "event": pause.event(),
            "reason": pause.reason(),
            "taskId": task_id,
            "attempt": attempt,
            "retryAfterMs": retry_after_ms
        })
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    #[test]
    fn classification_requires_larm_409_and_exact_error_code() {
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, HeaderValue::from_static("7"));
        let body = r#"{"error":{"code":"foreground_preempted","message":"foreground won"}}"#;
        let classified = classify_larm_foreground_preemption(
            "larm-agent-connection:background",
            409,
            &headers,
            body,
        )
        .unwrap();
        assert_eq!(classified.retry_after_floor_ms, 7_000);
        assert_eq!(classified.kind, InferencePauseKind::ForegroundPreempted);
        assert_eq!(classified.message.as_deref(), Some("foreground won"));
        assert!(classify_larm_foreground_preemption("local-a", 409, &headers, body).is_none());
        assert!(classify_larm_foreground_preemption(
            "larm-agent-connection:background",
            409,
            &headers,
            r#"{"error":{"code":"allocation_inactive"}}"#
        )
        .is_none());
        assert!(classify_larm_foreground_preemption(
            "larm-agent-connection:background",
            409,
            &headers,
            "not-json"
        )
        .is_none());
    }

    #[test]
    fn message_classification_requires_larm_and_explicit_connect_flag() {
        let classified = classify_larm_provider_unreachable_message(
            "larm-agent-connection:background",
            "agent request failed (connect=true, timeout=false)",
        )
        .unwrap();
        assert_eq!(classified.kind, InferencePauseKind::ProviderUnreachable);
        assert!(classify_larm_provider_unreachable_message(
            "local-a",
            "agent request failed (connect=true, timeout=false)"
        )
        .is_none());
        assert!(classify_larm_provider_unreachable_message(
            "larm-agent-connection:background",
            "agent request failed (connect=false, timeout=true)"
        )
        .is_none());
    }

    #[test]
    fn retry_delay_starts_at_one_second_and_caps_at_thirty_seconds() {
        assert_eq!(preemption_retry_delay_ms(0, 1_000, 500), 1_000);
        assert!((1_000..=2_000).contains(&preemption_retry_delay_ms(1, 1_000, 500)));
        assert!((1_000..=30_000).contains(&preemption_retry_delay_ms(20, 1_000, 99_999)));
        assert_eq!(preemption_retry_delay_ms(20, 90_000, 0), 30_000);
    }
}
