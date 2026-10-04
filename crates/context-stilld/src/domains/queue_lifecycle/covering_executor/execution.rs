use std::path::PathBuf;

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::shared::errors::CliError;

use super::super::episode_executor::LocalLlmTargetConfig;
use super::super::types::ClaimedProviderLeaseJob;

use super::deduplication::inspect_knowledge_duplicates;
use super::external_evidence::run_positive_external_evidence;
use super::helpers::{failure_result, parse_json};
use super::negative_response::parse_negative_response;
use super::positive_response::{
    candidate_has_project_identity, candidate_has_required_applicability,
    has_skill_like_procedure_body, merge_json_references, parse_positive_response,
    positive_failure_result, positive_rule_body_actionable, positive_terminal_result,
    positive_value_user_prompt, prepend_positive_tool_events, refine_positive_applicability,
    render_catalog_prompt, repair_positive_procedure,
};
use super::provider::{request_covering_completion, request_negative_evidence};
use super::source::{
    base_positive_candidate, evaluate_positive_source_support, normalized_character_count,
    positive_source_content, requires_external_evidence, source_reference,
};
use super::types::{CoveringExecution, CoveringExternalSearchConfig, CoveringResult};

pub(crate) fn load_claimed_covering_execution(
    connection: &Connection,
    claimed: ClaimedProviderLeaseJob,
    target: LocalLlmTargetConfig,
    api_key: Option<String>,
    low_importance_reject_threshold: i64,
    source_read_root: PathBuf,
    external_search: CoveringExternalSearchConfig,
) -> Result<CoveringExecution, CliError> {
    let claimed_id = claimed.id.clone();
    let provider_lease = claimed.provider_lease;
    // Older databases can be read by the resident during a rolling migration.  Do not
    // reference an additive column until it is present in that database.
    let queue_columns = connection
        .prepare("select name from pragma_table_info('covering_evidence_queue')")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| {
            CliError::io(format!("failed to inspect covering queue schema: {error}"))
        })?;
    let input_generation = if queue_columns
        .iter()
        .any(|column| column == "input_generation")
    {
        "coalesce(cq.input_generation, 0)"
    } else {
        "0"
    };
    let protocol_version = if queue_columns
        .iter()
        .any(|column| column == "protocol_version")
    {
        "coalesce(cq.protocol_version, 1)"
    } else {
        "1"
    };
    let has_source_metadata: bool = connection.query_row(
        "select exists(select 1 from pragma_table_info('finding_candidate_queue') where name='metadata')",
        [], |r|r.get(0)).map_err(|e|CliError::io(e.to_string()))?;
    let source_metadata_column = if has_source_metadata {
        "metadata"
    } else {
        "'{}' as metadata"
    };
    let has_legacy: bool = connection.query_row(
        "select count(*)=2 from sqlite_master where type='table' and name in ('find_candidate_results','distillation_target_states')",
        [], |r|r.get(0)).map_err(|e|CliError::io(e.to_string()))?;
    let has_vibe_metadata: bool = connection
        .query_row(
            "select exists(select 1 from pragma_table_info('vibe_memories') where name='metadata')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| CliError::io(e.to_string()))?;
    let vibe_metadata_column = if has_vibe_metadata {
        "vm.metadata"
    } else {
        "'{}'"
    };
    let legacy_candidates = if has_legacy {
        "union all select r.id,'legacy-preview-'||r.id,r.title,r.content,coalesce(json_extract(r.origin,'$.type'),'rule'),r.origin,t.metadata from find_candidate_results r join distillation_target_states t on t.id=r.target_state_id where not exists(select 1 from found_candidates n where n.id=r.id) and exists(select 1 from covering_evidence_queue q where q.id=?1 and q.found_candidate_id=r.id and q.protocol_version=3 and json_extract(q.payload,'$.agentPreview')=1)"
    } else {
        ""
    };
    let legacy_sources = if has_legacy {
        "union all select 'legacy-preview-'||r.id,t.target_key,t.source_uri,t.target_kind,t.metadata from find_candidate_results r join distillation_target_states t on t.id=r.target_state_id where exists(select 1 from covering_evidence_queue q where q.id=?1 and q.found_candidate_id=r.id and q.protocol_version=3 and json_extract(q.payload,'$.agentPreview')=1)"
    } else {
        ""
    };
    let mut execution = connection
        .query_row(
            &format!(
                "
            with fc as (
                select id,finding_job_id,title,content,type,origin,metadata from found_candidates
                {legacy_candidates}
            ), fq as (
                select id,source_key,source_uri,source_kind,{source_metadata_column} from finding_candidate_queue
                {legacy_sources}
            )
            select
              cq.id,
              cq.found_candidate_id,
              cq.distillation_version,
              cq.attempt_count,
              cq.max_attempts,
              {input_generation},
              {protocol_version},
              coalesce(cq.provider_policy, 'default'),
              fc.title,
              fc.content,
              coalesce(fc.type, 'rule'),
              coalesce(fc.origin, '{{}}'),
              coalesce(fc.metadata, '{{}}'),
              coalesce(fq.source_key, ''),
              coalesce(fq.source_uri, ''),
              coalesce(fq.source_kind, ''),
              case
                when fq.source_kind = 'vibe_memory' then coalesce((select content from vibe_memories where id = fq.source_key limit 1), '')
                when fq.source_kind = 'knowledge_candidate' then fc.content
                else ''
              end,
              case
                when fq.source_kind = 'vibe_memory' then coalesce((select {vibe_metadata_column} from vibe_memories vm where vm.id = fq.source_key limit 1), '{{}}')
                else coalesce(fq.metadata, '{{}}')
              end
            from covering_evidence_queue cq
            join fc on fc.id = cq.found_candidate_id
            join fq on fq.id = fc.finding_job_id
            where cq.id = ?1
              and cq.status = 'running'
            limit 1
            "
            ),
            [&claimed_id],
            |row| {
                Ok(CoveringExecution {
                    job_id: row.get(0)?,
                    found_candidate_id: row.get(1)?,
                    distillation_version: row.get(2)?,
                    attempt_count: row.get(3)?,
                    max_attempts: row.get(4)?,
                    input_generation: row.get(5)?,
                    protocol_version: row.get(6)?,
                    provider_policy: row.get(7)?,
                    candidate_title: row.get(8)?,
                    candidate_content: row.get(9)?,
                    candidate_type: row.get(10)?,
                    candidate_origin: parse_json(row.get::<_, String>(11)?),
                    candidate_metadata: parse_json(row.get::<_, String>(12)?),
                    source_key: row.get(13)?,
                    source_uri: row.get(14)?,
                    source_kind: row.get(15)?,
                    source_content: row.get(16)?,
                    source_metadata: parse_json(row.get::<_, String>(17)?),
                    provider_lease,
                    target,
                    api_key,
                    source_read_root: source_read_root.clone(),
                    source_read_ranges: None,
                    low_importance_reject_threshold,
                    duplicate_status: None,
                    duplicate_refs: Vec::new(),
                    external_search: external_search.clone(),
                })
            },
        )
        .optional()
        .map_err(|error| CliError::io(format!("failed to load claimed covering job: {error}")))?
        .ok_or_else(|| {
            CliError::io(format!(
                "claimed covering job was not available for execution: {}",
                claimed_id
            ))
        })?;
    if execution.source_kind == "vibe_memory"
        && connection
            .query_row(
                "select exists(select 1 from sqlite_master where type = 'table' and name = 'agent_diff_entries')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            != 0
    {
        let mut statement = connection
            .prepare(
                "select diff_hunk from agent_diff_entries where vibe_memory_id = ?1 order by created_at asc, file_path asc, id asc",
            )
            .map_err(|error| CliError::io(format!("failed to prepare covering source diff read: {error}")))?;
        let diffs = statement
            .query_map([&execution.source_key], |row| row.get::<_, String>(0))
            .map_err(|error| CliError::io(format!("failed to query covering source diffs: {error}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| CliError::io(format!("failed to read covering source diffs: {error}")))?;
        for diff in diffs {
            if !diff.trim().is_empty() {
                execution.source_content.push('\n');
                execution.source_content.push_str(&diff);
            }
        }
    }
    let (duplicate_status, duplicate_refs) = inspect_knowledge_duplicates(
        connection,
        &execution.candidate_title,
        &execution.candidate_content,
    )?;
    execution.duplicate_status = duplicate_status;
    execution.duplicate_refs = duplicate_refs;
    Ok(execution)
}

pub(crate) fn execute_negative_covering(
    execution: &CoveringExecution,
    timeout_seconds: u64,
) -> CoveringResult {
    if execution.provider_policy != "default" {
        return failure_result(
            "provider_failed",
            "rust_negative_covering_supports_default_policy_only",
        );
    }
    if execution.source_kind != "vibe_memory" {
        return failure_result(
            "tool_failed",
            &format!(
                "rust_negative_covering_unsupported_source_kind:{}",
                execution.source_kind
            ),
        );
    }
    let response = match request_negative_evidence(execution, timeout_seconds) {
        Ok(response) => response,
        Err(error) => return failure_result("provider_failed", &error.to_string()),
    };
    match parse_negative_response(execution, &response) {
        Ok(result) => result,
        Err(error) => failure_result("parse_failed", &error.to_string()),
    }
}

pub(crate) fn execute_covering(
    execution: &CoveringExecution,
    timeout_seconds: u64,
) -> CoveringResult {
    if execution.is_negative() {
        execute_negative_covering(execution, timeout_seconds)
    } else {
        execute_positive_covering(execution, timeout_seconds)
    }
}

pub(crate) fn capture_agent_input(
    connection: &Connection,
    execution: &CoveringExecution,
) -> Result<crate::domains::agent_runtime::ledger::Input, String> {
    use super::applicability::trusted_source_project_identity;
    use crate::domains::agent_runtime::{
        ledger::Input,
        policy::State,
        source::{hash, Snapshot},
    };
    let identity =
        trusted_source_project_identity(&execution.source_metadata).unwrap_or_else(|| json!({}));
    let candidate = json!({"type":execution.candidate_type,"polarity":if execution.is_negative(){"negative"}else{"positive"},
        "title":execution.candidate_title,"content":execution.candidate_content});
    let bundle_id = execution
        .candidate_origin
        .pointer("/agentRuntime/bundleId")
        .and_then(Value::as_str);
    let mut bundle = None;
    let mut state = if let Some(bundle_id) = bundle_id {
        // The bundle is authoritative only through the persisted Finding lineage of this candidate.
        // Matching content alone cannot establish project scope or input-generation provenance.
        let (candidate_hash,bundle_hash,raw,parent_identity,parent_run,parent_generation)=connection.query_row(
            "select b.candidate_hash,b.bundle_hash,b.bundle_json,r.identity_json,r.id,r.input_generation
             from agent_evidence_bundles b join agent_runs r on r.id=b.run_id
             join found_candidates fc on fc.finding_job_id=r.job_id
             where b.id=?1 and fc.id=?2 and r.queue_name='findingCandidate'
               and r.protocol_version=3 and r.status='completed' and b.root_lineage=r.root_lineage",
            rusqlite::params![bundle_id,execution.found_candidate_id],
            |r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,i64>(5)?)))
            .map_err(|_|"evidence_bundle_provenance_mismatch")?;
        if execution
            .candidate_origin
            .pointer("/agentRuntime/runId")
            .and_then(Value::as_str)
            != Some(parent_run.as_str())
            || execution
                .candidate_origin
                .pointer("/agentRuntime/generation")
                .and_then(Value::as_i64)
                != Some(parent_generation)
        {
            return Err("evidence_bundle_provenance_mismatch".into());
        }
        if candidate_hash != hash(&candidate.to_string())
            || bundle_hash != hash(&raw)
            || execution
                .candidate_origin
                .pointer("/agentRuntime/bundleHash")
                .and_then(Value::as_str)
                != Some(bundle_hash.as_str())
        {
            return Err("evidence_bundle_binding_mismatch".into());
        }
        let b: Value = serde_json::from_str(&raw).map_err(|_| "evidence_bundle_invalid")?;
        let snapshot_ids = b["snapshotIds"]
            .as_array()
            .ok_or("evidence_bundle_invalid")?;
        let mut sources = Vec::new();
        let bound_identity = b
            .get("identity")
            .cloned()
            .ok_or("evidence_bundle_identity_missing")?;
        if serde_json::from_str::<Value>(&parent_identity)
            .map_err(|_| "evidence_bundle_identity_invalid")?
            != bound_identity
        {
            return Err("evidence_bundle_scope_mismatch".into());
        }
        if !identity.as_object().is_some_and(|o| o.is_empty()) && identity != bound_identity {
            return Err("evidence_bundle_scope_mismatch".into());
        }
        for id in snapshot_ids {
            let id = id.as_str().ok_or("evidence_bundle_invalid")?;
            let (h,scope,uri,kind,text)=connection.query_row("select source_hash,identity_hash,uri,kind,content from agent_snapshots where id=?1",[id],
                |r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?))).map_err(|_|"evidence_snapshot_missing")?;
            if hash(&text) != h || scope != hash(&bound_identity.to_string()) {
                return Err("evidence_snapshot_binding_mismatch".into());
            }
            sources.push(Snapshot {
                hash: h,
                uri,
                kind,
                text,
            });
        }
        let primary = sources
            .first()
            .cloned()
            .ok_or("evidence_snapshot_missing")?;
        let mut state = State::new(primary, Some(candidate.clone()));
        state.sources = sources;
        state.evidence =
            serde_json::from_value(b["evidence"].clone()).map_err(|_| "evidence_bundle_invalid")?;
        state.read_ranges = serde_json::from_value(b["readRanges"].clone())
            .map_err(|_| "evidence_bundle_invalid")?;
        state.history =
            serde_json::from_value(b["history"].clone()).map_err(|_| "evidence_bundle_invalid")?;
        for q in &state.evidence {
            state
                .sources
                .iter()
                .find(|s| s.hash == q.snapshot_hash)
                .ok_or("evidence_snapshot_missing")?
                .validate(q)?;
        }
        bundle = Some(b);
        state
    } else {
        let text = crate::domains::queue_lifecycle::finding_executor::filter_source_text(
            &execution.source_content,
        );
        State::new(
            Snapshot::new(
                execution.source_uri.clone(),
                if text.is_empty() {
                    "pending_primary"
                } else if execution.source_kind == "knowledge_candidate" {
                    "provided_candidate"
                } else {
                    "primary"
                }
                .into(),
                text,
            )?,
            Some(candidate),
        )
    };
    // A supplied candidate is not independent evidence. Capture its linked source separately.
    if state
        .sources
        .first()
        .is_some_and(|s| s.kind == "provided_candidate")
        && execution.source_kind != "knowledge_candidate"
    {
        let text = crate::domains::queue_lifecycle::finding_executor::filter_source_text(
            &execution.source_content,
        );
        state.sources.insert(
            0,
            Snapshot::new(
                execution.source_uri.clone(),
                if text.is_empty() {
                    "pending_primary"
                } else {
                    "primary"
                }
                .into(),
                text,
            )?,
        );
    }
    // Quote location reuse is separate from this run's semantic support judgment and usage.
    state.assessment = None;
    state.questions.clear();
    state.next = None;
    state.progress = Default::default();
    state.budget = Default::default();
    let identity = bundle
        .as_ref()
        .and_then(|b| b.get("identity"))
        .cloned()
        .unwrap_or(identity);
    let deferred_source = state
        .sources
        .first()
        .is_some_and(|s| s.kind == "pending_primary");
    Ok(Input {
        preview: connection.query_row("select coalesce(json_extract(payload,'$.agentPreview'),0) from covering_evidence_queue where id=?1",[&execution.job_id],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())?,
        generation: execution.input_generation,
        identity,
        source_key: execution.source_key.clone(),
        source_kind: execution.source_kind.clone(),
        source_uri: execution.source_uri.clone(),
        source_metadata: execution.source_metadata.clone(),
        distillation_version: execution.distillation_version.clone(),
        priority: 50,
        bundle,
        deferred_source,
        provided: false,
        provided_attributes: json!({"intentTags":execution.candidate_origin.get("intentTags"),"appliesTo":execution.candidate_origin.get("appliesTo")}),
        initial_state: state,
    })
}

pub(super) fn execute_positive_covering(
    execution: &CoveringExecution,
    timeout_seconds: u64,
) -> CoveringResult {
    if execution.provider_policy != "default" {
        return positive_failure_result(
            "provider_failed",
            "final",
            "cloud_api_provider_unavailable",
            Vec::new(),
        );
    }
    let source_read = match positive_source_content(execution, timeout_seconds) {
        Ok(source_read) if !source_read.content.trim().is_empty() => source_read,
        Ok(_) => {
            return positive_terminal_result(
                "insufficient",
                "source_support",
                "unsupported_by_source",
                source_reference(execution),
            )
        }
        Err(error) => {
            return positive_failure_result("tool_failed", "source_support", &error, Vec::new())
        }
    };
    let mut execution = execution.clone();
    execution.source_read_ranges = Some(source_read.read_ranges);
    let execution = &execution;
    let source_content = source_read.content;
    if normalized_character_count(&execution.candidate_title) < 3
        || normalized_character_count(&execution.candidate_content) < 24
    {
        return positive_terminal_result(
            "insufficient",
            "source_support",
            "not_actionable",
            source_reference(execution),
        );
    }
    if let Some(status) = execution.duplicate_status.as_deref() {
        let mut references = source_reference(execution);
        references.extend(execution.duplicate_refs.iter().filter_map(|duplicate| {
            let knowledge_id = duplicate.get("knowledgeId")?.as_str()?;
            Some(json!({
                "kind": "knowledge",
                "uri": format!("knowledge://{knowledge_id}"),
                "title": duplicate.get("title").and_then(Value::as_str),
                "note": duplicate.get("reason").and_then(Value::as_str).unwrap_or(status),
                "evidenceRole": "dedupe_match"
            }))
        }));
        return CoveringResult {
            status: status.to_string(),
            stage: "dedupe",
            candidate: None,
            references,
            duplicate_refs: execution.duplicate_refs.clone(),
            tool_events: Vec::new(),
            reason: Some(status.to_string()),
        };
    }

    let (source_supported, confidence, overlap) =
        evaluate_positive_source_support(&execution.candidate_content, &source_content);
    let candidate = base_positive_candidate(execution, confidence);
    if !candidate_has_project_identity(&candidate) {
        let mut result = positive_terminal_result(
            "insufficient",
            "source_support",
            "project_identity_required",
            source_reference(execution),
        );
        result.tool_events.push(json!({
            "name": "project_identity_required",
            "ok": false,
            "metadata": {
                "reason": "project_identity_required",
                "boundary": "finalize_distille",
                "preflight": true
            }
        }));
        return result;
    }
    let needs_external =
        requires_external_evidence(&execution.candidate_title, &execution.candidate_content);
    let mut diagnostics = Vec::new();
    if !source_supported {
        diagnostics.push(json!({
            "name": "source_support",
            "ok": false,
            "metadata": {
                "reason": "unsupported_by_source",
                "confidence": confidence,
                "overlapRatio": overlap,
                "mode": "llm_verification"
            }
        }));
    }
    diagnostics.push(json!({
        "name": "source_first_route",
        "ok": true,
        "metadata": {
            "route": if needs_external { "needs_external" } else { "source_only" },
            "reason": if needs_external { "requires_external_evidence" } else { "no_external_evidence_signal" }
        }
    }));

    let result = if needs_external {
        run_positive_external_evidence(execution, &candidate, &source_content, timeout_seconds)
    } else {
        run_positive_value_assessment(execution, &candidate, &source_content, timeout_seconds)
    };
    prepend_positive_tool_events(result, diagnostics)
}

pub(super) fn run_positive_value_assessment(
    execution: &CoveringExecution,
    candidate: &Value,
    source_content: &str,
    timeout_seconds: u64,
) -> CoveringResult {
    let system_prompt = match render_catalog_prompt(
        "coverEvidence.valueAssessment",
        &json!({
            "lowImportanceRejectThreshold": execution.low_importance_reject_threshold
        }),
    ) {
        Ok(prompt) => prompt,
        Err(error) => {
            return positive_failure_result(
                "parse_failed",
                "final",
                &error.to_string(),
                source_reference(execution),
            )
        }
    };
    let user_prompt = positive_value_user_prompt(execution, candidate, source_content);
    let completion = match request_covering_completion(
        execution,
        &system_prompt,
        &user_prompt,
        4096,
        timeout_seconds,
    ) {
        Ok(completion) => completion,
        Err(error) => {
            return positive_failure_result(
                "provider_failed",
                "final",
                &format!("value_provider_failed:{error}"),
                source_reference(execution),
            )
        }
    };
    let parsed = match parse_positive_response(&completion, candidate, "final") {
        Ok(result) => result,
        Err(error) => {
            return positive_failure_result(
                "parse_failed",
                "final",
                &format!("value_parse_failed:{error}"),
                source_reference(execution),
            )
        }
    };
    finalize_positive_result(execution, parsed, source_content, timeout_seconds)
}

pub(super) fn finalize_positive_result(
    execution: &CoveringExecution,
    mut result: CoveringResult,
    source_content: &str,
    timeout_seconds: u64,
) -> CoveringResult {
    result.references = merge_json_references(source_reference(execution), result.references);
    if result.status != "knowledge_ready" {
        return result;
    }
    let Some(mut candidate) = result.candidate.take() else {
        return positive_terminal_result(
            "insufficient",
            result.stage,
            "candidate_missing",
            result.references,
        );
    };
    let importance = candidate
        .get("importance")
        .and_then(Value::as_i64)
        .unwrap_or(70);
    if importance <= execution.low_importance_reject_threshold {
        return positive_terminal_result(
            "insufficient",
            result.stage,
            "low_importance",
            result.references,
        );
    }

    if !candidate_has_required_applicability(&candidate) {
        let refined =
            refine_positive_applicability(execution, &candidate, source_content, timeout_seconds);
        match refined {
            Ok((refined_candidate, event)) => {
                candidate = refined_candidate;
                result.tool_events.push(event);
            }
            Err(event) => result.tool_events.push(event),
        }
    }
    if !candidate_has_required_applicability(&candidate) {
        result.tool_events.push(json!({
            "name": "applicability_required",
            "ok": false,
            "metadata": {"reason": "applies_to_categories_required"}
        }));
        return CoveringResult {
            status: "insufficient".to_string(),
            stage: result.stage,
            candidate: None,
            references: result.references,
            duplicate_refs: result.duplicate_refs,
            tool_events: result.tool_events,
            reason: Some("applies_to_categories_required".to_string()),
        };
    }

    if !candidate_has_project_identity(&candidate) {
        result.tool_events.push(json!({
            "name": "project_identity_required",
            "ok": false,
            "metadata": {
                "reason": "project_identity_required",
                "boundary": "finalize_distille"
            }
        }));
        return CoveringResult {
            status: "insufficient".to_string(),
            stage: result.stage,
            candidate: None,
            references: result.references,
            duplicate_refs: result.duplicate_refs,
            tool_events: result.tool_events,
            reason: Some("project_identity_required".to_string()),
        };
    }

    if candidate.get("type").and_then(Value::as_str) == Some("procedure")
        && !has_skill_like_procedure_body(
            candidate
                .get("body")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
    {
        match repair_positive_procedure(execution, &candidate, source_content, timeout_seconds) {
            Ok(repaired) => {
                candidate = repaired;
                result.tool_events.push(json!({
                    "name": "procedure_repair",
                    "ok": true,
                    "metadata": {"reason": "procedure_repaired_from_source"}
                }));
            }
            Err(reason) => {
                if positive_rule_body_actionable(
                    candidate
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    candidate
                        .get("body")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                ) {
                    if let Some(object) = candidate.as_object_mut() {
                        object.insert("type".to_string(), json!("rule"));
                    }
                    result.tool_events.push(json!({
                        "name": "procedure_demoted_to_rule",
                        "ok": true,
                        "metadata": {"reason": reason}
                    }));
                } else {
                    return positive_terminal_result(
                        "insufficient",
                        result.stage,
                        "procedure_repair_failed",
                        result.references,
                    );
                }
            }
        }
    }
    if candidate.get("type").and_then(Value::as_str) == Some("rule")
        && !positive_rule_body_actionable(
            candidate
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            candidate
                .get("body")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
    {
        return positive_terminal_result(
            "insufficient",
            result.stage,
            "rule_body_not_actionable",
            result.references,
        );
    }
    result.candidate = Some(candidate);
    result.reason = None;
    result
}

/// Protocol-3 adapter: parsing may normalize legacy output, but scope and business gates are host owned.
pub(crate) fn agent_result(
    execution: &CoveringExecution,
    raw: &Value,
    identity: &Value,
) -> Result<CoveringResult, String> {
    let mut result = if execution.is_negative() {
        parse_negative_response(execution, &raw.to_string())
    } else {
        if !raw.is_object()
            || !matches!(
                raw["status"].as_str(),
                Some("knowledge_ready" | "insufficient" | "duplicate")
            )
        {
            return Err("invalid_covering_result".into());
        }
        parse_positive_response(
            &raw.to_string(),
            &base_positive_candidate(execution, 70),
            "final",
        )
    }
    .map_err(|e| e.to_string())?;
    if let Some(candidate) = result.candidate.as_mut() {
        let applies = candidate
            .get_mut("appliesTo")
            .and_then(Value::as_object_mut)
            .ok_or("applicability_required")?;
        // Identity is never accepted from model output or candidate text.
        for key in ["projectRef", "repoKey", "repoPath"] {
            applies.remove(key);
            if let Some(value) = identity
                .get(key)
                .filter(|v| v.as_str().is_some_and(|v| !v.is_empty()))
            {
                applies.insert(key.into(), value.clone());
            }
        }
        if !candidate_has_project_identity(candidate)
            || !candidate_has_required_applicability(candidate)
        {
            return Err("applicability_required".into());
        }
        if candidate["importance"]
            .as_i64()
            .is_none_or(|v| v <= execution.low_importance_reject_threshold || v > 100)
            || candidate["confidence"]
                .as_i64()
                .is_none_or(|v| !(0..=100).contains(&v))
        {
            return Err("candidate_value_invalid".into());
        }
        let kind = candidate["type"].as_str().ok_or("candidate_type_invalid")?;
        let body = candidate["body"].as_str().ok_or("candidate_body_invalid")?;
        if execution.is_negative() && kind != "rule"
            || !matches!(kind, "rule" | "procedure")
            || kind == "procedure" && !has_skill_like_procedure_body(body)
            || !execution.is_negative()
                && kind == "rule"
                && !positive_rule_body_actionable(
                    candidate["title"].as_str().unwrap_or_default(),
                    body,
                )
        {
            return Err("candidate_body_invalid".into());
        }
    }
    Ok(result)
}
