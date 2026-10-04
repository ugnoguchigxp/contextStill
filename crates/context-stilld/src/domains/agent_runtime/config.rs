use super::measurement::RequestCapability;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Config {
    #[serde(default)]
    pub enabled: bool,
    // Read old settings without making a separate LARM API a prerequisite.
    #[serde(rename = "measurement", skip_serializing)]
    pub _legacy_measurement: Option<Value>,
    pub research: Option<ResearchConfig>,
}
impl Config {
    pub fn from_settings(settings: &Value) -> Result<Self, String> {
        settings
            .pointer("/advanced/agentRuntime")
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|_| "agent_runtime_config_invalid".to_owned())
            .map(|c| c.unwrap_or_default())
    }
    pub fn request_capability(
        &self,
        connection: &Connection,
        lease: &str,
        target: &crate::domains::queue_lifecycle::episode_executor::LocalLlmTargetConfig,
    ) -> Result<RequestCapability, String> {
        let raw = connection
            .query_row(
                "select metadata from llm_provider_leases where id=?1 and status='active'",
                [lease],
                |r| r.get::<_, String>(0),
            )
            .map_err(|_| "request_lease_missing")?;
        let metadata: Value =
            serde_json::from_str(&raw).map_err(|_| "provider_metadata_invalid")?;
        RequestCapability::from_provider(&metadata, target)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResearchConfig {
    pub base_url: String,
    pub credential_key: String,
    pub gateway_credential_key: String,
    pub gateway_url: String,
}
impl ResearchConfig {
    pub fn validate(&self) -> Result<(), String> {
        for raw in [&self.base_url, &self.gateway_url] {
            let url = reqwest::Url::parse(raw).map_err(|_| "research_url_invalid")?;
            if url.scheme() != "http"
                || !matches!(
                    url.host_str(),
                    Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
                )
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err("research_loopback_required".into());
            }
        }
        if self.credential_key == self.gateway_credential_key
            || self.credential_key.is_empty()
            || self.gateway_credential_key.is_empty()
        {
            return Err("research_dedicated_credentials_required".into());
        }
        Ok(())
    }
}
