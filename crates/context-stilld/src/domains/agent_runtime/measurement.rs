//! Request admission from the claimed Provider, with no privileged measurement API.
//! Counts here are conservative byte estimates, never actual tokenizer measurements.
use super::{
    budget::{Window, SOFT_WINDOW},
    source::hash,
};
use crate::domains::queue_lifecycle::episode_executor::LocalLlmTargetConfig;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub(crate) struct RequestCapability {
    pub allocation_id: String,
    pub connection_id: String,
    pub model: String,
    pub expires_at_ms: u64,
    pub window: Window,
}
impl RequestCapability {
    pub fn from_provider(metadata: &Value, target: &LocalLlmTargetConfig) -> Result<Self, String> {
        let text = |name| {
            metadata[name]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| "provider_metadata_invalid".to_owned())
        };
        let allocation_id = text("allocationId")?;
        let connection_id = text("connectionId")?;
        if metadata["publicModel"] != target.model
            || metadata["providerBaseUrl"] != target.api_base_url
        {
            return Err("provider_target_mismatch".into());
        }
        let expires_at_ms = crate::domains::provider_connection::service::parse_rfc3339_utc_ms(
            &text("credentialExpiresAt")?,
        )
        .ok_or("provider_expiry_invalid")?;
        if expires_at_ms <= now_ms() {
            return Err("provider_credential_expired".into());
        }
        let mut window = if metadata["contextWindow"].is_null() {
            // Older catalogs omit this optional field. Apply the Consumer's 32K ceiling.
            Window {
                max_tokens: SOFT_WINDOW,
                output_reserve_tokens: 4096,
                safety_margin_tokens: 4096,
            }
        } else {
            serde_json::from_value::<Window>(metadata["contextWindow"].clone())
                .map_err(|_| "provider_window_invalid")?
        };
        window.max_tokens = window.max_tokens.min(SOFT_WINDOW);
        window.safety_margin_tokens = window.safety_margin_tokens.max(4096);
        window.admit(1, window.output_reserve_tokens)?;
        Ok(Self {
            allocation_id,
            connection_id,
            model: target.model.clone(),
            expires_at_ms,
            window,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Measurement {
    /// Estimated upper bound for admission. Actual tokens come only from Provider usage.
    pub input_tokens: u64,
    pub request_hash: String,
    pub tokenizer_digest: String,
    pub template_digest: String,
    pub lease_epoch: u64,
    pub expires_at_ms: u64,
    pub binding: Value,
    pub window: Window,
}

pub(crate) fn measure(
    capability: &RequestCapability,
    request: &Value,
) -> Result<Measurement, String> {
    if request["model"] != capability.model {
        return Err("provider_target_mismatch".into());
    }
    if capability.expires_at_ms <= now_ms() {
        return Err("provider_credential_expired".into());
    }
    let output = request["max_tokens"]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or("measurement_missing_output_limit")?;
    let messages = request["messages"]
        .as_array()
        .filter(|m| !m.is_empty())
        .ok_or("measurement_messages_invalid")?;
    if messages
        .iter()
        .any(|m| !m["content"].is_string() || !m["role"].is_string())
    {
        return Err("measurement_messages_invalid".into());
    }
    // JSON byte count includes prompt, roles, schemas and escaped content. Additional
    // per-message framing and a 4096-token margin leave room for model templates.
    // This is deliberately labeled an estimate: arbitrary tokenizer/template behavior
    // cannot be proven from an OpenAI-compatible descriptor alone.
    let raw = request.to_string();
    let input_tokens = (raw.len() as u64)
        .checked_add((messages.len() as u64).saturating_mul(256))
        .ok_or("context_limit")?;
    capability.window.admit(input_tokens, output)?;
    let request_hash = hash(&raw);
    Ok(Measurement {
        input_tokens,
        request_hash: request_hash.clone(),
        tokenizer_digest: String::new(),
        template_digest: String::new(),
        lease_epoch: 0,
        expires_at_ms: capability.expires_at_ms,
        binding: json!({"method":"utf8_bytes_with_framing_margin","exact":false,
            "requestDigest":request_hash,"connectionId":capability.connection_id,
            "allocationId":capability.allocation_id,"publicModel":capability.model,
            "inputTokenUpperBound":input_tokens}),
        window: capability.window.clone(),
    })
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn target() -> LocalLlmTargetConfig {
        LocalLlmTargetConfig {
            codex: false,
            quota_db: None,
            target_id: "target".into(),
            api_base_url: "http://127.0.0.1:9800/v1".into(),
            api_path: "/v1/chat/completions".into(),
            model: "returned-model".into(),
        }
    }
    fn metadata() -> Value {
        json!({"connectionId":"conn", "allocationId":"alloc", "publicModel":"returned-model",
            "providerBaseUrl":target().api_base_url, "credentialExpiresAt":"2099-01-01T00:00:00Z"})
    }
    #[test]
    fn provider_without_measurement_api_or_window_is_accepted_and_large_prompts_are_rejected() {
        let cap = RequestCapability::from_provider(&metadata(), &target()).unwrap();
        let request = json!({"model":"returned-model", "messages":[{"role":"user","content":"日本語を確認"}], "max_tokens":4096});
        let measured = measure(&cap, &request).unwrap();
        assert_eq!(measured.binding["exact"], false);
        assert_eq!(measured.window.max_tokens, 32768);
        assert_eq!(
            measured.input_tokens,
            request.to_string().len() as u64 + 256
        );
        let mut large = request.clone();
        large["messages"][0]["content"] = json!("あ".repeat(11000));
        assert_eq!(measure(&cap, &large).unwrap_err(), "context_limit");
    }
    #[test]
    fn admission_is_bound_to_claimed_model_endpoint_expiry_and_advertised_window() {
        for (field, value) in [
            ("publicModel", json!("coding-default")),
            ("providerBaseUrl", json!("http://127.0.0.1:44448/v1")),
            ("credentialExpiresAt", json!("2000-01-01T00:00:00Z")),
        ] {
            let mut m = metadata();
            m[field] = value;
            assert!(RequestCapability::from_provider(&m, &target()).is_err());
        }
        let mut m = metadata();
        m["contextWindow"] =
            json!({"maxTokens":16384,"outputReserveTokens":4096,"safetyMarginTokens":1024});
        assert_eq!(
            RequestCapability::from_provider(&m, &target())
                .unwrap()
                .window
                .max_tokens,
            16384
        );
        m["contextWindow"]["maxTokens"] = json!(65536);
        assert_eq!(
            RequestCapability::from_provider(&m, &target())
                .unwrap()
                .window
                .max_tokens,
            32768
        );
        m["contextWindow"] =
            json!({"maxTokens":4096,"outputReserveTokens":4096,"safetyMarginTokens":1024});
        assert!(RequestCapability::from_provider(&m, &target()).is_err());
    }
}
