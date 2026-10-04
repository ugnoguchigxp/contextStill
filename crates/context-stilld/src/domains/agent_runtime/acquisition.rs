//! Durable acquisition receipts keep restart recovery separate from request retries.
use super::{
    ledger::{require_owner, Run},
    source::{hash, Snapshot},
};
use crate::domains::sqlite_writer;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

pub(crate) enum Acquisition {
    Start { attempt: u64 },
    Saved(Snapshot),
    Unknown,
    Exhausted,
}

pub(crate) fn begin(run: &Run, key: &str) -> Result<Acquisition, String> {
    let a = run.assignment.clone();
    let lineage = run.lineage.clone();
    let owner = run.id.clone();
    let key = key.to_owned();
    let scope = hash(&run.input.identity.to_string());
    sqlite_writer::execute_for_path(&run.path, "agent.acquisition_begin", move |connection| {
        let tx = connection.transaction().map_err(|e| e.to_string())?;
        require_owner(&tx, &a)?;
        let existing=tx.query_row("select status,scope_hash,result_json from agent_acquisitions where root_lineage=?1 and operation_key=?2",
            params![lineage,key],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?))).optional().map_err(|e|e.to_string())?;
        let attempt = if let Some((status, saved_scope, raw)) = existing {
            if saved_scope != scope {
                return Err("acquisition_scope_mismatch".into());
            }
            let value: Value = raw
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .map_err(|_| "acquisition_receipt_invalid")?
                .unwrap_or(Value::Null);
            match status.as_str() {
                "succeeded" => {
                    let snapshot: Snapshot = serde_json::from_value(value["snapshot"].clone())
                        .map_err(|_| "acquisition_receipt_invalid")?;
                    if hash(&snapshot.text) != snapshot.hash {
                        return Err("acquisition_receipt_invalid".into());
                    }
                    return Ok(Acquisition::Saved(snapshot));
                }
                "failed" if value["attempt"].as_u64() == Some(1) && value["retryable"] == true => 2,
                "failed" => return Ok(Acquisition::Exhausted),
                _ => return Ok(Acquisition::Unknown),
            }
        } else {
            1
        };
        tx.execute("insert into agent_acquisitions(root_lineage,operation_key,owner_run,status,scope_hash,result_json)
            values(?1,?2,?3,'inflight',?4,?5) on conflict(root_lineage,operation_key) do update set owner_run=excluded.owner_run,status='inflight',result_json=excluded.result_json,updated_at=CURRENT_TIMESTAMP",
            params![lineage,key,owner,scope,json!({"attempt":attempt}).to_string()]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(Acquisition::Start { attempt })
    })
}

pub(crate) fn complete(
    run: &Run,
    key: &str,
    attempt: u64,
    snapshot: Option<&Snapshot>,
    retryable: bool,
) -> Result<(), String> {
    let a = run.assignment.clone();
    let lineage = run.lineage.clone();
    let owner = run.id.clone();
    let key = key.to_owned();
    let value = json!({"attempt":attempt,"snapshot":snapshot,"retryable":retryable}).to_string();
    let succeeded = snapshot.is_some();
    sqlite_writer::execute_for_path(&run.path, "agent.acquisition_finish", move |connection| {
        let tx = connection.transaction().map_err(|e| e.to_string())?;
        require_owner(&tx, &a)?;
        let changed=tx.execute("update agent_acquisitions set status=?4,result_json=?5,updated_at=CURRENT_TIMESTAMP where root_lineage=?1 and operation_key=?2 and owner_run=?3 and status='inflight'",
            params![lineage,key,owner,if succeeded{"succeeded"}else{"failed"},value]).map_err(|e|e.to_string())?;
        if changed != 1 {
            return Err("acquisition_fence_changed".into());
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
}
