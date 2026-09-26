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
    claim_next_job_with_provider_lease_for_connection, heartbeat_provider_lease_for_connection,
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
}

struct LarmManagerCheckout {
    entry: Arc<Mutex<LarmManagerEntry>>,
    manager: Option<LarmConnectionManager>,
}

impl LarmManagerCheckout {
    fn take(sqlite_path: &Path, config: &LarmConnectionConfig) -> Result<Option<Self>, CliError> {
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
            return Err(CliError::runtime(format!(
                "LARM connection {} has an unconfirmed remote cleanup; refusing a new manager",
                config.id
            )));
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
        }
        Ok(Some(Self {
            entry: entry_handle,
            manager: Some(manager),
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
        let manager = self
            .manager
            .as_mut()
            .expect("checked-out LARM manager must exist");
        // Reconciliation performs control-plane HTTP.  The registry entry is not
        // locked here, so unrelated connections and drain requests can progress.
        let reconciled = manager.reconcile(due_job_exists)?;
        Ok((reconciled, manager.target().cloned()))
    }
}

impl Drop for LarmManagerCheckout {
    fn drop(&mut self) {
        let Some(manager) = self.manager.take() else {
            return;
        };
        if let Ok(mut entry) = self.entry.lock() {
            entry.manager = Some(manager);
            entry.checked_out = false;
        }
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
            if entry.checked_out {
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

pub(crate) fn release_dynamic_provider_connections() {
    release_unreferenced_larm_managers(None, &BTreeSet::new());
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

pub(crate) fn claim_dynamic_provider_execution_for_path(
    sqlite_path: &std::path::Path,
    queue_stale_seconds: u64,
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

    for plan in plans {
        let due_job_exists = dynamic_plan_has_runnable_job(&reader, &plan)?;
        let Some(mut manager) = LarmManagerCheckout::take(sqlite_path, &plan.connection)? else {
            continue;
        };
        let (target, api_key) = match manager.reconcile(due_job_exists) {
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
                )
            }
            Err(error) if error.kind == "transport" && due_job_exists => {
                let Some(local) = local_ornith_fallback(&settings, &reader, &plan.pool.targets[0])
                else {
                    eprintln!(
                        "LARM connection {} and local ornith are unavailable: {error}",
                        plan.connection.id
                    );
                    continue;
                };
                local
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
        let pool = plan.pool.clone();
        let priority_queues = plan.priority_queues.clone();
        let job = sqlite_writer::execute_for_path(
            sqlite_path,
            "queue.dynamic_provider_claim",
            move |connection| {
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
                    append_claimed_event(connection, job, &worker_id);
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

fn append_claimed_event(connection: &Connection, job: &ClaimedProviderLeaseJob, worker_id: &str) {
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
                "providerKind": "larm-agent-connection"
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
                max_concurrent: 1,
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
        let allowed = queue.allowed_route_values.as_deref().unwrap_or_default();
        let (route_condition, parameters) = route_filter(queue, allowed)?;
        let sql = format!(
            "select exists(
               select 1 from {table_name}
               where (
                 (status = 'pending' and (next_run_at is null or datetime(next_run_at) <= CURRENT_TIMESTAMP))
                 or (status = 'paused' and next_run_at is not null and datetime(next_run_at) <= CURRENT_TIMESTAMP)
               )
               {route_condition}
             )"
        );
        let exists = connection
            .query_row(&sql, rusqlite::params_from_iter(parameters), |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|error| {
                CliError::io(format!(
                    "failed to inspect dynamic {} queue: {error}",
                    queue.queue_name
                ))
            })?;
        if exists != 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

fn local_ornith_fallback(
    settings: &Value,
    reader: &Connection,
    target_id: &str,
) -> Option<(LocalLlmTargetConfig, Option<Zeroizing<String>>)> {
    let models = settings
        .pointer("/providers/local-llm/models")?
        .as_array()?;
    let model = models.iter().find(|model| {
        if !model
            .get("model")
            .and_then(Value::as_str)
            .is_some_and(|name| name.starts_with("ornith-"))
        {
            return false;
        }
        let Some(base_url) = model.get("apiBaseUrl").and_then(Value::as_str) else {
            return false;
        };
        reqwest::Url::parse(base_url).ok().is_some_and(|url| {
            url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
                && url.port_or_known_default().is_some()
        })
    })?;
    let base_url = model.get("apiBaseUrl")?.as_str()?.trim_end_matches('/');
    let health = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(700))
        .no_proxy()
        .build()
        .ok()?
        .get(format!("{base_url}/health"))
        .send()
        .ok()?;
    if !health.status().is_success()
        || health
            .json::<Value>()
            .ok()?
            .get("ready")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return None;
    }
    let api_key = crate::domains::secret_store::row_token(reader, "localLlmApiKey")
        .or_else(|| std::env::var("LOCAL_LLM_API_KEY").ok())
        .map(Zeroizing::new);
    Some((
        LocalLlmTargetConfig {
            codex: false,
            quota_db: None,
            target_id: target_id.to_string(),
            api_base_url: base_url.to_string(),
            api_path: model
                .get("apiPath")
                .and_then(Value::as_str)
                .unwrap_or("/v1/chat/completions")
                .to_string(),
            model: model.get("model")?.as_str()?.to_string(),
        },
        api_key,
    ))
}

fn route_filter<'a>(
    queue: &ProviderQueueClaimSpec,
    allowed: &'a [String],
) -> Result<(String, Vec<&'a String>), CliError> {
    if allowed.is_empty() {
        return Ok((String::new(), Vec::new()));
    }
    let column = match queue.route_target_column {
        Some("source_kind") => "source_kind",
        Some("provider_policy") => "provider_policy",
        Some(other) => {
            return Err(CliError::invalid_arguments(format!(
                "unsupported dynamic route column: {other}"
            )))
        }
        None => {
            return Err(CliError::invalid_arguments(format!(
                "dynamic queue {} restricts route values without a route column",
                queue.queue_name
            )))
        }
    };
    let placeholders = (1..=allowed.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    Ok((
        format!("and {column} in ({placeholders})"),
        allowed.iter().collect(),
    ))
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
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{}-{millis}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::super::executor::{executor_priority_queues_for_pool, provider_pools};
    use super::*;

    #[test]
    fn local_ornith_is_available_only_when_its_loopback_health_is_ready() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            use std::io::{Read, Write};
            let mut request = [0_u8; 1024];
            let size = stream.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..size]).starts_with("GET /health"));
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 14\r\nConnection: close\r\n\r\n{\"ready\":true}").unwrap();
        });
        let settings = json!({"providers":{"local-llm":{"models":[{"apiBaseUrl":format!("http://127.0.0.1:{port}"),"apiPath":"/v1/chat/completions","model":"ornith-1.0-9b-4bit"}]}}});
        let db = Connection::open_in_memory().unwrap();
        let (target, _) = local_ornith_fallback(&settings, &db, "fallback").unwrap();
        assert_eq!(target.model, "ornith-1.0-9b-4bit");
        assert_eq!(target.target_id, "fallback");
        server.join().unwrap();
    }

    fn larm_connection_config(id: &str) -> LarmConnectionConfig {
        let settings = json!({
            "providers": {
                "larm-agent-connection": {
                    "enabled": true,
                    "connections": [{
                        "id": id,
                        "controlBaseUrl": "http://127.0.0.1:9810",
                        "agentProfile": "contextstill-background",
                        "audience": "saaa-desktop",
                        "availabilityPollMs": 5000,
                        "availabilityTimeoutMs": 2000,
                        "controlTimeoutMs": 5000,
                        "readyTimeoutMs": 180000,
                        "ttlSeconds": 900,
                        "requestTimeoutMs": 300000
                    }]
                }
            }
        });
        LarmConnectionConfig::from_settings(&settings, id)
            .unwrap()
            .expect("enabled test LARM connection must be present")
    }

    #[test]
    fn manager_checkout_keeps_one_manager_per_runtime_connection() {
        let config = larm_connection_config("checkout-registry-test");
        let scope_path = std::env::temp_dir().join(format!(
            "context-stilld-checkout-registry-test-{}.sqlite",
            unique_suffix()
        ));
        let scope = scope_path.as_path();

        let first = LarmManagerCheckout::take(scope, &config).unwrap().unwrap();
        assert!(LarmManagerCheckout::take(scope, &config).unwrap().is_none());

        let first_entry = first.entry.clone();
        drop(first);

        let second = LarmManagerCheckout::take(scope, &config).unwrap().unwrap();
        assert!(Arc::ptr_eq(&first_entry, &second.entry));
    }

    #[test]
    fn builds_row_aware_larm_claim_plan() {
        let settings = json!({
            "providers": {
                "larm-agent-connection": {
                    "enabled": true,
                    "connections": [{
                        "id": "contextstill-background",
                        "controlBaseUrl": "http://127.0.0.1:9810",
                        "agentProfile": "contextstill-background",
                        "audience": "saaa-desktop",
                        "availabilityPollMs": 5000,
                        "availabilityTimeoutMs": 2000,
                        "controlTimeoutMs": 5000,
                        "readyTimeoutMs": 180000,
                        "ttlSeconds": 900,
                        "requestTimeoutMs": 300000
                    }]
                }
            },
            "taskRouting": {
                "findCandidate": {
                    "source": {"kind": "larm-agent-connection", "connectionId": "contextstill-background"},
                    "vibe": {"kind": "larm-agent-connection", "connectionId": "contextstill-background"}
                },
                "episodeDistiller": {"kind": "larm-agent-connection", "connectionId": "contextstill-background"}
            }
        });

        let plans = dynamic_provider_plans(&settings, &HashSet::new()).unwrap();

        assert_eq!(plans.len(), 1);
        assert_eq!(
            plans[0].pool.pool_id,
            "larm-agent-connection:contextstill-background"
        );
        assert_eq!(plans[0].priority_queues.len(), 2);
        assert_eq!(plans[0].priority_queues[0].queue_name, "findingCandidate");
        assert_eq!(
            plans[0].priority_queues[0].allowed_route_values,
            Some(vec![
                "knowledge_candidate".to_string(),
                "web_ingest".to_string(),
                "wiki_file".to_string(),
                "source".to_string(),
                "vibe_memory".to_string(),
            ])
        );
        assert_eq!(plans[0].priority_queues[1].queue_name, "episodeDistiller");

        let startup_lines = provider_startup_selection_lines(&settings).unwrap();
        assert_eq!(startup_lines.len(), 1);
        assert!(startup_lines[0].contains("providerKind=larm-agent-connection"));
        assert!(startup_lines[0].contains("provider=contextstill-background"));
        assert!(startup_lines[0].contains("controlHost=127.0.0.1:9810"));
        assert!(startup_lines[0].contains("agentProfile=contextStill"));
        assert!(startup_lines[0].contains("audience=same-host"));
        assert!(startup_lines[0]
            .contains("routes=findCandidate.source,findCandidate.vibe,episodeDistiller"));
        assert!(!startup_lines[0].to_ascii_lowercase().contains("token"));
    }

    #[test]
    fn startup_log_identifies_explicit_legacy_static_routes() {
        let settings = json!({
            "taskRouting": {
                "findCandidate": {
                    "source": {"kind": "static", "provider": "local-llm", "fallback": []},
                    "vibe": {"provider": "local-llm", "fallback": []}
                },
                "episodeDistiller": {"kind": "static", "provider": "local-llm", "fallback": []}
            }
        });

        let startup_lines = provider_startup_selection_lines(&settings).unwrap();

        assert_eq!(startup_lines.len(), 1);
        assert!(startup_lines[0].contains("providerKind=static provider=local-llm"));
        assert!(startup_lines[0].contains("controlHost=- agentProfile=- audience=-"));
    }

    #[test]
    fn static_rust_executor_does_not_claim_larm_dynamic_routes() {
        let settings = json!({
            "providerPools": [{
                "id": "dynamic-background",
                "enabled": true,
                "targets": [{
                    "provider": "larm-agent-connection",
                    "connectionId": "contextstill-background"
                }],
                "maxConcurrent": 1
            }],
            "taskRouting": {
                "findCandidate": {
                    "source": {
                        "kind": "larm-agent-connection",
                        "connectionId": "contextstill-background"
                    },
                    "vibe": {
                        "kind": "larm-agent-connection",
                        "connectionId": "contextstill-background"
                    }
                }
            }
        });

        assert!(provider_pools(&settings).is_empty());
        assert!(executor_priority_queues_for_pool(
            &settings,
            "dynamic-background",
            &HashSet::new()
        )
        .is_empty());
    }
    #[test]
    fn static_rust_executor_does_not_partially_execute_a_mixed_larm_pool() {
        let settings = json!({
            "providerPools": [{
                "id": "mixed-background",
                "enabled": true,
                "targets": [
                    {
                        "provider": "local-llm",
                        "localLlmModelId": "local-a"
                    },
                    {
                        "provider": "larm-agent-connection",
                        "connectionId": "contextstill-background"
                    }
                ],
                "maxConcurrent": 2
            }],
            "taskRouting": {
                "episodeDistiller": {
                    "provider": "local-llm",
                    "providerPoolId": "mixed-background",
                    "fallback": []
                }
            }
        });

        assert!(provider_pools(&settings).is_empty());
    }

    #[test]
    fn static_rust_executor_does_not_claim_a_dynamic_vibe_row_from_a_static_source_pool() {
        let settings = json!({
            "providerPools": [{
                "id": "static-source",
                "enabled": true,
                "targets": [{
                    "provider": "local-llm",
                    "localLlmModelId": "local-a"
                }],
                "maxConcurrent": 1
            }],
            "taskRouting": {
                "findCandidate": {
                    "source": {
                        "provider": "local-llm",
                        "providerPoolId": "static-source",
                        "fallback": []
                    },
                    "vibe": {
                        "kind": "larm-agent-connection",
                        "connectionId": "contextstill-background"
                    }
                }
            }
        });

        assert!(
            executor_priority_queues_for_pool(&settings, "static-source", &HashSet::new())
                .is_empty()
        );
    }
}
