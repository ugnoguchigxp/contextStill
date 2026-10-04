//! Dedicated DeepStill principal; model and physical request permits remain host owned.
use super::{
    config::Config,
    measurement,
    source::hash,
    transport::{self, CompletionRequest},
};
use crate::domains::{
    queue_lifecycle::{
        dynamic_provider::research_provider_permit, provider_execution::open_query_only_connection,
    },
    secret_store, sqlite_writer,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;

pub(crate) fn load_config(path: &Path) -> Result<Config, String> {
    let c = open_query_only_connection(path).map_err(|e| e.to_string())?;
    let raw = c
        .query_row(
            "select value from settings where namespace='runtime' and key='settings.v1'",
            [],
            |r| r.get::<_, String>(0),
        )
        .map_err(|_| "settings_missing")?;
    let v: Value = serde_json::from_str(&raw).map_err(|_| "settings_invalid")?;
    Config::from_settings(v.get("settings").unwrap_or(&v))
}
pub(crate) fn credential(path: &Path, key: &str) -> Result<zeroize::Zeroizing<String>, String> {
    let c = open_query_only_connection(path).map_err(|e| e.to_string())?;
    let value = secret_store::row_token(&c, key).ok_or("research_credential_missing")?;
    secret_store::resolve(&value)
}
pub(crate) fn handle(path: &Path, token: &str, body: Value) -> Result<Value, String> {
    let config = load_config(path)?;
    let research = config
        .research
        .as_ref()
        .ok_or("research_capability_missing")?;
    research.validate()?;
    let expected = credential(path, &research.gateway_credential_key)?;
    if !equal(expected.as_bytes(), token.as_bytes()) {
        return Err("research_gateway_unauthorized".into());
    }
    if body["model"] != "deepstill-agent" || body["stream"] != false || body["tools"].is_array() {
        return Err("research_gateway_request_invalid".into());
    }
    let messages = body["messages"]
        .as_array()
        .filter(|m| !m.is_empty() && m.len() <= 16)
        .ok_or("research_gateway_messages_invalid")?;
    for m in messages {
        if !matches!(m["role"].as_str(), Some("system" | "user" | "assistant"))
            || !m["content"].is_string()
        {
            return Err("research_gateway_messages_invalid".into());
        }
    }
    let output = body["max_tokens"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 12000)
        .ok_or("research_gateway_output_invalid")?;
    let delegation = body["delegationId"]
        .as_str()
        .filter(|s| s.len() <= 100)
        .ok_or("research_owner_required")?
        .to_owned();
    let operation = body["operationKey"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 100)
        .ok_or("research_operation_required")?
        .to_owned();
    let request_hash = hash(&body.to_string());
    let c = open_query_only_connection(path).map_err(|e| e.to_string())?;
    if let Some((prior_hash,status,result))=c.query_row("select request_hash,status,result_json from agent_research_requests where delegation_id=?1 and operation_key=?2",params![delegation,operation],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?))).optional().map_err(|e|e.to_string())? {
        if prior_hash!=request_hash{return Err("research_idempotency_conflict".into());}
        if status=="succeeded" {return serde_json::from_str(result.as_deref().ok_or("research_receipt_missing")?).map_err(|_|"research_receipt_invalid".into());}
        return Err("research_request_result_unknown".into());
    }
    let (queue,deadline)=c.query_row("select r.queue_name,min(r.deadline_at,json_extract(d.request_json,'$.deadline')) from agent_delegations d join agent_runs r on r.id=d.run_id where d.id=?1 and d.status in ('submitting','running') and r.status in ('waiting','running')",[&delegation],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?))).map_err(|_|"research_owner_invalid")?;
    let now = c
        .query_row("select unixepoch()", [], |r| r.get::<_, i64>(0))
        .map_err(|e| e.to_string())?;
    if deadline <= now {
        return Err("research_deadline_exceeded".into());
    }
    let permit = research_provider_permit(path, &queue)?.ok_or("research_slot_busy")?;
    let capability =
        measurement::RequestCapability::from_provider(&permit.metadata, &permit.target)?;
    let messages = Value::Array(
        messages
            .iter()
            .map(|m| {
                let mut message = m.clone();
                if message["role"] != "system" {
                    message["content"] = json!(
                        crate::domains::queue_lifecycle::finding_executor::filter_source_text(
                            m["content"].as_str().unwrap_or_default()
                        )
                    );
                }
                message
            })
            .collect(),
    );
    let request = CompletionRequest {
        target: &permit.target,
        api_key: Some(&permit.api_key),
        messages: &messages,
        max_output: output,
        response_format: None,
        timeout_seconds: (deadline - now).min(120) as u64,
    };
    let measured = measurement::measure(&capability, &transport::request_body(&request))?;
    let reserved = measured
        .input_tokens
        .checked_add(output)
        .ok_or("usage_overflow")?;
    let lease = format!(
        "research-{}",
        hash(&json!([delegation, operation]).to_string())
    );
    let lease_for_begin = lease.clone();
    let delegation_for_begin = delegation.clone();
    let operation_for_begin = operation.clone();
    let pool = permit.pool_id.clone();
    let capacity = permit.capacity;
    let target = permit.target.target_id.clone();
    let metadata = permit.metadata.to_string();
    let expires = measured.expires_at_ms;
    let measured_input = measured.input_tokens;
    let measurement_json = json!(measured).to_string();
    let final_request = transport::request_body(&request).to_string();
    sqlite_writer::execute_for_path(path, "agent.research_request_begin", move |c| {
        let tx = c.transaction().map_err(|e| e.to_string())?;
        if expires <= measurement::now_ms() {
            return Err("measurement_receipt_expired".into());
        }
        let parent_table = match queue.as_str() {
            "findingCandidate" => "finding_candidate_queue",
            "coveringEvidence" => "covering_evidence_queue",
            _ => return Err("research_owner_invalid".into()),
        };
        let valid=tx.query_row(&format!("select exists(select 1 from agent_delegations d join agent_runs r on r.id=d.run_id join {parent_table} q on q.id=r.job_id where d.id=?1 and d.status in ('submitting','running') and r.status in ('running','waiting') and r.input_generation=q.input_generation and r.protocol_version=q.protocol_version and q.protocol_version=3 and q.status in ('pending','running') and r.deadline_at>unixepoch() and json_extract(d.request_json,'$.deadline')>unixepoch())"),[&delegation_for_begin],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())?;
        if !valid {
            return Err("research_owner_invalid".into());
        }
        let (ceiling,input_cap,output_cap,target_budget)=tx.query_row("select reserved_tokens,json_extract(request_json,'$.inputTokens'),json_extract(request_json,'$.outputTokens'),json_extract(request_json,'$.targetTokens') from agent_delegations where id=?1 and status in ('submitting','running')",[&delegation_for_begin],|r|Ok((r.get::<_,u64>(0)?,r.get::<_,u64>(1)?,r.get::<_,u64>(2)?,r.get::<_,u64>(3)?))).map_err(|_|"research_owner_invalid")?;
        let (calls,total,inputs,outputs,active)=tx.query_row("select count(*),coalesce(sum(coalesce(usage_tokens,reserved_tokens)),0),coalesce(sum(measured_input),0),coalesce(sum(output_limit),0),sum(case when status in ('inflight','result_unknown') then 1 else 0 end) from agent_research_requests where delegation_id=?1",[&delegation_for_begin],|r|Ok((r.get::<_,u64>(0)?,r.get::<_,u64>(1)?,r.get::<_,u64>(2)?,r.get::<_,u64>(3)?,r.get::<_,Option<u64>>(4)?.unwrap_or(0)))).map_err(|e|e.to_string())?;
        if calls >= 12
            || total >= target_budget
            || active > 0
            || total.saturating_add(reserved) > ceiling
            || inputs.saturating_add(measured_input) > input_cap
            || outputs.saturating_add(output) > output_cap
        {
            return Err("research_budget_exhausted".into());
        }
        let count = tx
            .query_row(
                "select count(*) from llm_provider_leases where pool_id=?1 and status='active'",
                [&pool],
                |r| r.get::<_, u64>(0),
            )
            .map_err(|e| e.to_string())?;
        if count >= capacity {
            return Err("research_slot_busy".into());
        }
        tx.execute("insert into llm_provider_leases(id,pool_id,target_id,queue_name,queue_job_id,worker_id,metadata,expires_at) values(?1,?2,?3,'agentResearch',?4,?1,?5,datetime(CURRENT_TIMESTAMP,'+180 seconds'))",params![lease_for_begin,pool,target,delegation_for_begin,metadata]).map_err(|e|e.to_string())?;
        tx.execute("insert into agent_research_requests(delegation_id,operation_key,request_hash,status,reserved_tokens,measured_input,output_limit,lease_id,measurement_json,request_json) values(?1,?2,?3,'inflight',?4,?5,?6,?7,?8,?9)",params![delegation_for_begin,operation_for_begin,request_hash,reserved,measured_input,output,lease_for_begin,measurement_json,final_request]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })?;
    let completion = transport::send(request);
    let response=completion.as_ref().ok().map(|r| json!({"choices":[{"message":{"role":"assistant","content":r.content},"finish_reason":r.finish_reason}],"usage":r.usage.as_ref().map(|u|json!({"prompt_tokens":u.input,"completion_tokens":u.output,"total_tokens":u.input.saturating_add(u.output)}))}));
    let valid = completion.as_ref().is_ok_and(|r| {
        r.terminal_error.is_none()
            && r.finish_reason.as_deref() == Some("stop")
            && r.usage
                .as_ref()
                .is_some_and(|u| u.input <= measured_input && u.output <= output)
    });
    let usage = completion
        .as_ref()
        .ok()
        .and_then(|r| r.usage.as_ref())
        .map(|u| u.input.saturating_add(u.output));
    let saved = response.clone().map(|r| r.to_string());
    let response_received = completion.is_ok();
    sqlite_writer::execute_for_path(path, "agent.research_request_finish", move |c| {
        let tx = c.transaction().map_err(|e| e.to_string())?;
        tx.execute("update agent_research_requests set status=?3,usage_tokens=?4,result_json=?5,updated_at=CURRENT_TIMESTAMP where delegation_id=?1 and operation_key=?2 and status='inflight'",params![delegation,operation,if valid{"succeeded"}else{"result_unknown"},usage,saved]).map_err(|e|e.to_string())?;
        if response_received {
            tx.execute("update llm_provider_leases set status='released',release_reason=?2,released_at=CURRENT_TIMESTAMP where id=?1",params![lease,if valid {"research_request_finished"} else {"research_response_rejected"}]).map_err(|e|e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })?;
    if !valid {
        return Err("research_request_result_unknown".into());
    }
    response.ok_or("research_request_result_unknown".into())
}
fn equal(a: &[u8], b: &[u8]) -> bool {
    let mut different = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        different |= (a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0)) as usize;
    }
    different == 0
}
