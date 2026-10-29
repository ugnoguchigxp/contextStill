//! SAAA owns raw SQLite records. This adapter only reads its versioned export view.
//! All local mutations go through the existing Writer and EpisodeDistiller queue.
use crate::shared::{config::EnvProvider, errors::CliError};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Source {
    pub source_id: String,
    pub version: u64,
    pub sequence: u64,
    pub role: String,
    pub digest: String,
    pub recorded_at: i64,
    pub uttered_at: i64,
    pub policy_revision: u64,
    pub scope: String,
    pub scope_epoch: u64,
    pub access_revision: u64,
    pub start: usize,
    pub end: usize,
    pub byte_length: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceContract {
    pub contract_version: u64,
    pub sqlite_path: String,
    pub principal: String,
    pub sources: Vec<Source>,
}
fn fail(e: impl std::fmt::Display) -> CliError {
    CliError::io(format!("SAAA_SOURCE_UNAVAILABLE: {e}"))
}
fn open(path: &str) -> Result<Connection, CliError> {
    if !Path::new(path).is_absolute() {
        return Err(fail("absolute SQLite path required"));
    }
    let c = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(fail)?;
    c.busy_timeout(std::time::Duration::from_millis(500))
        .map_err(fail)?;
    c.execute_batch("PRAGMA query_only=ON").map_err(fail)?;
    Ok(c)
}
fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn load(
    c: &Connection,
    id: &str,
    scope: &str,
) -> Result<Option<(Source, String, String)>, CliError> {
    c.query_row("SELECT source_id,version,sequence,role,content,recorded_at,uttered_at,principal,scope_key,policy_revision,scope_epoch,access_revision FROM memory_episode_source_v1 WHERE source_id=?1 AND scope_key=?2 ORDER BY version DESC LIMIT 1",params![id,scope],|r|{
        let text:String=r.get(4)?;
        Ok((Source{source_id:r.get(0)?,version:r.get(1)?,sequence:r.get(2)?,role:r.get(3)?,digest:digest(&text),recorded_at:r.get(5)?,uttered_at:r.get(6)?,scope:r.get(8)?,policy_revision:r.get(9)?,scope_epoch:r.get(10)?,access_revision:r.get(11)?,start:0,end:text.len(),byte_length:text.len()},text,r.get(7)?))
    }).optional().map_err(fail)
}
pub(crate) fn contract(metadata: &Value) -> Result<Option<SourceContract>, CliError> {
    metadata
        .get("saaa")
        .filter(|v| !v.is_null())
        .map(|value| serde_json::from_value(value.clone()).map_err(fail))
        .transpose()
}
pub(crate) fn validate(metadata: &Value) -> Result<(), CliError> {
    let Some(spec) = contract(metadata)? else {
        return Ok(());
    };
    if spec.contract_version != 1 || spec.sources.is_empty() || spec.sources.len() > 8 {
        return Err(fail("invalid contract"));
    }
    let c = open(&spec.sqlite_path)?;
    let tx = c.unchecked_transaction().map_err(fail)?;
    if !matches_source(&tx, &spec)? {
        return Err(fail("source version, permission or policy changed"));
    }
    Ok(())
}
fn matches_source(c: &Connection, spec: &SourceContract) -> Result<bool, CliError> {
    for src in &spec.sources {
        let Some((live, text, principal)) = load(c, &src.source_id, &src.scope)? else {
            return Ok(false);
        };
        if principal != spec.principal
            || live.role != src.role
            || live.recorded_at != src.recorded_at
            || live.uttered_at != src.uttered_at
            || live.version != src.version
            || live.digest != src.digest
            || live.policy_revision != src.policy_revision
            || live.sequence != src.sequence
            || live.scope_epoch != src.scope_epoch
            || live.access_revision != src.access_revision
            || live.byte_length != src.byte_length
            || src.start >= src.end
            || src.end > live.byte_length
            || !text.is_char_boundary(src.start)
            || !text.is_char_boundary(src.end)
        {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) fn verify_quotes(
    metadata: &Value,
    quotes: &[crate::domains::queue_lifecycle::episode_executor::types::EvidenceQuote],
) -> Result<(), CliError> {
    let Some(spec) = contract(metadata)? else {
        return Ok(());
    };
    if quotes.is_empty() || quotes.len() > 8 {
        return Err(fail("personal Episode needs exact user evidence"));
    }
    let c = open(&spec.sqlite_path)?;
    let tx = c.unchecked_transaction().map_err(fail)?;
    if !matches_source(&tx, &spec)? {
        return Err(fail("evidence changed"));
    }
    for q in quotes {
        if q.quote.trim().is_empty() || q.quote.len() > 1800 {
            return Err(fail("invalid evidence quote"));
        }
        let mut supported = false;
        for src in spec.sources.iter().filter(|s| {
            s.source_id == q.source_id && matches!(s.role.as_str(), "user" | "transcript")
        }) {
            if let Some((_, text, _)) = load(&tx, &src.source_id, &src.scope)? {
                supported |= text[src.start..src.end].contains(&q.quote);
            }
        }
        if !supported {
            return Err(fail("quotation is not in authorized user source range"));
        }
    }
    Ok(())
}

pub(crate) fn sync<E: EnvProvider>(env: &E, target: &Path) -> Result<u64, CliError> {
    let Some(path) = env.var("SAAA_MEMORY_SQLITE_PATH").filter(|p| !p.is_empty()) else {
        return Ok(0);
    };
    let raw = open(&path)?;
    let key = format!("saaa:{}", digest(&path));
    let reader = open(
        target
            .to_str()
            .ok_or_else(|| fail("SQLite path encoding"))?,
    )?;
    let cursor = reader
        .query_row(
            "SELECT CAST(cursor AS INTEGER) FROM sync_states WHERE id=?1",
            [&key],
            |r| r.get::<_, u64>(0),
        )
        .optional()
        .map_err(fail)?
        .unwrap_or(0);
    let tx = raw.unchecked_transaction().map_err(fail)?;
    let mut stmt=tx.prepare("SELECT sequence,source_id FROM memory_episode_changes WHERE sequence>?1 ORDER BY sequence LIMIT 128").map_err(fail)?;
    let changes = stmt
        .query_map([cursor], |r| {
            Ok((r.get::<_, u64>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(fail)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(fail)?;
    let next = changes.last().map_or(cursor, |r| r.0);
    let mut stmt = tx
        .prepare("SELECT scope_key FROM memory_episode_grants WHERE enabled=1 ORDER BY scope_key")
        .map_err(fail)?;
    let scopes = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(fail)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(fail)?;
    let mut records = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for (_, id) in &changes {
        for scope in &scopes {
            if seen.insert((id.clone(), scope.clone())) {
                if let Some(record) = load(&tx, id, scope)? {
                    records.push(record);
                }
            }
        }
    }
    // Sweep at most 128 imported records per tick; feed-affected records are prioritized.
    // This also reconciles restored local copies without requiring a fresh notification.
    let sweep_key = format!("{key}:sweep");
    let sweep: u64 = reader
        .query_row(
            "SELECT CAST(cursor AS INTEGER) FROM sync_states WHERE id=?1",
            [&sweep_key],
            |r| r.get(0),
        )
        .optional()
        .map_err(fail)?
        .unwrap_or(0);
    let mut stmt=reader.prepare("SELECT rowid FROM vibe_memories WHERE rowid>?1 AND json_type(metadata,'$.saaa')='object' ORDER BY rowid LIMIT 128").map_err(fail)?;
    let sweep_rows = stmt
        .query_map([sweep], |r| r.get::<_, u64>(0))
        .map_err(fail)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(fail)?;
    let sweep_next = if sweep_rows.len() < 128 {
        0
    } else {
        *sweep_rows.last().unwrap()
    };
    let changed_ids =
        serde_json::to_string(&changes.iter().map(|r| &r.1).collect::<Vec<_>>()).map_err(fail)?;
    let sweep_ids = serde_json::to_string(&sweep_rows).map_err(fail)?;
    let mut stmt=reader.prepare("SELECT id,metadata FROM vibe_memories WHERE json_type(metadata,'$.saaa')='object' AND (rowid IN (SELECT value FROM json_each(?1)) OR EXISTS(SELECT 1 FROM json_each(metadata,'$.saaa.sources') refs JOIN json_each(?2) changed ON changed.value=json_extract(refs.value,'$.sourceId'))) ORDER BY rowid").map_err(fail)?;
    let old = stmt
        .query_map(params![sweep_ids, changed_ids], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(fail)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(fail)?;
    let mut stale = Vec::new();
    let mut live_fragments = Vec::new();
    for (id, meta) in old {
        let meta: Value = serde_json::from_str(&meta).map_err(fail)?;
        if let Some(spec) = contract(&meta)? {
            if spec.sqlite_path == path && !matches_source(&tx, &spec)? {
                for source in &spec.sources {
                    if seen.insert((source.source_id.clone(), source.scope.clone())) {
                        if let Some(record) = load(&tx, &source.source_id, &source.scope)? {
                            records.push(record);
                        }
                    }
                }
                stale.push(id);
            } else if spec.sqlite_path == path {
                live_fragments.extend(spec.sources);
            }
        }
    }
    let mut fragments = Vec::new();
    for (src, text, principal) in records {
        let mut start = 0;
        while start < text.len() {
            let mut end = (start + 32000).min(text.len());
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            let mut fragment = src.clone();
            fragment.start = start;
            fragment.end = end;
            if !live_fragments.iter().any(|old: &Source| {
                old.source_id == fragment.source_id
                    && old.scope == fragment.scope
                    && old.version == fragment.version
                    && old.digest == fragment.digest
                    && old.policy_revision == fragment.policy_revision
                    && old.scope_epoch == fragment.scope_epoch
                    && old.start <= start
                    && old.end >= end
            }) {
                fragments.push((fragment, text[start..end].to_owned(), principal.clone()));
            }
            start = end;
        }
    }
    let mut records = fragments;
    let mut batches = Vec::new();
    records.sort_by(|a, b| {
        a.0.scope
            .cmp(&b.0.scope)
            .then(a.0.sequence.cmp(&b.0.sequence))
    });
    let mut current: Vec<(Source, String, String)> = Vec::new();
    let mut bytes = 0;
    for record in records {
        let split = current.last().is_some_and(|last| {
            last.0.scope != record.0.scope
                || last.2 != record.2
                || (record.0.uttered_at - last.0.uttered_at).abs() > 30 * 60 * 1000
        });
        if !current.is_empty() && (split || current.len() == 8 || bytes + record.1.len() > 64000) {
            batches.push(std::mem::take(&mut current));
            bytes = 0;
        }
        bytes += record.1.len();
        current.push(record);
    }
    if !current.is_empty() {
        batches.push(current);
    }
    let sqlite_path = path.clone();
    crate::domains::sqlite_writer::execute_for_path(target, "saaa_episode_sync", move |c| {
        persist(
            c,
            &key,
            next,
            &sqlite_path,
            batches,
            stale,
            (&sweep_key, sweep_next),
        )
        .map_err(|e| e.to_string())
    })
    .map_err(fail)
}
fn persist(
    c: &mut Connection,
    key: &str,
    cursor: u64,
    path: &str,
    batches: Vec<Vec<(Source, String, String)>>,
    stale: Vec<String>,
    sweep: (&str, u64),
) -> Result<u64, CliError> {
    let tx = c.transaction().map_err(fail)?;
    for id in stale {
        tx.execute(
            "DELETE FROM saaa_imported_fragments WHERE vibe_memory_id=?1",
            [&id],
        )
        .map_err(fail)?;
        tx.execute("DELETE FROM episode_cards_fts WHERE id IN (SELECT id FROM episode_cards WHERE json_extract(metadata,'$.episodeDistillation.parentVibeMemoryId')=?1)",[&id]).map_err(fail)?;
        tx.execute("DELETE FROM episode_refs WHERE episode_card_id IN (SELECT id FROM episode_cards WHERE json_extract(metadata,'$.episodeDistillation.parentVibeMemoryId')=?1)",[&id]).map_err(fail)?;
        tx.execute("DELETE FROM episode_cards WHERE json_extract(metadata,'$.episodeDistillation.parentVibeMemoryId')=?1",[&id]).map_err(fail)?;
        tx.execute("DELETE FROM vibe_memories_fts WHERE id=?1", [&id])
            .map_err(fail)?;
        tx.execute("DELETE FROM vibe_memories WHERE id=?1", [&id])
            .map_err(fail)?;
        tx.execute(
            "DELETE FROM distillation_queue_events WHERE queue_name='episodeDistiller' AND queue_job_id IN (SELECT id FROM episode_distiller_queue WHERE source_key=?1)",
            [&id],
        ).map_err(fail)?;
        tx.execute(
            "DELETE FROM episode_distiller_queue WHERE source_key=?1",
            [&id],
        )
        .map_err(fail)?;
    }
    let mut imported = 0;
    for batch in batches {
        let mut missing = Vec::new();
        for record in batch {
            let key = digest(&serde_json::to_string(&(path, &record.2, &record.0)).map_err(fail)?);
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM saaa_imported_fragments WHERE fragment_key=?1)",
                    [key],
                    |r| r.get(0),
                )
                .map_err(fail)?;
            if !exists {
                missing.push(record);
            }
        }
        let batch = missing;
        if batch.is_empty() {
            continue;
        }

        let scope = batch[0].0.scope.clone();
        let principal = batch[0].2.clone();
        let spec = SourceContract {
            contract_version: 1,
            sqlite_path: path.into(),
            principal: principal.clone(),
            sources: batch.iter().map(|r| r.0.clone()).collect(),
        };
        let content = batch
            .iter()
            .map(|r| {
                format!(
                    "[source={} version={} role={} uttered_at={} range={}..{}]\n{}",
                    r.0.source_id, r.0.version, r.0.role, r.0.uttered_at, r.0.start, r.0.end, r.1
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        let metadata = json!({"saaa":spec,"memoryPipeline":"raw_for_distillation","kind":"personal_conversation"});
        validate(&metadata)?;
        let id = format!(
            "saaa-{}",
            digest(&serde_json::to_string(&spec).map_err(fail)?)
        );
        let created = format!("unix-ms:{}", batch[0].0.uttered_at);
        let changed=tx.execute("INSERT OR IGNORE INTO vibe_memories(id,session_id,content,metadata,created_at) VALUES(?1,?2,?3,?4,?5)",params![id,format!("saaa:{principal}:{scope}"),content,metadata.to_string(),created]).map_err(fail)?;
        for record in &batch {
            let key = digest(&serde_json::to_string(&(path, &record.2, &record.0)).map_err(fail)?);
            tx.execute(
                "INSERT OR IGNORE INTO saaa_imported_fragments VALUES(?1,?2)",
                params![key, id],
            )
            .map_err(fail)?;
        }
        if changed == 1 {
            tx.execute(
                "INSERT INTO vibe_memories_fts(id,content) VALUES(?1,?2)",
                params![id, content],
            )
            .map_err(fail)?;
            super::store::enqueue_episode_distiller(&tx, &id, "saaa_sqlite", &scope, 0, &id)?;
            imported += 1;
        }
    }
    tx.execute("INSERT INTO sync_states(id,cursor,metadata,created_at,updated_at) VALUES(?1,?2,'{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor,updated_at=CURRENT_TIMESTAMP",params![key,cursor.to_string()]).map_err(fail)?;
    tx.execute("INSERT INTO sync_states(id,cursor,metadata,created_at,updated_at) VALUES(?1,?2,'{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor,updated_at=CURRENT_TIMESTAMP",params![sweep.0,sweep.1.to_string()]).map_err(fail)?;
    tx.commit().map_err(fail)?;
    Ok(imported)
}

#[cfg(test)]
pub(crate) mod tests;

pub(crate) fn deny_knowledge_source(c: &Connection, id: &str) -> Result<(), CliError> {
    let personal: bool = c
        .query_row(
            "SELECT json_type(metadata,'$.saaa')='object' FROM vibe_memories WHERE id=?1",
            [id],
            |r| r.get::<_, Option<bool>>(0),
        )
        .map_err(fail)?
        .unwrap_or(false);
    if personal {
        return Err(fail("personal source requires Episode pipeline"));
    }
    Ok(())
}
