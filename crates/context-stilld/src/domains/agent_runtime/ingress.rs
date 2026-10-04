//! Authenticated resident ingress. Only this writer mutates versioned work.
use super::source::hash;
use crate::domains::sqlite_writer;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;

pub(crate) fn handle(path: &Path, body: Value) -> Result<Value, String> {
    if body.to_string().len() > 262_144 {
        return Err("agent_ingress_byte_limit".into());
    }
    let operation = body["operation"]
        .as_str()
        .ok_or("agent_operation_required")?
        .to_owned();
    sqlite_writer::execute_for_path(path, "agent.ingress", move |c| {
        match operation.as_str() {
            "finding" => {
                let target = if let Some(id) =
                    body["targetStateId"].as_str().filter(|v| !v.is_empty())
                {
                    c.query_row("select target_kind,target_key,source_uri,metadata from distillation_target_states where id=?1",[id],|r| Ok(json!({"targetKind":r.get::<_,String>(0)?,"targetKey":r.get::<_,String>(1)?,"sourceUri":r.get::<_,String>(2)?,"metadata":serde_json::from_str::<Value>(&r.get::<_,String>(3)?).unwrap_or(json!({}))}))).map_err(|_| "target_not_found")?
                } else {
                    body["sourceInput"].clone()
                };
                let kind = field(&target, "targetKind")?;
                if !matches!(kind, "wiki_file" | "vibe_memory" | "web_ingest") {
                    return Err("agent_source_kind_unsupported".into());
                }
                let key = field(&target, "targetKey")?;
                let uri = field(&target, "sourceUri")?;
                let preview = body["preview"] == true;
                let version = if preview {
                    "agent-v1-preview"
                } else {
                    "agent-v1"
                };
                let id = format!("ai-{}", hash(&json!([kind, key, version]).to_string()));
                let metadata = target
                    .get("metadata")
                    .filter(|v| v.is_object())
                    .cloned()
                    .unwrap_or(json!({}));
                c.execute("insert into finding_candidate_queue(id,input_kind,source_kind,source_key,source_uri,distillation_version,payload,metadata,priority,protocol_version) values(?1,'source_target',?2,?3,?4,?5,?6,?7,100,3) on conflict(input_kind,source_kind,source_key,distillation_version) do nothing",params![id,kind,key,uri,version,json!({"agentPreview":preview}).to_string(),metadata.to_string()]).map_err(|e| e.to_string())?;
                let id=c.query_row("select id from finding_candidate_queue where input_kind='source_target' and source_kind=?1 and source_key=?2 and distillation_version=?3",params![kind,key,version],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?;
                Ok(json!({"ok":true,"queue":"findingCandidate","jobId":id,"target":target}))
            }
            "covering" => {
                let candidate = field(&body, "candidateId")?;
                let preview = body["preview"] == true;
                let exists = c
                    .query_row(
                        "select exists(select 1 from found_candidates where id=?1)",
                        [candidate],
                        |r| r.get::<_, bool>(0),
                    )
                    .map_err(|e| e.to_string())?;
                if !exists {
                    // Import persisted legacy inputs only; a preview reads them without
                    // publishing a Finding candidate or changing the legacy result.
                    let legacy = c.query_row("select r.title,r.content,r.origin,t.target_kind,t.target_key,t.source_uri,t.metadata from find_candidate_results r join distillation_target_states t on t.id=r.target_state_id where r.id=?1",[candidate],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?))).optional().map_err(|e|e.to_string())?.ok_or("native_candidate_required")?;
                    if !preview {
                        let parent = format!("legacy-{}", hash(candidate));
                        let tx = c.transaction().map_err(|e| e.to_string())?;
                        tx.execute("insert into finding_candidate_queue(id,input_kind,source_kind,source_key,source_uri,distillation_version,status,protocol_version,metadata) values(?1,'provided_candidate',?2,?3,?4,'legacy-agent-bridge','completed',3,?5) on conflict(id) do nothing",params![parent,legacy.3,legacy.4,legacy.5,legacy.6]).map_err(|e|e.to_string())?;
                        let origin: Value = serde_json::from_str(&legacy.2)
                            .map_err(|_| "legacy_candidate_origin_invalid")?;
                        let kind = origin["type"]
                            .as_str()
                            .filter(|s| matches!(*s, "rule" | "procedure"))
                            .unwrap_or("rule");
                        tx.execute("insert into found_candidates(id,finding_job_id,candidate_index,type,title,content,origin,metadata) values(?1,?2,0,?3,?4,?5,?6,?7) on conflict(id) do nothing",params![candidate,parent,kind,legacy.0,legacy.1,legacy.2,legacy.6]).map_err(|e|e.to_string())?;
                        tx.commit().map_err(|e| e.to_string())?;
                    }
                }
                // Reuse Finding's normal downstream job; preview gets a separate ledger.
                let existing = if !preview {
                    c.query_row("select id from covering_evidence_queue where found_candidate_id=?1 and coalesce(json_extract(payload,'$.agentPreview'),0)=0 order by created_at desc,id limit 1",[candidate],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?
                } else {
                    None
                };
                let id = existing.unwrap_or_else(|| {
                    format!("aci-{}", hash(&json!([candidate, preview]).to_string()))
                });
                c.execute("insert into covering_evidence_queue(id,found_candidate_id,distillation_version,priority,protocol_version,provider_policy,payload) select ?1,?2,'agent-v1',100,3,'default',?3 where not exists(select 1 from covering_evidence_queue where id=?1)",params![id,candidate,json!({"agentPreview":preview}).to_string()]).map_err(|e|e.to_string())?;
                if body["reprocess"] == true {
                    reprocess(c, "coveringEvidence", &id)?;
                }
                Ok(json!({"ok":true,"queue":"coveringEvidence","jobId":id}))
            }
            "reprocess" => {
                let queue = field(&body, "queue")?;
                let id = field(&body, "jobId")?;
                reprocess(c, queue, id)?;
                Ok(json!({"ok":true,"queue":queue,"jobId":id}))
            }
            "status" => {
                let queue = field(&body, "queue")?;
                let id = field(&body, "jobId")?;
                let table = table(queue)?;
                let row = c
                    .query_row(
                        &format!(
                            "select status,last_error,input_generation from {table} where id=?1"
                        ),
                        [id],
                        |r| {
                            Ok((
                                r.get::<_, String>(0)?,
                                r.get::<_, Option<String>>(1)?,
                                r.get::<_, i64>(2)?,
                            ))
                        },
                    )
                    .map_err(|_| "agent_job_not_found")?;
                let run=c.query_row("select state_json,stop_reason from agent_runs where queue_name=?1 and job_id=?2 and input_generation=?3 and protocol_version=3",params![queue,id,row.2],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?))).optional().map_err(|e|e.to_string())?;
                let (state, reason) = run
                    .map(|(s, r)| (serde_json::from_str::<Value>(&s).unwrap_or(Value::Null), r))
                    .unwrap_or((Value::Null, None));
                let mut ids = Vec::new();
                if queue == "findingCandidate" {
                    let mut stmt=c.prepare("select id from found_candidates where finding_job_id=?1 and json_extract(origin,'$.agentRuntime.generation')=?2 order by candidate_index").map_err(|e|e.to_string())?;
                    ids = stmt
                        .query_map(params![id, row.2], |r| r.get::<_, String>(0))
                        .map_err(|e| e.to_string())?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|e| e.to_string())?;
                }
                Ok(
                    json!({"ok":true,"status":row.0,"error":row.1,"generation":row.2,"reason":reason,"candidates":confirmed_candidates(&state)?,"assessment":state.pointer("/state/assessment"),"result":state.pointer("/state/finalResult"),"budget":state.pointer("/state/budget"),"candidateIds":ids,"readRanges":state.pointer("/state/readRanges")}),
                )
            }
            _ => Err("agent_operation_unsupported".into()),
        }
    })
}
fn field<'a>(v: &'a Value, k: &str) -> Result<&'a str, String> {
    v[k].as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= 4096)
        .ok_or_else(|| format!("agent_field_invalid:{k}"))
}
fn table(queue: &str) -> Result<&'static str, String> {
    match queue {
        "findingCandidate" => Ok("finding_candidate_queue"),
        "coveringEvidence" => Ok("covering_evidence_queue"),
        _ => Err("agent_queue_unsupported".into()),
    }
}
fn reprocess(c: &rusqlite::Connection, queue: &str, id: &str) -> Result<(), String> {
    let table = table(queue)?;
    // Unknown requests retain their reservation; an explicit generation cannot erase it.
    let unknown=c.query_row("select exists(select 1 from agent_runs r join agent_steps s on s.run_id=r.id where r.queue_name=?1 and r.job_id=?2 and s.status in ('inflight','result_unknown'))",params![queue,id],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())?;
    if unknown {
        return Err("agent_unknown_request_requires_reconciliation".into());
    }
    let child=c.query_row("select exists(select 1 from agent_delegations d join agent_runs r on r.id=d.run_id where r.queue_name=?1 and r.job_id=?2 and (d.status!='completed' or exists(select 1 from agent_research_requests x where x.delegation_id=d.id and x.status!='succeeded')))",params![queue,id],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())?;
    if child {
        return Err("agent_research_requires_confirmed_cancellation".into());
    }
    let changed=c.execute(&format!("update {table} set input_generation=input_generation+1,protocol_version=3,status='pending',attempt_count=0,completed_at=null,last_error=null,last_outcome_kind=null,next_run_at=null,locked_by=null,locked_at=null,heartbeat_at=null,updated_at=CURRENT_TIMESTAMP where id=?1 and status in ('completed','skipped','failed','paused')"),[id]).map_err(|e|e.to_string())?;
    if changed != 1 {
        return Err("agent_reprocess_requires_terminal_or_paused_job".into());
    }
    Ok(())
}

fn confirmed_candidates(saved: &Value) -> Result<Vec<Value>, String> {
    if saved.is_null() {
        return Ok(vec![]);
    }
    let state: super::policy::State =
        serde_json::from_value(saved["state"].clone()).map_err(|_| "agent_state_corrupt")?;
    let provided = saved.pointer("/input/provided") == Some(&json!(true));
    let mut seen = std::collections::BTreeSet::new();
    Ok(state
        .candidates
        .iter()
        .filter(|d| {
            let key = hash(&d.candidate.to_string());
            d.unresolved_questions.is_empty()
                && !state
                    .questions
                    .iter()
                    .any(|q| !q.resolved && (q.candidate_key == key || q.candidate_key == "source"))
                && (provided
                    || d.evidence.iter().any(|q| {
                        q.role == "supports"
                            && state
                                .sources
                                .iter()
                                .any(|s| s.kind == "primary" && s.hash == q.snapshot_hash)
                    }))
                && seen.insert(key)
        })
        .map(|d| json!(d))
        .collect())
}
