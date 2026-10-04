//! One durable decision per queue tick. Acquisition/wait ticks release the shared request slot.
use super::{
    config::Config,
    ledger::{self, release_request, require_owner, Run, Step},
    measurement,
    policy::{Action, Envelope, EvidenceDraft},
    projection,
    source::{hash, Snapshot},
    transport::{self, CompletionRequest},
};
use crate::domains::{
    queue_lifecycle::{
        common::queue_table_name,
        covering_executor::{self, CoveringExecution, CoveringPersistStatus},
        episode_executor::LocalLlmTargetConfig,
        provider_execution::{open_query_only_connection, ProviderExecutionHeartbeatGuard},
        types::ProviderLeaseAssignment,
    },
    sqlite_writer,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Assessment {
    status: String,
    result: Value,
    claims: Vec<Claim>,
    material_gaps: Vec<String>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Claim {
    claim: String,
    supported: bool,
    evidence: Vec<EvidenceDraft>,
}

pub(crate) fn should_run(
    connection: &Connection,
    settings: &Value,
    a: &ProviderLeaseAssignment,
) -> Result<bool, String> {
    if !matches!(
        a.queue_name.as_str(),
        "findingCandidate" | "coveringEvidence"
    ) {
        return Ok(false);
    }
    let table = queue_table_name(&a.queue_name).map_err(|e| e.to_string())?;
    let has_protocol=connection.query_row(&format!("select exists(select 1 from pragma_table_info('{table}') where name='protocol_version')"),[],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())?;
    let protocol = if has_protocol {
        connection
            .query_row(
                &format!("select protocol_version from {table} where id=?1"),
                [&a.queue_job_id],
                |r| r.get::<_, i64>(0),
            )
            .map_err(|e| e.to_string())?
    } else {
        1
    };
    if protocol > super::ledger::PROTOCOL as i64 {
        return Err("agent_protocol_unsupported".into());
    }
    let pinned = protocol == super::ledger::PROTOCOL as i64;
    Ok(pinned || Config::from_settings(settings)?.enabled)
}

#[derive(Clone, Copy)]
pub(crate) struct TickRequest<'a> {
    pub target: &'a LocalLlmTargetConfig,
    pub key: Option<&'a str>,
    pub settings: &'a Value,
    pub timeout: u64,
    pub covering: Option<&'a CoveringExecution>,
    pub source_root: &'a Path,
}
pub(crate) fn tick(
    path: &Path,
    a: ProviderLeaseAssignment,
    request: TickRequest<'_>,
    release_io: &mut dyn FnMut(),
) -> Result<bool, String> {
    let TickRequest {
        target: _,
        key: _,
        settings,
        timeout: _,
        covering,
        source_root: _,
    } = request;
    let reader = open_query_only_connection(path).map_err(|e| e.to_string())?;
    let captured = if let Some(input) = ledger::saved_input(&reader, &a)? {
        Ok(input)
    } else if let Some(execution) = covering {
        covering_executor::capture_agent_input(&reader, execution)
    } else {
        crate::domains::queue_lifecycle::finding_executor::capture_agent_input(
            &reader,
            &a.queue_job_id,
        )
    };
    let input = match captured {
        Ok(input) => input,
        Err(error) => {
            ledger::pause_unprepared(path, &a, &error)?;
            return Ok(false);
        }
    };
    if let Some(execution) = covering {
        let candidate = json!({"type":execution.candidate_type,"polarity":if execution.is_negative(){"negative"}else{"positive"},"title":execution.candidate_title,"content":execution.candidate_content});
        if input.initial_state.original_candidate.as_ref() != Some(&candidate) {
            ledger::pause_unprepared(path, &a, "covering_input_generation_changed")?;
            return Ok(false);
        }
    }
    let mut run = ledger::prepare(path, a, input)?;
    let _heartbeat =
        ProviderExecutionHeartbeatGuard::start(path, &run.assignment).map_err(|e| e.to_string())?;
    let config = Config::from_settings(settings)?;
    let outcome = advance(&mut run, &reader, &config, &request, release_io);
    match outcome {
        Ok(done) => Ok(done),
        Err(error) => {
            run.yield_queue(&error, None, false)?;
            Ok(false)
        }
    }
}

fn advance(
    run: &mut Run,
    reader: &Connection,
    config: &Config,
    request: &TickRequest<'_>,
    release_io: &mut dyn FnMut(),
) -> Result<bool, String> {
    let TickRequest {
        target,
        key,
        settings: _,
        timeout,
        covering,
        source_root,
    } = *request;
    let unknown=reader.query_row("select exists(select 1 from agent_steps where run_id=?1 and status in ('inflight','result_unknown'))",[&run.id],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())?;
    if unknown {
        return Err("agent_request_result_unknown".into());
    }
    let invalid_receipt=reader.query_row("select exists(select 1 from agent_steps where run_id=?1 and status='succeeded' and
        (json_extract(result_json,'$.providerContractViolation')=1 or json_extract(result_json,'$.budgetError') is not null
         or json_extract(result_json,'$.terminalError') is not null))",[&run.id],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())?;
    if invalid_receipt {
        return Err("provider_context_contract_violation".into());
    }
    let replay=reader.query_row("select step_no,json_extract(result_json,'$.content') from agent_steps where run_id=?1 and status='succeeded' and step_no>?2 order by step_no limit 1",
        params![run.id,run.state.applied_step],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?))).optional().map_err(|e|e.to_string())?;
    if let Some((no, content)) = replay {
        return apply_response(run, &content, no, covering);
    }
    if super::research::poll(run, config.research.as_ref(), release_io)? {
        return Ok(false);
    }
    let now = reader
        .query_row("select unixepoch()", [], |r| r.get::<_, i64>(0))
        .map_err(|e| e.to_string())?;
    if now >= run.deadline {
        return finish(run, covering, "timeout");
    }
    if run.input.provided {
        return projection::finish_finding(run, "provided_candidate");
    }
    if run.input.deferred_source {
        run.release_for_io()?;
        release_io();
        let root = source_root;
        let operation = hash(
            &json!([
                "primary",
                run.input.source_kind,
                run.input.source_key,
                run.input.source_uri
            ])
            .to_string(),
        );
        let snapshot = match super::acquisition::begin(run, &operation)? {
            super::acquisition::Acquisition::Saved(snapshot) => snapshot,
            super::acquisition::Acquisition::Unknown => {
                return Err("acquisition_result_unknown".into())
            }
            super::acquisition::Acquisition::Exhausted => return Err("retrieval_failed".into()),
            super::acquisition::Acquisition::Start { attempt } => {
                let fetched = covering_executor::source::raw_source_content(
                    &run.input.source_kind,
                    &run.input.source_key,
                    &run.input.source_uri,
                    root,
                    "",
                    timeout.min(30),
                );
                match fetched {
                    Ok(text) if !text.trim().is_empty() => {
                        let snapshot =
                            Snapshot::new(run.input.source_uri.clone(), "primary".into(), text)?;
                        super::acquisition::complete(
                            run,
                            &operation,
                            attempt,
                            Some(&snapshot),
                            false,
                        )?;
                        snapshot
                    }
                    fetched => {
                        let retryable = fetched.as_ref().err().is_some_and(|e| {
                            e.contains("timeout")
                                || e.contains("request failed")
                                || e.contains("HTTP 5")
                        });
                        super::acquisition::complete(run, &operation, attempt, None, retryable)?;
                        run.state.record_acquisition(&operation, false, true);
                        if retryable && attempt == 1 {
                            run.yield_queue("source_fetch_retry", Some(1), false)?;
                            return Ok(false);
                        }
                        return Err("source_fetch_failed".into());
                    }
                }
            }
        };
        run.state.sources[0] = snapshot;
        run.input.deferred_source = false;
        save_sources(run)?;
        run.yield_queue("primary_source_acquired", Some(0), false)?;
        return Ok(false);
    }
    if run.state.progress.no_gain >= super::policy::NO_GAIN_LIMIT
        || run.state.progress.fetch_failures >= super::policy::FETCH_FAILURE_LIMIT
    {
        return finish(
            run,
            covering,
            if run.state.progress.no_gain >= super::policy::NO_GAIN_LIMIT {
                "no_gain"
            } else {
                "retrieval_failed"
            },
        );
    }
    if !run.state.finalizing {
        if let Some(action) = run.state.next.clone() {
            match action {
                Action::Finish { reason } => return finish(run, covering, &reason),
                Action::ReadSource {
                    snapshot_hash,
                    from_byte,
                    to_byte,
                    ..
                } => {
                    run.release_for_io()?;
                    release_io();
                    let repeated =
                        run.state.read_ranges.iter().any(|(h, a, b)| {
                            h == &snapshot_hash && *a <= from_byte && to_byte <= *b
                        });
                    if repeated {
                        run.state.record_acquisition(
                            &format!("read:{snapshot_hash}:{from_byte}:{to_byte}"),
                            false,
                            false,
                        );
                    } else {
                        run.state.history.push(json!({"acquisition":"read","snapshotHash":snapshot_hash,"fromByte":from_byte,"toByte":to_byte,"pendingGain":true}));
                    }
                    run.state.next = None;
                    run.yield_queue("source_read_planned", Some(0), false)?;
                    return Ok(false);
                }
                Action::LookupKnowledge {
                    query, question_id, ..
                } => {
                    run.release_for_io()?;
                    release_io();
                    if run.state.progress.knowledge_calls >= super::policy::KNOWLEDGE_CALL_LIMIT {
                        return finish(run, covering, "knowledge_limit");
                    }
                    run.state.progress.knowledge_calls += 1;
                    let result = lookup_knowledge(reader, &run.input.identity, &query);
                    match result {
                        Ok(sources) => {
                            let mut added = false;
                            for source in sources {
                                if !run
                                    .state
                                    .sources
                                    .iter()
                                    .any(|s| s.hash == source.hash && s.kind == source.kind)
                                {
                                    run.state.history.push(json!({"acquisition":"knowledge","questionId":question_id,"snapshotHash":source.hash,"pendingGain":true}));
                                    run.state.sources.push(source);
                                    added = true;
                                }
                            }
                            if !added {
                                run.state.record_acquisition(
                                    &format!("knowledge:{question_id}"),
                                    false,
                                    false,
                                );
                            }
                        }
                        Err(reason) => {
                            run.state
                                .history
                                .push(json!({"acquisition":"knowledge","reason":reason}));
                            run.state.record_acquisition(
                                &format!("knowledge:{question_id}"),
                                false,
                                true,
                            );
                        }
                    }
                    run.state.next = None;
                    save_sources(run)?;
                    run.yield_queue("knowledge_acquired", Some(0), false)?;
                    return Ok(false);
                }
                Action::DelegateResearch {
                    question_ids,
                    expected_gain,
                } => {
                    if let Some(research) = &config.research {
                        super::research::start(
                            run,
                            research,
                            &question_ids,
                            &expected_gain,
                            release_io,
                        )?;
                        return Ok(false);
                    }
                    return finish(run, covering, "research_capability_missing");
                }
            }
        }
    }
    if !run.state.finalizing
        && (run
            .state
            .budget
            .used
            .saturating_add(run.state.budget.reserved)
            >= run.state.budget.target
            || run.state.budget.calls >= super::budget::EXPLORATION_CALLS)
    {
        return finish(run, covering, "budget_target");
    }
    let capability = config.request_capability(reader, &run.assignment.id, target)?;
    let output = super::budget::AGENT_OUTPUT_TOKENS;
    let mut chunk_bytes = 24_000;
    let (messages, measured, ranges) = loop {
        let (messages, ranges) = context(
            run,
            covering.is_some(),
            chunk_bytes,
            config.research.is_some(),
        )?;
        let request = CompletionRequest {
            target,
            api_key: key,
            messages: &messages,
            max_output: output,
            response_format: Some(json!({"type":"json_object"})),
            timeout_seconds: timeout,
        };
        match measurement::measure(&capability, &transport::request_body(&request)) {
            Ok(measured) => break (messages, measured, ranges),
            Err(error) if error == "context_limit" && chunk_bytes > 1_000 => {
                chunk_bytes /= 2;
            }
            Err(error) => return Err(error),
        }
    };
    // Only excerpts in the measured, admitted request become readable evidence locations.
    for range in ranges {
        if !run.state.read_ranges.contains(&range) {
            run.state.read_ranges.push(range);
        }
    }
    let current = reader
        .query_row("select unixepoch()", [], |r| r.get::<_, i64>(0))
        .map_err(|e| e.to_string())?;
    if current >= run.deadline {
        return finish(run, covering, "timeout");
    }
    let timeout = timeout.min((run.deadline - current) as u64);
    let step = match run.begin_llm(&measured, output) {
        Ok(step) => step,
        Err(error) if error == "budget_exhausted" && !run.state.finalizing => {
            return finish(run, covering, "budget_exhausted")
        }
        Err(error) => return Err(error),
    };
    let result = match transport::send(CompletionRequest {
        target,
        api_key: key,
        messages: &messages,
        max_output: output,
        response_format: Some(json!({"type":"json_object"})),
        timeout_seconds: timeout,
    }) {
        Ok(result) => result,
        Err(_) => {
            record_unknown(run, &step)?;
            return Err("agent_request_result_unknown".into());
        }
    };
    let no = step.no;
    run.finish_llm(step, &result)?;
    apply_response(run, &result.content, no, covering)
}

fn apply_response(
    run: &mut Run,
    content: &str,
    no: i64,
    covering: Option<&CoveringExecution>,
) -> Result<bool, String> {
    let parsed = serde_json::from_str::<Envelope>(content)
        .map_err(|_| "invalid_agent_output".to_owned())
        .and_then(|envelope| {
            run.state
                .validate_envelope(&envelope, covering.is_some())
                .map(|evidence| (envelope, evidence))
        });
    match parsed {
        Ok((envelope, evidence)) => {
            if covering.is_some() && envelope.assessment.is_none() {
                return Err("assessment_missing".into());
            }
            let mut evidence = evidence;
            if let Some(assessment) = &envelope.assessment {
                let assessment = validate_assessment(run, assessment)?;
                for draft in assessment.claims.iter().flat_map(|c| &c.evidence) {
                    let quote = run.state.locate(draft)?;
                    if !evidence.contains(&quote) {
                        evidence.push(quote);
                    }
                }
            }
            let meaningful = evidence.iter().any(|q| run.state.novel_evidence(q));
            if run.state.history.iter().any(|h| h["pendingGain"] == true) {
                for h in &mut run.state.history {
                    if h["pendingGain"] == true {
                        h["pendingGain"] = json!(false);
                    }
                }
                run.state
                    .record_acquisition("acquisition_assessed", meaningful, false);
            }
            if run
                .state
                .assessment
                .as_ref()
                .is_some_and(|a| a["status"] == "rejected")
                && envelope
                    .assessment
                    .as_ref()
                    .is_some_and(|a| a["status"] == "supported")
            {
                if run.state.progress.reconsidered || !meaningful {
                    return Err("reconsideration_requires_new_evidence".into());
                }
                run.state.progress.reconsidered = true;
            }
            run.state.apply(envelope, evidence);
            // A repair instruction is consumed once; keeping the entire raw failed output forever
            // would inflate every later request and invite repeated formatting loops.
            run.state
                .history
                .retain(|h| h.get("formatRepair").is_none());
            run.state.applied_step = no;
            run.checkpoint("ready", None)?;
            if run.state.finalizing {
                return finish(run, covering, "final_verified");
            }
            run.yield_queue("agent_decision_saved", Some(0), false)?;
            Ok(false)
        }
        Err(error) => {
            if run.state.progress.format_repaired {
                return Err(error);
            }
            run.state.progress.format_repaired = true;
            run.state.applied_step = no;
            run.state
                .history
                .push(json!({"formatRepair":{"error":"invalid_agent_output","response":content}}));
            run.state.next = None;
            run.yield_queue("format_repair", Some(0), false)?;
            Ok(false)
        }
    }
}

fn context(
    run: &Run,
    covering: bool,
    chunk_bytes: usize,
    research_available: bool,
) -> Result<(Value, super::policy::ReadRanges), String> {
    let system = super::prompt::render_catalog_prompt(
        if covering {
            "coverEvidence.agentic"
        } else {
            "findCandidate.agentic"
        },
        &json!({}),
    )
    .map_err(|e| e.to_string())?;
    let mut excerpts = Vec::new();
    let mut ranges = Vec::new();
    for source in &run.state.sources {
        let chunks = source.ranges(chunk_bytes);
        let mut selected = Vec::new();
        if let Some(first) = chunks.first() {
            selected.push(*first);
        }
        if source.kind == "primary" {
            if let Some(last) = chunks.last() {
                if !selected.contains(last) {
                    selected.push(*last);
                }
            }
        }
        for q in run
            .state
            .evidence
            .iter()
            .filter(|q| q.snapshot_hash == source.hash)
        {
            if !selected.contains(&(q.from_byte, q.to_byte)) {
                selected.push((q.from_byte, q.to_byte));
            }
        }
        for h in run.state.history.iter().filter(|h| {
            h["pendingGain"] == true
                && h["snapshotHash"] == source.hash
                && h["acquisition"] == "read"
        }) {
            let from = h["fromByte"].as_u64().ok_or("read_range_invalid")? as usize;
            let to = h["toByte"].as_u64().ok_or("read_range_invalid")? as usize;
            // A large planned range is split, never turned into a model-token estimate.
            let requested = source.read(from, to)?;
            let mut end = from + requested.len().min(chunk_bytes);
            while !source.text.is_char_boundary(end) {
                end -= 1;
            }
            selected.push((from, end));
        }
        for (from, to) in selected {
            excerpts.push(json!({"snapshotHash":source.hash,"kind":source.kind,"uri":source.uri,"fromByte":from,"toByte":to,"text":source.read(from,to)?}));
            ranges.push((source.hash.clone(), from, to));
        }
    }
    let source_index = run
        .state
        .sources
        .iter()
        .map(|s| json!({"snapshotHash":s.hash,"uri":s.uri,"kind":s.kind,"byteLength":s.text.len()}))
        .collect::<Vec<_>>();
    let user = json!({"policy":if covering{"covering"}else{"finding"},"identity":run.input.identity,"originalCandidate":run.state.original_candidate,"candidateConstraints":run.input.provided_attributes,
        "candidates":run.state.candidates,"assessment":if run.state.finalizing {None}else{run.state.assessment.as_ref()},
        "finalArtifact":if run.state.finalizing {run.state.assessment.as_ref().and_then(|a|a.get("result"))}else{None},
        "questions":run.state.questions,"evidence":run.state.evidence,
        "history":run.state.history,"sources":source_index,"excerpts":excerpts,"finalizing":run.state.finalizing,"finalBodyHash":run.state.final_body_hash,
        "budget":{"used":run.state.budget.used,"reserved":run.state.budget.reserved,"target":run.state.budget.target,"hard":run.state.budget.hard,"calls":run.state.budget.calls,"maxCalls":super::budget::MAX_CALLS},
        "capabilities":{"lookupKnowledge":run.state.progress.knowledge_calls<super::policy::KNOWLEDGE_CALL_LIMIT,"delegateResearch":research_available&&!run.state.progress.delegated},
        "outputContract":{"version":1,"candidates":[],"assessment":null,"questions":[],"evidence":[],"next":{"kind":"finish","reason":"sufficient"}},
        "actionContracts":[{"kind":"read_source","snapshot_hash":"hash","from_byte":0,"to_byte":100,"question_id":"q1","expected_gain":"material gap"},
            {"kind":"lookup_knowledge","query":"query","question_id":"q1","expected_gain":"material gap"}],
        "questionContract":{"id":"q1","candidateKey":"candidate hash or source","question":"material question","successCriteria":"observable evidence","resolved":false},
        "evidenceContract":{"snapshotHash":"hash","fromByte":0,"text":"exact quote","role":"supports"},
        "candidateContract":{"candidate":{"type":"rule","polarity":"positive","title":"title","content":"content"},"evidence":[],"unresolvedQuestions":[]}});
    Ok((
        json!([{"role":"system","content":system},{"role":"user","content":user.to_string()}]),
        ranges,
    ))
}

fn validate_assessment(run: &Run, value: &Value) -> Result<Assessment, String> {
    let assessment: Assessment =
        serde_json::from_value(value.clone()).map_err(|_| "invalid_assessment")?;
    if !matches!(
        assessment.status.as_str(),
        "supported" | "rejected" | "unknown"
    ) || assessment.claims.len() > 64
        || assessment.material_gaps.len() > 12
    {
        return Err("invalid_assessment".into());
    }
    if assessment.status == "supported" {
        if !assessment.material_gaps.is_empty()
            || assessment.claims.is_empty()
            || assessment
                .claims
                .iter()
                .any(|c| c.claim.trim().is_empty() || !c.supported || c.evidence.is_empty())
        {
            return Err("unverified_claims".into());
        }
        for claim in &assessment.claims {
            if !claim.evidence.iter().any(|draft| {
                draft.role == "supports"
                    && run.state.sources.iter().any(|s| {
                        s.hash == draft.snapshot_hash
                            && matches!(s.kind.as_str(), "primary" | "research")
                    })
            }) {
                return Err("claim_requires_primary_support".into());
            }
            for draft in &claim.evidence {
                run.state.locate(draft)?;
            }
        }
    }
    Ok(assessment)
}

fn finish(
    run: &mut Run,
    covering: Option<&CoveringExecution>,
    reason: &str,
) -> Result<bool, String> {
    let Some(execution) = covering else {
        return projection::finish_finding(run, reason);
    };
    let assessment = run.state.assessment.as_ref().ok_or("assessment_missing")?;
    let assessment = validate_assessment(run, assessment)?;
    if assessment.status == "unknown" {
        return Err(if reason == "final_verified" {
            "final_verification_unknown".into()
        } else {
            reason.to_owned()
        });
    }
    if assessment.status == "supported" {
        if run.state.questions.iter().any(|q| !q.resolved) {
            return Err("material_gap_unresolved".into());
        }
        let raw = assessment.result.to_string();
        let body_hash = hash(&raw);
        if !run.state.finalizing {
            run.state.finalizing = true;
            run.state.final_body_hash = Some(body_hash);
            run.state.final_pending_after_step = Some(run.state.applied_step);
            run.state.next = None;
            run.yield_queue("independent_final_verification", Some(0), false)?;
            return Ok(false);
        }
        verify_final_artifact(&run.state, &body_hash, reason)?;
    }
    if assessment.result["status"] == "duplicate" {
        let reader = open_query_only_connection(&run.path).map_err(|e| e.to_string())?;
        let candidate = run
            .state
            .original_candidate
            .as_ref()
            .ok_or("candidate_missing")?;
        if !exact_duplicate(&reader, &run.input.identity, candidate)? {
            return Err("duplicate_evidence_required".into());
        }
    }
    let mut execution = execution.clone();
    execution.protocol_version = 3;
    execution.source_content = run
        .state
        .sources
        .first()
        .map(|s| s.text.clone())
        .unwrap_or_default();
    execution.source_metadata = json!({"projectIdentity":run.input.identity});
    let mut result = match covering_executor::agent_result(
        &execution,
        &assessment.result,
        &run.input.identity,
    ) {
        Ok(result) => result,
        Err(e) if e == "candidate_body_invalid" && !run.state.progress.body_repaired => {
            run.state.progress.body_repaired = true;
            run.state.finalizing = false;
            run.state.final_body_hash = None;
            run.state.final_pending_after_step = None;
            run.state.next = None;
            run.state.history.push(json!({"bodyRepair":{"reason":e,"limit":1,"requiresNewIndependentVerification":true}}));
            run.yield_queue("body_repair", Some(0), false)?;
            return Ok(false);
        }
        Err(e) => return Err(e),
    };
    if assessment.status == "rejected" && result.status == "knowledge_ready" {
        return Err("assessment_result_mismatch".into());
    }
    if assessment.status == "supported" && result.status != "knowledge_ready" {
        return Err("assessment_result_mismatch".into());
    }
    result.references = projection::evidence_references(run);
    result.tool_events.push(json!({"name":"agent_final_verification","ok":assessment.status=="supported","metadata":{"runId":run.id,"bodyHash":run.state.final_body_hash,"reason":reason,"usage":run.state.budget}}));
    run.state.final_result = Some(
        json!({"schemaVersion":1,"status":result.status,"stage":result.stage,"candidate":result.candidate,"references":result.references,"duplicateRefs":result.duplicate_refs,"toolEvents":result.tool_events,"reason":result.reason}),
    );
    if run.input.preview {
        let a = run.assignment.clone();
        let id = run.id.clone();
        let data = json!({"input":run.input,"state":run.state}).to_string();
        let reason = reason.to_owned();
        sqlite_writer::execute_for_path(&run.path, "agent.covering_preview", move |c| {
            let tx = c.transaction().map_err(|e| e.to_string())?;
            require_owner(&tx, &a)?;
            tx.execute("update covering_evidence_queue set status='completed',completed_at=CURRENT_TIMESTAMP,locked_by=null,locked_at=null,heartbeat_at=null,last_error=null,updated_at=CURRENT_TIMESTAMP where id=?1",[&a.queue_job_id]).map_err(|e|e.to_string())?;
            tx.execute("update agent_runs set status='completed',stop_reason=?2,state_json=?3,updated_at=CURRENT_TIMESTAMP where id=?1",params![id,reason,data]).map_err(|e|e.to_string())?;
            release_request(&tx, &a, "agent_preview_finished")?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(())
        })?;
        return Ok(true);
    }
    run.checkpoint("ready", Some(reason))?;
    let outcome =
        sqlite_writer::execute_for_path(&run.path, "agent.covering_project", move |connection| {
            covering_executor::persist_covering_result(connection, &execution, &result)
                .map_err(|e| e.to_string())
        })?;
    Ok(outcome == CoveringPersistStatus::Completed)
}

fn lookup_knowledge(
    connection: &Connection,
    identity: &Value,
    query: &str,
) -> Result<Vec<Snapshot>, String> {
    let repo = identity["repoKey"].as_str().filter(|s| !s.is_empty());
    let project = identity["projectRef"].as_str().filter(|s| !s.is_empty());
    let path = identity["repoPath"].as_str().filter(|s| !s.is_empty());
    if repo.is_none() && project.is_none() && path.is_none() {
        return Err("knowledge_scope_unresolved".into());
    }
    let words = query
        .split_whitespace()
        .collect::<std::collections::BTreeSet<_>>();
    if words.is_empty() || words.len() > 8 {
        return Err("knowledge_query_invalid".into());
    }
    let patterns = words
        .into_iter()
        .map(|word| {
            format!(
                "%{}%",
                word.replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            )
        })
        .collect::<Vec<_>>();
    let patterns = serde_json::to_string(&patterns).map_err(|e| e.to_string())?;
    let mut statement=connection.prepare("select id,title,body from knowledge_items where status='active'
        and (?1 is null or repo_key=?1) and (?2 is null or project_ref=?2) and (?3 is null or repo_path=?3)
        and not exists(select 1 from json_each(?4) term
            where not (title like term.value escape '\\' or body like term.value escape '\\'))
        order by importance desc,id limit 3").map_err(|e|e.to_string())?;
    let records = statement
        .query_map(params![repo, project, path, patterns], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    records
        .into_iter()
        .map(|(id, title, body)| {
            Snapshot::new(
                format!("knowledge://{id}"),
                "knowledge".into(),
                crate::domains::queue_lifecycle::finding_executor::filter_source_text(&format!(
                    "{title}\n{body}"
                )),
            )
        })
        .collect()
}

fn save_sources(run: &Run) -> Result<(), String> {
    let a = run.assignment.clone();
    let sources = run.state.sources.clone();
    let identity = hash(&run.input.identity.to_string());
    sqlite_writer::execute_for_path(&run.path, "agent.snapshot_acquired", move |connection| {
        let tx = connection.transaction().map_err(|e| e.to_string())?;
        require_owner(&tx, &a)?;
        for s in sources {
            tx.execute("insert or ignore into agent_snapshots(id,source_hash,identity_hash,uri,kind,content) values(?1,?2,?3,?4,?5,?6)",params![hash(&json!([s.hash,identity,s.uri,s.kind]).to_string()),s.hash,identity,s.uri,s.kind,s.text]).map_err(|e|e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
}
fn record_unknown(run: &Run, step: &Step) -> Result<(), String> {
    let a = run.assignment.clone();
    let id = run.id.clone();
    let no = step.no;
    sqlite_writer::execute_for_path(&run.path, "agent.request_unknown", move |connection| {
        let tx = connection.transaction().map_err(|e| e.to_string())?;
        require_owner(&tx, &a)?;
        tx.execute("update agent_steps set status='result_unknown',updated_at=CURRENT_TIMESTAMP where run_id=?1 and step_no=?2 and status='inflight'",params![id,no]).map_err(|e|e.to_string())?;
        release_request(&tx, &a, "request_result_unknown")?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
}

fn exact_duplicate(
    connection: &Connection,
    identity: &Value,
    candidate: &Value,
) -> Result<bool, String> {
    let repo = identity["repoKey"].as_str().filter(|s| !s.is_empty());
    let project = identity["projectRef"].as_str().filter(|s| !s.is_empty());
    let path = identity["repoPath"].as_str().filter(|s| !s.is_empty());
    if repo.is_none() && project.is_none() && path.is_none() {
        return Ok(false);
    }
    connection.query_row("select exists(select 1 from knowledge_items where status='active'
        and (?1 is null or repo_key=?1) and (?2 is null or project_ref=?2) and (?3 is null or repo_path=?3)
        and type=?4 and polarity=?5 and title=?6 and body=?7)",
        params![repo,project,path,candidate["type"].as_str(),candidate["polarity"].as_str(),candidate["title"].as_str(),candidate["content"].as_str()],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())
}

fn verify_final_artifact(
    state: &super::policy::State,
    body_hash: &str,
    reason: &str,
) -> Result<(), String> {
    if state
        .final_pending_after_step
        .is_none_or(|step| state.applied_step <= step)
        || reason != "final_verified"
    {
        return Err("final_verification_incomplete".into());
    }
    if state.final_body_hash.as_deref() != Some(body_hash) {
        return Err("final_artifact_changed".into());
    }
    Ok(())
}
#[cfg(test)]
mod verification_tests {
    use super::*;
    #[test]
    fn knowledge_search_uses_all_keywords_and_cannot_escape_its_scope() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("create table knowledge_items(id text,title text,body text,status text,repo_key text,project_ref text,repo_path text,importance real);
            insert into knowledge_items values
            ('noise','Rust','unrelated','active','repo-a',null,null,1.0),
            ('useful','Rust','queue budget','active','repo-a',null,null,0.5),
            ('foreign','Rust queue budget','other repository','active','repo-b',null,null,1.0),
            ('wildcard','Rust','literal % budget','active','repo-a',null,null,0.4);").unwrap();
        let scope = json!({"repoKey":"repo-a"});
        let sources = lookup_knowledge(&c, &scope, "Rust queue budget").unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].uri, "knowledge://useful");
        let sources = lookup_knowledge(&c, &scope, "Rust % budget").unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].uri, "knowledge://wildcard");
        assert_eq!(
            lookup_knowledge(&c, &json!({}), "Rust").unwrap_err(),
            "knowledge_scope_unresolved"
        );
    }
    #[test]
    fn timeout_budget_stop_and_old_response_never_adopt_an_unverified_body() {
        let mut state = super::super::policy::State::new(
            Snapshot::new("vibe://source".into(), "primary".into(), "根拠".into()).unwrap(),
            None,
        );
        state.finalizing = true;
        state.final_body_hash = Some("body".into());
        state.final_pending_after_step = Some(1);
        state.applied_step = 1;
        assert!(verify_final_artifact(&state, "body", "final_verified").is_err());
        state.applied_step = 2;
        for reason in ["timeout", "budget_target", "no_gain"] {
            assert!(verify_final_artifact(&state, "body", reason).is_err());
        }
        assert_eq!(
            verify_final_artifact(&state, "changed", "final_verified").unwrap_err(),
            "final_artifact_changed"
        );
        verify_final_artifact(&state, "body", "final_verified").unwrap();
    }
}
