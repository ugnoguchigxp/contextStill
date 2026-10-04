use serde_json::json;

use crate::shared::errors::CliError;

use super::types::{CoveringExecution, NEGATIVE_SYSTEM_PROMPT};

pub(super) fn request_negative_evidence(
    execution: &CoveringExecution,
    timeout_seconds: u64,
) -> Result<String, CliError> {
    request_covering_completion(
        execution,
        NEGATIVE_SYSTEM_PROMPT,
        &json!({
            "candidate": {
                "title": execution.candidate_title,
                "content": execution.candidate_content
            }
        })
        .to_string(),
        2048,
        timeout_seconds,
    )
}

pub(super) fn request_covering_completion(
    execution: &CoveringExecution,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: u64,
    timeout_seconds: u64,
) -> Result<String, CliError> {
    let messages = json!([
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt}
    ]);
    crate::domains::agent_runtime::transport::send(
        crate::domains::agent_runtime::transport::CompletionRequest {
            target: &execution.target,
            api_key: execution.api_key.as_deref(),
            messages: &messages,
            max_output: max_tokens,
            response_format: None,
            timeout_seconds,
        },
    )
    .and_then(|completion| match completion.terminal_error {
        Some(error) => Err(
            crate::domains::queue_lifecycle::inference_preemption::InferenceRequestError::Other(
                error,
            ),
        ),
        None => Ok(completion.content),
    })
    .map_err(|error| CliError::io(error.to_string()))
}
