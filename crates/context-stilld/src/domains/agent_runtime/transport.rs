use std::io::Read;
use std::time::Duration;

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::domains::queue_lifecycle::episode_executor::LocalLlmTargetConfig;
use crate::domains::queue_lifecycle::inference_preemption::{
    classify_larm_foreground_preemption, classify_larm_provider_unreachable,
    classify_larm_provider_unreachable_message, InferenceRequestError,
};
use crate::shared::agent_session::{is_agent_session_api_path, AgentSessionRequest};

const RESPONSE_LIMIT: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct Usage {
    pub input: u64,
    pub output: u64,
    pub cached_input: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct Completion {
    pub content: String,
    pub terminal_error: Option<String>,
    pub usage: Option<Usage>,
    pub finish_reason: Option<String>,
    pub request_id: Option<String>,
}

pub(crate) struct CompletionRequest<'a> {
    pub target: &'a LocalLlmTargetConfig,
    pub api_key: Option<&'a str>,
    pub messages: &'a Value,
    pub max_output: u64,
    pub response_format: Option<Value>,
    pub timeout_seconds: u64,
}

pub(crate) fn chat_url(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    let path = if base.ends_with("/v1") && path.starts_with("/v1/") {
        &path[3..]
    } else {
        path
    };
    format!("{base}/{}", path.trim_start_matches('/'))
}

pub(crate) fn request_body(request: &CompletionRequest<'_>) -> Value {
    let mut body = json!({
        "model": request.target.model,
        "messages": request.messages,
        "max_tokens": request.max_output,
        "temperature": 0,
        "stream": false
    });
    if let Some(format) = &request.response_format {
        body["response_format"] = format.clone();
    }
    body
}

pub(crate) fn send(request: CompletionRequest<'_>) -> Result<Completion, InferenceRequestError> {
    let target = request.target;
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(request.timeout_seconds.max(1)))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| InferenceRequestError::Other(format!("LLM client failed: {e}")))?;
    if target.codex || is_agent_session_api_path(&target.api_path) {
        let content = target
            .run_agent_chat(
                &client,
                request.timeout_seconds,
                AgentSessionRequest {
                    api_base_url: &target.api_base_url,
                    api_path: &target.api_path,
                    api_key: request.api_key,
                    model: &target.model,
                    messages: request.messages,
                    max_tokens: request.max_output as i64,
                    json_response: true,
                },
            )
            .map_err(|error| {
                classify_larm_provider_unreachable_message(&target.target_id, &error)
                    .map(InferenceRequestError::Preempted)
                    .unwrap_or(InferenceRequestError::Other(error))
            })?;
        return Ok(Completion {
            content,
            terminal_error: None,
            usage: None,
            finish_reason: None,
            request_id: None,
        });
    }
    let mut http = client
        .post(chat_url(&target.api_base_url, &target.api_path))
        .json(&request_body(&request));
    if let Some(key) = request.api_key.filter(|k| !k.trim().is_empty()) {
        http = http.header(
            "authorization",
            crate::domains::secret_store::header(key, true)
                .map_err(InferenceRequestError::Other)?,
        );
    }
    let response = http.send().map_err(|e| {
        classify_larm_provider_unreachable(&target.target_id, &e)
            .map(InferenceRequestError::Preempted)
            .unwrap_or_else(|| InferenceRequestError::Other(format!("LLM request failed: {e}")))
    })?;
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let mut bytes = Vec::new();
    response
        .take(RESPONSE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| InferenceRequestError::Other(format!("LLM response read failed: {e}")))?;
    if bytes.len() as u64 > RESPONSE_LIMIT {
        return Err(InferenceRequestError::Other(
            "LLM response byte_limit_exceeded".into(),
        ));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| InferenceRequestError::Other("LLM response invalid_utf8".into()))?;
    if !(200..300).contains(&status) {
        if let Some(preempted) =
            classify_larm_foreground_preemption(&target.target_id, status, &headers, &text)
        {
            return Err(InferenceRequestError::Preempted(preempted));
        }
        // Provider bodies can echo credentials or source data. Keep the persisted error bounded and private.
        return Err(InferenceRequestError::Other(format!("LLM HTTP {status}")));
    }
    let payload: Value = serde_json::from_str(&text)
        .map_err(|_| InferenceRequestError::Other("LLM response invalid_json".into()))?;
    // A complete HTTP response is a receipt even when its generation is truncated
    // or refused. Preserve usage without passing its contents to the policy.
    let (content, terminal_error) = completion_content(&payload);
    let usage = parse_usage(&payload);
    Ok(Completion {
        content,
        terminal_error,
        usage,
        finish_reason: payload
            .pointer("/choices/0/finish_reason")
            .and_then(Value::as_str)
            .map(str::to_owned),
        request_id: headers
            .get("x-request-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .or_else(|| payload.get("id").and_then(Value::as_str).map(str::to_owned)),
    })
}

fn completion_content(payload: &Value) -> (String, Option<String>) {
    match crate::domains::queue_lifecycle::structured_output::terminal_content(payload) {
        Ok(content) => (content.to_owned(), None),
        Err(error) => (String::new(), Some(error)),
    }
}

fn parse_usage(payload: &Value) -> Option<Usage> {
    let usage = payload.get("usage")?;
    let input = usage
        .get("prompt_tokens")
        .or_else(|| usage.get("input_tokens"))?
        .as_u64()?;
    let output = usage
        .get("completion_tokens")
        .or_else(|| usage.get("output_tokens"))?
        .as_u64()?;
    let cached_input = usage
        .pointer("/prompt_tokens_details/cached_tokens")
        .or_else(|| usage.pointer("/input_tokens_details/cached_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if cached_input > input {
        return None;
    }
    Some(Usage {
        input,
        output,
        cached_input,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incomplete_or_refused_responses_preserve_usage_but_expose_no_content() {
        for choice in [
            json!({"message":{"content":"{\"next\":{\"kind\":\"finish\"}}"},"finish_reason":"length"}),
            json!({"message":{"content":"{}","refusal":"denied"},"finish_reason":"stop"}),
            json!({"message":{"content":"{}"}}),
        ] {
            let payload =
                json!({"choices":[choice],"usage":{"prompt_tokens":100,"completion_tokens":4096}});
            let (content, error) = completion_content(&payload);
            assert!(content.is_empty());
            assert!(error.is_some());
            assert_eq!(parse_usage(&payload).unwrap().output, 4096);
        }
    }
    #[test]
    fn usage_is_optional_and_cache_is_an_input_subset() {
        assert_eq!(
            parse_usage(
                &json!({"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":40}}})
            ),
            Some(Usage {
                input: 100,
                output: 20,
                cached_input: 40
            })
        );
        assert_eq!(parse_usage(&json!({"usage":{"prompt_tokens":100}})), None);
        assert_eq!(
            parse_usage(
                &json!({"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":101}}})
            ),
            None
        );
    }
    #[test]
    fn versioned_urls_do_not_repeat_v1() {
        assert_eq!(
            chat_url("http://localhost:9000/v1/", "/v1/chat/completions"),
            "http://localhost:9000/v1/chat/completions"
        );
    }
}
