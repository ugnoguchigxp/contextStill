use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use zeroize::Zeroizing;

use crate::domains::{
    provider_connection::{LarmConnectionConfig, LarmConnectionManager, LarmControlError},
    sqlite_writer,
};
use crate::shared::errors::CliError;

use super::common::queue_table_name;
use super::episode_executor::LocalLlmTargetConfig;
use super::events::append_queue_event_for_connection;
use super::provider_execution::open_query_only_connection;
use super::provider_lease::{
    claim_next_job_with_provider_lease_for_connection, has_runnable_provider_job,
    heartbeat_provider_lease_for_connection,
};
use super::state::heartbeat_queue_job_for_connection;
use super::types::{
    CandidatePolarityFilter, ClaimedProviderLeaseJob, ProviderPoolClaimConfig,
    ProviderQueueClaimSpec,
};

const STARTUP_LLM_ROUTES: [(&str, &str); 11] = [
    ("findCandidate.source", "/taskRouting/findCandidate/source"),
    ("findCandidate.vibe", "/taskRouting/findCandidate/vibe"),
    ("webSourceResearch", "/taskRouting/webSourceResearch"),
    ("episodeDistiller", "/taskRouting/episodeDistiller"),
    (
        "coverEvidence.sourceSupport",
        "/taskRouting/coverEvidence/sourceSupport",
    ),
    (
        "coverEvidence.externalEvidence",
        "/taskRouting/coverEvidence/externalEvidence",
    ),
    (
        "coverEvidence.mcpEvidence",
        "/taskRouting/coverEvidence/mcpEvidence",
    ),
    ("deadZoneMergeReview", "/taskRouting/deadZoneMergeReview"),
    ("landscapeCuration", "/taskRouting/landscapeCuration"),
    (
        "mergeActivationFinalize",
        "/taskRouting/mergeActivationFinalize",
    ),
    ("finalizeDistille", "/taskRouting/finalizeDistille"),
];

#[derive(Debug, Clone)]
struct DynamicProviderPlan {
    connection: LarmConnectionConfig,
    pool: ProviderPoolClaimConfig,
    priority_queues: Vec<ProviderQueueClaimSpec>,
}

pub(crate) struct DynamicProviderClaim {
    pub(crate) job: ClaimedProviderLeaseJob,
    pub(crate) target: LocalLlmTargetConfig,
    pub(crate) api_key: Option<Zeroizing<String>>,
    pub(crate) request_timeout_seconds: u64,
    _manager: LarmManagerCheckout,
}

impl DynamicProviderClaim {
    pub(crate) fn release_for_io(&mut self) {
        if self._manager.request_permit {
            if let Ok(mut entry) = self._manager.entry.lock() {
                entry.active_requests = entry.active_requests.saturating_sub(1);
                self._manager.request_permit = false;
            }
        }
    }
}

// The registry is intentionally scoped to a SQLite runtime.  Tests and residents can
// legitimately use the same configured connection id against different databases.
// Keeping the manager in the registry while it is checked out prevents a second
// control-plane connection from being created for the same runtime/connection pair.
type LarmManagerRegistry = BTreeMap<LarmManagerRegistryKey, Arc<Mutex<LarmManagerEntry>>>;

static LARM_CONNECTION_MANAGERS: OnceLock<Mutex<LarmManagerRegistry>> = OnceLock::new();

#[derive(Debug, Clone, Eq, Ord, PartialEq, PartialOrd)]
struct LarmManagerRegistryKey {
    runtime_scope: String,
    connection_id: String,
}

struct LarmManagerEntry {
    manager: Option<LarmConnectionManager>,
    checked_out: bool,
    draining: bool,
    cleanup_failed: bool,
    active_requests: u64,
}

// A finite draft probe blocks new request admission while checking an unadopted
// connection. Existing requests must drain first; no fifth inference can escape.
static SETTINGS_TRIAL_GATE: OnceLock<Mutex<()>> = OnceLock::new();

struct LarmManagerCheckout {
    entry: Arc<Mutex<LarmManagerEntry>>,
    manager: Option<LarmConnectionManager>,
    request_permit: bool,
    expected_config: LarmConnectionConfig,
}

impl LarmManagerCheckout {
    fn take(sqlite_path: &Path, config: &LarmConnectionConfig) -> Result<Option<Self>, CliError> {
        Self::take_for_reconcile(sqlite_path, config, false)
    }

    fn take_for_reconcile(
        sqlite_path: &Path,
        config: &LarmConnectionConfig,
        refresh: bool,
    ) -> Result<Option<Self>, CliError> {
        let mut authenticated = config.clone();
        if authenticated.control_bearer_token.is_none() && sqlite_path.exists() {
            let reader = open_query_only_connection(sqlite_path)?;
            if let Some(token) = crate::domains::secret_store::row_token(&reader, "larmApiToken") {
                authenticated.control_bearer_token = Some(
                    crate::domains::secret_store::resolve(&token)
                        .map_err(|_| CliError::runtime("larm_credential_unavailable"))?,
                );
            }
        }
        let config = &authenticated;
        let registry = LARM_CONNECTION_MANAGERS.get_or_init(|| Mutex::new(BTreeMap::new()));
        let key = larm_manager_registry_key(sqlite_path, &config.id);
        let state_path = sqlite_path.with_extension(format!("larm-{}.json", config.id));
        let new_manager = LarmConnectionManager::new_persistent(config.clone(), state_path.clone())
            .map_err(|error| {
                CliError::io(format!(
                    "failed to initialize LARM connection {}: {error}",
                    config.id
                ))
            })?;
        let entry_handle = {
            let mut registry = registry
                .lock()
                .map_err(|_| CliError::runtime("LARM connection manager registry is poisoned"))?;
            registry
                .entry(key)
                .or_insert_with(|| {
                    Arc::new(Mutex::new(LarmManagerEntry {
                        manager: Some(new_manager),
                        checked_out: false,
                        draining: false,
                        cleanup_failed: false,
                        active_requests: 0,
                    }))
                })
                .clone()
        };
        let mut entry = entry_handle
            .lock()
            .map_err(|_| CliError::runtime("LARM connection manager entry is poisoned"))?;
        if entry.checked_out {
            return Ok(None);
        }
        if entry.cleanup_failed {
            // Retry release of the retained identity before allowing another connection.
            // A transient DELETE failure must not require restarting the resident.
            entry.draining = true;
        }
        if !refresh
            && !entry.draining
            && entry.manager.as_ref().is_some_and(|manager| {
                manager.config() == config && manager.reusable_target().is_some()
            })
        {
            drop(entry);
            return Ok(Some(Self {
                entry: entry_handle,
                manager: None,
                request_permit: false,
                expected_config: config.clone(),
            }));
        }
        // Renew, reconfigure and release only after every request using the old token ends.
        if entry.active_requests > 0 {
            return Ok(None);
        }
        let mut manager = entry
            .manager
            .take()
            .ok_or_else(|| CliError::runtime("available LARM manager entry has no manager"))?;
        entry.checked_out = true;
        drop(entry);

        if manager.config() != config || manager_needs_drain(&entry_handle) {
            if let Err(error) = manager.release() {
                restore_failed_manager(&entry_handle, manager);
                return Err(CliError::io(format!(
                    "failed to release reconfigured LARM connection {}: {error}",
                    config.id
                )));
            }
            if manager.config() != config {
                manager = LarmConnectionManager::new_persistent(config.clone(), state_path)
                    .map_err(|error| {
                        restore_failed_manager(&entry_handle, manager);
                        CliError::io(format!(
                            "failed to reinitialize LARM connection {}: {error}",
                            config.id
                        ))
                    })?;
            }
            let mut entry = entry_handle
                .lock()
                .map_err(|_| CliError::runtime("LARM connection manager entry is poisoned"))?;
            entry.draining = false;
            entry.cleanup_failed = false;
        }
        Ok(Some(Self {
            entry: entry_handle,
            manager: Some(manager),
            request_permit: false,
            expected_config: config.clone(),
        }))
    }

    fn reconcile(
        &mut self,
        due_job_exists: bool,
    ) -> Result<
        (
            crate::domains::provider_connection::LarmReconcileResult,
            Option<crate::domains::provider_connection::ClaimedLarmTarget>,
        ),
        LarmControlError,
    > {
        let _admission = if due_job_exists {
            Some(
                SETTINGS_TRIAL_GATE
                    .get_or_init(|| Mutex::new(()))
                    .lock()
                    .map_err(|_| LarmControlError::configuration("settings_probe_gate_poisoned"))?,
            )
        } else {
            None
        };
        if self.request_permit {
            return Err(LarmControlError::configuration(
                "checkout already has a request permit",
            ));
        }
        // Control-plane HTTP runs only while this checkout exclusively owns the manager.
        let controlled_result = if let Some(manager) = self.manager.as_mut() {
            let result = manager.reconcile(due_job_exists)?;
            if result.ready {
                manager.request_capacity()?;
            }
            Some(result)
        } else {
            None
        };
        let mut entry = self
            .entry
            .lock()
            .map_err(|_| LarmControlError::configuration("LARM entry poisoned"))?;
        if let Some(manager) = self.manager.take() {
            entry.manager = Some(manager);
            entry.checked_out = false;
        }
        if let Some(result) = controlled_result.as_ref().filter(|result| !result.ready) {
            return Ok((result.clone(), None));
        }
        if entry.checked_out || entry.draining || entry.cleanup_failed {
            return Ok((waiting_request_permit(), None));
        }
        let Some(manager) = entry
            .manager
            .as_ref()
            .filter(|manager| manager.config() == &self.expected_config)
        else {
            return Ok((waiting_request_permit(), None));
        };
        let Some(target) = manager.reusable_target().cloned() else {
            return Ok((waiting_request_permit(), None));
        };
        let capacity = manager.cached_request_capacity().unwrap_or(0);
        if due_job_exists {
            if entry.active_requests >= capacity {
                return Ok((waiting_request_permit(), None));
            }
            // Validate the target and acquire the permit under the same lock. A renewal,
            // release or settings replacement cannot intervene between these operations.
            entry.active_requests += 1;
            self.request_permit = true;
        }
        Ok((
            controlled_result.unwrap_or_else(|| {
                crate::domains::provider_connection::LarmReconcileResult {
                    state: crate::domains::provider_connection::LarmConnectionManagerState::Ready,
                    ready: true,
                    reason_code: Some("connection_ready".into()),
                    retry_after_ms: 0,
                }
            }),
            Some(target),
        ))
    }
}

impl Drop for LarmManagerCheckout {
    fn drop(&mut self) {
        if let Ok(mut entry) = self.entry.lock() {
            if self.request_permit {
                entry.active_requests = entry.active_requests.saturating_sub(1);
            }
            if let Some(manager) = self.manager.take() {
                entry.manager = Some(manager);
                entry.checked_out = false;
            }
        }
    }
}

fn waiting_request_permit() -> crate::domains::provider_connection::LarmReconcileResult {
    crate::domains::provider_connection::LarmReconcileResult {
        state: crate::domains::provider_connection::LarmConnectionManagerState::Ready,
        ready: false,
        reason_code: Some("waiting_request_capacity".into()),
        retry_after_ms: 1000,
    }
}

fn manager_needs_drain(entry: &Arc<Mutex<LarmManagerEntry>>) -> bool {
    entry.lock().map(|entry| entry.draining).unwrap_or(true)
}

fn restore_failed_manager(entry: &Arc<Mutex<LarmManagerEntry>>, manager: LarmConnectionManager) {
    if let Ok(mut entry) = entry.lock() {
        entry.manager = Some(manager);
        entry.checked_out = false;
        entry.draining = true;
        entry.cleanup_failed = true;
    }
}

fn larm_manager_registry_key(sqlite_path: &Path, connection_id: &str) -> LarmManagerRegistryKey {
    LarmManagerRegistryKey {
        runtime_scope: sqlite_path.to_string_lossy().into_owned(),
        connection_id: connection_id.to_string(),
    }
}

fn release_unreferenced_larm_managers(
    runtime_scope: Option<&Path>,
    active_connection_ids: &BTreeSet<String>,
) {
    let Some(registry) = LARM_CONNECTION_MANAGERS.get() else {
        return;
    };
    let Ok(registry) = registry.lock() else {
        return;
    };
    let scope = runtime_scope.map(|path| path.to_string_lossy().into_owned());
    let stale_entries = registry
        .iter()
        .filter(|(key, _)| {
            scope
                .as_ref()
                .is_none_or(|scope| key.runtime_scope == *scope)
                && !active_connection_ids.contains(&key.connection_id)
        })
        .map(|(key, entry)| (key.clone(), entry.clone()))
        .collect::<Vec<_>>();
    drop(registry);

    for (_, entry_handle) in stale_entries {
        let mut manager = {
            let Ok(mut entry) = entry_handle.lock() else {
                continue;
            };
            entry.draining = true;
            if entry.checked_out || entry.active_requests > 0 {
                // The active request owns the connection.  Its checkout will put
                // the manager back; the next maintenance pass can release it.
                continue;
            }
            let Some(manager) = entry.manager.take() else {
                continue;
            };
            entry.checked_out = true;
            manager
        };

        // Remote cleanup must not hold either the registry lock or an entry lock.
        let release_result = manager.release();
        if let Ok(mut entry) = entry_handle.lock() {
            entry.manager = Some(manager);
            entry.checked_out = false;
            entry.cleanup_failed = release_result.is_err();
        }
    }
}

pub(crate) fn release_dynamic_provider_connections(path: &Path) {
    release_unreferenced_larm_managers(Some(path), &BTreeSet::new());
    super::larm_embedding::shutdown();
}

pub(crate) fn log_provider_startup_selection_for_path(sqlite_path: &std::path::Path) {
    let result = open_query_only_connection(sqlite_path).and_then(|reader| {
        load_settings_document(&reader).and_then(|settings| match settings {
            Some(settings) => provider_startup_selection_lines(&settings),
            None => Ok(vec![
                "resident LLM provider selection: providerKind=unconfigured".to_string(),
            ]),
        })
    });
    match result {
        Ok(lines) if lines.is_empty() => {
            eprintln!("resident LLM provider selection: providerKind=unconfigured");
        }
        Ok(lines) => {
            for line in lines {
                eprintln!("{line}");
            }
        }
        Err(error) => {
            eprintln!("resident LLM provider selection unavailable: {error}");
        }
    }
}

fn provider_startup_selection_lines(settings: &Value) -> Result<Vec<String>, CliError> {
    type SelectionKey = (String, String, String, String, String);
    let mut grouped = BTreeMap::<SelectionKey, Vec<&str>>::new();
    for (route_name, pointer) in STARTUP_LLM_ROUTES {
        let Some(route) = settings.pointer(pointer) else {
            continue;
        };
        let key = if is_larm_route(route) {
            let connection_id = string_field(route, "connectionId").ok_or_else(|| {
                CliError::invalid_arguments(format!(
                    "dynamic route {route_name} has no LARM connectionId"
                ))
            })?;
            let connection = LarmConnectionConfig::from_settings(settings, &connection_id)
                .map_err(|error| {
                    CliError::invalid_arguments(format!(
                        "invalid LARM connection {connection_id}: {error}"
                    ))
                })?
                .ok_or_else(|| {
                    CliError::invalid_arguments(format!(
                        "dynamic route {route_name} selected a disabled LARM Provider"
                    ))
                })?;
            (
                "larm-agent-connection".to_string(),
                connection_id,
                control_host_label(&connection.control_base_url)?,
                "contextStill".to_string(),
                connection.audience,
            )
        } else {
            (
                "static".to_string(),
                string_field(route, "provider").unwrap_or_else(|| "unconfigured".to_string()),
                "-".to_string(),
                "-".to_string(),
                "-".to_string(),
            )
        };
        grouped.entry(key).or_default().push(route_name);
    }

    Ok(grouped
        .into_iter()
        .map(
            |((provider_kind, provider, control_host, agent_profile, audience), routes)| {
                format!(
                    "resident LLM provider selection: routes={} providerKind={provider_kind} provider={provider} controlHost={control_host} agentProfile={agent_profile} audience={audience}",
                    routes.join(",")
                )
            },
        )
        .collect())
}

fn control_host_label(control_base_url: &str) -> Result<String, CliError> {
    let url = reqwest::Url::parse(control_base_url).map_err(|error| {
        CliError::invalid_arguments(format!("invalid LARM controlBaseUrl: {error}"))
    })?;
    let host = url
        .host_str()
        .ok_or_else(|| CliError::invalid_arguments("LARM controlBaseUrl host is missing"))?;
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    Ok(match url.port_or_known_default() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

pub(crate) fn dynamic_provider_routes_configured(
    sqlite_path: &std::path::Path,
) -> Result<bool, CliError> {
    let reader = open_query_only_connection(sqlite_path)?;
    let Some(settings) = load_settings_document(&reader)? else {
        return Ok(false);
    };
    let configured = settings
        .pointer("/providers/larm-agent-connection/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && task_routing_routes(&settings)
            .into_iter()
            .any(is_larm_route);
    if !configured {
        release_unreferenced_larm_managers(Some(sqlite_path), &BTreeSet::new());
    }
    Ok(configured)
}

pub(crate) fn dynamic_worker_capacity(settings: &Value) -> Result<u64, CliError> {
    Ok(dynamic_provider_plans(settings, &HashSet::new())?
        .iter()
        .map(|plan| plan.connection.max_concurrent_requests)
        .sum())
}

// Resolve once before starting the worker batch, so the first create/claim cannot cause
// the other workers to exit before a shared target exists.
pub(crate) fn prepare_dynamic_provider_connections(
    sqlite_path: &Path,
    covering_mode: &str,
    canary_job_ids: &[String],
) -> Result<(), CliError> {
    let reader = open_query_only_connection(sqlite_path)?;
    let settings = load_settings_document(&reader)?.unwrap_or_else(|| json!({}));
    let paused = load_paused_queues(&reader)?;
    for mut plan in dynamic_provider_plans(&settings, &paused)? {
        apply_covering_mode(&mut plan, covering_mode, canary_job_ids);
        if !dynamic_plan_has_runnable_job(&reader, &plan)? {
            continue;
        }
        if let Some(mut checkout) =
            LarmManagerCheckout::take_for_reconcile(sqlite_path, &plan.connection, true)?
        {
            if let Err(error) = checkout.reconcile(false) {
                eprintln!(
                    "LARM connection {} preparation failed: {error}",
                    plan.connection.id
                );
            }
        }
    }
    Ok(())
}

pub(crate) fn claim_dynamic_provider_execution_for_path(
    sqlite_path: &std::path::Path,
    queue_stale_seconds: u64,
    covering_mode: &str,
    canary_job_ids: &[String],
) -> Result<Option<DynamicProviderClaim>, CliError> {
    let reader = open_query_only_connection(sqlite_path)?;
    let Some(settings) = load_settings_document(&reader)? else {
        return Ok(None);
    };
    let paused_queues = load_paused_queues(&reader)?;
    let plans = dynamic_provider_plans(&settings, &paused_queues)?;
    let active_connection_ids = plans
        .iter()
        .map(|plan| plan.connection.id.clone())
        .collect::<BTreeSet<_>>();
    release_unreferenced_larm_managers(Some(sqlite_path), &active_connection_ids);

    for mut plan in plans {
        apply_covering_mode(&mut plan, covering_mode, canary_job_ids);
        let due_job_exists = dynamic_plan_has_runnable_job(&reader, &plan)?;
        if !due_job_exists {
            continue;
        }
        let Some(mut manager) = LarmManagerCheckout::take(sqlite_path, &plan.connection)? else {
            continue;
        };
        let (target, api_key, telemetry) = match manager.reconcile(due_job_exists) {
            Ok((reconciled, claimed_target)) if due_job_exists && reconciled.ready => {
                let claimed_target = claimed_target
                    .as_ref()
                    .ok_or_else(|| CliError::runtime("ready LARM manager has no claimed target"))?;
                (
                    LocalLlmTargetConfig {
                        codex: false,
                        quota_db: None,
                        target_id: plan.pool.targets[0].clone(),
                        api_base_url: claimed_target.api_base_url.clone(),
                        api_path: "/v1/chat/completions".to_string(),
                        model: claimed_target.model.clone(),
                    },
                    Some(Zeroizing::new(
                        claimed_target.bearer_token.as_str().to_string(),
                    )),
                    json!({"requestedProfile":"contextStill", "connectionId":claimed_target.connection_id, "allocationId":claimed_target.allocation_id, "providerName":"llm", "publicModel":claimed_target.model, "providerBaseUrl":claimed_target.api_base_url, "credentialExpiresAt":claimed_target.expires_at, "contextWindow":claimed_target.context_window}),
                )
            }
            Err(error) => {
                eprintln!(
                    "LARM connection {} is unavailable; queue remains unclaimed: {error}",
                    plan.connection.id
                );
                continue;
            }
            Ok(_) => continue,
        };
        if target.model.trim() == "coding-default" {
            continue;
        }
        let worker_id = format!(
            "context-stilld-rust-executor:{}:{}",
            plan.pool.pool_id,
            unique_suffix()
        );
        let lease_id = format!("rust-lease-{}", unique_suffix());
        let mut pool = plan.pool.clone();
        pool.max_concurrent = manager
            .entry
            .lock()
            .map_err(|_| CliError::runtime("LARM entry poisoned"))?
            .manager
            .as_ref()
            .and_then(|manager| manager.cached_request_capacity())
            .ok_or_else(|| CliError::runtime("shared LARM manager capacity missing"))?;
        let mut telemetry = telemetry;
        if let Some(connection) = manager
            .entry
            .lock()
            .map_err(|_| CliError::runtime("LARM entry poisoned"))?
            .manager
            .as_ref()
            .and_then(|manager| manager.connection())
        {
            telemetry["canonicalProfile"] = json!(connection.agent_profile);
            telemetry["catalogRevision"] = json!(connection.catalog_revision);
            telemetry["bootEpoch"] = json!(connection.boot_epoch);
        }
        telemetry["controlOrigin"] = json!(plan.connection.control_base_url);
        telemetry["requestId"] = json!(lease_id);
        telemetry["maxConcurrentRequests"] = json!(pool.max_concurrent);
        let expected_config = plan.connection.clone();
        let covering_mode = covering_mode.to_string();
        let canary_job_ids = canary_job_ids.to_vec();
        let job = sqlite_writer::execute_for_path(
            sqlite_path,
            "queue.dynamic_provider_claim",
            move |connection| {
                // Control-plane waits can outlast a pause or route change. Re-read the
                // authoritative settings on the writer immediately before claiming.
                let priority_queues = revalidated_claim_queues(
                    connection,
                    &expected_config,
                    &covering_mode,
                    &canary_job_ids,
                )
                .map_err(|error| error.to_string())?;
                let job = claim_next_job_with_provider_lease_for_connection(
                    connection,
                    &pool,
                    &priority_queues,
                    &worker_id,
                    &lease_id,
                    queue_stale_seconds,
                )
                .map_err(|error| error.to_string())?;
                if let Some(job) = job.as_ref() {
                    connection.execute("update llm_provider_leases set metadata=?2 where id=?1 and status='active'",rusqlite::params![job.provider_lease.id,telemetry.to_string()]).map_err(|e|e.to_string())?;
                    append_claimed_event(connection, job, &worker_id, &telemetry);
                    heartbeat_claim(connection, job);
                }
                Ok(job)
            },
        )
        .map_err(|error| CliError::io(format!("SQLite writer dynamic claim failed: {error}")))?;
        let Some(job) = job else {
            continue;
        };
        return Ok(Some(DynamicProviderClaim {
            job,
            target,
            api_key,
            request_timeout_seconds: plan.connection.request_timeout_ms.div_ceil(1_000),
            _manager: manager,
        }));
    }
    Ok(None)
}

fn revalidated_claim_queues(
    connection: &Connection,
    expected: &LarmConnectionConfig,
    covering_mode: &str,
    canary_job_ids: &[String],
) -> Result<Vec<ProviderQueueClaimSpec>, CliError> {
    let Some(settings) = load_settings_document(connection)? else {
        return Ok(Vec::new());
    };
    let paused = load_paused_queues(connection)?;
    let Some(mut plan) = dynamic_provider_plans(&settings, &paused)?
        .into_iter()
        .find(|plan| plan.connection == *expected)
    else {
        return Ok(Vec::new());
    };
    apply_covering_mode(&mut plan, covering_mode, canary_job_ids);
    Ok(plan.priority_queues)
}

fn append_claimed_event(
    connection: &Connection,
    job: &ClaimedProviderLeaseJob,
    worker_id: &str,
    telemetry: &Value,
) {
    if let Err(error) = append_queue_event_for_connection(
        connection,
        &format!("rust-queue-event-{}", unique_suffix()),
        &job.queue_name,
        &job.id,
        "claimed",
        Some("job claimed for dynamic LARM execution"),
        Some(
            &json!({
                "workerId": worker_id,
                "executor": "rust",
                "providerKind": "larm-agent-connection",
                "larm": telemetry
            })
            .to_string(),
        ),
    ) {
        eprintln!(
            "failed to append dynamic {}/{} claimed queue event: {error}",
            job.queue_name, job.id
        );
    }
}

fn heartbeat_claim(connection: &Connection, job: &ClaimedProviderLeaseJob) {
    if let Err(error) = heartbeat_queue_job_for_connection(connection, &job.queue_name, &job.id) {
        eprintln!(
            "failed to heartbeat newly claimed dynamic {}/{} queue job: {error}",
            job.queue_name, job.id
        );
    }
    if let Err(error) = heartbeat_provider_lease_for_connection(connection, &job.provider_lease.id)
    {
        eprintln!(
            "failed to heartbeat newly claimed dynamic provider lease {}: {error}",
            job.provider_lease.id
        );
    }
}

fn apply_covering_mode(plan: &mut DynamicProviderPlan, mode: &str, canary_job_ids: &[String]) {
    let mut queues = Vec::new();
    for mut spec in std::mem::take(&mut plan.priority_queues) {
        if spec.queue_name == "coveringEvidence" {
            match mode {
                "negative" => spec.candidate_polarity_filter = CandidatePolarityFilter::Negative,
                "canary" => {
                    let mut negative = spec.clone();
                    negative.candidate_polarity_filter = CandidatePolarityFilter::Negative;
                    queues.push(negative);
                    if canary_job_ids.is_empty() {
                        continue;
                    }
                    spec.candidate_polarity_filter = CandidatePolarityFilter::NonNegative;
                    spec.allowed_job_ids = Some(canary_job_ids.to_vec());
                }
                "all" => {}
                _ => continue,
            }
        }
        queues.push(spec);
    }
    plan.priority_queues = queues;
}

fn dynamic_provider_plans(
    settings: &Value,
    paused_queues: &HashSet<String>,
) -> Result<Vec<DynamicProviderPlan>, CliError> {
    let connection_ids = task_routing_routes(settings)
        .into_iter()
        .filter(|route| is_larm_route(route))
        .filter_map(|route| string_field(route, "connectionId"))
        .collect::<BTreeSet<_>>();
    let mut plans = Vec::new();
    for connection_id in connection_ids {
        let Some(connection) = LarmConnectionConfig::from_settings(settings, &connection_id)
            .map_err(|error| {
                CliError::invalid_arguments(format!(
                    "invalid LARM connection {connection_id}: {error}"
                ))
            })?
        else {
            continue;
        };
        let target_id = format!("larm-agent-connection:{connection_id}");
        let mut priority_queues = Vec::new();
        push_finding_plan(
            settings,
            paused_queues,
            &connection_id,
            &target_id,
            &mut priority_queues,
        );
        if !paused_queues.contains("coveringEvidence")
            && [
                "/taskRouting/coverEvidence/sourceSupport",
                "/taskRouting/coverEvidence/externalEvidence",
                "/taskRouting/coverEvidence/mcpEvidence",
            ]
            .iter()
            .all(|pointer| {
                route_connection_id(settings, pointer).as_deref() == Some(connection_id.as_str())
            })
        {
            priority_queues.push(ProviderQueueClaimSpec {
                queue_name: "coveringEvidence".into(),
                preferred_target_ids: vec![target_id.clone()],
                route_target_column: Some("provider_policy"),
                route_target_preferences: vec![],
                allowed_route_values: Some(vec!["default".into()]),
                candidate_polarity_filter: CandidatePolarityFilter::Any,
                allowed_job_ids: None,
            });
        }
        push_episode_plan(
            settings,
            paused_queues,
            &connection_id,
            &target_id,
            &mut priority_queues,
        );
        if !paused_queues.contains("landscapeCuration")
            && route_connection_id(settings, "/taskRouting/landscapeCuration").as_deref()
                == Some(connection_id.as_str())
        {
            priority_queues.push(ProviderQueueClaimSpec {
                queue_name: "landscapeCuration".into(),
                preferred_target_ids: vec![target_id.clone()],
                route_target_column: None,
                route_target_preferences: Vec::new(),
                allowed_route_values: None,
                candidate_polarity_filter: CandidatePolarityFilter::Any,
                allowed_job_ids: None,
            });
        }
        if priority_queues.is_empty() {
            continue;
        }
        plans.push(DynamicProviderPlan {
            pool: ProviderPoolClaimConfig {
                pool_id: target_id.clone(),
                targets: vec![target_id],
                max_concurrent: connection.max_concurrent_requests,
                stale_lease_seconds: connection.ttl_seconds.min(900),
                low_priority_aging_seconds: 1800,
            },
            connection,
            priority_queues,
        });
    }
    Ok(plans)
}

fn push_finding_plan(
    settings: &Value,
    paused_queues: &HashSet<String>,
    connection_id: &str,
    target_id: &str,
    queues: &mut Vec<ProviderQueueClaimSpec>,
) {
    if paused_queues.contains("findingCandidate") {
        return;
    }
    let source_connection = route_connection_id(settings, "/taskRouting/findCandidate/source");
    let vibe_connection = route_connection_id(settings, "/taskRouting/findCandidate/vibe");
    let mut allowed_route_values = Vec::new();
    if source_connection.as_deref() == Some(connection_id) {
        allowed_route_values.extend(
            ["knowledge_candidate", "web_ingest", "wiki_file", "source"]
                .into_iter()
                .map(str::to_string),
        );
    }
    if vibe_connection.as_deref() == Some(connection_id) {
        allowed_route_values.push("vibe_memory".to_string());
    }
    if allowed_route_values.is_empty() {
        return;
    }
    queues.push(ProviderQueueClaimSpec {
        queue_name: "findingCandidate".to_string(),
        preferred_target_ids: vec![target_id.to_string()],
        route_target_column: Some("source_kind"),
        route_target_preferences: Vec::new(),
        allowed_route_values: Some(allowed_route_values),
        candidate_polarity_filter: CandidatePolarityFilter::Any,
        allowed_job_ids: None,
    });
}

fn push_episode_plan(
    settings: &Value,
    paused_queues: &HashSet<String>,
    connection_id: &str,
    target_id: &str,
    queues: &mut Vec<ProviderQueueClaimSpec>,
) {
    if paused_queues.contains("episodeDistiller")
        || route_connection_id(settings, "/taskRouting/episodeDistiller").as_deref()
            != Some(connection_id)
    {
        return;
    }
    queues.push(ProviderQueueClaimSpec {
        queue_name: "episodeDistiller".to_string(),
        preferred_target_ids: vec![target_id.to_string()],
        route_target_column: None,
        route_target_preferences: Vec::new(),
        allowed_route_values: None,
        candidate_polarity_filter: CandidatePolarityFilter::Any,
        allowed_job_ids: None,
    });
}

fn dynamic_plan_has_runnable_job(
    connection: &Connection,
    plan: &DynamicProviderPlan,
) -> Result<bool, CliError> {
    for queue in &plan.priority_queues {
        let table_name = queue_table_name(&queue.queue_name)?;
        if !table_exists(connection, table_name)? {
            continue;
        }
        if has_runnable_provider_job(connection, queue)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn load_settings_document(connection: &Connection) -> Result<Option<Value>, CliError> {
    if !table_exists(connection, "settings")? {
        return Ok(None);
    }
    let value = connection
        .query_row(
            "select value from settings where namespace = 'runtime' and key = 'settings.v1' limit 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CliError::io(format!("failed to load runtime settings: {error}")))?;
    let Some(value) = value else {
        return Ok(None);
    };
    let document = serde_json::from_str::<Value>(&value)
        .map_err(|error| CliError::io(format!("failed to parse runtime settings: {error}")))?;
    Ok(Some(document.get("settings").cloned().unwrap_or(document)))
}

fn load_paused_queues(connection: &Connection) -> Result<HashSet<String>, CliError> {
    let value = connection
        .query_row(
            "select value from settings where namespace = 'runtime' and key = 'queue.controls.v1' limit 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CliError::io(format!("failed to load queue controls: {error}")))?;
    let Some(value) = value else {
        return Ok(HashSet::new());
    };
    let document = serde_json::from_str::<Value>(&value)
        .map_err(|error| CliError::io(format!("failed to parse queue controls: {error}")))?;
    Ok(document
        .get("queues")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|queues| queues.iter())
        .filter_map(|(queue_name, control)| {
            control
                .get("paused")
                .and_then(Value::as_bool)
                .filter(|paused| *paused)
                .map(|_| queue_name.clone())
        })
        .collect())
}

fn task_routing_routes(settings: &Value) -> Vec<&Value> {
    [
        "/taskRouting/findCandidate/source",
        "/taskRouting/findCandidate/vibe",
        "/taskRouting/webSourceResearch",
        "/taskRouting/episodeDistiller",
        "/taskRouting/coverEvidence/sourceSupport",
        "/taskRouting/coverEvidence/externalEvidence",
        "/taskRouting/coverEvidence/mcpEvidence",
        "/taskRouting/deadZoneMergeReview",
        "/taskRouting/landscapeCuration",
        "/taskRouting/mergeActivationFinalize",
        "/taskRouting/finalizeDistille",
    ]
    .into_iter()
    .filter_map(|pointer| settings.pointer(pointer))
    .collect()
}

fn route_connection_id(settings: &Value, pointer: &str) -> Option<String> {
    settings
        .pointer(pointer)
        .filter(|route| is_larm_route(route))
        .and_then(|route| string_field(route, "connectionId"))
}

fn is_larm_route(route: &Value) -> bool {
    string_field(route, "kind").as_deref() == Some("larm-agent-connection")
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn table_exists(connection: &Connection, table_name: &str) -> Result<bool, CliError> {
    connection
        .query_row(
            "select exists(select 1 from sqlite_master where type = 'table' and name = ?1)",
            [table_name],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(|error| {
            CliError::io(format!(
                "failed to inspect SQLite table {table_name}: {error}"
            ))
        })
}

fn unique_suffix() -> String {
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!(
        "{}-{millis}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

/// Child research uses the very same manager checkout and SQLite pool as Queue work.
pub(crate) struct ResearchProviderPermit {
    pub(crate) target: LocalLlmTargetConfig,
    pub(crate) api_key: Zeroizing<String>,
    pub(crate) metadata: Value,
    pub(crate) pool_id: String,
    pub(crate) capacity: u64,
    _manager: LarmManagerCheckout,
}
pub(crate) fn research_provider_permit(
    path: &Path,
    queue: &str,
) -> Result<Option<ResearchProviderPermit>, String> {
    let reader = open_query_only_connection(path).map_err(|e| e.to_string())?;
    let settings = load_settings_document(&reader)
        .map_err(|e| e.to_string())?
        .ok_or("settings_missing")?;
    let plan = dynamic_provider_plans(&settings, &HashSet::new())
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|p| p.priority_queues.iter().any(|q| q.queue_name == queue))
        .ok_or("research_route_missing")?;
    let Some(mut manager) =
        LarmManagerCheckout::take(path, &plan.connection).map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    let (ready, target) = manager
        .reconcile(true)
        .map_err(|_| "research_provider_unavailable")?;
    let Some(target) = target.filter(|_| ready.ready) else {
        return Ok(None);
    };
    let capacity = manager
        .entry
        .lock()
        .map_err(|_| "provider_registry_poisoned")?
        .manager
        .as_ref()
        .and_then(|m| m.cached_request_capacity())
        .ok_or("provider_capacity_missing")?;
    Ok(Some(ResearchProviderPermit {
        metadata: json!({"connectionId":target.connection_id,"allocationId":target.allocation_id,"publicModel":target.model,"providerBaseUrl":target.api_base_url,"credentialExpiresAt":target.expires_at,"contextWindow":target.context_window,"controlOrigin":plan.connection.control_base_url}),
        target: LocalLlmTargetConfig {
            codex: false,
            quota_db: None,
            target_id: plan.pool.targets[0].clone(),
            api_base_url: target.api_base_url,
            api_path: "/v1/chat/completions".into(),
            model: target.model,
        },
        api_key: target.bearer_token,
        pool_id: plan.pool.pool_id,
        capacity,
        _manager: manager,
    }))
}

mod settings;
pub(crate) use settings::{settings_provider_probe, settings_provider_runtime};

mod tests;
