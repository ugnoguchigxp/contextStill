use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use super::native_common::{
    content_json, open_database, parse_json_array, parse_json_or_empty, score_text, string_arg,
    table_exists, tool_error, usize_arg,
};
use super::native_tools::NativeToolContext;

pub(crate) fn search_episodes(params: &Value, context: &NativeToolContext) -> Value {
    let args = params.get("arguments").and_then(Value::as_object);
    let connection = match open_database(context) {
        Ok(connection) => connection,
        Err(error) => return tool_error(&error),
    };
    if !table_exists(&connection, "episode_cards") {
        return content_json(json!({ "items": [] }));
    }
    let query = args.and_then(|args| string_arg(args, "query"));
    let limit = args
        .and_then(|args| usize_arg(args, "limit"))
        .unwrap_or(10)
        .min(100);
    let status = args
        .and_then(|args| string_arg(args, "status"))
        .unwrap_or_else(|| "active".to_string());
    let rows = match fetch_episode_rows(&connection, 500) {
        Ok(rows) => rows,
        Err(error) => return tool_error(&error),
    };
    let mut items = Vec::new();
    for row in rows {
        if row.status != status {
            continue;
        }
        let refs = fetch_episode_refs(&connection, &row.id);
        let score = score_text(
            &episode_search_text(&row, &refs),
            query.as_deref().unwrap_or(""),
        ) + ((row.importance * 6 + row.confidence * 4) / 100)
            + if row.outcome_kind == "unknown" { 0 } else { 1 };
        if query.is_some() && score <= 0 {
            continue;
        }
        items.push((
            score,
            row.created_at.clone(),
            episode_search_payload(row, refs, Some(score)),
        ));
    }
    items.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
    content_json(json!({
        "items": items.into_iter().take(limit).map(|(_, _, item)| item).collect::<Vec<_>>()
    }))
}

pub(crate) fn fetch_episode(params: &Value, context: &NativeToolContext) -> Value {
    let Some(args) = params.get("arguments").and_then(Value::as_object) else {
        return tool_error("fetch_episode arguments must be an object");
    };
    let id = match string_arg(args, "id") {
        Some(id) if !id.is_empty() => id,
        _ => return tool_error("id is required"),
    };
    let connection = match open_database(context) {
        Ok(connection) => connection,
        Err(error) => return tool_error(&error),
    };
    let row = match fetch_episode_row(&connection, &id) {
        Ok(Some(row)) => row,
        Ok(None) => return tool_error("Episode not found."),
        Err(error) => return tool_error(&error),
    };
    content_json(episode_full_payload(
        row,
        fetch_episode_refs(&connection, &id),
    ))
}

#[derive(Debug, Clone)]
struct EpisodeRow {
    id: String,
    title: String,
    situation: String,
    observations: String,
    action: String,
    outcome: String,
    lesson: String,
    applicability: String,
    anti_applicability: String,
    domains: String,
    technologies: String,
    change_types: String,
    tools: String,
    repo_path: Option<String>,
    repo_key: Option<String>,
    source_kind: String,
    source_key: String,
    outcome_kind: String,
    importance: i64,
    confidence: i64,
    compile_use_count: i64,
    decision_use_count: i64,
    status: String,
    stale_at: Option<String>,
    metadata: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EpisodeRef {
    ref_kind: String,
    ref_value: String,
    locator: Option<String>,
    query_hint: Option<String>,
}

fn fetch_episode_rows(connection: &Connection, limit: usize) -> Result<Vec<EpisodeRow>, String> {
    let mut statement = connection
        .prepare("select * from episode_cards order by created_at desc limit ?1")
        .map_err(|error| format!("failed to search episodes: {error}"))?;
    let rows = statement
        .query_map([limit as i64], map_episode_row)
        .map_err(|error| format!("failed to search episodes: {error}"))?;
    Ok(rows.flatten().collect())
}

fn fetch_episode_row(connection: &Connection, id: &str) -> Result<Option<EpisodeRow>, String> {
    connection
        .query_row(
            "select * from episode_cards where id = ?1 limit 1",
            [id],
            map_episode_row,
        )
        .optional()
        .map_err(|error| format!("failed to fetch episode: {error}"))
}

fn map_episode_row(row: &rusqlite::Row<'_>) -> Result<EpisodeRow, rusqlite::Error> {
    Ok(EpisodeRow {
        id: row.get(0)?,
        title: row.get(1)?,
        situation: row.get(2)?,
        observations: row.get(3)?,
        action: row.get(4)?,
        outcome: row.get(5)?,
        lesson: row.get(6)?,
        applicability: row.get(7)?,
        anti_applicability: row.get(8)?,
        domains: row.get(9)?,
        technologies: row.get(10)?,
        change_types: row.get(11)?,
        tools: row.get(12)?,
        repo_path: row.get(13)?,
        repo_key: row.get(14)?,
        source_kind: row.get(15)?,
        source_key: row.get(16)?,
        outcome_kind: row.get(17)?,
        importance: row.get(18)?,
        confidence: row.get(19)?,
        compile_use_count: row.get(20)?,
        decision_use_count: row.get(21)?,
        status: row.get(22)?,
        stale_at: row.get(23)?,
        metadata: row.get(25)?,
        created_at: row.get(26)?,
        updated_at: row.get(27)?,
    })
}

fn fetch_episode_refs(connection: &Connection, episode_id: &str) -> Vec<EpisodeRef> {
    let mut statement = match connection.prepare(
        "select ref_kind, ref_value, locator, query_hint from episode_refs where episode_card_id = ?1",
    ) {
        Ok(statement) => statement,
        Err(_) => return Vec::new(),
    };
    statement
        .query_map([episode_id], |row| {
            Ok(EpisodeRef {
                ref_kind: row.get(0)?,
                ref_value: row.get(1)?,
                locator: row.get(2)?,
                query_hint: row.get(3)?,
            })
        })
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

fn episode_search_payload(row: EpisodeRow, refs: Vec<EpisodeRef>, score: Option<i64>) -> Value {
    json!({
        "id": row.id,
        "title": row.title,
        "situation": row.situation,
        "outcome": row.outcome,
        "lesson": row.lesson,
        "outcomeKind": row.outcome_kind,
        "importance": row.importance,
        "confidence": row.confidence,
        "compileUseCount": row.compile_use_count,
        "decisionUseCount": row.decision_use_count,
        "status": row.status,
        "score": score,
        "domains": parse_json_array(&row.domains),
        "technologies": parse_json_array(&row.technologies),
        "changeTypes": parse_json_array(&row.change_types),
        "repoPath": row.repo_path,
        "repoKey": row.repo_key,
        "refs": refs,
        "createdAt": row.created_at
    })
}

fn episode_full_payload(row: EpisodeRow, refs: Vec<EpisodeRef>) -> Value {
    json!({
        "id": row.id,
        "title": row.title,
        "situation": row.situation,
        "observations": row.observations,
        "action": row.action,
        "outcome": row.outcome,
        "lesson": row.lesson,
        "applicability": parse_json_or_empty(&row.applicability),
        "antiApplicability": parse_json_or_empty(&row.anti_applicability),
        "domains": parse_json_array(&row.domains),
        "technologies": parse_json_array(&row.technologies),
        "changeTypes": parse_json_array(&row.change_types),
        "tools": parse_json_array(&row.tools),
        "repoPath": row.repo_path,
        "repoKey": row.repo_key,
        "sourceKind": row.source_kind,
        "sourceKey": row.source_key,
        "outcomeKind": row.outcome_kind,
        "importance": row.importance,
        "confidence": row.confidence,
        "compileUseCount": row.compile_use_count,
        "decisionUseCount": row.decision_use_count,
        "status": row.status,
        "staleAt": row.stale_at,
        "metadata": parse_json_or_empty(&row.metadata),
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
        "refs": refs
    })
}

fn episode_search_text(row: &EpisodeRow, refs: &[EpisodeRef]) -> String {
    [
        row.title.as_str(),
        row.situation.as_str(),
        row.observations.as_str(),
        row.action.as_str(),
        row.outcome.as_str(),
        row.lesson.as_str(),
        row.domains.as_str(),
        row.technologies.as_str(),
        row.change_types.as_str(),
        row.tools.as_str(),
        &refs
            .iter()
            .map(|reference| {
                format!(
                    "{} {} {}",
                    reference.ref_kind,
                    reference.ref_value,
                    reference.query_hint.clone().unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join(" "),
    ]
    .join("\n")
}
