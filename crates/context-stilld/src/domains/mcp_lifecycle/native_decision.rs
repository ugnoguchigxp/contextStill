use rusqlite::Connection;
use serde_json::{json, Value};

use super::native_common::{
    content_json, now_iso, open_database, pseudo_uuid, request_session_id, score_text, single_line,
    string_arg, table_exists, tool_error,
};
use super::native_tools::NativeToolContext;

pub(crate) fn context_decision(params: &Value, context: &NativeToolContext) -> Value {
    let Some(args) = params.get("arguments").and_then(Value::as_object) else {
        return tool_error("context_decision arguments must be an object");
    };
    let decision_point = match string_arg(args, "decisionPoint") {
        Some(value) => value,
        None => return tool_error("decisionPoint is required"),
    };
    let session_id = request_session_id(params, args);
    let retrieval_hints = args
        .get("retrievalHints")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let metadata = args.get("metadata").cloned().unwrap_or_else(|| json!({}));
    let connection = match open_database(context) {
        Ok(connection) => connection,
        Err(error) => return tool_error(&error),
    };
    if !table_exists(&connection, "context_decision_runs") {
        return tool_error("context_decision_runs table is not available");
    }

    let query = decision_query(&decision_point, &retrieval_hints);
    let knowledge = search_decision_knowledge(&connection, &query, 8);
    let support = knowledge
        .iter()
        .filter(|item| item.polarity != "negative")
        .take(4)
        .cloned()
        .collect::<Vec<_>>();
    let counter = knowledge
        .iter()
        .filter(|item| item.polarity == "negative")
        .take(4)
        .cloned()
        .collect::<Vec<_>>();
    let hard_stop = has_hard_stop_language(&decision_point)
        || counter
            .iter()
            .any(|item| has_hard_stop_language(&format!("{}\n{}", item.title, item.body)));
    let no_knowledge_table = !table_exists(&connection, "knowledge_items");
    let (decision, selected_action, rejected_actions, confidence, status) = if hard_stop {
        (
            "reject",
            "stop and ask for a safer path",
            vec!["execute".to_string()],
            82,
            "completed",
        )
    } else if support.is_empty() || no_knowledge_table {
        (
            "revise_and_execute",
            "continue with narrow scope and explicit verification",
            Vec::new(),
            58,
            "degraded",
        )
    } else if counter.is_empty() {
        ("execute", "continue", Vec::new(), 76, "completed")
    } else {
        (
            "revise_and_execute",
            "continue while avoiding the risky sub-action",
            Vec::new(),
            68,
            "completed",
        )
    };
    let mandate = mandate(decision);
    let agent_message = agent_message(
        decision,
        support.len(),
        counter.len(),
        no_knowledge_table,
        &decision_point,
    );
    let run_id = pseudo_uuid();
    if let Err(error) = insert_decision_run(
        &connection,
        &run_id,
        session_id.as_deref(),
        &decision_point,
        &retrieval_hints,
        decision,
        selected_action,
        &rejected_actions,
        mandate,
        &agent_message,
        confidence,
        status,
        &metadata,
    ) {
        return tool_error(&error);
    }
    if let Err(error) = insert_evidence(&connection, &run_id, &support, &counter) {
        return tool_error(&error);
    }
    let _ = insert_coverage_trace(
        &connection,
        &run_id,
        &query,
        knowledge.len(),
        &support,
        &counter,
        if no_knowledge_table {
            "knowledge_items_missing"
        } else {
            "rust_native_text_search"
        },
    );
    content_json(json!({
        "decisionId": run_id,
        "decision": decision,
        "selectedAction": selected_action,
        "rejectedActions": rejected_actions,
        "mandate": mandate,
        "confidence": confidence,
        "agentMessage": agent_message,
        "feedbackHandle": {
            "decisionId": run_id,
            "tool": "context_decision_feedback"
        },
        "coverageSummary": {
            "queryCount": 1,
            "supportHits": support.len(),
            "counterEvidenceHits": counter.len(),
            "degraded": status == "degraded"
        }
    }))
}

#[derive(Clone, Debug)]
struct DecisionKnowledge {
    id: String,
    title: String,
    body: String,
    polarity: String,
    score: i64,
}

fn decision_query(decision_point: &str, retrieval_hints: &Value) -> String {
    let mut parts = vec![decision_point.to_string()];
    for key in ["technologies", "changeTypes", "domains"] {
        if let Some(values) = retrieval_hints.get(key).and_then(Value::as_array) {
            parts.extend(
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string),
            );
        }
    }
    parts.join(" ")
}

fn search_decision_knowledge(
    connection: &Connection,
    query: &str,
    limit: usize,
) -> Vec<DecisionKnowledge> {
    if !table_exists(connection, "knowledge_items") {
        return Vec::new();
    }
    let mut statement = match connection.prepare(
        r#"
        select id, title, body, polarity, coalesce(dynamic_score, 0)
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
            row.get::<_, f64>(4)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    let mut items = rows
        .flatten()
        .filter_map(|(id, title, body, polarity, dynamic_score)| {
            let score =
                score_text(&format!("{title}\n{body}"), query) + dynamic_score.round() as i64;
            (score > 0).then_some(DecisionKnowledge {
                id,
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

fn has_hard_stop_language(value: &str) -> bool {
    let lower = value.to_lowercase();
    [
        "reset --hard",
        "drop database",
        "delete production",
        "irreversible",
        "directly forbidden",
        "must stop",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn mandate(decision: &str) -> &'static str {
    match decision {
        "execute" => "Proceed autonomously and verify the result.",
        "reject" => "Do not execute the proposed action until a safer path is provided.",
        "revise_and_execute" => {
            "Proceed only after narrowing scope, preserving rollback, and verifying the changed behavior."
        }
        _ => "Escalate before proceeding.",
    }
}

fn agent_message(
    decision: &str,
    support_hits: usize,
    counter_hits: usize,
    degraded: bool,
    decision_point: &str,
) -> String {
    let degraded_text = if degraded {
        " Knowledge table coverage was unavailable or weak."
    } else {
        ""
    };
    format!(
        "判断は {decision} です。対象: {}。support hitsは{}件、counter evidence hitsは{}件です。{}",
        single_line(decision_point, 180),
        support_hits,
        counter_hits,
        degraded_text
    )
}

#[allow(clippy::too_many_arguments)]
fn insert_decision_run(
    connection: &Connection,
    run_id: &str,
    session_id: Option<&str>,
    decision_point: &str,
    retrieval_hints: &Value,
    decision: &str,
    selected_action: &str,
    rejected_actions: &[String],
    mandate: &str,
    agent_message: &str,
    confidence: i64,
    status: &str,
    metadata: &Value,
) -> Result<(), String> {
    let now = now_iso();
    connection
        .execute(
            r#"
            insert into context_decision_runs (
              id, session_id, decision_point, options, retrieval_hints, decision,
              selected_action, rejected_actions, mandate, agent_message, confidence,
              confidence_trace, autonomy_level, risk_budget, knowledge_policy, guardrails,
              unsupported_alternatives, status, metadata, created_at, updated_at
            ) values (
              ?1, ?2, ?3, '[]', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
              'high', 'medium', 'optional', ?12, '[]', ?13, ?14, ?15, ?15
            )
            "#,
            (
                run_id,
                session_id,
                decision_point,
                retrieval_hints.to_string(),
                decision,
                selected_action,
                json!(rejected_actions).to_string(),
                mandate,
                agent_message,
                confidence,
                json!({"engine":"rust-native","confidence":confidence}).to_string(),
                json!({"verify": true, "avoidUserPromptByDefault": true}).to_string(),
                status,
                metadata.to_string(),
                now,
            ),
        )
        .map_err(|error| format!("failed to insert context_decision run: {error}"))?;
    Ok(())
}

fn insert_evidence(
    connection: &Connection,
    run_id: &str,
    support: &[DecisionKnowledge],
    counter: &[DecisionKnowledge],
) -> Result<(), String> {
    for item in support {
        insert_evidence_row(connection, run_id, item, "selected_support")?;
    }
    for item in counter {
        insert_evidence_row(connection, run_id, item, "counter_evidence")?;
    }
    Ok(())
}

fn insert_evidence_row(
    connection: &Connection,
    run_id: &str,
    item: &DecisionKnowledge,
    role: &str,
) -> Result<(), String> {
    connection
        .execute(
            r#"
            insert into context_decision_evidence (
              id, decision_run_id, knowledge_id, role, weight_at_decision,
              dynamic_score_at_decision, applicability_score, temporal_relevance,
              summary, source_refs, metadata, created_at
            ) values (?1, ?2, ?3, ?4, ?5, ?5, ?5, 100, ?6, '[]', ?7, ?8)
            "#,
            (
                pseudo_uuid(),
                run_id,
                &item.id,
                role,
                item.score,
                format!("{}: {}", item.title, single_line(&item.body, 240)),
                json!({"engine":"rust-native","polarity":item.polarity}).to_string(),
                now_iso(),
            ),
        )
        .map_err(|error| format!("failed to insert context_decision evidence: {error}"))?;
    Ok(())
}

fn insert_coverage_trace(
    connection: &Connection,
    run_id: &str,
    query: &str,
    hit_count: usize,
    support: &[DecisionKnowledge],
    counter: &[DecisionKnowledge],
    reason: &str,
) -> Result<(), String> {
    connection
        .execute(
            r#"
            insert into context_decision_coverage_traces (
              id, decision_run_id, query, query_role, scope, hit_count, max_similarity,
              selected_knowledge_ids, rejected_knowledge_ids, reason, created_at
            ) values (?1, ?2, ?3, 'support', '{}', ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            (
                pseudo_uuid(),
                run_id,
                query,
                i64::try_from(hit_count).unwrap_or(i64::MAX),
                support
                    .first()
                    .map(|item| item.score)
                    .or_else(|| counter.first().map(|item| item.score)),
                json!(support.iter().map(|item| &item.id).collect::<Vec<_>>()).to_string(),
                json!(counter.iter().map(|item| &item.id).collect::<Vec<_>>()).to_string(),
                reason,
                now_iso(),
            ),
        )
        .map_err(|error| format!("failed to insert context_decision coverage: {error}"))?;
    Ok(())
}
