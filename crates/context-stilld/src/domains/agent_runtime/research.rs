//! Durable async broker: one submission, idempotent lookup, confirmed cancellation and host usage.
use super::{
    config::ResearchConfig,
    gateway,
    ledger::{require_owner, Run},
    source::{hash, Snapshot},
};
use crate::domains::{
    queue_lifecycle::provider_execution::open_query_only_connection, sqlite_writer,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{io::Read, time::Duration};

pub(crate) fn start(
    run: &mut Run,
    config: &ResearchConfig,
    ids: &[String],
    gain: &str,
    release_io: &mut dyn FnMut(),
) -> Result<(), String> {
    config.validate()?;
    if run.state.progress.delegated {
        return Err("research_delegation_limit".into());
    }
    run.release_for_io()?;
    release_io();
    let ready = remote(run, config, "GET", "/ready", None)?;
    if ready["contractVersion"] != "contextstill-research.v1"
        || ready["liveReady"] != true
        || ready["hostGateway"] != true
        || ready["usageReceipts"] != true
        || ready["cancelConfirmation"] != true
        || ready["scopeBinding"] != true
    {
        return Err("research_capability_missing".into());
    }
    let questions = run
        .state
        .questions
        .iter()
        .filter(|q| ids.contains(&q.id) && !q.resolved)
        .map(|q| json!({"id":q.id,"question":q.question,"successCriterion":q.success_criteria}))
        .collect::<Vec<_>>();
    if questions.len() != ids.len() {
        return Err("research_material_gap_missing".into());
    }
    let operation = gap_operation(&questions);
    let mut budget = run.state.budget.clone();
    let total = budget.research_remaining()?.min(262144);
    let outputs = 65536u64.min(total / 4);
    let inputs = 196608u64.min(total.saturating_sub(outputs));
    let total = inputs + outputs;
    if inputs < 4096 || outputs < 1024 {
        return Err("research_budget_exhausted".into());
    }
    let c = open_query_only_connection(&run.path).map_err(|e| e.to_string())?;
    let (queries, documents, urls) = c
        .query_row(
            "select 6-search_count,8-document_count,16-url_count from agent_lineages where id=?1",
            [&run.lineage],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?.min(4),
                    r.get::<_, i64>(1)?.min(6),
                    r.get::<_, i64>(2)?.min(12),
                ))
            },
        )
        .map_err(|e| e.to_string())?;
    if queries < 1 || documents < 1 || urls < 1 {
        return Err("research_lineage_budget_exhausted".into());
    }
    let now = c
        .query_row("select unixepoch()", [], |r| r.get::<_, i64>(0))
        .map_err(|e| e.to_string())?;
    let id = format!("ar-d-{}", hash(&json!([run.id, operation]).to_string()));
    let request = json!({"contractVersion":"contextstill-research.v1","delegationId":id,"ownerRun":run.id,"rootLineage":run.lineage,"scopeHash":hash(&run.input.identity.to_string()),"identity":run.input.identity,"questions":questions,"expectedGain":gain,"inputTokens":inputs,"outputTokens":outputs,"hardTokens":total,"targetTokens":total.min(196608),"deadline":run.deadline.min(now+300),"limits":{"queries":queries,"documents":documents,"urls":urls,"depth":2,"llmCalls":12,"noGain":2,"fetchFailures":3},"gatewayUrl":config.gateway_url,"knownEvidence":run.state.evidence,"history":run.state.history});
    let prior_state = run.state.clone();
    budget.reserved = budget.reserved.checked_add(total).ok_or("usage_overflow")?;
    run.state.budget = budget;
    run.state.progress.delegated = true;
    run.state.next = None;
    let a = run.assignment.clone();
    let owner = run.id.clone();
    let lineage = run.lineage.clone();
    let data = json!({"input":run.input,"state":run.state}).to_string();
    let saved = request.to_string();
    let id_for_write = id.clone();
    let counter = if a.queue_name == "findingCandidate" {
        "finding_delegations"
    } else {
        "covering_delegations"
    };
    let persisted = sqlite_writer::execute_for_path(
        &run.path,
        "agent.research_reserve",
        move |c| {
            let tx = c.transaction().map_err(|e| e.to_string())?;
            require_owner(&tx, &a)?;
            let changed=tx.execute(&format!("update agent_lineages set external_reserved=external_reserved+?2,{counter}={counter}+1,search_count=search_count+?3,document_count=document_count+?4,url_count=url_count+?5,updated_at=CURRENT_TIMESTAMP where id=?1 and {counter}=0 and external_used+external_reserved+?2<=393216 and search_count+?3<=6 and document_count+?4<=8 and url_count+?5<=16"),params![lineage,total,queries,documents,urls]).map_err(|e|e.to_string())?;
            if changed != 1 {
                return Err("research_lineage_budget_exhausted".into());
            }
            tx.execute("insert into agent_delegations(id,root_lineage,run_id,idempotency_key,status,reserved_tokens,request_json) values(?1,?2,?3,?1,'submitting',?4,?5)",params![id_for_write,lineage,owner,total,saved]).map_err(|e|e.to_string())?;
            tx.execute("insert into agent_acquisitions(root_lineage,operation_key,owner_run,status,scope_hash) values(?1,?2,?3,'inflight',?4)",params![lineage,operation,owner,hash(&run_identity_from_data(&data)?)]).map_err(|e|e.to_string())?;
            tx.execute(
                "update agent_runs set state_json=?2,updated_at=CURRENT_TIMESTAMP where id=?1",
                params![owner, data],
            )
            .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(())
        },
    );
    if let Err(e) = persisted {
        run.state = prior_state;
        return Err(e);
    }
    let payload = request.to_string();
    let request_hash = format!("sha256:{}", hash(&payload));
    // An unknown outcome is resolved exclusively by GET by key, never a second POST.
    match remote(
        run,
        config,
        "POST",
        "/jobs",
        Some(&json!({"payloadJson":payload,"requestHash":request_hash})),
    ) {
        Ok(receipt) => {
            validate_binding(run, &request, &receipt, false)?;
            let job = receipt["jobId"]
                .as_str()
                .ok_or("research_job_id_missing")?
                .to_owned();
            let a = run.assignment.clone();
            sqlite_writer::execute_for_path(&run.path, "agent.research_submitted", move |c| {
                require_owner(c, &a)?;
                c.execute("update agent_delegations set remote_job_id=?2,status='running',updated_at=CURRENT_TIMESTAMP where id=?1 and status='submitting'",params![id,job]).map_err(|e|e.to_string())?;
                Ok(())
            })?;
        }
        Err(_) => run
            .state
            .history
            .push(json!({"research":"submission_result_unknown","delegationId":id})),
    }
    run.yield_queue("research_wait", Some(2), false)
}
fn run_identity_from_data(data: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(data).map_err(|_| "agent_state_corrupt")?;
    Ok(v["input"]["identity"].to_string())
}

/// Returns true when this tick belongs to a research wait (including terminal ingestion).
pub(crate) fn poll(
    run: &mut Run,
    config: Option<&ResearchConfig>,
    release_io: &mut dyn FnMut(),
) -> Result<bool, String> {
    let c = open_query_only_connection(&run.path).map_err(|e| e.to_string())?;
    let row=c.query_row("select id,status,reserved_tokens,request_json from agent_delegations where run_id=?1 and status in ('submitting','running','cancel_requested') order by created_at limit 1",[&run.id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,u64>(2)?,r.get::<_,String>(3)?))).optional().map_err(|e|e.to_string())?;
    let Some((id, status, reserved, raw)) = row else {
        return Ok(false);
    };
    let config = config.ok_or("research_capability_missing")?;
    config.validate()?;
    let request: Value = serde_json::from_str(&raw).map_err(|_| "research_request_corrupt")?;
    run.release_for_io()?;
    release_io();
    let path = format!("/jobs/by-key/{id}");
    let now = c
        .query_row("select unixepoch()", [], |r| r.get::<_, i64>(0))
        .map_err(|e| e.to_string())?;
    if now
        >= request["deadline"]
            .as_i64()
            .ok_or("research_deadline_missing")?
        && status != "cancel_requested"
    {
        let a = run.assignment.clone();
        let id = id.clone();
        sqlite_writer::execute_for_path(&run.path, "agent.research_cancel_requested", move |c| {
            require_owner(c, &a)?;
            c.execute("update agent_delegations set status='cancel_requested',updated_at=CURRENT_TIMESTAMP where id=?1",[id]).map_err(|e|e.to_string())?;
            Ok(())
        })?;
        let _ = remote(
            run,
            config,
            "POST",
            &format!("{path}/cancel"),
            Some(&json!({})),
        );
    }
    let result = match remote(run, config, "GET", &path, None) {
        Ok(v) => v,
        Err(e) if e == "research_http_404" => {
            return Err("research_submission_unknown_not_found".into())
        }
        Err(_) => {
            run.yield_queue("research_wait_unavailable", Some(5), false)?;
            return Ok(true);
        }
    };
    validate_binding(run, &request, &result, true)?;
    if result["terminal"] != true {
        run.yield_queue("research_wait", Some(2), false)?;
        return Ok(true);
    }
    if result["status"] == "cancelled" && result["cancelConfirmed"] != true {
        return Err("research_cancel_unconfirmed".into());
    }
    let (unknown,used)=c.query_row("select coalesce(sum(case when status!='succeeded' or usage_tokens is null then 1 else 0 end),0),coalesce(sum(usage_tokens),0) from agent_research_requests where delegation_id=?1",[&id],|r|Ok((r.get::<_,u64>(0)?,r.get::<_,u64>(1)?))).map_err(|e|e.to_string())?;
    if unknown > 0 {
        return Err("research_request_result_unknown".into());
    }
    if used > reserved {
        return Err("research_usage_exceeded_reservation".into());
    }
    if result["usage"]["tokens"].as_u64() != Some(used) {
        return Err("research_usage_receipt_mismatch".into());
    }
    let queries = usage_count(&result, &request, "queries")?;
    let documents = usage_count(&result, &request, "documents")?;
    let urls = usage_count(&result, &request, "urls")?;
    let new_reserved = run
        .state
        .budget
        .reserved
        .checked_sub(reserved)
        .ok_or("research_reservation_corrupt")?;
    let new_used = run
        .state
        .budget
        .used
        .checked_add(used)
        .ok_or("usage_overflow")?;
    let sources = result["sources"]
        .as_array()
        .filter(|s| s.len() <= 6)
        .ok_or("research_sources_invalid")?;
    let mut acquired = Vec::new();
    for source in sources {
        let text = source["text"].as_str().ok_or("research_source_invalid")?;
        if source["snapshotHash"] != hash(text) {
            return Err("research_snapshot_hash_mismatch".into());
        }
        let uri = source["uri"].as_str().ok_or("research_source_invalid")?;
        let parsed = reqwest::Url::parse(uri).map_err(|_| "research_uri_invalid")?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("research_uri_invalid".into());
        }
        acquired.push(Snapshot::new(
            uri.into(),
            "research".into(),
            crate::domains::queue_lifecycle::finding_executor::filter_source_text(text),
        )?);
    }
    // Only filtered snapshots enter host receipts. Child quote text is re-read and
    // independently located by the parent; raw child artifacts have no authority.
    let safe_result = json!({"contractVersion":result["contractVersion"],"delegationId":result["delegationId"],"jobId":result["jobId"],"ownerRun":result["ownerRun"],"rootLineage":result["rootLineage"],"scopeHash":result["scopeHash"],"requestHash":result["requestHash"],"status":result["status"],"stopReason":result["stopReason"],"usage":result["usage"],"sources":acquired,"evidenceCount":result["evidence"].as_array().map_or(0,Vec::len),"unresolvedCount":result["unresolved"].as_array().map_or(0,Vec::len)});
    let prior_state = run.state.clone();
    let mut added = false;
    for snapshot in acquired {
        if !run.state.sources.iter().any(|s| s.hash == snapshot.hash) {
            run.state.sources.push(snapshot);
            added = true;
        }
    }
    run.state.history.push(json!({"research":"completed","delegationId":id,"stopReason":safe_result["stopReason"],"usageTokens":used,"unresolvedCount":safe_result["unresolvedCount"],"evidenceCount":safe_result["evidenceCount"]}));
    run.state
        .record_acquisition(&format!("research:{id}"), added, false);
    run.state.budget.reserved = new_reserved;
    run.state.budget.used = new_used;
    let data = json!({"input":run.input,"state":run.state}).to_string();
    let a = run.assignment.clone();
    let owner = run.id.clone();
    let lineage = run.lineage.clone();
    let snapshots = run.state.sources.clone();
    let identity = hash(&run.input.identity.to_string());
    let output = safe_result.to_string();
    let persisted = sqlite_writer::execute_for_path(
        &run.path,
        "agent.research_complete",
        move |c| {
            let tx = c.transaction().map_err(|e| e.to_string())?;
            require_owner(&tx, &a)?;
            tx.execute("update agent_delegations set status='completed',remote_job_id=?3,result_json=?2,updated_at=CURRENT_TIMESTAMP where id=?1 and status in ('submitting','running','cancel_requested')",params![id,output,result["jobId"].as_str()]).map_err(|e|e.to_string())?;
            tx.execute("update agent_lineages set external_reserved=external_reserved-?2,external_used=external_used+?3,search_count=search_count-?4+?5,document_count=document_count-?6+?7,url_count=url_count-?8+?9,updated_at=CURRENT_TIMESTAMP where id=?1",params![lineage,reserved,used,request["limits"]["queries"].as_i64(),queries,request["limits"]["documents"].as_i64(),documents,request["limits"]["urls"].as_i64(),urls]).map_err(|e|e.to_string())?;
            tx.execute("update agent_acquisitions set status='succeeded',result_json=?2,updated_at=CURRENT_TIMESTAMP where owner_run=?1 and operation_key like 'research:%' and status='inflight'",params![owner,output]).map_err(|e|e.to_string())?;
            for s in snapshots {
                tx.execute("insert or ignore into agent_snapshots(id,source_hash,identity_hash,uri,kind,content) values(?1,?2,?3,?4,?5,?6)",params![hash(&json!([s.hash,identity,s.uri,s.kind]).to_string()),s.hash,identity,s.uri,s.kind,s.text]).map_err(|e|e.to_string())?;
            }
            tx.execute(
                "update agent_runs set state_json=?2,updated_at=CURRENT_TIMESTAMP where id=?1",
                params![owner, data],
            )
            .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(())
        },
    );
    if let Err(e) = persisted {
        run.state = prior_state;
        return Err(e);
    }
    run.yield_queue("research_acquired", Some(0), false)?;
    Ok(true)
}
fn validate_binding(
    run: &Run,
    request: &Value,
    receipt: &Value,
    result: bool,
) -> Result<(), String> {
    for key in ["contractVersion", "delegationId", "ownerRun", "scopeHash"] {
        if request[key] != receipt[key] {
            return Err("research_owner_binding_mismatch".into());
        }
    }
    if receipt["requestHash"] != format!("sha256:{}", hash(&request.to_string()))
        || (result && receipt["rootLineage"] != run.lineage)
    {
        return Err("research_request_binding_mismatch".into());
    }
    Ok(())
}
fn remote(
    run: &Run,
    config: &ResearchConfig,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, String> {
    let key = gateway::credential(&run.path, &config.credential_key)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "research_http_client_failed")?;
    let url = format!("{}{path}", config.base_url.trim_end_matches('/'));
    let mut request = if method == "GET" {
        client.get(url)
    } else {
        client.post(url)
    };
    request = request.bearer_auth(key.as_str());
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request.send().map_err(|_| "research_http_unavailable")?;
    if !response.status().is_success() {
        return Err(format!("research_http_{}", response.status().as_u16()));
    }
    let mut bytes = Vec::new();
    response
        .take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "research_http_read_failed")?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("research_result_byte_limit".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "research_result_invalid_json".into())
}

fn usage_count(result: &Value, request: &Value, key: &str) -> Result<i64, String> {
    result["usage"][key]
        .as_i64()
        .filter(|n| *n >= 0 && *n <= request["limits"][key].as_i64().unwrap_or(0))
        .ok_or_else(|| "research_usage_invalid".into())
}

fn gap_operation(questions: &[Value]) -> String {
    // Question IDs belong to a policy/run. They must not permit the same
    // material gap to be researched again in the inherited lineage.
    let mut gaps = questions
        .iter()
        .map(|q| {
            json!([
                q["question"]
                    .as_str()
                    .unwrap_or_default()
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" "),
                q["successCriterion"]
                    .as_str()
                    .unwrap_or_default()
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
            ])
            .to_string()
        })
        .collect::<Vec<_>>();
    gaps.sort();
    gaps.dedup();
    format!("research:{}", hash(&json!(gaps).to_string()))
}
#[cfg(test)]
mod gap_tests {
    use super::*;
    #[test]
    fn material_gap_identity_is_independent_of_policy_ids_and_order() {
        let a = vec![
            json!({"id":"finding-a","question":"API 条件","successCriterion":"原資料"}),
            json!({"id":"finding-b","question":"根拠","successCriterion":"支持条件"}),
        ];
        let b = vec![
            json!({"id":"covering-b","question":"根拠","successCriterion":"支持条件"}),
            json!({"id":"covering-a","question":"API  条件","successCriterion":"原資料"}),
        ];
        assert_eq!(gap_operation(&a), gap_operation(&b));
        assert_ne!(
            gap_operation(&a),
            gap_operation(&[json!({"question":"新しい反証","successCriterion":"原資料"})])
        );
    }
}
