//! Settings facade behind the authenticated resident writer endpoint.
use serde_json::{json, Value};
use std::path::Path;
pub(crate) fn handle(path: &Path, body: Value) -> Result<Value, String> {
    use crate::domains::{
        agent_runtime::budget::{
            Budget, AGENT_OUTPUT_TOKENS, EXPLORATION_CALLS, FINAL_RESERVE, HARD_WINDOW, MAX_CALLS,
            RESEARCH_HARD, RESEARCH_TARGET, SOFT_WINDOW,
        },
        queue_lifecycle::dynamic_provider,
    };
    match body["operation"].as_str() {
        Some("policy") => {
            let mut policy = json!({"windowCeiling":SOFT_WINDOW,"hardWindowCeiling":HARD_WINDOW,"outputTokens":AGENT_OUTPUT_TOKENS,"finalReserve":FINAL_RESERVE,"runTarget":Budget::default().target,"runHard":Budget::default().hard,"researchTarget":RESEARCH_TARGET,"researchHard":RESEARCH_HARD,"maxCalls":MAX_CALLS,"explorationCalls":EXPLORATION_CALLS,"noGainLimit":crate::domains::agent_runtime::policy::NO_GAIN_LIMIT,"fetchFailureLimit":crate::domains::agent_runtime::policy::FETCH_FAILURE_LIMIT,"maxDelegations":1,"estimate":"utf8_bytes_plus_message_margin"});
            policy["revision"] = json!(crate::domains::agent_runtime::source::hash(
                &policy.to_string()
            ));
            Ok(policy)
        }
        Some("runtime") => dynamic_provider::settings_provider_runtime(
            path,
            body["id"].as_str().ok_or("connection_id_required")?,
        ),
        Some("test") => {
            let mut config: crate::domains::provider_connection::LarmConnectionConfig =
                serde_json::from_value(body["config"].clone())
                    .map_err(|_| "connection_config_invalid")?;
            if let Some(token) = body["credential"].as_str() {
                config.control_bearer_token = Some(zeroize::Zeroizing::new(token.into()));
            }
            if body["saved"] == true {
                let reader=crate::domains::queue_lifecycle::provider_execution::open_query_only_connection(path).map_err(|_|"provider_settings_unavailable")?;
                let (raw,revision):(String,u64)=reader.query_row("select value,schema_version from settings where namespace='runtime' and key='settings.v1'",[],|row|Ok((row.get(0)?,row.get(1)?))).map_err(|_|"provider_settings_unavailable")?;
                if body["revision"].as_u64() != Some(revision) {
                    return Err("provider_settings_changed".into());
                }
                let document: Value =
                    serde_json::from_str(&raw).map_err(|_| "provider_settings_unavailable")?;
                let mut current =
                    crate::domains::provider_connection::LarmConnectionConfig::from_settings(
                        &document["settings"],
                        &config.id,
                    )
                    .map_err(|_| "provider_config_invalid")?
                    .ok_or("provider_settings_changed")?;
                current.control_bearer_token = config.control_bearer_token.clone();
                if current != config {
                    return Err("provider_settings_changed".into());
                }
            }
            dynamic_provider::settings_provider_probe(path, config, body["saved"] == true)
        }
        _ => Err("settings_operation_unsupported".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_is_read_from_execution_constants_without_allocation() {
        let policy = handle(
            Path::new("/missing-settings-test"),
            json!({"operation":"policy"}),
        )
        .unwrap();
        assert_eq!(
            policy["windowCeiling"],
            crate::domains::agent_runtime::budget::SOFT_WINDOW
        );
        assert_eq!(
            policy["runHard"],
            crate::domains::agent_runtime::budget::Budget::default().hard
        );
        assert_eq!(
            policy["noGainLimit"],
            crate::domains::agent_runtime::policy::NO_GAIN_LIMIT
        );
        assert!(!policy.to_string().contains("token"));
    }
    #[test]
    fn unadopted_runtime_stays_unconfirmed() {
        let result = handle(
            Path::new("/missing-settings-test"),
            json!({"operation":"runtime","id":"not-adopted"}),
        )
        .unwrap();
        assert_eq!(result["status"], "unconfirmed");
        assert!(result["capacity"].is_null());
    }
}
