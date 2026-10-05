use super::*;

/// Settings observes the manager itself; tokens and persisted state files never
/// cross the API boundary. A snapshot does not reconcile or allocate a model.
pub(crate) fn settings_provider_runtime(path: &Path, id: &str) -> Result<Value, String> {
    let registry = LARM_CONNECTION_MANAGERS
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .map_err(|_| "provider_registry_poisoned")?;
    let key = larm_manager_registry_key(path, id);
    let Some(entry) = registry.get(&key) else {
        return Ok(json!({"status":"unconfirmed"}));
    };
    let entry = entry.lock().map_err(|_| "provider_registry_poisoned")?;
    let Some(manager) = entry.manager.as_ref() else {
        return Ok(json!({"status":"refreshing","activeRequests":entry.active_requests}));
    };
    let target = manager.reusable_target();
    let configured = crate::domains::queue_lifecycle::provider_execution::open_query_only_connection(path)
        .ok().and_then(|reader| reader.query_row("select value from settings where namespace='runtime' and key='settings.v1'", [], |row| row.get::<_, String>(0)).ok())
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|document| LarmConnectionConfig::from_settings(&document["settings"], id).ok().flatten());
    let matches = configured.is_some_and(|mut config| {
        let mut adopted = manager.config().clone();
        config.control_bearer_token = None;
        adopted.control_bearer_token = None;
        config == adopted
    });
    let capability = target.and_then(|t| {
        let runtime = LocalLlmTargetConfig {codex:false,quota_db:None,target_id:format!("larm:settings:{id}"),api_base_url:t.api_base_url.clone(),api_path:"/v1/chat/completions".into(),model:t.model.clone()};
        crate::domains::agent_runtime::measurement::RequestCapability::from_provider(&json!({"connectionId":t.connection_id,"allocationId":t.allocation_id,"publicModel":t.model,"providerBaseUrl":t.api_base_url,"credentialExpiresAt":t.expires_at,"contextWindow":t.context_window}), &runtime).ok()
    });
    let input_ceiling = capability.as_ref().map(|c| {
        c.window
            .max_tokens
            .saturating_sub(
                c.window
                    .output_reserve_tokens
                    .max(crate::domains::agent_runtime::budget::AGENT_OUTPUT_TOKENS),
            )
            .saturating_sub(c.window.safety_margin_tokens)
    });
    Ok(json!({
        "status":if !matches || entry.draining {"refreshing"} else if target.is_some() {"ready"} else {"unconfirmed"},
        "canonicalProfile":manager.connection().map(|c|&c.agent_profile),"connectionId":manager.connection_id(),
        "model":target.map(|t|&t.model),"endpoint":target.map(|t|&t.api_base_url),"expiresAt":target.map(|t|&t.expires_at),
        "contextWindow":target.map(|t|&t.context_window),"effectiveWindow":capability.as_ref().map(|c|&c.window),"inputEstimateCeiling":input_ceiling,
        "capacity":manager.cached_request_capacity(),"activeRequests":entry.active_requests,
        "providers":manager.connection().map(|c|c.providers.iter().map(|p|json!({"name":p.name,"model":p.model,"protocol":p.protocol,"status":format!("{:?}",p.readiness)})).collect::<Vec<_>>()),
        "reason":if !matches {"設定変更の適用待ちです。表示は現在採用中の接続です。".into()} else {format!("{:?}",manager.state())}
    }))
}

pub(crate) fn settings_provider_probe(
    path: &Path,
    config: LarmConnectionConfig,
    saved: bool,
) -> Result<Value, String> {
    use crate::domains::agent_runtime::transport::{send, CompletionRequest};
    let messages = json!([{"role":"user","content":"Return a JSON object with ok equal to true."}]);
    let probe =
        |target: &crate::domains::provider_connection::ClaimedLarmTarget| -> Result<Value, String> {
            let runtime = LocalLlmTargetConfig {
                codex: false,
                quota_db: None,
                target_id: format!("larm-agent-connection:{}", config.id),
                api_base_url: target.api_base_url.clone(),
                api_path: "/v1/chat/completions".into(),
                model: target.model.clone(),
            };
            let completion = send(CompletionRequest {
                target: &runtime,
                api_key: Some(target.bearer_token.as_str()),
                messages: &messages,
                max_output: 64,
                response_format: Some(super::super::structured_output::probe_format()),
                timeout_seconds: 15,
            })
            .map_err(|_| "provider_inference_failed")?;
            completion.validate_probe()?;
            Ok(
                json!({"model":target.model,"endpoint":target.api_base_url,"contextWindow":target.context_window}),
            )
        };
    let adopted = {
        let registry = LARM_CONNECTION_MANAGERS
            .get_or_init(|| Mutex::new(BTreeMap::new()))
            .lock()
            .map_err(|_| "provider_registry_poisoned")?;
        registry
            .get(&larm_manager_registry_key(path, &config.id))
            .is_some_and(|entry| {
                entry.lock().ok().is_some_and(|entry| {
                    !entry.checked_out
                        && !entry.draining
                        && !entry.cleanup_failed
                        && entry
                            .manager
                            .as_ref()
                            .is_some_and(|m| m.config() == &config && m.reusable_target().is_some())
                })
            })
    };
    if saved && adopted {
        let Some(mut checkout) =
            LarmManagerCheckout::take(path, &config).map_err(|_| "provider_unavailable")?
        else {
            return Err("provider_slot_busy".into());
        };
        if checkout.manager.is_some() {
            return Err("provider_slot_busy".into());
        }
        let (ready, target) = checkout
            .reconcile(true)
            .map_err(|_| "provider_control_failed")?;
        return target
            .filter(|_| ready.ready)
            .ok_or_else(|| "provider_slot_busy".to_owned())
            .and_then(|target| probe(&target));
    }
    let _gate = SETTINGS_TRIAL_GATE
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "provider_registry_poisoned")?;
    let registry = LARM_CONNECTION_MANAGERS
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .map_err(|_| "provider_registry_poisoned")?;
    for (key, entry) in registry.iter() {
        if key.runtime_scope == larm_manager_registry_key(path, &config.id).runtime_scope {
            let entry = entry.lock().map_err(|_| "provider_registry_poisoned")?;
            if entry.active_requests > 0 || entry.checked_out {
                return Err("provider_slot_busy".into());
            }
        }
    }
    drop(registry);
    // Same manager protocol, finite TTL and no persistent Queue identity.
    let mut trial = config.clone();
    trial.ttl_seconds = 60;
    trial.request_timeout_ms = 15_000;
    trial.ready_timeout_ms = trial.ready_timeout_ms.min(15_000);
    trial.control_timeout_ms = trial.control_timeout_ms.min(5_000);
    let mut manager = LarmConnectionManager::new(trial).map_err(|_| "provider_config_invalid")?;
    let result = (|| {
        let ready = manager
            .reconcile(true)
            .map_err(|_| "provider_control_failed")?;
        if !ready.ready {
            return Err("provider_not_ready".into());
        }
        manager
            .request_capacity()
            .map_err(|_| "provider_capacity_unconfirmed")?;
        probe(manager.target().ok_or("provider_target_missing")?)
    })();
    let release = manager
        .release()
        .map_err(|_| "provider_trial_release_failed".to_owned());
    match (result, release) {
        (Ok(v), Ok(())) => Ok(v),
        (Err(e), _) => Err(e),
        (_, Err(e)) => Err(e),
    }
}
