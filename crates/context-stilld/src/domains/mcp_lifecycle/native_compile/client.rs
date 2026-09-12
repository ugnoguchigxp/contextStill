//! Authenticated internal DTO; public MCP arguments remain unchanged.
use super::*;
use serde::Deserialize;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CompileOptions {
    pub(super) source: String,
    pub(super) session_id: Option<String>,
    pub(super) retrieval_mode: String,
    pub(super) intent: Option<String>,
    pub(super) token_budget: Option<usize>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    contract_version: u8,
    database_fingerprint: String,
    input: Value,
    options: CompileOptions,
}
pub(crate) fn compile(payload: Value, context: &NativeToolContext) -> Value {
    let request: Request = match serde_json::from_value(payload) {
        Ok(request) => request,
        Err(_) => return json!({"ok":false,"error":"compile_request_invalid"}),
    };
    if request.contract_version != 1 {
        return json!({"ok":false,"error":"compile_contract_mismatch"});
    }
    if request.database_fingerprint != context.compile_runtime.database_identity_fingerprint {
        return json!({"ok":false,"error":"compile_database_mismatch"});
    }
    if context.compile_runtime.mode == CompileFoundationMode::Legacy {
        return json!({"ok":false,"error":"compile_requires_split_runtime"});
    }
    let options = request.options;
    if !["cli", "ui", "mcp", "unknown"].contains(&options.source.as_str())
        || ![
            "task_context",
            "review_context",
            "debug_context",
            "architecture_context",
            "procedure_context",
            "learning_context",
            "sqlite_text",
        ]
        .contains(&options.retrieval_mode.as_str())
        || options
            .token_budget
            .is_some_and(|v| !(128..=8192).contains(&v))
        || options.session_id.as_ref().is_some_and(|v| v.len() > 1024)
        || options.intent.as_ref().is_some_and(|v| v.len() > 4096)
    {
        return json!({"ok":false,"error":"compile_options_invalid"});
    }
    let params = json!({"arguments":request.input,"_meta":{"sessionId":options.session_id}});
    let result = context_compile_split_internal(
        &params,
        context,
        context.compile_runtime.mode,
        Some(options.clone()),
    );
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        return json!({"ok":false,"error":"compile_engine_failed","details":result});
    }
    let Some(pack) = result.get("structuredContent") else {
        return json!({"ok":false,"error":"compile_snapshot_missing"});
    };
    let markdown = pack["outputMarkdown"].as_str().unwrap_or("No Content");
    let degraded = pack
        .pointer("/diagnostics/degradedReasons")
        .and_then(Value::as_array)
        .is_some_and(|v| !v.is_empty());
    json!({"ok":true,"envelope":{"contractVersion":1,"databaseFingerprint":context.compile_runtime.database_identity_fingerprint,"runId":pack["runId"],"status":if degraded {"degraded"} else {"ok"},"contentStatus":if markdown=="No Content" {"empty"} else if degraded {"partial"} else {"content"},"markdown":markdown,"pack":pack,"retrievalMode":options.retrieval_mode,"tokenBudget":pack["diagnostics"]["effectiveTokenBudget"]}})
}

pub(super) fn apply_budget(prepared: &mut SplitPrepared, composed: &mut ComposeResult) {
    let Some(requested) = prepared
        .client_options
        .as_ref()
        .and_then(|o| o.token_budget)
    else {
        return;
    };
    let budget = prepared
        .settings
        .as_ref()
        .map_or(requested, |s| requested.min(s.max_tokens.max(128) as usize));
    // A byte is a conservative upper bound on a byte-tokenizer token. Keep whole evidence
    // groups; never truncate a prohibition, condition, or source reference to fit a limit.
    if composed.markdown.len() <= budget {
        return;
    }
    // Budget fallback must not reintroduce candidates rejected by the composer.
    prepared.knowledge.retain(|item| {
        composed
            .used_knowledge
            .iter()
            .any(|used| used.id == item.id)
    });
    prepared
        .episodes
        .retain(|item| composed.used_episodes.iter().any(|used| used.id == item.id));
    let rendered = evidence::render(&prepared.knowledge, &prepared.episodes, budget);
    prepared.knowledge.retain(|item| {
        rendered
            .included_ids
            .contains(&("knowledge", item.id.clone()))
    });
    prepared.episodes.retain(|item| {
        rendered
            .included_ids
            .contains(&("episode", item.id.clone()))
    });
    composed.used_knowledge.retain(|item| {
        rendered
            .included_ids
            .contains(&("knowledge", item.id.clone()))
    });
    composed.used_episodes.retain(|item| {
        rendered
            .included_ids
            .contains(&("episode", item.id.clone()))
    });
    composed.markdown = rendered.markdown;
    composed.partial_reasons.extend(rendered.partial_reasons);
    composed
        .partial_reasons
        .push("client_output_budget_applied".into());
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{create_minimal_compile_schema, temp_db_path};
    use super::*;
    fn context() -> NativeToolContext {
        let path = temp_db_path();
        let db = Connection::open(&path).unwrap();
        create_minimal_compile_schema(&db);
        let mut context = NativeToolContext::for_test(std::env::temp_dir(), path);
        context.compile_runtime = std::sync::Arc::new(
            crate::domains::context_compile::runtime::CompileRuntimeContext {
                mode: CompileFoundationMode::SplitLegacyRank,
                ..(*context.compile_runtime).clone()
            },
        );
        context
    }
    fn request(context: &NativeToolContext) -> Value {
        json!({"contractVersion":1,"databaseFingerprint":context.compile_runtime.database_identity_fingerprint,"input":{"goal":"sqlite workflow"},"options":{"source":"cli","sessionId":"client-session","retrievalMode":"architecture_context","intent":"legacy diagnostic"}})
    }
    #[test]
    fn client_empty_run_is_persisted_once_with_metadata_and_public_mcp_shape_is_unchanged() {
        let context = context();
        let result = compile(request(&context), &context);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(result["envelope"]["contentStatus"], "empty");
        let fixture: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../shared/context-compile/client-envelope.v1.json"
        )))
        .unwrap();
        assert_eq!(
            result["envelope"]
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            fixture.as_object().unwrap().keys().collect::<Vec<_>>()
        );
        let db = Connection::open(&context.sqlite_core_path).unwrap();
        let row: (i64, String, String, String) = db
            .query_row(
                "SELECT count(*),source,session_id,retrieval_mode FROM context_compile_runs",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            row,
            (
                1,
                "cli".into(),
                "client-session".into(),
                "architecture_context".into()
            )
        );
        let public = context_compile(&json!({"arguments":{"goal":"sqlite workflow"}}), &context);
        assert!(public.get("structuredContent").is_none());
        assert_eq!(public["content"][0]["text"], "No Content");
    }
    #[test]
    fn client_rejects_wrong_binding_version_and_budget_before_persistence() {
        let context = context();
        for (field, value) in [
            ("databaseFingerprint", json!("wrong")),
            ("contractVersion", json!(99)),
        ] {
            let mut req = request(&context);
            req[field] = value;
            assert_eq!(compile(req, &context)["ok"], false);
        }
        let mut req = request(&context);
        req["options"]["tokenBudget"] = json!(127);
        assert_eq!(compile(req, &context)["error"], "compile_options_invalid");
        let db = Connection::open(&context.sqlite_core_path).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM context_compile_runs", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn client_budget_omits_whole_protected_evidence_and_records_partial_outcome() {
        let context = context();
        let db = Connection::open(&context.sqlite_core_path).unwrap();
        db.execute("INSERT INTO knowledge_items(id,type,status,scope,classification_status,polarity,title,body,applies_to) VALUES('protected','rule','active','global','classified','negative','sqlite workflow',?1,'{}')",["Do not omit the sqlite workflow restriction. ".repeat(100)]).unwrap();
        let mut req = request(&context);
        req["options"]["tokenBudget"] = json!(128);
        let result = compile(req, &context);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(result["envelope"]["status"], "degraded");
        assert!(result["envelope"]["markdown"].as_str().unwrap().len() <= 128);
        assert!(result["envelope"]["pack"]["rules"]
            .as_array()
            .unwrap()
            .is_empty());
    }
    #[test]
    fn client_budget_does_not_reintroduce_composer_rejected_candidates() {
        let context = context();
        let db = Connection::open(&context.sqlite_core_path).unwrap();
        for (id, body) in [
            ("chosen", "Selected sqlite workflow evidence."),
            ("rejected", "Rejected sqlite workflow evidence."),
        ] {
            db.execute("INSERT INTO knowledge_items(id,type,status,scope,classification_status,title,body,applies_to) VALUES(?1,'rule','active','global','classified','sqlite workflow',?2,'{}')", [id, body]).unwrap();
        }
        let mut prepared =
            prepare_split_compile(&json!({"arguments":{"goal":"sqlite workflow"}}), &context)
                .unwrap();
        assert_eq!(prepared.knowledge.len(), 2);
        prepared.client_options = Some(CompileOptions {
            source: "cli".into(),
            session_id: None,
            retrieval_mode: "task_context".into(),
            intent: None,
            token_budget: Some(2048),
        });
        let mut composed = compose_context_response_with_settings(
            None,
            "sqlite workflow",
            &prepared.knowledge,
            &prepared.episodes,
        );
        composed.used_knowledge.retain(|item| item.id == "chosen");
        composed.markdown = "oversized composer output ".repeat(100);
        apply_budget(&mut prepared, &mut composed);
        assert!(composed
            .markdown
            .contains("Selected sqlite workflow evidence."));
        assert!(!composed.markdown.contains("Rejected"));
        assert_eq!(prepared.knowledge.len(), 1);
        assert_eq!(composed.used_knowledge.len(), 1);
        assert!(composed.markdown.len() <= 2048);
    }
}
