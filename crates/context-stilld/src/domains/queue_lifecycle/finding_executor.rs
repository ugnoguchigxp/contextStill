use reqwest::blocking::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::shared::agent_session::{is_agent_session_api_path, AgentSessionRequest};
use crate::shared::errors::CliError;

use super::episode_executor::LocalLlmTargetConfig;
use super::events::append_queue_event_for_connection;
use super::provider_execution::owns_provider_execution;
use super::types::{ClaimedProviderLeaseJob, ProviderLeaseAssignment};

const FINDING_VERSION: &str = "finding-candidate-rust-v1";
const MAX_CANDIDATES_PER_JOB: usize = 20;

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) enum FindingExecutionStatus {
    Completed,
    Skipped,
    Failed,
    Retrying,
}

#[derive(Debug, Clone)]
struct FindingJob {
    id: String,
    input_kind: String,
    source_kind: String,
    source_key: String,
    source_uri: String,
    distillation_version: String,
    priority: i64,
    attempt_count: i64,
    metadata: Value,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Candidate {
    #[serde(rename = "type")]
    kind: String,
    polarity: String,
    title: String,
    content: String,
}

#[derive(Clone)]
pub(crate) struct FindingExecution {
    job: FindingJob,
    source: Option<String>,
    self_ingestion_blocked: bool,
    pub(crate) provider_lease: ProviderLeaseAssignment,
    target: LocalLlmTargetConfig,
    api_key: Option<zeroize::Zeroizing<String>>,
}

#[derive(Debug, Clone)]
pub(crate) enum FindingWorkerResult {
    Candidates(Vec<Candidate>),
    SelfIngestionBlocked,
    UnsupportedInput(String),
    ProviderUnavailable(String),
    Failed(String),
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) enum FindingPersistStatus {
    Completed,
    Skipped,
    Failed,
    Retrying,
    Paused,
    Superseded,
}

pub(crate) fn load_claimed_finding_execution(
    connection: &Connection,
    claimed: ClaimedProviderLeaseJob,
    target: LocalLlmTargetConfig,
    api_key: Option<zeroize::Zeroizing<String>>,
) -> Result<FindingExecution, CliError> {
    let job = load_job(connection, &claimed.id)?;
    if job.input_kind != "source_target" || job.source_kind != "vibe_memory" {
        return Ok(FindingExecution {
            job: job.clone(),
            source: None,
            self_ingestion_blocked: false,
            provider_lease: claimed.provider_lease,
            target,
            api_key,
        });
    }
    let self_ingestion_blocked = is_self_ingestion_blocked(connection, &job.source_key)?;
    let source = if self_ingestion_blocked {
        None
    } else {
        Some(read_filtered_vibe_source(connection, &job.source_key)?)
    };
    Ok(FindingExecution {
        job,
        source,
        self_ingestion_blocked,
        provider_lease: claimed.provider_lease,
        target,
        api_key,
    })
}

pub(crate) fn execute_finding(
    execution: &FindingExecution,
    timeout_seconds: u64,
) -> FindingWorkerResult {
    if execution.job.input_kind != "source_target" || execution.job.source_kind != "vibe_memory" {
        return FindingWorkerResult::UnsupportedInput(format!(
            "worker_capability_missing: {}/{}",
            execution.job.input_kind, execution.job.source_kind
        ));
    }
    if execution.self_ingestion_blocked {
        return FindingWorkerResult::SelfIngestionBlocked;
    }
    let Some(source) = execution.source.as_deref() else {
        return FindingWorkerResult::Failed("finding execution source is missing".to_string());
    };
    match request_candidates(
        &execution.target,
        execution.api_key.as_ref().map(|key| key.as_str()),
        timeout_seconds,
        source,
    ) {
        Ok(candidates) => FindingWorkerResult::Candidates(candidates),
        Err(error) if is_provider_unavailable(&error.to_string()) => {
            FindingWorkerResult::ProviderUnavailable(error.to_string())
        }
        Err(error) => FindingWorkerResult::Failed(error.to_string()),
    }
}

pub(crate) fn persist_finding_result(
    connection: &mut Connection,
    execution: &FindingExecution,
    result: &FindingWorkerResult,
) -> Result<FindingPersistStatus, CliError> {
    let tx = connection
        .transaction()
        .map_err(|error| CliError::io(format!("failed to begin finding persistence: {error}")))?;
    if !owns_provider_execution(&tx, &execution.provider_lease)? {
        let event_id = stable_id(
            "finding-event",
            &format!(
                "{}:{}:superseded",
                execution.job.id, execution.provider_lease.id
            ),
            0,
        );
        let event_exists = tx
            .query_row(
                "select exists(select 1 from distillation_queue_events where id = ?1)",
                [&event_id],
                |row| row.get::<_, i64>(0),
            )
            .map(|value| value != 0)
            .map_err(|error| {
                CliError::io(format!(
                    "failed to inspect discarded finding event: {error}"
                ))
            })?;
        if !event_exists {
            append_queue_event_for_connection(
                &tx,
                &event_id,
                "findingCandidate",
                &execution.job.id,
                "discarded",
                Some("stale finding result discarded after claim ownership changed"),
                Some(
                    &json!({
                        "executor": "rust",
                        "reason": "claim_ownership_changed",
                        "workerId": execution.provider_lease.worker_id,
                        "providerLeaseId": execution.provider_lease.id
                    })
                    .to_string(),
                ),
            )?;
        }
        tx.commit().map_err(|error| {
            CliError::io(format!(
                "failed to commit discarded finding result: {error}"
            ))
        })?;
        return Ok(FindingPersistStatus::Superseded);
    }

    let next_attempt_count = execution.job.attempt_count + 1;
    let (
        persist_status,
        queue_status,
        outcome,
        error,
        next_run_seconds,
        release_reason,
        event_type,
    ) = match result {
        FindingWorkerResult::Candidates(candidates) => {
            persist_candidates(&tx, &execution.job, candidates)?;
            if candidates.is_empty() {
                (
                    FindingPersistStatus::Skipped,
                    "skipped",
                    "no_candidate",
                    None,
                    None,
                    "worker_finished",
                    "skipped",
                )
            } else {
                (
                    FindingPersistStatus::Completed,
                    "completed",
                    "completed",
                    None,
                    None,
                    "worker_finished",
                    "completed",
                )
            }
        }
        FindingWorkerResult::SelfIngestionBlocked => (
            FindingPersistStatus::Skipped,
            "skipped",
            "self_ingestion_blocked",
            None,
            None,
            "worker_finished",
            "skipped",
        ),
        FindingWorkerResult::UnsupportedInput(error) => (
            FindingPersistStatus::Paused,
            "paused",
            "worker_capability_missing",
            Some(error.as_str()),
            None,
            "worker_capability_missing",
            "paused",
        ),
        FindingWorkerResult::ProviderUnavailable(error) if next_attempt_count >= 8 => (
            FindingPersistStatus::Paused,
            "paused",
            "provider_unavailable_exhausted",
            Some(error.as_str()),
            None,
            "provider_unavailable_retry",
            "paused",
        ),
        FindingWorkerResult::ProviderUnavailable(error) => (
            FindingPersistStatus::Retrying,
            "pending",
            "provider_unavailable_retry",
            Some(error.as_str()),
            Some(provider_unavailable_backoff_seconds(
                execution.job.attempt_count,
            )),
            "provider_unavailable_retry",
            "retried",
        ),
        FindingWorkerResult::Failed(error) => (
            FindingPersistStatus::Failed,
            "failed",
            "failed",
            Some(error.as_str()),
            None,
            "worker_failed",
            "failed",
        ),
    };
    let completed_at = if matches!(queue_status, "completed" | "skipped" | "failed") {
        "CURRENT_TIMESTAMP"
    } else {
        "null"
    };
    let next_run_at = next_run_seconds
        .map(|seconds| format!("datetime(CURRENT_TIMESTAMP, '+{seconds} seconds')"))
        .unwrap_or_else(|| "null".to_string());
    let candidate_count = match result {
        FindingWorkerResult::Candidates(candidates) => candidates.len(),
        _ => 0,
    };
    let attempt_count = if matches!(
        result,
        FindingWorkerResult::ProviderUnavailable(_) | FindingWorkerResult::Failed(_)
    ) {
        next_attempt_count
    } else {
        execution.job.attempt_count
    };
    let queue_changed = tx
        .execute(
            &format!(
                "update finding_candidate_queue
                 set status = ?1,
                     attempt_count = ?2,
                     locked_by = null,
                     locked_at = null,
                     heartbeat_at = null,
                     next_run_at = {next_run_at},
                     completed_at = {completed_at},
                     last_error = ?3,
                     last_outcome_kind = ?4,
                     metadata = json_set(
                       case when json_valid(metadata) then metadata else '{{}}' end,
                       '$.findingCandidate.executor', 'rust',
                       '$.findingCandidate.candidateCount', ?5,
                       '$.findingCandidate.version', ?6,
                       '$.findingCandidate.providerRetryAfterSeconds', ?7
                     ),
                     updated_at = CURRENT_TIMESTAMP
                 where id = ?8
                   and status = 'running'
                   and locked_by = ?9"
            ),
            params![
                queue_status,
                attempt_count,
                error.map(|value| truncate(value, 1000)),
                outcome,
                candidate_count as i64,
                FINDING_VERSION,
                next_run_seconds.map(|value| value as i64),
                execution.job.id,
                execution.provider_lease.worker_id
            ],
        )
        .map_err(|error| CliError::io(format!("failed to update finding queue job: {error}")))?;
    if queue_changed != 1 {
        return Err(CliError::io(
            "finding claim ownership changed before queue transition",
        ));
    }
    let lease_changed = tx
        .execute(
            "update llm_provider_leases
             set status = 'released',
                 released_at = CURRENT_TIMESTAMP,
                 release_reason = ?2,
                 updated_at = CURRENT_TIMESTAMP
             where id = ?1
               and status = 'active'
               and queue_name = 'findingCandidate'
               and queue_job_id = ?3
               and worker_id = ?4",
            params![
                execution.provider_lease.id,
                release_reason,
                execution.job.id,
                execution.provider_lease.worker_id
            ],
        )
        .map_err(|error| CliError::io(format!("failed to release finding lease: {error}")))?;
    if lease_changed != 1 {
        return Err(CliError::io(
            "finding claim ownership changed before provider lease release",
        ));
    }
    append_queue_event_for_connection(
        &tx,
        &stable_id(
            "finding-event",
            &format!(
                "{}:{}:{}",
                execution.job.id, execution.provider_lease.id, event_type
            ),
            0,
        ),
        "findingCandidate",
        &execution.job.id,
        event_type,
        Some("finding candidate processed by Rust resident executor"),
        Some(
            &json!({
                "executor": "rust",
                "targetId": execution.target.target_id,
                "status": outcome,
                "attemptCount": attempt_count,
                "candidateCount": candidate_count
            })
            .to_string(),
        ),
    )?;
    tx.commit()
        .map_err(|error| CliError::io(format!("failed to commit finding result: {error}")))?;
    Ok(persist_status)
}

pub(crate) fn run_finding_candidate_job_for_connection(
    connection: &Connection,
    job_id: &str,
    worker_id: &str,
    target: &LocalLlmTargetConfig,
    api_key: Option<&str>,
    timeout_seconds: u64,
) -> Result<FindingExecutionStatus, CliError> {
    let job = load_job(connection, job_id)?;
    let result = process_job(connection, &job, target, api_key, timeout_seconds);
    match result {
        Ok(status) => Ok(status),
        Err(error) if is_provider_unavailable(&error.to_string()) => {
            mark_retrying(connection, &job.id, &error.to_string())?;
            append_finding_event_best_effort(
                connection,
                &event_id("finding-event-retry", &job.id),
                "findingCandidate",
                &job.id,
                "retried",
                Some("finding candidate provider unavailable; job returned to queue"),
                Some(
                    &json!({
                        "workerId": worker_id,
                        "executor": "rust",
                        "targetId": target.target_id,
                        "reason": "provider_unavailable_retry",
                        "error": truncate(&error.to_string(), 500)
                    })
                    .to_string(),
                ),
            );
            Ok(FindingExecutionStatus::Retrying)
        }
        Err(error) => {
            mark_failed(connection, &job.id, &error.to_string())?;
            append_finding_event_best_effort(
                connection,
                &event_id("finding-event-failed", &job.id),
                "findingCandidate",
                &job.id,
                "failed",
                Some("finding candidate failed"),
                Some(
                    &json!({
                        "workerId": worker_id,
                        "executor": "rust",
                        "targetId": target.target_id,
                        "error": truncate(&error.to_string(), 500)
                    })
                    .to_string(),
                ),
            );
            Ok(FindingExecutionStatus::Failed)
        }
    }
}

fn process_job(
    connection: &Connection,
    job: &FindingJob,
    target: &LocalLlmTargetConfig,
    api_key: Option<&str>,
    timeout_seconds: u64,
) -> Result<FindingExecutionStatus, CliError> {
    if job.input_kind != "source_target" || job.source_kind != "vibe_memory" {
        return Err(CliError::io(format!(
            "unsupported findingCandidate input: {}/{}",
            job.input_kind, job.source_kind
        )));
    }
    if is_self_ingestion_blocked(connection, &job.source_key)? {
        connection
            .execute(
                "update finding_candidate_queue set status = 'skipped', locked_by = null, locked_at = null, heartbeat_at = null, next_run_at = null, completed_at = CURRENT_TIMESTAMP, last_error = null, last_outcome_kind = 'self_ingestion_blocked', updated_at = CURRENT_TIMESTAMP where id = ?1",
                [&job.id],
            )
            .map_err(|error| CliError::io(format!("failed to skip self-ingestion job: {error}")))?;
        append_finding_event_best_effort(
            connection,
            &event_id("finding-event-self-ingestion", &job.id),
            "findingCandidate",
            &job.id,
            "skipped",
            Some("self ingestion blocked"),
            Some(
                &json!({"executor":"rust","reason":"codex_finding_escalation_self_ingestion"})
                    .to_string(),
            ),
        );
        return Ok(FindingExecutionStatus::Skipped);
    }
    let source = read_filtered_vibe_source(connection, &job.source_key)?;
    let candidates = request_candidates(target, api_key, timeout_seconds, &source)?;
    persist_result(connection, job, &candidates)?;
    let (status, outcome, message) = if candidates.is_empty() {
        (
            FindingExecutionStatus::Skipped,
            "no_candidate",
            "finding candidate produced no reusable knowledge",
        )
    } else {
        (
            FindingExecutionStatus::Completed,
            "completed",
            "finding candidate completed",
        )
    };
    append_finding_event_best_effort(
        connection,
        &event_id("finding-event-completed", &job.id),
        "findingCandidate",
        &job.id,
        if candidates.is_empty() {
            "skipped"
        } else {
            "completed"
        },
        Some(message),
        Some(
            &json!({
                "executor": "rust",
                "targetId": target.target_id,
                "candidateCount": candidates.len(),
                "outcome": outcome
            })
            .to_string(),
        ),
    );
    Ok(status)
}

fn append_finding_event_best_effort(
    connection: &Connection,
    event_id: &str,
    queue_name: &str,
    queue_job_id: &str,
    event_type: &str,
    message: Option<&str>,
    metadata_json: Option<&str>,
) {
    if let Err(error) = append_queue_event_for_connection(
        connection,
        event_id,
        queue_name,
        queue_job_id,
        event_type,
        message,
        metadata_json,
    ) {
        eprintln!("failed to append {queue_name}/{queue_job_id} {event_type} queue event: {error}");
    }
}

fn is_self_ingestion_blocked(connection: &Connection, source_key: &str) -> Result<bool, CliError> {
    let metadata = connection
        .query_row(
            "select coalesce(metadata, '{}') from vibe_memories where id = ?1 limit 1",
            [source_key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| {
            CliError::io(format!("failed to inspect vibe memory metadata: {error}"))
        })?;
    let value = metadata
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .unwrap_or_else(|| json!({}));
    Ok(value.get("generatedBy").and_then(Value::as_str)
        == Some("contextStill.codexFindingEscalation")
        || value.get("excludedFromVibeMemory").and_then(Value::as_bool) == Some(true)
        || value
            .get("excludeFromFindingCandidate")
            .and_then(Value::as_bool)
            == Some(true))
}

fn load_job(connection: &Connection, job_id: &str) -> Result<FindingJob, CliError> {
    connection.query_row(
        "select id, input_kind, source_kind, source_key, source_uri, distillation_version, priority, attempt_count, coalesce(metadata, '{}') from finding_candidate_queue where id = ?1 limit 1",
        [job_id],
        |row| Ok(FindingJob {
            id: row.get(0)?, input_kind: row.get(1)?, source_kind: row.get(2)?, source_key: row.get(3)?,
            source_uri: row.get(4)?, distillation_version: row.get(5)?, priority: row.get(6)?,
            attempt_count: row.get(7)?,
            metadata: serde_json::from_str(&row.get::<_, String>(8)?).unwrap_or_else(|_| json!({})),
        }),
    ).optional()
     .map_err(|error| CliError::io(format!("failed to load finding candidate job: {error}")))?
     .ok_or_else(|| CliError::io(format!("finding candidate queue job not found: {job_id}")))
}

fn read_filtered_vibe_source(
    connection: &Connection,
    source_key: &str,
) -> Result<String, CliError> {
    let content = connection
        .query_row(
            "select content from vibe_memories where id = ?1 limit 1",
            [source_key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CliError::io(format!("failed to load vibe memory: {error}")))?
        .ok_or_else(|| CliError::io(format!("vibe memory not found: {source_key}")))?;
    let mut blocks = vec![filter_source_text(&content)];
    let table_exists: bool = connection.query_row(
        "select exists(select 1 from sqlite_master where type = 'table' and name = 'agent_diff_entries')",
        [], |row| row.get(0),
    ).unwrap_or(false);
    if table_exists {
        let mut statement = connection.prepare(
            "select file_path, diff_hunk from agent_diff_entries where vibe_memory_id = ?1 order by created_at asc, id asc"
        ).map_err(|error| CliError::io(format!("failed to prepare vibe diffs: {error}")))?;
        let rows = statement
            .query_map([source_key], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| CliError::io(format!("failed to query vibe diffs: {error}")))?;
        for row in rows {
            let (path, diff) =
                row.map_err(|error| CliError::io(format!("failed to read vibe diff: {error}")))?;
            blocks.push(format!(
                "\n[agent diff: {}]\n{}",
                path,
                filter_source_text(&diff)
            ));
        }
    }
    let joined = blocks.join("\n");
    Ok(truncate_middle(&joined, 32_000))
}

fn filter_source_text(input: &str) -> String {
    let mut result = Vec::new();
    let mut skipped_tag: Option<&str> = None;
    let mut skipped_private_key = false;
    for line in input.lines() {
        let lower = line.trim().to_ascii_lowercase();
        if skipped_private_key {
            if lower.contains("-----end") && lower.contains("private key-----") {
                skipped_private_key = false;
            }
            continue;
        }
        if let Some(tag) = skipped_tag {
            if lower.contains(&format!("</{tag}>")) {
                skipped_tag = None;
            }
            continue;
        }
        if let Some(tag) = ["instructions", "environment_context", "filesystem"]
            .into_iter()
            .find(|tag| lower.starts_with(&format!("<{tag}")))
        {
            if !lower.contains(&format!("</{tag}>")) {
                skipped_tag = Some(tag);
            }
            continue;
        }
        if lower.contains("-----begin") && lower.contains("private key-----") {
            skipped_private_key = true;
            result.push("[REDACTED SENSITIVE LINE]".to_string());
            continue;
        }
        if lower.contains("\"apikey\"") || lower.contains("\"api_key\"") {
            result.push(redact_json_sensitive_value(line));
            continue;
        }
        let sensitive = lower.contains("authorization: bearer ")
            || lower.contains("authorization:")
            || lower.contains("bearer ")
            || lower.contains("api_key=")
            || lower.contains("api_key:")
            || lower.contains("apikey=")
            || lower.contains("apikey:")
            || lower.contains("\"apikey\"")
            || lower.contains("access_token=")
            || lower.contains("access_token:")
            || lower.contains("database_url=")
            || lower.contains("database_url:")
            || lower.contains("password=")
            || lower.contains("password:")
            || lower.contains("--token ")
            || lower.contains("--token=")
            || lower.contains("--api-key ")
            || lower.contains("--api-key=")
            || (lower.contains("://") && lower.contains('@'))
            || lower.split_whitespace().any(|part| {
                (part.starts_with("sk-") || part.starts_with("ghp_")) && part.len() > 12
            });
        if sensitive {
            result.push("[REDACTED SENSITIVE LINE]".to_string());
        } else {
            result.push(line.chars().take(2_000).collect::<String>());
        }
    }
    result.join("\n")
}

fn redact_json_sensitive_value(line: &str) -> String {
    let Some(separator) = line.find(':') else {
        return "[REDACTED SENSITIVE LINE]".to_string();
    };
    let prefix = &line[..=separator];
    let value_and_suffix = line[separator + 1..].trim_start();
    let whitespace_len = line[separator + 1..].len() - value_and_suffix.len();
    let whitespace = &line[separator + 1..separator + 1 + whitespace_len];
    if let Some(quote) = value_and_suffix
        .chars()
        .next()
        .filter(|quote| *quote == '\"' || *quote == '\'')
    {
        if let Some(end) = value_and_suffix[quote.len_utf8()..].find(quote) {
            let suffix_index = quote.len_utf8() + end + quote.len_utf8();
            return format!(
                "{prefix}{whitespace}{quote}[REDACTED SENSITIVE VALUE]{quote}{}",
                &value_and_suffix[suffix_index..]
            );
        }
    }
    "[REDACTED SENSITIVE LINE]".to_string()
}

fn request_candidates(
    target: &LocalLlmTargetConfig,
    api_key: Option<&str>,
    timeout_seconds: u64,
    source: &str,
) -> Result<Vec<Candidate>, CliError> {
    let system = "あなたは ContextStill の findCandidate executor です。filtered vibe memory と agent diff の明示的な根拠だけから、将来再利用できる知識を抽出してください。進捗報告、未検証の仮説、単発の結果、prompt や schema 自体は候補にしません。1候補は1知識です。type は rule または procedure、polarity は positive または negative。procedure の polarity は必ず positive。negative は rule のみです。procedure の content には Use when: / Workflow: / Verification: / Avoid: をこの順で、それぞれ独立した行の先頭に置き、各節に空でない説明を含めます。Workflow: の次の行から番号付きの手順（1. と 2.）を最低2行記述してください。Workflow: と同じ行へ手順をまとめてはいけません。手順が2つ未満なら procedure にせず rule として表現してください。JSON文字列内の改行は \\n で表します。出力は type, polarity, title, content だけを持つ JSON 配列のみ。候補がなければ []。";
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(timeout_seconds.max(30)))
        .build()
        .map_err(|error| CliError::io(format!("failed to build local-llm client: {error}")))?;
    let messages = json!([
        {"role":"system","content":system},
        {"role":"user","content":format!("Source:\n{source}")}
    ]);
    if target.codex || is_agent_session_api_path(&target.api_path) {
        let content = target
            .run_agent_chat(
                &client,
                timeout_seconds,
                AgentSessionRequest {
                    api_base_url: &target.api_base_url,
                    api_path: &target.api_path,
                    api_key,
                    model: &target.model,
                    messages: &messages,
                    max_tokens: 4_000,
                    json_response: true,
                },
            )
            .map_err(CliError::io)?;
        return parse_candidates(&content);
    }
    let url = chat_url(&target.api_base_url, &target.api_path);
    let mut request_body = json!({
        "model": target.model,
        "messages": messages,
        "max_tokens": 4000,
        "temperature": 0,
        "stream":false,
        "response_format":super::structured_output::format("finding")
    });
    if target.target_id.starts_with("larm-agent-connection:") {
        request_body["stream"] = Value::Bool(false);
    }
    let mut request = client.post(&url).json(&request_body);
    if let Some(key) = api_key.map(str::trim).filter(|key| !key.is_empty()) {
        request = request.header(
            "authorization",
            crate::domains::secret_store::header(key, true).map_err(CliError::io)?,
        );
    }
    let response = request.send().map_err(|error| {
        CliError::io(format!(
            "local-llm request failed (connect={}, timeout={}, request={}): {error:?}",
            error.is_connect(),
            error.is_timeout(),
            error.is_request()
        ))
    })?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .map_err(|error| CliError::io(format!("failed to read local-llm response: {error}")))?;
    if !(200..300).contains(&status) {
        return Err(CliError::io(format!(
            "local-llm HTTP {}: {}",
            status,
            truncate(&body, 1000)
        )));
    }
    let payload: Value = serde_json::from_str(&body).map_err(|error| {
        CliError::io(format!("failed to parse local-llm response JSON: {error}"))
    })?;
    let content = super::structured_output::content(&payload).map_err(CliError::io)?;
    parse_candidates(content)
}

fn parse_candidates(content: &str) -> Result<Vec<Candidate>, CliError> {
    let cleaned = content
        .lines()
        .filter(|line| !line.trim_start().starts_with("```"))
        .collect::<Vec<_>>()
        .join("\n");
    let value: Value = serde_json::from_str(cleaned.trim())
        .or_else(|_| {
            let start = cleaned.find('[').unwrap_or(0);
            let end = cleaned
                .rfind(']')
                .map(|index| index + 1)
                .unwrap_or(cleaned.len());
            serde_json::from_str(&cleaned[start..end])
        })
        .map_err(|error| CliError::io(format!("finding candidate parse failed: {error}")))?;
    let values = if value.is_array() {
        value.as_array().cloned().unwrap_or_default()
    } else if let Some(candidates) = value.get("candidates").and_then(Value::as_array) {
        candidates.clone()
    } else {
        vec![value]
    };
    if values.len() > MAX_CANDIDATES_PER_JOB {
        return Err(CliError::io(format!(
            "finding candidate output_limit_exceeded: received {} candidates (limit {MAX_CANDIDATES_PER_JOB})",
            values.len()
        )));
    }
    let mut candidates = Vec::new();
    for value in values {
        let mut candidate = serde_json::from_value::<Candidate>(value).map_err(|error| {
            CliError::io(format!("finding candidate output_schema_invalid: {error}"))
        })?;
        candidate.kind = candidate.kind.trim().to_ascii_lowercase();
        candidate.polarity = candidate.polarity.trim().to_ascii_lowercase();
        candidate.title = candidate.title.trim().to_string();
        candidate.content = candidate.content.trim().to_string();
        if !matches!(candidate.kind.as_str(), "rule" | "procedure")
            || !matches!(candidate.polarity.as_str(), "positive" | "negative")
            || candidate.title.is_empty()
            || candidate.content.is_empty()
            || (candidate.kind == "procedure" && candidate.polarity == "negative")
            || (candidate.kind == "procedure" && !has_skill_like_procedure_body(&candidate.content))
        {
            return Err(CliError::io(
                format!("finding candidate output_schema_invalid: candidate violates the canonical contract (type={}, polarity={}, title_empty={}, content_empty={}, procedure_body_valid={})", candidate.kind, candidate.polarity, candidate.title.is_empty(), candidate.content.is_empty(), has_skill_like_procedure_body(&candidate.content)),
            ));
        }
        candidates.push(candidate);
    }
    Ok(candidates)
}

fn has_skill_like_procedure_body(body: &str) -> bool {
    let lines = body.lines().collect::<Vec<_>>();
    let heading_index = |heading: &str| {
        lines.iter().position(|line| {
            line.trim_start()
                .to_ascii_lowercase()
                .starts_with(&format!("{}:", heading.to_ascii_lowercase()))
        })
    };
    let (Some(use_when), Some(workflow), Some(verification), Some(avoid)) = (
        heading_index("Use when"),
        heading_index("Workflow"),
        heading_index("Verification"),
        heading_index("Avoid"),
    ) else {
        return false;
    };
    if !(use_when < workflow && workflow < verification && verification < avoid) {
        return false;
    }
    let section_has_content = |start: usize, end: usize| {
        lines[start..end].iter().enumerate().any(|(index, line)| {
            let content = if index == 0 {
                line.split_once(':').map(|(_, value)| value).unwrap_or("")
            } else {
                line
            };
            !content
                .trim_start_matches(|character: char| {
                    character.is_whitespace()
                        || character == '-'
                        || character == '*'
                        || character == '.'
                        || character == ')'
                        || character.is_ascii_digit()
                })
                .is_empty()
        })
    };
    let workflow_steps = lines[workflow + 1..verification]
        .iter()
        .filter(|line| {
            let trimmed = line.trim_start();
            trimmed.starts_with("- ")
                || trimmed
                    .split_once(['.', ')'])
                    .is_some_and(|(prefix, rest)| {
                        !prefix.is_empty()
                            && prefix.chars().all(|character| character.is_ascii_digit())
                            && !rest.trim().is_empty()
                    })
        })
        .count();
    section_has_content(use_when, workflow)
        && workflow_steps >= 2
        && section_has_content(verification, avoid)
        && section_has_content(avoid, lines.len())
}

fn persist_result(
    connection: &Connection,
    job: &FindingJob,
    candidates: &[Candidate],
) -> Result<(), CliError> {
    let tx = connection.unchecked_transaction().map_err(|error| {
        CliError::io(format!(
            "failed to begin finding result transaction: {error}"
        ))
    })?;
    persist_candidates(&tx, job, candidates)?;
    let outcome = if candidates.is_empty() {
        "no_candidate"
    } else {
        "completed"
    };
    tx.execute(
        "update finding_candidate_queue set status = ?2, locked_by = null, locked_at = null, heartbeat_at = null, next_run_at = null, completed_at = CURRENT_TIMESTAMP, last_error = null, last_outcome_kind = ?3, metadata = json_set(case when json_valid(metadata) then metadata else '{}' end, '$.findingCandidate.executor', 'rust', '$.findingCandidate.candidateCount', ?4, '$.findingCandidate.version', ?5), updated_at = CURRENT_TIMESTAMP where id = ?1",
        params![job.id, if candidates.is_empty() { "skipped" } else { "completed" }, outcome, candidates.len() as i64, FINDING_VERSION],
    ).map_err(|error| CliError::io(format!("failed to complete finding candidate job: {error}")))?;
    tx.commit().map_err(|error| {
        CliError::io(format!(
            "failed to commit finding result transaction: {error}"
        ))
    })?;
    Ok(())
}

fn persist_candidates(
    connection: &Connection,
    job: &FindingJob,
    candidates: &[Candidate],
) -> Result<(), CliError> {
    for (index, candidate) in candidates.iter().enumerate() {
        let found_id = stable_id("found-candidate", &job.id, index);
        let cover_id = stable_id("cover-evidence", &job.id, index);
        let origin = json!({
            "queueVersion":"v2", "sourceKind":job.source_kind, "sourceKey":job.source_key,
            "sourceUri":job.source_uri, "findingJobId":job.id, "polarity":candidate.polarity
        });
        let metadata = json!({
            "sourceKind":job.source_kind, "sourceKey":job.source_key, "sourceUri":job.source_uri,
            "polarity":candidate.polarity, "executor":"rust", "version":FINDING_VERSION,
            "sourceMetadata":job.metadata
        });
        connection.execute(
            "insert into found_candidates (id, finding_job_id, candidate_index, type, title, content, source_summary, origin, metadata, created_at, updated_at) values (?1, ?2, ?3, ?4, ?5, ?6, null, ?7, ?8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) on conflict(id) do update set type=excluded.type, title=excluded.title, content=excluded.content, origin=excluded.origin, metadata=excluded.metadata, updated_at=CURRENT_TIMESTAMP",
            params![found_id, job.id, index as i64, candidate.kind, candidate.title, candidate.content, origin.to_string(), metadata.to_string()],
        ).map_err(|error| CliError::io(format!("failed to persist found candidate: {error}")))?;
        connection.execute(
            "insert into covering_evidence_queue (id, found_candidate_id, distillation_version, status, priority, provider_policy, payload, metadata, created_at, updated_at) select ?1, ?2, ?3, 'pending', ?4, 'default', '{}', ?5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP where not exists (select 1 from covering_evidence_queue where found_candidate_id = ?2)",
            params![cover_id, found_id, job.distillation_version, job.priority, metadata.to_string()],
        ).map_err(|error| CliError::io(format!("failed to enqueue covering evidence: {error}")))?;
    }
    Ok(())
}

fn provider_unavailable_backoff_seconds(attempt_count: i64) -> u64 {
    match attempt_count.max(0) {
        0 => 60,
        1 => 120,
        2 => 300,
        3 => 600,
        4 => 1_200,
        _ => 3_600,
    }
}

fn mark_retrying(connection: &Connection, job_id: &str, error: &str) -> Result<(), CliError> {
    let attempt_count = connection
        .query_row(
            "select attempt_count from finding_candidate_queue where id = ?1",
            [job_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| CliError::io(format!("failed to read finding attempt count: {error}")))?;
    let next_attempt_count = attempt_count + 1;
    let exhausted = next_attempt_count >= 8;
    let delay = provider_unavailable_backoff_seconds(attempt_count);
    connection.execute(
        "update finding_candidate_queue
         set status = case when ?2 then 'paused' else 'pending' end,
             attempt_count = ?3,
             locked_by = null,
             locked_at = null,
             heartbeat_at = null,
             next_run_at = case when ?2 then null else datetime(CURRENT_TIMESTAMP, '+' || ?4 || ' seconds') end,
             last_error = ?5,
             last_outcome_kind = case when ?2 then 'provider_unavailable_exhausted' else 'provider_unavailable_retry' end,
             updated_at = CURRENT_TIMESTAMP
         where id = ?1",
        params![
            job_id,
            exhausted,
            next_attempt_count,
            delay as i64,
            truncate(error, 1000)
        ],
    ).map_err(|error| CliError::io(format!("failed to retry finding candidate job: {error}")))?;
    Ok(())
}

fn mark_failed(connection: &Connection, job_id: &str, error: &str) -> Result<(), CliError> {
    connection.execute(
        "update finding_candidate_queue set status = 'failed', attempt_count = attempt_count + 1, locked_by = null, locked_at = null, heartbeat_at = null, next_run_at = null, last_error = ?2, last_outcome_kind = 'failed', updated_at = CURRENT_TIMESTAMP where id = ?1",
        params![job_id, truncate(error, 1000)],
    ).map_err(|error| CliError::io(format!("failed to mark finding candidate failed: {error}")))?;
    Ok(())
}

fn is_provider_unavailable(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("local-llm request failed")
        || lower.contains("failed to read local-llm response")
        || lower.contains("local-llm curl fallback failed")
        || lower.contains("failed to start curl fallback")
        || lower.contains("failed to wait for curl fallback")
        || lower.contains("failed to configure curl fallback")
        || lower.contains("curl fallback omitted http status")
        || lower.contains("invalid curl fallback http status")
        || lower.contains("http 408")
        || lower.contains("http 429")
        || (500..=599).any(|status| lower.contains(&format!("http {status}")))
}

fn chat_url(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    let path = if path.trim().is_empty() {
        "/v1/chat/completions"
    } else {
        path.trim()
    };
    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    if base.ends_with("/v1") && path.starts_with("/v1/") {
        format!("{}{}", base, &path[3..])
    } else {
        format!("{base}{path}")
    }
}

fn stable_id(prefix: &str, job_id: &str, index: usize) -> String {
    let digest = Sha256::digest(format!("{prefix}:{job_id}:{index}"));
    format!("{prefix}-{:x}", digest)[..56].to_string()
}

fn event_id(prefix: &str, job_id: &str) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    stable_id(prefix, &format!("{job_id}:{now}"), 0)
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn truncate_middle(value: &str, max_chars: usize) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    if chars.len() <= max_chars {
        return value.to_string();
    }
    let head_len = max_chars * 7 / 10;
    let tail_len = max_chars * 2 / 10;
    let omitted = chars.len() - head_len - tail_len;
    format!(
        "{}\n[...truncated {omitted} chars...]\n{}",
        chars[..head_len].iter().collect::<String>(),
        chars[chars.len() - tail_len..].iter().collect::<String>()
    )
}

#[cfg(test)]
#[path = "finding_executor_tests.rs"]
mod tests;
