use super::{
    ledger::{release_request, require_owner, Run},
    source::hash,
};
use crate::domains::{queue_lifecycle::events::append_queue_event_for_connection, sqlite_writer};
use rusqlite::params;
use serde_json::{json, Value};

pub(crate) fn finish_finding(run: &Run, reason: &str) -> Result<bool, String> {
    let input = run.input.clone();
    let state = run.state.clone();
    let a = run.assignment.clone();
    let id = run.id.clone();
    let lineage = run.lineage.clone();
    let reason = reason.to_owned();
    sqlite_writer::execute_for_path(&run.path, "agent.finding_project", move |connection| {
        let tx = connection.transaction().map_err(|e| e.to_string())?;
        require_owner(&tx, &a)?;
        let identity_hash = hash(&input.identity.to_string());
        let snapshot_ids = state
            .sources
            .iter()
            .map(|s| hash(&json!([s.hash, identity_hash, s.uri, s.kind]).to_string()))
            .collect::<Vec<_>>();
        let mut seen = std::collections::BTreeSet::new();
        let mut count = 0;
        let first_index: i64 = tx.query_row("select coalesce(max(candidate_index),-1)+1 from found_candidates where finding_job_id=?1",[&a.queue_job_id],|r|r.get(0)).map_err(|e|e.to_string())?;
        for draft in &state.candidates {
            if !draft.unresolved_questions.is_empty() {
                continue;
            }
            let candidate_hash = hash(&draft.candidate.to_string());
            if state.questions.iter().any(|q| {
                !q.resolved && (q.candidate_key == candidate_hash || q.candidate_key == "source")
            }) {
                continue;
            }
            if !seen.insert(candidate_hash.clone()) {
                continue;
            }
            let evidence = draft
                .evidence
                .iter()
                .map(|e| state.locate(e))
                .collect::<Result<Vec<_>, _>>()?;
            if !input.provided
                && !evidence.iter().any(|q| {
                    q.role == "supports"
                        && state
                            .sources
                            .iter()
                            .any(|s| s.hash == q.snapshot_hash && s.kind == "primary")
                })
            {
                continue;
            }
            if input.preview {
                count += 1;
                continue;
            }
            let bundle = json!({"rootLineage":lineage,"identity":input.identity,"snapshotIds":snapshot_ids,
                "candidateHash":candidate_hash,"evidence":evidence,"readRanges":state.read_ranges,"history":state.history,
                "questions":state.questions,"stopReason":reason});
            let raw = bundle.to_string();
            let bundle_hash = hash(&raw);
            let bundle_id = format!("ab-{}", hash(&format!("{id}:{candidate_hash}")));
            let candidate_id = format!("af-{}", hash(&format!("{id}:{candidate_hash}")));
            tx.execute("insert into agent_evidence_bundles(id,run_id,root_lineage,candidate_hash,bundle_hash,bundle_json) values(?1,?2,?3,?4,?5,?6)",
                params![bundle_id,id,lineage,candidate_hash,bundle_hash,raw]).map_err(|e|e.to_string())?;
            let mut origin = input
                .provided_attributes
                .as_object()
                .cloned()
                .unwrap_or_default();
            let host_origin = json!({"sourceKind":input.source_kind,"sourceKey":input.source_key,"sourceUri":super::source::display_uri(&input.source_uri),"findingJobId":a.queue_job_id,"polarity":draft.candidate["polarity"],
                "agentRuntime":{"runId":id,"bundleId":bundle_id,"bundleHash":bundle_hash,"generation":input.generation,"candidateHash":candidate_hash}});
            origin.extend(
                host_origin
                    .as_object()
                    .ok_or("agent_origin_invalid")?
                    .clone(),
            );
            let origin = Value::Object(origin);
            let metadata = json!({"executor":"rust","version":"finding-agent-v1","sourceMetadata":input.source_metadata,"projectIdentity":input.identity});
            tx.execute("insert into found_candidates(id,finding_job_id,candidate_index,type,title,content,origin,metadata) values(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![candidate_id,a.queue_job_id,first_index+count,draft.candidate["type"].as_str(),draft.candidate["title"].as_str(),draft.candidate["content"].as_str(),origin.to_string(),metadata.to_string()]).map_err(|e|e.to_string())?;
            tx.execute("insert into covering_evidence_queue(id,found_candidate_id,distillation_version,status,priority,protocol_version,provider_policy,metadata)
                values(?1,?2,?3,'pending',?4,3,'default',?5)",params![format!("ac-{}",hash(&candidate_id)),candidate_id,input.distillation_version,input.priority,metadata.to_string()]).map_err(|e|e.to_string())?;
            count += 1;
        }
        // Unresolved candidates remain in the run ledger, never escape into Finalize.
        let hold = count == 0
            && (!state.questions.is_empty()
                || !state.candidates.is_empty()
                || !state.primary_read_complete())
            && !input.provided;
        let reason = if count == 0 && !input.provided && !state.primary_read_complete() {
            "insufficient_context".to_owned()
        } else {
            reason
        };
        let status = if hold {
            "paused"
        } else if count == 0 {
            "skipped"
        } else {
            "completed"
        };
        tx.execute("update finding_candidate_queue set status=?3,locked_by=null,locked_at=null,heartbeat_at=null,next_run_at=null,
            completed_at=case when ?3='paused' then null else CURRENT_TIMESTAMP end,last_outcome_kind=?4,last_error=case when ?3='paused' then ?4 else null end,
            updated_at=CURRENT_TIMESTAMP where id=?1 and locked_by=?2 and status='running'",params![a.queue_job_id,a.worker_id,status,reason]).map_err(|e|e.to_string())?;
        tx.execute("update agent_runs set status=?3,stop_reason=?4,state_json=?5,updated_at=CURRENT_TIMESTAMP where id=?1 and claim_epoch=?2",
            params![id,a.id,if hold {"paused"}else{"completed"},reason,json!({"input":input,"state":state}).to_string()]).map_err(|e|e.to_string())?;
        release_request(&tx, &a, "agent_finished")?;
        append_queue_event_for_connection(
            &tx,
            &format!("agent-finished-{id}"),
            "findingCandidate",
            &a.queue_job_id,
            status,
            Some("Finding agent run projected"),
            Some(&json!({"runId":id,"candidateCount":count,"reason":reason}).to_string()),
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(!hold)
    })
}

pub(crate) fn evidence_references(run: &Run) -> Vec<Value> {
    run.state.evidence.iter().filter_map(|q|run.state.sources.iter().find(|s|s.hash==q.snapshot_hash).map(|s|json!({
        "kind":if s.kind=="primary"{"source"}else if s.kind=="research"{"web"}else{&s.kind},"uri":s.uri,"evidenceRole":if s.kind=="research"{"external_verification"}else if q.role=="supports"{"supports_candidate"}else{"source_summary"},"quoteRole":q.role,"note":q.text,
        "snapshotHash":s.hash,"locatorUnit":"utf8_bytes","fromByte":q.from_byte,"toByte":q.to_byte,"quote":q.text
    }))).collect()
}
