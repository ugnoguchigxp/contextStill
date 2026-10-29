use super::*;
use crate::domains::queue_lifecycle::{
    episode_executor::{quality, types},
    structured_output,
};

#[test]
fn personal_episode_keeps_unknown_outcomes_and_rejects_fabricated_time_precision() {
    let mut c = test_canonical_episode();
    c.generation_kind = "personal_episode".into();
    c.action_taken.clear();
    c.outcome.clear();
    c.reusable_lesson.clear();
    c.event_start = Some("2024".into());
    c.event_end = Some("2024".into());
    c.time_precision = Some("year".into());
    let json = serde_json::to_string(&vec![quality::canonical_json(&c)]).unwrap();
    assert_eq!(parse_canonical_array(&json).unwrap().len(), 1);
    c.event_start = Some("2024-99".into());
    c.time_precision = Some("month".into());
    assert!(parse_canonical_array(
        &serde_json::to_string(&vec![quality::canonical_json(&c)]).unwrap()
    )
    .is_err());
    let schema = structured_output::format("episode");
    assert!(schema
        .pointer("/json_schema/schema/items/properties/generationKind/enum")
        .unwrap()
        .as_array()
        .unwrap()
        .contains(&json!("personal_episode")));
    assert!(schema
        .pointer("/json_schema/schema/items/properties/eventStart")
        .is_some());
}

#[test]
fn synced_personal_episode_uses_normal_persistence_search_fetch_and_forget_fences() {
    use crate::domains::agent_log_sync::saaa;
    use crate::domains::mcp_lifecycle::{native_episodes, native_tools::NativeToolContext};
    let dir = saaa::tests::isolated_dir();
    let raw_path = dir.join("saaa.sqlite");
    saaa::tests::fixture(&raw_path);
    let target_path = dir.join("core.sqlite");
    crate::domains::vector_index::service::register_sqlite_vec();
    let mut c = Connection::open(&target_path).unwrap();
    crate::domains::sqlite_writer::schema::migrate(&mut c, 4).unwrap();
    let env = crate::shared::config::MapEnv::from_pairs(vec![(
        "SAAA_MEMORY_SQLITE_PATH",
        raw_path.to_str().unwrap(),
    )]);
    saaa::sync(&env, &target_path).unwrap();
    let memory: String = c
        .query_row("SELECT id FROM vibe_memories LIMIT 1", [], |r| r.get(0))
        .unwrap();
    let document = read_source_document(&c, &memory).unwrap();
    let write_identity = resolve_episode_write_identity(&document.metadata).unwrap();
    assert_eq!(write_identity.scope, "personal");
    let mut canonical = test_canonical_episode();
    canonical.generation_kind = "personal_episode".into();
    canonical.evidence_quotes = vec![types::EvidenceQuote {
        source_id: "origin".into(),
        quote: "2024年に京都へ行った。".into(),
    }];
    canonical.title = "京都旅行".into();
    canonical.context = "2024年に京都へ行った。雨で散歩は中止した。".into();
    canonical.action_taken.clear();
    canonical.outcome.clear();
    canonical.reusable_lesson.clear();
    canonical.event_start = Some("2024".into());
    canonical.event_end = Some("2024".into());
    canonical.time_precision = Some("year".into());
    let pending = PendingEpisode {
        canonical,
        source_key: episode_source_fragment_key(
            &memory,
            0,
            document.content.len(),
            "personal_episode",
        ),
        source_start_offset: 0,
        source_end_offset: document.content.len(),
        event_start: None,
        event_end: None,
    };
    let target = LocalLlmTargetConfig {
        codex: false,
        quota_db: None,
        target_id: "fixture".into(),
        api_base_url: "http://127.0.0.1:1".into(),
        api_path: "/v1/chat/completions".into(),
        model: "fixture".into(),
    };
    let id = match create_episode_idempotently(
        &c,
        &pending,
        &document,
        &write_identity,
        &target,
        None,
        30,
    )
    .unwrap()
    {
        EpisodePersistOutcome::Created(id) => id,
        _ => panic!("new Episode expected"),
    };
    let raw = Connection::open(&raw_path).unwrap();
    let scope: String = raw
        .query_row(
            "SELECT scope_key FROM memory_episode_grants LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let context = NativeToolContext::for_test(dir.clone(), target_path.clone());
    let unwrap = |result: Value| -> Value {
        serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap()
    };
    let found = unwrap(native_episodes::search_episodes(
        &json!({"arguments":{"query":"京都","personalScopes":[scope.clone()]}}),
        &context,
    ));
    assert_eq!(found["items"].as_array().unwrap().len(), 1);
    assert!(found["items"][0]["sourceContract"].is_object());
    let detail = unwrap(native_episodes::fetch_episode(
        &json!({"arguments":{"id":id,"sourceKey":pending.source_key,"personalScopes":[scope]}}),
        &context,
    ));
    assert!(detail["sourceContract"].is_object());
    assert_eq!(detail["lesson"], "");
    let hidden = unwrap(native_episodes::search_episodes(
        &json!({"arguments":{"query":"京都"}}),
        &context,
    ));
    assert!(hidden["items"].as_array().unwrap().is_empty());
    raw.execute(
        "UPDATE memory_episode_grants SET enabled=0,revision=revision+1",
        [],
    )
    .unwrap();
    assert!(create_episode_idempotently(
        &c,
        &pending,
        &document,
        &write_identity,
        &target,
        None,
        30
    )
    .is_err());
    let hidden = unwrap(native_episodes::search_episodes(
        &json!({"arguments":{"query":"京都","personalScopes":["user:test"]}}),
        &context,
    ));
    assert!(hidden["items"].as_array().unwrap().is_empty());
    saaa::sync(&env, &target_path).unwrap();
    assert_eq!(
        c.query_row("SELECT count(*) FROM episode_cards", [], |r| r
            .get::<_, u32>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM episode_cards_fts", [], |r| r
            .get::<_, u32>(0))
            .unwrap(),
        0
    );
}
