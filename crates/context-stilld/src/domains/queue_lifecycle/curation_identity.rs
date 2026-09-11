//! Bounded reconciliation of repository evidence, using the shared identity contract.
use super::curation_repository::{canonical_json, hash, load_knowledge};
use crate::domains::mcp_lifecycle::project_identity::{
    resolve_compile_project_identity, CompileProjectIdentityAlias, CompileProjectIdentityAliasKind,
    CompileProjectIdentityInput, CompileProjectIdentityTrust,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

fn text(value: &Value, key: &str) -> Option<String> {
    value[key]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
}

fn collect(value: &Value, evidence: &mut Vec<CompileProjectIdentityInput>, project_root: bool) {
    let direct_trusted = value
        .get("classificationStatus")
        .is_none_or(|s| s == "classified");
    let input = CompileProjectIdentityInput {
        project_ref: text(value, "projectRef"),
        repo_key: text(value, "repoKey"),
        repo_path: text(value, "repoPath")
            .or_else(|| project_root.then(|| text(value, "projectRoot")).flatten()),
    };
    if direct_trusted
        && (input.project_ref.is_some() || input.repo_key.is_some() || input.repo_path.is_some())
    {
        evidence.push(input);
    }
    if project_root && direct_trusted {
        if let Some(root) = text(value, "projectRoot") {
            evidence.push(CompileProjectIdentityInput {
                repo_path: Some(root),
                ..Default::default()
            });
        }
    }
    for key in [
        "projectIdentity",
        "repositoryIdentity",
        "compileProjectIdentity",
        "sourceCaptureIdentity",
    ] {
        if let Some(nested) = value.get(key) {
            collect(nested, evidence, false);
        }
    }
    if let Some(capture) = value.get("capture").or_else(|| value.get("sourceCapture")) {
        collect(
            capture.get("projectIdentity").unwrap_or(capture),
            evidence,
            false,
        );
    }
}

fn resolve_evidence(
    evidence: &[CompileProjectIdentityInput],
    aliases: &[CompileProjectIdentityAlias],
) -> Result<CompileProjectIdentityInput, String> {
    let mut merged = CompileProjectIdentityInput::default();
    for input in evidence {
        let normalized = resolve_compile_project_identity(
            input,
            CompileProjectIdentityTrust::TrustedAdapter,
            None,
        )
        .map_err(|_| "malformed")?;
        let mut refs = std::collections::HashSet::new();
        if let Some(reference) = &normalized.project_ref {
            refs.insert(reference.clone());
        }
        for alias in aliases {
            let matched = match alias.alias_kind {
                CompileProjectIdentityAliasKind::RepoKey => {
                    normalized.repo_key.as_ref() == Some(&alias.normalized_value)
                }
                CompileProjectIdentityAliasKind::RepoPath => {
                    normalized.repo_path.as_ref() == Some(&alias.normalized_value)
                }
            };
            if matched {
                refs.insert(alias.project_ref.clone());
            }
        }
        if refs.len() > 1 {
            return Err("conflict".into());
        }
        let fields = [
            (&mut merged.project_ref, refs.into_iter().next()),
            (&mut merged.repo_key, normalized.repo_key),
            (&mut merged.repo_path, normalized.repo_path),
        ];
        for (target, value) in fields {
            if let Some(value) = value {
                if target.as_ref().is_some_and(|current| current != &value) {
                    return Err("conflict".into());
                }
                *target = Some(value);
            }
        }
    }
    // Multiple identifiers need an authoritative binding, including when no aliases exist.
    resolve_compile_project_identity(
        &merged,
        CompileProjectIdentityTrust::TrustedAdapter,
        Some(aliases),
    )
    .map_err(|_| "conflict")?;
    Ok(merged)
}

pub(super) fn recover_one(connection: &Connection, id: &str) -> Result<bool, String> {
    let Some(before) = load_knowledge(connection, id)? else {
        return Ok(false);
    };
    if before["scope"] != "repo" || before["status"] != "active" {
        return Ok(false);
    }
    if before["classificationStatus"] == "classified"
        && super::curation_repository::identity_wait_reason(&before).is_none()
        && before["metadata"]["curationIdentityRecovery"].is_null()
    {
        return Ok(false);
    }
    let mut evidence = Vec::new();
    // Existing canonical fields remain evidence even when classification is unresolved.
    collect(
        &json!({"repoKey":before["repoKey"],"repoPath":before["repoPath"],"projectRef":before["projectRef"]}),
        &mut evidence,
        false,
    );
    collect(&before["metadata"], &mut evidence, true);
    collect(&before["appliesTo"], &mut evidence, false);
    let mut sources = Vec::<Value>::new();
    let mut statement = connection.prepare(
        "select distinct s.id, s.classification_status, s.scope, s.project_ref, s.repo_key, s.repo_path
         from knowledge_source_links l join source_fragments f on f.id=l.source_fragment_id
         join sources s on s.id=f.source_id where l.knowledge_id=?1 and l.link_type='derived_from'
         order by s.id limit 129"
    ).map_err(|e| e.to_string())?;
    let rows = statement.query_map([id], |r| Ok(json!({"id":r.get::<_,String>(0)?,
        "classificationStatus":r.get::<_,String>(1)?,"scope":r.get::<_,String>(2)?,
        "projectRef":r.get::<_,Option<String>>(3)?,"repoKey":r.get::<_,Option<String>>(4)?,"repoPath":r.get::<_,Option<String>>(5)?})))
        .map_err(|e|e.to_string())?;
    for row in rows {
        sources.push(row.map_err(|e| e.to_string())?);
    }
    let mut statement = connection.prepare(
        "select distinct v.id,v.metadata from knowledge_origin_links l join vibe_memories v on v.id=l.origin_key
         where l.knowledge_id=?1 and l.origin_kind='vibe_memory' order by v.id limit 129"
    ).map_err(|e|e.to_string())?;
    let memories = statement
        .query_map([id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    // Do not silently drop unresolved ownership or truncate a conflicting origin.
    let incomplete = sources.len() > 128
        || memories.len() > 128
        || sources.iter().any(|s| {
            s["classificationStatus"] != "classified"
                || s["scope"] != "repo"
                || ["repoKey", "repoPath", "projectRef"]
                    .iter()
                    .all(|key| text(s, key).is_none())
        });
    for source in &sources {
        collect(source, &mut evidence, false);
    }
    let mut malformed = false;
    for (_, raw) in &memories {
        match serde_json::from_str::<Value>(raw) {
            Ok(value) if value.is_object() => collect(&value, &mut evidence, true),
            _ => malformed = true,
        }
    }
    let mut statement = connection.prepare("select project_ref,alias_kind,normalized_value from project_identity_aliases where status='active' and alias_kind in ('repo_key','repo_path') order by project_ref,alias_kind,normalized_value")
        .map_err(|e|e.to_string())?;
    let aliases = statement
        .query_map([], |r| {
            Ok(CompileProjectIdentityAlias {
                project_ref: r.get(0)?,
                alias_kind: if r.get::<_, String>(1)? == "repo_key" {
                    CompileProjectIdentityAliasKind::RepoKey
                } else {
                    CompileProjectIdentityAliasKind::RepoPath
                },
                normalized_value: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let resolved = resolve_evidence(&evidence, &aliases);
    let (classification, resolved) = if malformed {
        ("malformed", None)
    } else if let Err(ref reason) = resolved {
        (reason.as_str(), None)
    } else if incomplete || evidence.is_empty() {
        ("unresolved", None)
    } else {
        ("classified", resolved.as_ref().ok())
    };
    let project = resolved
        .and_then(|r| r.project_ref.clone())
        .or_else(|| text(&before, "projectRef"));
    let key = resolved
        .and_then(|r| r.repo_key.clone())
        .or_else(|| text(&before, "repoKey"));
    let path = resolved
        .and_then(|r| r.repo_path.clone())
        .or_else(|| text(&before, "repoPath"));
    let after = json!({"classificationStatus":classification,"projectRef":project,"repoKey":key,"repoPath":path});
    if ["classificationStatus", "projectRef", "repoKey", "repoPath"]
        .iter()
        .all(|key| before[key] == after[key])
    {
        return Ok(false);
    }
    let mut applies = before["appliesTo"].clone();
    let evidence_snapshot = json!({
        "identities":evidence.iter().map(|input|json!({"projectRef":input.project_ref,"repoKey":input.repo_key,"repoPath":input.repo_path})).collect::<Vec<_>>(),
        "bindings":aliases.iter().map(|alias|json!({"projectRef":alias.project_ref,"kind":format!("{:?}",alias.alias_kind),"value":alias.normalized_value})).collect::<Vec<_>>()
    });
    let evidence_revision = hash(&canonical_json(&evidence_snapshot));
    if let Some(object) = applies.as_object_mut() {
        for field in ["projectRef", "repoKey", "repoPath"] {
            if classification == "classified" && !after[field].is_null() {
                object.insert(field.into(), after[field].clone());
            }
        }
    }
    connection.execute("update knowledge_items set classification_status=?2,project_ref=?3,repo_key=?4,repo_path=?5,applies_to=?6,
        metadata=json_set(metadata,'$.curationIdentityRecovery',json(?7)),updated_at=CURRENT_TIMESTAMP where id=?1",
        params![id,classification,project,key,path,applies.to_string(),json!({"version":1,"classification":classification,"evidenceRevision":evidence_revision}).to_string()]).map_err(|e|e.to_string())?;
    let audit = json!({"knowledgeId":id,"before":before,"after":after,"sources":sources,"originIds":memories.iter().map(|r|&r.0).collect::<Vec<_>>(),"evidence":evidence_snapshot,"evidenceRevision":evidence_revision});
    connection.execute("insert or ignore into audit_logs(id,event_type,actor,payload) values (?1,'CURATION_IDENTITY_RECOVERY','system',?2)",
        params![format!("curation-identity:{}",hash(&canonical_json(&audit))),audit.to_string()]).map_err(|e|e.to_string())?;
    Ok(true)
}

/// Persist a cursor so unresolved rows cannot starve later rows or restart the scan each tick.
pub(super) fn reconcile(connection: &Connection, limit: usize) -> Result<usize, String> {
    let exists: bool = connection
        .query_row(
            "select exists(select 1 from sqlite_master where name='landscape_curation_queue')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Ok(0);
    }
    let state: Option<(String,bool,String)> = connection.query_row(
        "select coalesce(json_extract(value,'$.cursor'),''), datetime(updated_at,'+60 seconds') > CURRENT_TIMESTAMP, updated_at from settings where namespace='curation' and key='identity_reconciliation'",
        [],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?;
    if state.as_ref().is_some_and(|s| s.1) {
        return Ok(0);
    }
    connection
        .execute_batch("SAVEPOINT curation_identity_recovery")
        .map_err(|e| e.to_string())?;
    let result = (|| {
        let (cursor, _, last_scan) =
            state.unwrap_or_else(|| (String::new(), false, "1970-01-01".into()));
        let budget = limit.clamp(1, 500);
        let changed_budget = budget / 5;
        // Prioritize changed provenance, but reserve most of the batch for the durable cursor.
        // This also recovers missed notifications and deletions without a new event store.
        let mut changed_statement = connection.prepare("select k.id from knowledge_items k
            where k.status='active' and k.scope='repo'
            and (k.classification_status <> 'classified' or json_type(k.metadata,'$.curationIdentityRecovery') is not null)
            and (k.updated_at >= ?1 or exists(select 1 from knowledge_source_links l
                join source_fragments f on f.id=l.source_fragment_id join sources s on s.id=f.source_id
                where l.knowledge_id=k.id and (l.created_at >= ?1 or s.updated_at >= ?1))
              or exists(select 1 from knowledge_origin_links l join vibe_memories v on v.id=l.origin_key
                where l.knowledge_id=k.id and l.origin_kind='vibe_memory' and
                (l.created_at >= ?1 or v.created_at >= ?1))) order by k.id limit ?2").map_err(|e|e.to_string())?;
        let changed_ids = changed_statement
            .query_map(params![last_scan, changed_budget as i64], |r| {
                r.get::<_, String>(0)
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let scan_budget = budget - changed_ids.len();
        let mut statement = connection.prepare("select id from knowledge_items where status='active' and scope='repo' and id > ?1
            and (classification_status <> 'classified' or json_type(metadata,'$.curationIdentityRecovery') is not null
            or (coalesce(trim(repo_key),'')='' and coalesce(trim(repo_path),'')='' and coalesce(trim(project_ref),'')=''))
            order by id limit ?2").map_err(|e|e.to_string())?;
        let ids = statement
            .query_map(params![cursor, scan_budget as i64], |r| {
                r.get::<_, String>(0)
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut changed = 0;
        let mut visited = std::collections::HashSet::new();
        for id in changed_ids
            .iter()
            .chain(&ids)
            .filter(|id| visited.insert(id.as_str()))
        {
            changed += usize::from(recover_one(connection, id)?);
        }
        connection.execute("update curation_review_ledger set outcome='needs_evidence',updated_at=CURRENT_TIMESTAMP
            where outcome='reviewed' and exists(select 1 from landscape_curation_queue q
            where q.id=curation_review_ledger.curation_job_id and q.subject_knowledge_id=curation_review_ledger.knowledge_id
            and q.status='skipped' and q.phase='preflight' and q.last_outcome_kind in ('identity_unavailable','identity_conflict')
            and json_extract(q.input_snapshot,'$.subject.contentRevision')=curation_review_ledger.content_revision)",[]).map_err(|e|e.to_string())?;
        super::curation_repository::enqueue_all(connection)?;
        connection.execute("insert into settings(id,namespace,key,value) values ('curation-identity-reconciliation','curation','identity_reconciliation',?1)
            on conflict(namespace,key) do update set value=excluded.value,updated_at=CURRENT_TIMESTAMP",
            [json!({"cursor":if ids.len() < scan_budget { "" } else { ids.last().map(String::as_str).unwrap_or("") }}).to_string()]).map_err(|e|e.to_string())?;
        Ok(changed)
    })();
    if result.is_err() {
        connection
            .execute_batch("ROLLBACK TO curation_identity_recovery")
            .map_err(|e| e.to_string())?;
    }
    connection
        .execute_batch("RELEASE curation_identity_recovery")
        .map_err(|e| e.to_string())?;
    result
}
