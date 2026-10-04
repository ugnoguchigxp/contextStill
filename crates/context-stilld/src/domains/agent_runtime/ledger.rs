use super::{measurement::Measurement, policy::State, source::hash, transport::Completion};
use crate::domains::{
    queue_lifecycle::{common::queue_table_name, types::ProviderLeaseAssignment},
    sqlite_writer,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub(crate) const PROTOCOL: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Input {
    pub generation: i64,
    #[serde(default)]
    pub preview: bool,
    pub identity: Value,
    pub source_key: String,
    pub source_kind: String,
    pub source_uri: String,
    pub source_metadata: Value,
    pub distillation_version: String,
    pub priority: i64,
    pub bundle: Option<Value>,
    pub deferred_source: bool,
    pub provided: bool,
    #[serde(default)]
    pub provided_attributes: Value,
    pub initial_state: State,
}

pub(crate) struct Run {
    pub path: PathBuf,
    pub assignment: ProviderLeaseAssignment,
    pub id: String,
    pub lineage: String,
    pub input: Input,
    pub state: State,
    pub deadline: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct Step {
    pub no: i64,
    pub reserved: u64,
    pub measured: u64,
    pub output: u64,
}

pub(crate) fn owns_run(
    connection: &Connection,
    assignment: &ProviderLeaseAssignment,
) -> Result<bool, String> {
    let table = queue_table_name(&assignment.queue_name).map_err(|e| e.to_string())?;
    connection.query_row(&format!("select exists(select 1 from agent_runs r join {table} q on q.id=r.job_id
        where r.queue_name=?1 and r.job_id=?2 and r.claim_epoch=?3 and r.status in ('running','ready')
        and q.status='running' and q.locked_by=?4
        and q.input_generation=r.input_generation and q.protocol_version=r.protocol_version)"),
        params![assignment.queue_name,assignment.queue_job_id,assignment.id,assignment.worker_id],|r|r.get::<_,bool>(0))
        .map_err(|e|e.to_string())
}

pub(crate) fn require_owner(
    connection: &Connection,
    assignment: &ProviderLeaseAssignment,
) -> Result<(), String> {
    if !owns_run(connection, assignment)? {
        return Err("agent_run_fence_changed".into());
    }
    Ok(())
}

pub(crate) fn prepare(
    path: &Path,
    assignment: ProviderLeaseAssignment,
    input: Input,
) -> Result<Run, String> {
    let a = assignment.clone();
    let mut input = input;
    // Only trusted project identity is duplicated into the execution ledger. Raw adapter metadata
    // can contain credentials and is neither needed for inference nor an authority source here.
    input.source_metadata = json!({"projectIdentity":input.identity});
    let captured = input.clone();
    let run_id = format!(
        "ar-{}",
        hash(&format!(
            "{}:{}:{}:{PROTOCOL}",
            a.queue_name, a.queue_job_id, captured.generation
        ))
    );
    let id = run_id.clone();
    let (input, state, lineage, deadline) = sqlite_writer::execute_for_path(
        path,
        "agent.prepare",
        move |connection| {
            let tx = connection.transaction().map_err(|e| e.to_string())?;
            let table = queue_table_name(&a.queue_name).map_err(|e| e.to_string())?;
            let owns=tx.query_row(&format!("select exists(select 1 from {table} q join llm_provider_leases l on l.id=?3
            where q.id=?1 and q.status='running' and q.locked_by=?2 and l.status='active'
            and l.queue_job_id=q.id and l.queue_name=?4 and l.worker_id=q.locked_by
            and q.input_generation=?5 and q.protocol_version<=3)"),
            params![a.queue_job_id,a.worker_id,a.id,a.queue_name,captured.generation],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())?;
            if !owns {
                return Err("agent_run_fence_changed".into());
            }
            let existing=tx.query_row("select state_json, identity_json, root_lineage, deadline_at, status from agent_runs where id=?1",
            [&id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?,r.get::<_,String>(4)?)))
            .optional().map_err(|e|e.to_string())?;
            let (input, state, lineage, deadline) = if let Some((
                saved,
                identity,
                lineage,
                deadline,
                status,
            )) = existing
            {
                if matches!(status.as_str(), "completed" | "failed") {
                    return Err("agent_run_already_terminal".into());
                }
                let saved: Value =
                    serde_json::from_str(&saved).map_err(|_| "agent_state_corrupt")?;
                let input: Input = serde_json::from_value(saved["input"].clone())
                    .map_err(|_| "agent_input_corrupt")?;
                let state: State = serde_json::from_value(saved["state"].clone())
                    .map_err(|_| "agent_state_corrupt")?;
                if serde_json::from_str::<Value>(&identity).map_err(|_| "agent_identity_corrupt")?
                    != input.identity
                {
                    return Err("agent_identity_corrupt".into());
                }
                (input, state, lineage, deadline)
            } else {
                let state = captured.initial_state.clone();
                let lineage = captured
                    .bundle
                    .as_ref()
                    .and_then(|b| b.get("rootLineage"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| id.clone());
                let deadline = tx
                    .query_row(
                        "select cast(strftime('%s','now') as integer)+600",
                        [],
                        |r| r.get::<_, i64>(0),
                    )
                    .map_err(|e| e.to_string())?;
                tx.execute(
                    "insert or ignore into agent_lineages(id) values(?1)",
                    [&lineage],
                )
                .map_err(|e| e.to_string())?;
                tx.execute("insert into agent_runs(id,queue_name,job_id,input_generation,input_hash,policy_version,root_lineage,claim_epoch,identity_json,status,state_json,deadline_at)
                values(?1,?2,?3,?4,?5,'finding-covering-agent-v1',?6,?7,?8,'running',?9,?10)",
                params![id,a.queue_name,a.queue_job_id,captured.generation,hash(&serde_json::to_string(&captured).map_err(|e|e.to_string())?),lineage,a.id,captured.identity.to_string(),json!({"input":captured,"state":state}).to_string(),deadline]).map_err(|e|e.to_string())?;
                for snapshot in &state.sources {
                    let identity_hash = hash(&captured.identity.to_string());
                    let snapshot_id = hash(
                        &json!([snapshot.hash, identity_hash, snapshot.uri, snapshot.kind])
                            .to_string(),
                    );
                    tx.execute("insert or ignore into agent_snapshots(id,source_hash,identity_hash,uri,kind,content) values(?1,?2,?3,?4,?5,?6)",
                    params![snapshot_id,snapshot.hash,identity_hash,snapshot.uri,snapshot.kind,snapshot.text]).map_err(|e|e.to_string())?;
                }
                (captured, state, lineage, deadline)
            };
            tx.execute("update agent_runs set claim_epoch=?2,status='running',updated_at=CURRENT_TIMESTAMP where id=?1",params![id,a.id]).map_err(|e|e.to_string())?;
            tx.execute(
                &format!("update {table} set protocol_version=3 where id=?1 and locked_by=?2"),
                params![a.queue_job_id, a.worker_id],
            )
            .map_err(|e| e.to_string())?;
            if a.queue_name == "coveringEvidence" {
                let input_id = format!(
                    "rust-covering-input-{:x}",
                    sha2::Sha256::digest(
                        format!("covering-input:{}-{}", a.queue_job_id, input.generation)
                            .as_bytes()
                    )
                );
                tx.execute("insert into covering_evidence_inputs(id,covering_job_id,input_generation,input_hash,identity_json,evidence_bundle_json,prompt_version,model_config_hash)
                values(?1,?2,?3,?4,?5,?6,'covering-agent-v1',?7) on conflict(covering_job_id,input_generation) do nothing",
                params![input_id,a.queue_job_id,input.generation,hash(&json!({"candidate":state.original_candidate,"source":state.sources,"identity":input.identity}).to_string()),
                    input.identity.to_string(),json!({"runId":id,"rootLineage":lineage,"bundle":input.bundle,"sourceContentHash":if input.deferred_source {None}else{state.sources.first().map(|s|&s.hash)},"sourceState":if input.deferred_source {"pending_acquisition"}else{"captured"},"snapshotBinding":"agent_run_receipts","locatorUnit":"utf8_bytes"}).to_string(),hash(&a.target_id)]).map_err(|e|e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())?;
            Ok((input, state, lineage, deadline))
        },
    )?;
    Ok(Run {
        path: path.to_path_buf(),
        assignment,
        id: run_id,
        lineage,
        input,
        state,
        deadline,
    })
}

use sha2::Digest;

impl Run {
    pub fn checkpoint(&self, status: &str, reason: Option<&str>) -> Result<(), String> {
        let a = self.assignment.clone();
        let id = self.id.clone();
        let data = json!({"input":self.input,"state":self.state}).to_string();
        let status = status.to_owned();
        let reason = reason.map(str::to_owned);
        sqlite_writer::execute_for_path(&self.path, "agent.checkpoint", move |connection| {
            require_owner(connection, &a)?;
            connection.execute("update agent_runs set state_json=?3,status=?4,stop_reason=?5,updated_at=CURRENT_TIMESTAMP where id=?1 and claim_epoch=?2",
                params![id,a.id,data,status,reason]).map_err(|e|e.to_string())?;
            Ok(())
        })
    }
    pub fn begin_llm(&mut self, measurement: &Measurement, output: u64) -> Result<Step, String> {
        let window = measurement.window.admit(measurement.input_tokens, output)?;
        let reserved = measurement
            .input_tokens
            .checked_add(output)
            .ok_or("usage_overflow")?;
        let mut next_budget = self.state.budget.clone();
        next_budget.reserve(reserved, self.state.finalizing)?;
        let prior_budget = std::mem::replace(&mut self.state.budget, next_budget);
        let a = self.assignment.clone();
        let id = self.id.clone();
        let data = json!({"input":self.input,"state":self.state}).to_string();
        let m = measurement.clone();
        let persisted = sqlite_writer::execute_for_path(
            &self.path,
            "agent.llm_begin",
            move |connection| {
                let tx = connection.transaction().map_err(|e| e.to_string())?;
                require_owner(&tx, &a)?;
                if m.expires_at_ms <= super::measurement::now_ms() {
                    return Err("measurement_receipt_expired".into());
                }
                let active=tx.query_row("select exists(select 1 from llm_provider_leases where id=?1 and status='active')",[&a.id],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())?;
                if !active {
                    return Err("request_lease_missing".into());
                }
                let no = tx
                    .query_row(
                        "select coalesce(max(step_no),0)+1 from agent_steps where run_id=?1",
                        [&id],
                        |r| r.get::<_, i64>(0),
                    )
                    .map_err(|e| e.to_string())?;
                tx.execute("insert into agent_steps(run_id,step_no,operation_key,status,request_hash,measured_input,window_tokens,output_reserve,reserved_tokens,result_json)
                values(?1,?2,?3,'inflight',?4,?5,?6,?7,?8,?9)",params![id,no,format!("llm:{no}"),m.request_hash,m.input_tokens,window,output,reserved,
                    json!({"measurementBinding":m.binding,"tokenizerDigest":m.tokenizer_digest,"templateDigest":m.template_digest,"leaseEpoch":m.lease_epoch,"softOverrun":window>super::budget::SOFT_WINDOW}).to_string()]).map_err(|e|e.to_string())?;
                tx.execute("update agent_runs set state_json=?3,updated_at=CURRENT_TIMESTAMP where id=?1 and claim_epoch=?2",params![id,a.id,data]).map_err(|e|e.to_string())?;
                tx.commit().map_err(|e| e.to_string())?;
                Ok(no)
            },
        );
        let no = match persisted {
            Ok(no) => no,
            Err(error) => {
                self.state.budget = prior_budget;
                return Err(error);
            }
        };
        Ok(Step {
            no,
            reserved,
            measured: measurement.input_tokens,
            output,
        })
    }
    pub fn finish_llm(&mut self, step: Step, result: &Completion) -> Result<(), String> {
        // Even a provider contract violation must leave a durable response/usage receipt.
        // Overflow retains the conservative reservation and pauses further requests.
        let prior_budget = self.state.budget.clone();
        let budget_error = self
            .state
            .budget
            .settle(step.reserved, result.usage.as_ref())
            .err();
        let violates = result
            .usage
            .as_ref()
            .is_some_and(|u| u.input > step.measured || u.output > step.output);
        let a = self.assignment.clone();
        let id = self.id.clone();
        let no = step.no;
        let data = json!({"input":self.input,"state":self.state}).to_string();
        let usage = result
            .usage
            .as_ref()
            .map(|u| serde_json::to_string(u).unwrap_or_default());
        let request_id = result.request_id.clone();
        let finish_reason = result.finish_reason.clone();
        let response = json!({"content":result.content,"terminalError":result.terminal_error,"providerContractViolation":violates,"budgetError":budget_error}).to_string();
        let persisted = sqlite_writer::execute_for_path(
            &self.path,
            "agent.llm_finish",
            move |connection| {
                let tx = connection.transaction().map_err(|e| e.to_string())?;
                require_owner(&tx, &a)?;
                let changed=tx.execute("update agent_steps set status='succeeded',request_id=?3,usage_json=?4,finish_reason=?5,result_json=json_patch(coalesce(result_json,'{}'),?6),updated_at=CURRENT_TIMESTAMP where run_id=?1 and step_no=?2 and status='inflight'",
                params![id,no,request_id,usage,finish_reason,response]).map_err(|e|e.to_string())?;
                if changed != 1 {
                    return Err("agent_step_fence_changed".into());
                }
                tx.execute("update agent_runs set state_json=?3,updated_at=CURRENT_TIMESTAMP where id=?1 and claim_epoch=?2",params![id,a.id,data]).map_err(|e|e.to_string())?;
                release_request(&tx, &a, "request_finished")?;
                tx.commit().map_err(|e| e.to_string())?;
                Ok(())
            },
        );
        if let Err(error) = persisted {
            self.state.budget = prior_budget;
            return Err(error);
        }
        if let Some(error) = budget_error {
            return Err(error);
        }
        if violates {
            return Err("provider_context_contract_violation".into());
        }
        if let Some(error) = &result.terminal_error {
            return Err(error.clone());
        }
        Ok(())
    }
    pub fn yield_queue(
        &self,
        reason: &str,
        resume_after: Option<u64>,
        failed: bool,
    ) -> Result<(), String> {
        let a = self.assignment.clone();
        let id = self.id.clone();
        let data = json!({"input":self.input,"state":self.state}).to_string();
        let reason = reason.to_owned();
        sqlite_writer::execute_for_path(&self.path, "agent.yield", move |connection| {
            let tx = connection.transaction().map_err(|e| e.to_string())?;
            require_owner(&tx, &a)?;
            let table = queue_table_name(&a.queue_name).map_err(|e| e.to_string())?;
            let status = if failed {
                "failed"
            } else if resume_after.is_some() {
                "pending"
            } else {
                "paused"
            };
            tx.execute(&format!("update {table} set status=?3,locked_by=null,locked_at=null,heartbeat_at=null,
                next_run_at=case when ?4 is null then null else datetime(CURRENT_TIMESTAMP,'+'||?4||' seconds') end,
                last_outcome_kind=?5,last_error=?5,updated_at=CURRENT_TIMESTAMP where id=?1 and locked_by=?2 and status='running'"),
                params![a.queue_job_id,a.worker_id,status,resume_after,reason]).map_err(|e|e.to_string())?;
            tx.execute("update agent_runs set status=?3,stop_reason=?4,state_json=?5,updated_at=CURRENT_TIMESTAMP where id=?1 and claim_epoch=?2",
                params![id,a.id,if failed {"failed"} else if resume_after.is_some() {"waiting"} else {"paused"},reason,data]).map_err(|e|e.to_string())?;
            release_request(&tx, &a, &reason)?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(())
        })
    }
    pub fn release_for_io(&self) -> Result<(), String> {
        let a = self.assignment.clone();
        sqlite_writer::execute_for_path(&self.path, "agent.release_for_io", move |connection| {
            require_owner(connection, &a)?;
            release_request(connection, &a, "external_io")
        })
    }
}

pub(crate) fn release_request(
    connection: &Connection,
    a: &ProviderLeaseAssignment,
    reason: &str,
) -> Result<(), String> {
    connection.execute("update llm_provider_leases set status='released',released_at=CURRENT_TIMESTAMP,release_reason=?2,updated_at=CURRENT_TIMESTAMP
        where id=?1 and status='active' and worker_id=?3",params![a.id,reason,a.worker_id]).map_err(|e|e.to_string())?;
    Ok(())
}

pub(crate) fn pause_unprepared(
    path: &Path,
    a: &ProviderLeaseAssignment,
    reason: &str,
) -> Result<(), String> {
    let a = a.clone();
    let reason = reason.to_owned();
    sqlite_writer::execute_for_path(path, "agent.input_pause", move |connection| {
        let tx = connection.transaction().map_err(|e| e.to_string())?;
        let table = queue_table_name(&a.queue_name).map_err(|e| e.to_string())?;
        let changed=tx.execute(&format!("update {table} set status='paused',locked_by=null,locked_at=null,heartbeat_at=null,next_run_at=null,
            last_outcome_kind=?3,last_error=?3,updated_at=CURRENT_TIMESTAMP where id=?1 and status='running' and locked_by=?2
            and exists(select 1 from llm_provider_leases where id=?4 and status='active' and queue_name=?5 and queue_job_id=?1 and worker_id=?2)"),
            params![a.queue_job_id,a.worker_id,reason,a.id,a.queue_name]).map_err(|e|e.to_string())?;
        if changed != 1 {
            return Err("agent_run_fence_changed".into());
        }
        release_request(&tx, &a, &reason)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
}

pub(crate) fn saved_input(
    connection: &Connection,
    a: &ProviderLeaseAssignment,
) -> Result<Option<Input>, String> {
    let table = queue_table_name(&a.queue_name).map_err(|e| e.to_string())?;
    let raw=connection.query_row(&format!("select r.state_json from agent_runs r join {table} q on q.id=r.job_id
        where r.queue_name=?1 and r.job_id=?2 and r.input_generation=q.input_generation and r.protocol_version=3"),
        params![a.queue_name,a.queue_job_id],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?;
    raw.map(|raw| {
        serde_json::from_str::<Value>(&raw)
            .map_err(|_| "agent_state_corrupt".to_owned())
            .and_then(|value| {
                serde_json::from_value(value["input"].clone())
                    .map_err(|_| "agent_input_corrupt".into())
            })
    })
    .transpose()
}
