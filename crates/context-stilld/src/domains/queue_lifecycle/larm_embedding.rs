use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::blocking::Client;
use reqwest::{StatusCode, Url};
use serde_json::{json, Value};
use zeroize::Zeroizing;

use crate::domains::provider_connection::parse_rfc3339_utc_ms;
use crate::shared::errors::CliError;

const MODEL_REVISION: &str = "614241f622f53c4eeff9890bdc4f31cfecc418b3";
const ARTIFACT_DIGEST: &str = "63bc913284590439c0fdadcd5f61ee9ad9630591075314bc975fb190983ed62c";
const TOKENIZER_DIGEST: &str = "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39";

#[derive(Debug)]
pub(super) enum EmbeddingConnectionError {
    Unreachable,
    Waiting(String),
    Contract(String),
}

#[derive(Default)]
struct EmbeddingConnection {
    control_url: String,
    audience: String,
    id: Option<String>,
    key: Option<String>,
    endpoint: Option<String>,
    credential: Option<Zeroizing<String>>,
    expires_at_ms: u64,
    state_path: Option<PathBuf>,
}

static CONNECTION: OnceLock<Mutex<EmbeddingConnection>> = OnceLock::new();

fn state() -> &'static Mutex<EmbeddingConnection> {
    CONNECTION.get_or_init(|| Mutex::new(EmbeddingConnection::default()))
}

fn client() -> Result<Client, EmbeddingConnectionError> {
    Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(|error| EmbeddingConnectionError::Contract(error.to_string()))
}

fn control_token() -> Result<Zeroizing<String>, EmbeddingConnectionError> {
    std::env::var("LARM_API_TOKEN")
        .ok()
        .filter(|value| !value.is_empty())
        .map(Zeroizing::new)
        .ok_or(EmbeddingConnectionError::Unreachable)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn new_key() -> Result<String, EmbeddingConnectionError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|error| EmbeddingConnectionError::Contract(error.to_string()))?;
    Ok(format!(
        "contextstill:embedding:{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn persist(connection: &EmbeddingConnection) -> Result<(), EmbeddingConnectionError> {
    let Some(path) = connection.state_path.as_ref() else {
        return Ok(());
    };
    let value = json!({"key":connection.key,"id":connection.id,"controlUrl":connection.control_url,"audience":connection.audience});
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&temporary, value.to_string()).map_err(|error| {
        EmbeddingConnectionError::Contract(format!("embedding state write failed: {error}"))
    })?;
    std::fs::rename(&temporary, path).map_err(|error| {
        EmbeddingConnectionError::Contract(format!("embedding state commit failed: {error}"))
    })
}

fn restore(
    connection: &mut EmbeddingConnection,
    path: &Path,
    control_url: &str,
    audience: &str,
) -> Result<(), EmbeddingConnectionError> {
    connection.state_path = Some(path.to_path_buf());
    connection.control_url = control_url.to_string();
    connection.audience = audience.to_string();
    if !path.exists() {
        return Ok(());
    }
    let bytes = std::fs::read(path).map_err(|error| {
        EmbeddingConnectionError::Contract(format!("embedding state read failed: {error}"))
    })?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| EmbeddingConnectionError::Contract("invalid embedding state".into()))?;
    if value["controlUrl"] != control_url || value["audience"] != audience {
        return Err(EmbeddingConnectionError::Contract(
            "embedding state configuration changed without confirmed release".into(),
        ));
    }
    connection.key = value["key"].as_str().map(str::to_string);
    connection.id = value["id"].as_str().map(str::to_string);
    if connection.key.is_none() {
        return Err(EmbeddingConnectionError::Contract(
            "embedding state has no idempotency key".into(),
        ));
    }
    Ok(())
}

fn request_url(base: &str, path: &str) -> Result<Url, EmbeddingConnectionError> {
    let url =
        Url::parse(base).map_err(|error| EmbeddingConnectionError::Contract(error.to_string()))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(EmbeddingConnectionError::Contract(
            "invalid LARM origin".into(),
        ));
    }
    url.join(path)
        .map_err(|error| EmbeddingConnectionError::Contract(error.to_string()))
}

fn body(response: reqwest::blocking::Response) -> Result<Value, EmbeddingConnectionError> {
    let bytes = response
        .bytes()
        .map_err(|_| EmbeddingConnectionError::Unreachable)?;
    if bytes.len() > 256 * 1024 {
        return Err(EmbeddingConnectionError::Contract(
            "LARM response too large".into(),
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| EmbeddingConnectionError::Contract("invalid LARM JSON".into()))
}

fn space_is_compatible(space: &Value) -> bool {
    space["contractVersion"] == "larm-embedding.v1"
        && space["workload"] == "embedding"
        && space["model"]["id"] == "intfloat/multilingual-e5-small"
        && space["model"]["revision"] == MODEL_REVISION
        && space["model"]["artifactDigest"] == ARTIFACT_DIGEST
        && space["dimension"] == 384
        && space["inputTypes"] == json!(["query", "passage"])
        && space["prefixes"]["query"] == "query: "
        && space["prefixes"]["passage"] == "passage: "
        && space["normalization"] == "l2"
        && space["tokenization"]["kind"] == "sentencepiece-bpe"
        && space["tokenization"]["tokenizerDigest"] == TOKENIZER_DIGEST
        && space["tokenization"]["maxTokens"] == 512
        && space["tokenization"]["truncation"] == "end"
        && space["tokenization"]["pooling"] == "mean"
}

fn validate_connection(value: &Value) -> Result<&str, EmbeddingConnectionError> {
    let id = value["id"]
        .as_str()
        .filter(|id| {
            !id.is_empty()
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        })
        .ok_or_else(|| {
            EmbeddingConnectionError::Contract("missing LARM embedding connection id".into())
        })?;
    let provider = &value["providers"][0];
    if value["profile"] != "embeddingCanary"
        || value["agentProfile"] != "contextstill-embedding"
        || value["providers"]
            .as_array()
            .is_none_or(|providers| providers.len() != 1)
        || provider["name"] != "embedding"
        || provider["protocol"] != "larm.embedding.v1"
        || provider["endpoint"] != "/v1/embed"
        || provider["model"] != "multilingual-e5-small"
        || !space_is_compatible(&provider["embeddingSpace"])
    {
        return Err(EmbeddingConnectionError::Contract(
            "embedding_space_mismatch".into(),
        ));
    }
    Ok(id)
}

fn release(
    connection: &mut EmbeddingConnection,
    client: &Client,
    token: &str,
) -> Result<(), EmbeddingConnectionError> {
    let Some(id) = connection.id.as_deref() else {
        return Ok(());
    };
    let response = client
        .delete(request_url(
            &connection.control_url,
            &format!("/v1/agent-connections/{id}"),
        )?)
        .bearer_auth(token)
        .send()
        .map_err(|_| EmbeddingConnectionError::Unreachable)?;
    if response.status() != StatusCode::NO_CONTENT {
        return Err(EmbeddingConnectionError::Waiting(format!(
            "embedding DELETE returned {}",
            response.status()
        )));
    }
    connection.id = None;
    connection.key = Some(new_key()?);
    connection.endpoint = None;
    connection.credential = None;
    persist(connection)?;
    Ok(())
}

pub(super) fn shutdown() {
    let Ok(mut connection) = state().lock() else {
        return;
    };
    let Ok(client) = client() else { return };
    let Ok(token) = control_token() else { return };
    let _ = release(&mut connection, &client, &token);
}

pub(super) fn target(
    control_url: &str,
    audience: &str,
    state_path: Option<&Path>,
) -> Result<(String, Zeroizing<String>), EmbeddingConnectionError> {
    let mut connection = state().lock().map_err(|_| {
        EmbeddingConnectionError::Contract("embedding manager lock poisoned".into())
    })?;
    let client = client()?;
    let token = control_token()?;
    if connection.state_path.as_deref() != state_path {
        if connection.id.is_some() {
            release(&mut connection, &client, &token)?;
            connection.key = None;
            connection.state_path = None;
        }
        if connection.key.is_some() && connection.id.is_none() && connection.state_path.is_some() {
            return Err(EmbeddingConnectionError::Contract(
                "ambiguous embedding create cannot change state scope".into(),
            ));
        }
        connection.key = None;
        connection.id = None;
        connection.state_path = None;
        if let Some(path) = state_path {
            restore(&mut connection, path, control_url, audience)?;
        }
    }
    if connection.control_url != control_url || connection.audience != audience {
        if connection.id.is_none() && connection.key.is_some() {
            return Err(EmbeddingConnectionError::Contract(
                "ambiguous embedding create cannot change configuration".into(),
            ));
        }
        release(&mut connection, &client, &token)?;
        connection.control_url = control_url.to_string();
        connection.audience = audience.to_string();
        persist(&connection)?;
    }
    if connection.credential.is_some() && connection.expires_at_ms > now_ms() + 30_000 {
        return Ok((
            connection.endpoint.clone().unwrap(),
            connection.credential.clone().unwrap(),
        ));
    }
    if connection.id.is_some() && connection.credential.is_some() {
        release(&mut connection, &client, &token)?;
    }
    if let Some(id) = connection.id.clone() {
        let response = client
            .get(request_url(
                control_url,
                &format!("/v1/agent-connections/{id}"),
            )?)
            .bearer_auth(token.as_str())
            .send()
            .map_err(|_| EmbeddingConnectionError::Unreachable)?;
        if response.status() != StatusCode::OK {
            return Err(EmbeddingConnectionError::Waiting(
                "embedding status unavailable".into(),
            ));
        }
        let value = body(response)?;
        if validate_connection(&value)? != id {
            return Err(EmbeddingConnectionError::Contract(
                "embedding connection id changed".into(),
            ));
        }
        if matches!(
            value["status"].as_str(),
            Some("released" | "expired" | "failed")
        ) {
            release(&mut connection, &client, &token)?;
        }
    }
    if connection.id.is_none() {
        let key = match connection.key.clone() {
            Some(key) => key,
            None => {
                let key = new_key()?;
                connection.key = Some(key.clone());
                persist(&connection)?;
                key
            }
        };
        let response = client
            .post(request_url(control_url, "/v1/agent-connections")?)
            .bearer_auth(token.as_str())
            .header("Idempotency-Key", key)
            .header("Prefer", "wait=1")
            .json(&json!({"profile":"embeddingCanary","audience":audience,"client":"contextstill","ttlSeconds":300,"allowFallback":false,"deploymentPolicy":"existing-only"}))
            .send()
            .map_err(|_| EmbeddingConnectionError::Unreachable)?;
        if response.status() == StatusCode::CONFLICT {
            return Err(EmbeddingConnectionError::Waiting(
                "provider_conflict".into(),
            ));
        }
        if !matches!(
            response.status(),
            StatusCode::CREATED | StatusCode::ACCEPTED
        ) {
            return Err(EmbeddingConnectionError::Waiting(format!(
                "embedding create returned {}",
                response.status()
            )));
        }
        let value = body(response)?;
        connection.id = Some(validate_connection(&value)?.to_string());
        persist(&connection)?;
        if value["status"] != "ready" {
            return Err(EmbeddingConnectionError::Waiting(
                "embedding deploying".into(),
            ));
        }
    }
    let id = connection.id.as_ref().unwrap().clone();
    let status = client
        .get(request_url(
            control_url,
            &format!("/v1/agent-connections/{id}"),
        )?)
        .bearer_auth(token.as_str())
        .send()
        .map_err(|_| EmbeddingConnectionError::Unreachable)?;
    if status.status() != StatusCode::OK {
        return Err(EmbeddingConnectionError::Waiting(
            "embedding status unavailable".into(),
        ));
    }
    let value = body(status)?;
    if validate_connection(&value)? != id {
        return Err(EmbeddingConnectionError::Contract(
            "embedding connection id changed".into(),
        ));
    }
    if value["status"] != "ready"
        || value["providers"][0]["readiness"] != "ready"
        || value["providers"][0]["claimable"] != true
    {
        return Err(EmbeddingConnectionError::Waiting(
            "embedding deploying".into(),
        ));
    }
    let response = client
        .post(request_url(
            control_url,
            &format!("/v1/agent-connections/{id}/claim"),
        )?)
        .bearer_auth(token.as_str())
        .json(&json!({"format":"larm-embedding-provider-v1"}))
        .send()
        .map_err(|_| EmbeddingConnectionError::Unreachable)?;
    if response.status() != StatusCode::OK {
        return Err(EmbeddingConnectionError::Waiting(
            "embedding claim unavailable".into(),
        ));
    }
    let claim = body(response)?;
    let provider = &claim["providers"][0];
    let expected_endpoint = request_url(control_url, "/v1/embed")?.to_string();
    if claim["id"] != id
        || claim["status"] != "ready"
        || claim["audience"] != audience
        || claim["providers"]
            .as_array()
            .is_none_or(|providers| providers.len() != 1)
        || provider["configuration"]["kind"] != "larm-embedding-provider-v1"
        || provider["protocol"] != "larm.embedding.v1"
        || provider["endpoint"] != expected_endpoint
        || !space_is_compatible(&provider["embeddingSpace"])
    {
        return Err(EmbeddingConnectionError::Contract(
            "embedding_space_mismatch".into(),
        ));
    }
    let credential = provider["credential"]["token"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| EmbeddingConnectionError::Contract("missing embedding credential".into()))?;
    let expires_at = provider["credential"]["expiresAt"]
        .as_str()
        .ok_or_else(|| {
            EmbeddingConnectionError::Contract("missing embedding credential expiry".into())
        })?;
    let expires_at_ms = parse_rfc3339_utc_ms(expires_at).ok_or_else(|| {
        EmbeddingConnectionError::Contract("invalid embedding credential expiry".into())
    })?;
    connection.endpoint = Some(expected_endpoint.clone());
    connection.credential = Some(Zeroizing::new(credential.to_string()));
    connection.expires_at_ms = expires_at_ms;
    Ok((expected_endpoint, Zeroizing::new(credential.to_string())))
}

pub(super) fn classify(error: EmbeddingConnectionError) -> Result<(), CliError> {
    match error {
        EmbeddingConnectionError::Unreachable => Ok(()),
        EmbeddingConnectionError::Waiting(reason) => Err(CliError::io(reason)),
        EmbeddingConnectionError::Contract(reason) => Err(CliError::io(reason)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incompatible_space_fails_closed() {
        let mut space = json!({"contractVersion":"larm-embedding.v1","workload":"embedding","model":{"id":"intfloat/multilingual-e5-small","revision":MODEL_REVISION,"artifactDigest":ARTIFACT_DIGEST},"dimension":384,"inputTypes":["query","passage"],"prefixes":{"query":"query: ","passage":"passage: "},"normalization":"l2","tokenization":{"kind":"sentencepiece-bpe","tokenizerDigest":TOKENIZER_DIGEST,"maxTokens":512,"truncation":"end","pooling":"mean"}});
        assert!(space_is_compatible(&space));
        space["dimension"] = json!(768);
        assert!(!space_is_compatible(&space));
    }

    #[test]
    #[ignore = "requires a live LARM server and LARM_API_TOKEN"]
    fn live_embedding_connection_claim_and_release() {
        struct Cleanup;
        impl Drop for Cleanup {
            fn drop(&mut self) {
                shutdown();
            }
        }
        let _cleanup = Cleanup;
        let origin = std::env::var("CONTEXT_STILL_LARM_E2E_URL").expect("LARM URL");
        let path = std::env::temp_dir().join(format!(
            "contextstill-embedding-e2e-{}.json",
            std::process::id()
        ));
        let (endpoint, credential) =
            target(&origin, "saaa-desktop", Some(&path)).expect("LARM embedding claim");
        let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(saved["id"].as_str().is_some());
        assert_eq!(
            target(&origin, "saaa-desktop", Some(&path)).unwrap().0,
            endpoint
        );
        let response = client().unwrap()
            .post(endpoint)
            .bearer_auth(credential.as_str())
            .json(&json!({"texts":["integration test"],"type":"passage","normalize":true,"priority":"normal"}))
            .send().unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let value = body(response).unwrap();
        assert_eq!(value["dimension"], 384);
        assert_eq!(value["type"], "passage");
        assert_eq!(value["normalize"], true);
        assert_eq!(value["embeddings"][0].as_array().unwrap().len(), 384);
        shutdown();
        let released: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(released["id"].is_null());
        std::fs::remove_file(path).unwrap();
    }
}
