use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::Instant;

use rusqlite::Connection;
use serde_json::{json, Value};

use super::native_common::{
    now_iso, open_database, pseudo_uuid, request_session_id, score_text, single_line, string_arg,
    string_array_arg, table_exists, tool_error, truncate_chars,
};
use super::native_tools::NativeToolContext;

pub(crate) fn context_compile(params: &Value, context: &NativeToolContext) -> Value {
    let started = Instant::now();
    let Some(args) = params.get("arguments").and_then(Value::as_object) else {
        return tool_error("context_compile arguments must be an object");
    };
    let goal = match string_arg(args, "goal") {
        Some(goal) => goal,
        None => return tool_error("goal is required"),
    };
    let session_id = request_session_id(params, args);
    let technologies = string_array_arg(args, "technologies");
    let change_types = string_array_arg(args, "changeTypes");
    let domains = string_array_arg(args, "domains");
    let connection = match open_database(context) {
        Ok(connection) => connection,
        Err(error) => return tool_error(&error),
    };
    if !table_exists(&connection, "context_compile_runs") {
        return tool_error("context_compile_runs table is not available");
    }

    let search_text = search_text(&goal, &technologies, &change_types, &domains);
    let knowledge = search_knowledge_items(&connection, &search_text, 8);
    let episodes = search_episode_cards(&connection, &search_text, 3);
    let run_id = pseudo_uuid();
    let degraded_reasons = degraded_reasons(&connection);
    let status = if degraded_reasons.is_empty() {
        "ok"
    } else {
        "degraded"
    };
    let markdown = render_markdown(&run_id, &goal, &knowledge, &episodes);
    let pack = json!({
        "runId": run_id,
        "goal": goal,
        "rules": knowledge.iter().filter(|item| item.kind == "rule").map(PackKnowledge::to_json).collect::<Vec<_>>(),
        "procedures": knowledge.iter().filter(|item| item.kind == "procedure").map(PackKnowledge::to_json).collect::<Vec<_>>(),
        "episodes": episodes.iter().map(PackEpisode::to_json).collect::<Vec<_>>(),
        "diagnostics": {
            "engine": "rust-native",
            "degradedReasons": degraded_reasons,
            "selectedKnowledge": knowledge.len(),
            "selectedEpisodes": episodes.len()
        },
        "outputMarkdown": markdown
    });
    let input = json!({
        "goal": goal,
        "technologies": technologies,
        "changeTypes": change_types,
        "domains": domains
    });
    let repo_path = context.project_root.to_string_lossy();
    if let Err(error) = insert_compile_run(CompileRunInsert {
        connection: &connection,
        run_id: &run_id,
        goal: &goal,
        session_id: session_id.as_deref(),
        repo_path: repo_path.as_ref(),
        input: &input,
        status,
        pack: &pack,
        duration_ms: started.elapsed().as_millis(),
    }) {
        return tool_error(&error);
    }
    if let Err(error) = insert_compile_items(&connection, &run_id, &knowledge, &episodes) {
        return tool_error(&error);
    }
    if markdown == "No Content" {
        return json!({"content":[{"type":"text","text":"No Content"}]});
    }
    json!({"content":[{"type":"text","text":markdown}]})
}

#[derive(Debug)]
struct PackKnowledge {
    id: String,
    kind: String,
    title: String,
    body: String,
    polarity: String,
    score: i64,
    source_refs: Vec<String>,
}

impl PackKnowledge {
    fn to_json(&self) -> Value {
        json!({
            "kind": "knowledge",
            "id": self.id,
            "type": self.kind,
            "title": self.title,
            "body": self.body,
            "polarity": self.polarity,
            "score": self.score,
            "sourceRefs": self.source_refs
        })
    }
}

#[derive(Debug)]
struct PackEpisode {
    id: String,
    title: String,
    situation: String,
    lesson: String,
    score: i64,
}

impl PackEpisode {
    fn to_json(&self) -> Value {
        json!({
            "kind": "episode",
            "id": self.id,
            "title": self.title,
            "situation": self.situation,
            "lesson": self.lesson,
            "score": self.score
        })
    }
}

fn search_text(
    goal: &str,
    technologies: &[String],
    change_types: &[String],
    domains: &[String],
) -> String {
    [&[goal.to_string()][..], technologies, change_types, domains]
        .concat()
        .join(" ")
}

fn search_knowledge_items(
    connection: &Connection,
    query: &str,
    limit: usize,
) -> Vec<PackKnowledge> {
    if !table_exists(connection, "knowledge_items") {
        return Vec::new();
    }
    let mut statement = match connection.prepare(
        r#"
        select id, type, polarity, title, body, coalesce(dynamic_score, 0), intent_tags, applies_to
        from knowledge_items
        where status = 'active'
        order by importance desc, updated_at desc
        limit 500
        "#,
    ) {
        Ok(statement) => statement,
        Err(_) => return Vec::new(),
    };
    let rows = match statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, f64>(5)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    let mut items = rows
        .flatten()
        .filter_map(|(id, kind, polarity, title, body, dynamic_score)| {
            let score =
                score_text(&format!("{title}\n{body}"), query) + dynamic_score.round() as i64;
            (score > 0).then(|| PackKnowledge {
                source_refs: knowledge_source_refs(connection, &id),
                id,
                kind,
                title,
                body,
                polarity,
                score,
            })
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| right.score.cmp(&left.score));
    items.truncate(limit);
    items
}

fn search_episode_cards(connection: &Connection, query: &str, limit: usize) -> Vec<PackEpisode> {
    if !table_exists(connection, "episode_cards") {
        return Vec::new();
    }
    let mut statement = match connection.prepare(
        r#"
        select id, title, situation, lesson, importance
        from episode_cards
        where status = 'active'
        order by importance desc, updated_at desc
        limit 200
        "#,
    ) {
        Ok(statement) => statement,
        Err(_) => return Vec::new(),
    };
    let rows = match statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    let mut items = rows
        .flatten()
        .filter_map(|(id, title, situation, lesson, importance)| {
            let score =
                score_text(&format!("{title}\n{situation}\n{lesson}"), query) + importance / 10;
            (score > 0).then_some(PackEpisode {
                id,
                title,
                situation,
                lesson,
                score,
            })
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| right.score.cmp(&left.score));
    items.truncate(limit);
    items
}

fn render_markdown(
    run_id: &str,
    goal: &str,
    knowledge: &[PackKnowledge],
    episodes: &[PackEpisode],
) -> String {
    if knowledge.is_empty() && episodes.is_empty() {
        return "No Content".to_string();
    }
    let mut lines = vec![
        "# Context Pack".to_string(),
        format!("- runId: `{run_id}`"),
        format!("- goal: {}", truncate_chars(goal, 220)),
    ];
    if !knowledge.is_empty() {
        lines.push("\n## Knowledge".to_string());
        for item in knowledge {
            lines.push(format!(
                "- [{}] {} ({}, score {})",
                item.id,
                single_line(&item.title, 120),
                item.polarity,
                item.score
            ));
            lines.push(format!("  {}", single_line(&item.body, 320)));
        }
    }
    if !episodes.is_empty() {
        lines.push("\n## Episodes".to_string());
        for item in episodes {
            lines.push(format!(
                "- [{}] {} (score {})",
                item.id,
                single_line(&item.title, 120),
                item.score
            ));
            let detail = if item.lesson.trim().is_empty() {
                &item.situation
            } else {
                &item.lesson
            };
            lines.push(format!("  {}", single_line(detail, 260)));
        }
    }
    lines.push("\n## Verification".to_string());
    lines.push(
        "- Treat this as Rust-native MCP context; no TypeScript sidecar was spawned.".to_string(),
    );
    lines.join("\n")
}

struct CompileRunInsert<'a> {
    connection: &'a Connection,
    run_id: &'a str,
    goal: &'a str,
    session_id: Option<&'a str>,
    repo_path: &'a str,
    input: &'a Value,
    status: &'a str,
    pack: &'a Value,
    duration_ms: u128,
}

fn insert_compile_run(params: CompileRunInsert<'_>) -> Result<(), String> {
    let now = now_iso();
    params
        .connection
        .execute(
            r#"
            insert into context_compile_runs (
              id, goal, intent, session_id, repo_path, input, retrieval_mode, status,
              degraded_reasons, token_budget, duration_ms, source, pack_snapshot, created_at
            ) values (?1, ?2, 'mcp_context_compile', ?3, ?4, ?5, 'sqlite_text', ?6, '[]', 0, ?7, 'mcp-rust', ?8, ?9)
            "#,
            (
                params.run_id,
                params.goal,
                params.session_id,
                params.repo_path,
                params.input.to_string(),
                params.status,
                i64::try_from(params.duration_ms).unwrap_or(i64::MAX),
                params.pack.to_string(),
                now,
            ),
        )
        .map_err(|error| format!("failed to insert context_compile run: {error}"))?;
    let _ = params.connection.execute(
        r#"
        insert or replace into context_compile_task_traces (
          run_id, retrieval_mode, repo_path, technologies, change_types, domains, goal_hash
        ) values (?1, 'sqlite_text', ?2, ?3, ?4, ?5, ?6)
        "#,
        (
            params.run_id,
            params.repo_path,
            json_array_string(params.input, "technologies"),
            json_array_string(params.input, "changeTypes"),
            json_array_string(params.input, "domains"),
            goal_hash(params.goal),
        ),
    );
    Ok(())
}

fn insert_compile_items(
    connection: &Connection,
    run_id: &str,
    knowledge: &[PackKnowledge],
    episodes: &[PackEpisode],
) -> Result<(), String> {
    for item in knowledge {
        connection
            .execute(
                r#"
                insert into context_pack_items (
                  run_id, item_kind, item_id, section, score, ranking_reason, source_refs
                ) values (?1, 'knowledge', ?2, ?3, ?4, 'rust_native_text_score', ?5)
                "#,
                (
                    run_id,
                    &item.id,
                    if item.kind == "procedure" {
                        "procedures"
                    } else {
                        "rules"
                    },
                    item.score as f64,
                    json!(item.source_refs).to_string(),
                ),
            )
            .map_err(|error| format!("failed to insert context pack item: {error}"))?;
    }
    for item in episodes {
        connection
            .execute(
                r#"
                insert into context_pack_items (
                  run_id, item_kind, item_id, section, score, ranking_reason, source_refs
                ) values (?1, 'episode', ?2, 'episodes', ?3, 'rust_native_text_score', '[]')
                "#,
                (run_id, &item.id, item.score as f64),
            )
            .map_err(|error| format!("failed to insert episode pack item: {error}"))?;
    }
    Ok(())
}

fn knowledge_source_refs(connection: &Connection, knowledge_id: &str) -> Vec<String> {
    let mut statement = match connection.prepare(
        r#"
        select s.uri, sf.locator
        from knowledge_source_links ksl
        join source_fragments sf on sf.id = ksl.source_fragment_id
        join sources s on s.id = sf.source_id
        where ksl.knowledge_id = ?1
        order by ksl.confidence desc, ksl.created_at desc
        limit 5
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

fn degraded_reasons(connection: &Connection) -> Vec<String> {
    let mut reasons = Vec::new();
    if !table_exists(connection, "knowledge_items") {
        reasons.push("knowledge_items_missing".to_string());
    }
    if !table_exists(connection, "episode_cards") {
        reasons.push("episode_cards_missing".to_string());
    }
    reasons
}

fn json_array_string(input: &Value, key: &str) -> String {
    input
        .get(key)
        .and_then(Value::as_array)
        .map(|values| json!(values).to_string())
        .unwrap_or_else(|| "[]".to_string())
}

fn goal_hash(goal: &str) -> String {
    let mut hasher = DefaultHasher::new();
    goal.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}
