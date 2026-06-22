use rusqlite::Connection;
use serde_json::{json, Value};

use super::native_common::{
    content_json, now_iso, open_database, parse_json_or_empty, pseudo_uuid, score_text, string_arg,
    table_exists, tool_error, usize_arg,
};
use super::native_tools::NativeToolContext;

pub(crate) fn search_knowledge(params: &Value, context: &NativeToolContext) -> Value {
    let Some(args) = params.get("arguments").and_then(Value::as_object) else {
        return tool_error("search_knowledge arguments must be an object");
    };
    let query = match string_arg(args, "query") {
        Some(query) if !query.is_empty() => query,
        _ => return tool_error("query is required"),
    };
    let limit = usize_arg(args, "limit").unwrap_or(10).min(50);
    let connection = match open_database(context) {
        Ok(connection) => connection,
        Err(error) => return tool_error(&error),
    };
    if !table_exists(&connection, "knowledge_items") {
        return content_json(json!({
            "query": query,
            "normalizedQuery": query,
            "items": [],
            "diagnostics": {"degradedReasons":["knowledge_items_missing"],"stats":{"queryText": query}}
        }));
    }

    let mut statement = match connection.prepare(
        r#"
        select id, type, status, scope, polarity, intent_tags, title, body, applies_to,
               confidence, importance, compile_select_count, last_compiled_at,
               agentic_accept_count, explicit_upvote_count, explicit_downvote_count,
               dynamic_score, metadata, updated_at, last_verified_at
        from knowledge_items
        order by importance desc, updated_at desc
        limit 500
        "#,
    ) {
        Ok(statement) => statement,
        Err(error) => return tool_error(&format!("failed to search knowledge: {error}")),
    };
    let rows = match statement.query_map([], |row| {
        Ok(KnowledgeRow {
            id: row.get(0)?,
            kind: row.get(1)?,
            status: row.get(2)?,
            scope: row.get(3)?,
            polarity: row.get(4)?,
            intent_tags: row.get(5)?,
            title: row.get(6)?,
            body: row.get(7)?,
            applies_to: row.get(8)?,
            confidence: row.get(9)?,
            importance: row.get(10)?,
            compile_select_count: row.get(11)?,
            last_compiled_at: row.get(12)?,
            agentic_accept_count: row.get(13)?,
            explicit_upvote_count: row.get(14)?,
            explicit_downvote_count: row.get(15)?,
            dynamic_score: row.get(16)?,
            metadata: row.get(17)?,
            updated_at: row.get(18)?,
            last_verified_at: row.get(19)?,
        })
    }) {
        Ok(rows) => rows,
        Err(error) => return tool_error(&format!("failed to search knowledge: {error}")),
    };
    let mut items = Vec::new();
    for row in rows.flatten() {
        if !matches_arg_array(args, "statuses", &row.status)
            && !default_status_matches(args, &row.status)
        {
            continue;
        }
        if !matches_arg_array(args, "types", &row.kind)
            || !matches_arg_array(args, "polarities", &row.polarity)
        {
            continue;
        }
        let score = score_text(&format!("{}\n{}", row.title, row.body), &query)
            + row.dynamic_score.round() as i64;
        if score <= 0 {
            continue;
        }
        let source_refs = source_refs(&connection, &row.id);
        items.push((
            score,
            json!({
                "id": row.id,
                "type": row.kind,
                "status": row.status,
                "scope": row.scope,
                "polarity": row.polarity,
                "intentTags": parse_json_array(&row.intent_tags),
                "title": row.title,
                "body": row.body,
                "score": score,
                "confidence": row.confidence,
                "importance": row.importance,
                "dynamicScore": row.dynamic_score,
                "decayFactor": 1.0,
                "compileSelectCount": row.compile_select_count,
                "agenticAcceptCount": row.agentic_accept_count,
                "explicitUpvoteCount": row.explicit_upvote_count,
                "explicitDownvoteCount": row.explicit_downvote_count,
                "lastCompiledAt": row.last_compiled_at,
                "lastVerifiedAt": row.last_verified_at,
                "updatedAt": row.updated_at,
                "sourceRefs": source_refs,
                "appliesTo": parse_json_or_empty(&row.applies_to),
                "applicabilityScore": 0,
                "applicabilityMatches": {},
                "metadata": parse_json_or_empty(&row.metadata)
            }),
        ));
    }
    items.sort_by(|left, right| right.0.cmp(&left.0));
    let values = items
        .into_iter()
        .take(limit)
        .map(|(_, value)| value)
        .collect::<Vec<_>>();
    if values.is_empty() {
        return json!({"content":[{"type":"text","text":"no content"}]});
    }
    content_json(json!({
        "query": query,
        "normalizedQuery": query,
        "items": values,
        "diagnostics": {
            "degradedReasons": [],
            "stats": {
                "queryText": query,
                "textHitCount": values.len(),
                "vectorHitCount": 0,
                "mergedCount": values.len(),
                "textFailed": false,
                "vectorFailed": false,
                "embeddingStatus": "disabled",
                "scopedSearch": false,
                "repoScopeFallbackUsed": false
            }
        }
    }))
}

pub(crate) fn context_decision_feedback(params: &Value, context: &NativeToolContext) -> Value {
    let Some(args) = params.get("arguments").and_then(Value::as_object) else {
        return tool_error("context_decision_feedback arguments must be an object");
    };
    let decision_id = match string_arg(args, "decisionId") {
        Some(value) => value,
        None => return tool_error("decisionId is required"),
    };
    let source = string_arg(args, "source").unwrap_or_else(|| "ai".to_string());
    let connection = match open_database(context) {
        Ok(connection) => connection,
        Err(error) => return tool_error(&error),
    };
    if !table_exists(&connection, "context_decision_runs") {
        return tool_error("context_decision_runs table is not available");
    }
    let exists = connection
        .query_row(
            "select exists(select 1 from context_decision_runs where id = ?1)",
            [&decision_id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        == 1;
    if !exists {
        return tool_error("Context decision not found.");
    }

    if source == "human" {
        let value = string_arg(args, "value").unwrap_or_else(|| "good".to_string());
        let id = pseudo_uuid();
        let now = now_iso();
        if let Err(error) = connection.execute(
            r#"
            insert or replace into context_decision_human_feedback (
              id, decision_run_id, value, created_at
            ) values (?1, ?2, ?3, ?4)
            "#,
            (&id, &decision_id, &value, &now),
        ) {
            return tool_error(&format!("failed to record human feedback: {error}"));
        }
        return content_json(json!({
            "humanFeedback": {
                "id": id,
                "decisionRunId": decision_id,
                "value": value,
                "createdAt": now
            }
        }));
    }

    let id = pseudo_uuid();
    let now = now_iso();
    let outcome = string_arg(args, "outcome").unwrap_or_else(|| "still_unknown".to_string());
    let reason = string_arg(args, "reason").unwrap_or_else(|| "No reason supplied.".to_string());
    let metadata = args.get("metadata").cloned().unwrap_or_else(|| json!({}));
    let affected = selected_support_knowledge_ids(&connection, &decision_id);
    if let Err(error) = connection.execute(
        r#"
        insert into context_decision_feedback (
          id, decision_run_id, source, outcome, inferred_reason, affected_knowledge_ids,
          suggested_adjustment, metadata, created_at
        ) values (?1, ?2, ?3, ?4, ?5, ?6, '{}', ?7, ?8)
        "#,
        (
            &id,
            &decision_id,
            &source,
            &outcome,
            &reason,
            json!(affected).to_string(),
            metadata.to_string(),
            &now,
        ),
    ) {
        return tool_error(&format!("failed to record decision feedback: {error}"));
    }
    content_json(json!({
        "feedback": {
            "id": id,
            "decisionRunId": decision_id,
            "source": source,
            "outcome": outcome,
            "inferredReason": reason,
            "affectedKnowledgeIds": affected,
            "suggestedAdjustment": {},
            "metadata": metadata,
            "createdAt": now
        },
        "effects": []
    }))
}

pub(crate) fn register_candidates(params: &Value, context: &NativeToolContext) -> Value {
    let Some(args) = params.get("arguments").and_then(Value::as_object) else {
        return tool_error("register_candidates arguments must be an object");
    };
    let Some(items) = args.get("items").and_then(Value::as_array) else {
        return tool_error("items must be an array");
    };
    if items.is_empty() || items.len() > 10 {
        return tool_error("items must contain 1-10 candidates");
    }
    let mut connection = match open_database(context) {
        Ok(connection) => connection,
        Err(error) => return tool_error(&error),
    };
    if !table_exists(&connection, "knowledge_items") {
        return tool_error("knowledge_items table is not available");
    }
    let tx = match connection.transaction() {
        Ok(tx) => tx,
        Err(error) => {
            return tool_error(&format!("failed to start candidate transaction: {error}"))
        }
    };
    let mut results = Vec::new();
    let mut registered = 0;
    for (index, value) in items.iter().enumerate() {
        let Some(item) = value.as_object() else {
            results.push(json!({"index": index, "status": "candidate_failed", "error": "candidate must be an object"}));
            continue;
        };
        match normalize_candidate(item).and_then(|candidate| insert_candidate(&tx, candidate)) {
            Ok(result) => {
                registered += 1;
                results.push(json!({
                    "index": index,
                    "status": "candidate_registered",
                    "title": result.title,
                    "type": result.kind,
                    "targetStateId": result.knowledge_id,
                    "findCandidateResultId": result.candidate_id,
                    "sourceUri": result.source_uri,
                    "warnings": result.warnings
                }));
            }
            Err(error) => {
                results.push(json!({"index": index, "status": "candidate_failed", "error": error}));
            }
        }
    }
    if let Err(error) = tx.commit() {
        return tool_error(&format!("failed to commit candidates: {error}"));
    }
    let failed = items.len() - registered;
    let status = if registered == items.len() {
        "bulk_candidates_registered"
    } else if registered > 0 {
        "bulk_candidates_partial"
    } else {
        "bulk_candidates_failed"
    };
    content_json(json!({
        "status": status,
        "registeredCount": registered,
        "failedCount": failed,
        "items": results,
        "next": "distillation_pipeline"
    }))
}

#[derive(Debug)]
struct KnowledgeRow {
    id: String,
    kind: String,
    status: String,
    scope: String,
    polarity: String,
    intent_tags: String,
    title: String,
    body: String,
    applies_to: String,
    confidence: f64,
    importance: f64,
    compile_select_count: i64,
    last_compiled_at: Option<String>,
    agentic_accept_count: i64,
    explicit_upvote_count: i64,
    explicit_downvote_count: i64,
    dynamic_score: f64,
    metadata: String,
    updated_at: String,
    last_verified_at: Option<String>,
}

#[derive(Debug)]
struct Candidate {
    title: String,
    body: String,
    kind: String,
    polarity: String,
    intent_tags: Vec<String>,
    confidence: f64,
    importance: f64,
    applies_to: Value,
    metadata: Value,
    scope: String,
    warnings: Vec<String>,
}

#[derive(Debug)]
struct InsertCandidateResult {
    knowledge_id: String,
    candidate_id: String,
    source_uri: String,
    title: String,
    kind: String,
    warnings: Vec<String>,
}

fn default_status_matches(args: &serde_json::Map<String, Value>, status: &str) -> bool {
    if args.get("statuses").is_some() {
        return false;
    }
    let requested = string_arg(args, "status").unwrap_or_else(|| "active".to_string());
    status == requested
}

fn matches_arg_array(args: &serde_json::Map<String, Value>, key: &str, value: &str) -> bool {
    let Some(values) = args.get(key).and_then(Value::as_array) else {
        return true;
    };
    if values.is_empty() {
        return true;
    }
    values
        .iter()
        .filter_map(Value::as_str)
        .any(|candidate| candidate == value)
}

fn parse_json_array(value: &str) -> Vec<Value> {
    serde_json::from_str(value).unwrap_or_default()
}

fn source_refs(connection: &Connection, knowledge_id: &str) -> Vec<String> {
    let mut statement = match connection.prepare(
        r#"
        select s.uri, sf.locator
        from knowledge_source_links ksl
        join source_fragments sf on sf.id = ksl.source_fragment_id
        join sources s on s.id = sf.source_id
        where ksl.knowledge_id = ?1
        order by ksl.confidence desc, ksl.created_at desc
        "#,
    ) {
        Ok(statement) => statement,
        Err(_) => return Vec::new(),
    };
    statement
        .query_map([knowledge_id], |row| {
            let uri: String = row.get(0)?;
            let locator: String = row.get(1)?;
            Ok(format!("{uri}#{locator}"))
        })
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

fn selected_support_knowledge_ids(connection: &Connection, decision_id: &str) -> Vec<String> {
    let mut statement = match connection.prepare(
        r#"
        select knowledge_id
        from context_decision_evidence
        where decision_run_id = ?1 and role = 'selected_support' and knowledge_id is not null
        "#,
    ) {
        Ok(statement) => statement,
        Err(_) => return Vec::new(),
    };
    statement
        .query_map([decision_id], |row| row.get::<_, String>(0))
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

fn normalize_candidate(item: &serde_json::Map<String, Value>) -> Result<Candidate, String> {
    let polarity = string_arg(item, "polarity").unwrap_or_else(|| "positive".to_string());
    let mut kind = string_arg(item, "type").unwrap_or_else(|| "rule".to_string());
    if kind != "rule" && kind != "procedure" {
        return Err("type must be rule or procedure".to_string());
    }
    let body = string_arg(item, "body")
        .or_else(|| string_arg(item, "text"))
        .or_else(|| {
            if polarity == "negative" {
                Some(format!(
                    "避けること: {}\n推奨: {}",
                    string_arg(item, "avoid").unwrap_or_default(),
                    string_arg(item, "prefer").unwrap_or_default()
                ))
            } else {
                None
            }
        })
        .ok_or_else(|| "body or text is required".to_string())?;
    if polarity == "negative" && kind == "procedure" {
        kind = "rule".to_string();
    }
    let title = string_arg(item, "title").unwrap_or_else(|| infer_title(&body));
    let mut warnings = Vec::new();
    if kind == "procedure" && !has_skill_like_sections(&body) {
        return Err("PROCEDURE_CANDIDATE_MISSING_SKILL_LIKE_SECTIONS".to_string());
    }
    if item.get("text").is_some() {
        warnings.push("text_parsed_to_candidate_json".to_string());
    }
    let applies_to = build_applies_to(item);
    let scope = if applies_to
        .get("general")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        "global"
    } else {
        "repo"
    }
    .to_string();
    let metadata = json!({
        "source": "mcp_register_candidate",
        "registeredAt": now_iso(),
        "sqliteDirectRegistration": true,
        "rustDirectRegistration": true,
        "polarity": polarity,
        "metadata": item.get("metadata").cloned().unwrap_or_else(|| json!({}))
    });
    Ok(Candidate {
        title,
        body,
        kind,
        polarity,
        intent_tags: string_array_arg(item, "intentTags"),
        confidence: number_arg(item, "confidence").unwrap_or(70.0),
        importance: number_arg(item, "importance").unwrap_or(70.0),
        applies_to,
        metadata,
        scope,
        warnings,
    })
}

fn insert_candidate(
    connection: &rusqlite::Transaction<'_>,
    candidate: Candidate,
) -> Result<InsertCandidateResult, String> {
    let knowledge_id = pseudo_uuid();
    let candidate_id = pseudo_uuid();
    let source_uri = format!("agent://candidate/{candidate_id}");
    let now = now_iso();
    connection
        .execute(
            r#"
            insert into knowledge_items (
              id, type, status, scope, polarity, intent_tags, title, body, applies_to,
              confidence, importance, metadata, created_at, updated_at, last_verified_at
            ) values (?1, ?2, 'active', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?12)
            "#,
            (
                &knowledge_id,
                &candidate.kind,
                &candidate.scope,
                &candidate.polarity,
                json!(candidate.intent_tags).to_string(),
                &candidate.title,
                &candidate.body,
                candidate.applies_to.to_string(),
                candidate.confidence,
                candidate.importance,
                candidate.metadata.to_string(),
                &now,
            ),
        )
        .map_err(|error| format!("failed to insert knowledge item: {error}"))?;
    let _ = connection.execute(
        "insert into knowledge_items_fts(id, title, body) values (?1, ?2, ?3)",
        (&knowledge_id, &candidate.title, &candidate.body),
    );
    Ok(InsertCandidateResult {
        knowledge_id,
        candidate_id,
        source_uri,
        title: candidate.title,
        kind: candidate.kind,
        warnings: candidate.warnings,
    })
}

fn infer_title(body: &str) -> String {
    body.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Registered candidate")
        .trim_start_matches('#')
        .trim_start_matches(['-', '*', ' '])
        .chars()
        .take(96)
        .collect()
}

fn has_skill_like_sections(body: &str) -> bool {
    ["Use when", "Workflow", "Verification", "Avoid"]
        .iter()
        .all(|heading| body.contains(&format!("{heading}:")))
}

fn build_applies_to(item: &serde_json::Map<String, Value>) -> Value {
    let mut applies_to = item.get("appliesTo").cloned().unwrap_or_else(|| json!({}));
    if !applies_to.is_object() {
        applies_to = json!({});
    }
    for key in [
        "general",
        "technologies",
        "changeTypes",
        "domains",
        "repoPath",
        "repoKey",
    ] {
        if let Some(value) = item.get(key) {
            applies_to[key] = value.clone();
        }
    }
    applies_to
}

fn string_array_arg(args: &serde_json::Map<String, Value>, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn number_arg(args: &serde_json::Map<String, Value>, key: &str) -> Option<f64> {
    args.get(key).and_then(Value::as_f64)
}
