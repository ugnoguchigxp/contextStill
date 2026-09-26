use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

fn setup() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch(r#"
            create table finalize_distille_queue (
              id text primary key, evidence_result_id text, status text not null, priority integer not null default 0, attempt_count integer not null default 0,
              max_attempts integer not null default 5, next_run_at text,
              metadata text not null default '{}',
              knowledge_id text, completed_at text, locked_by text, locked_at text, heartbeat_at text,
              last_error text, last_outcome_kind text, created_at text not null default CURRENT_TIMESTAMP, updated_at text not null default CURRENT_TIMESTAMP
            );
            create table evidence_coverage_results (
              id text primary key, found_candidate_id text not null, status text not null, stage text not null,
              type text, title text, body text, importance real, confidence real, applies_to text not null,
              "references" text not null, duplicate_refs text not null, tool_events text not null, reason text,
              updated_at text not null default CURRENT_TIMESTAMP
            );
            create table found_candidates (id text primary key, finding_job_id text not null, metadata text not null default '{}', updated_at text not null default CURRENT_TIMESTAMP);
            create table finding_candidate_queue (id text primary key, source_kind text not null, source_key text not null, source_uri text not null, metadata text not null default '{}', updated_at text not null default CURRENT_TIMESTAMP);
            create table vibe_memories (id text primary key, metadata text not null default '{}');
            create table landscape_review_item_candidate_links (id text primary key, found_candidate_id text, status text not null, created_at text not null default CURRENT_TIMESTAMP, updated_at text not null default CURRENT_TIMESTAMP);
            create table knowledge_items (
              id text primary key, type text not null, status text not null, scope text not null, classification_status text not null,
              project_ref text, repo_key text, repo_path text, polarity text not null, intent_tags text not null, title text not null,
              body text not null, applies_to text not null, confidence real not null, importance real not null, metadata text not null,
              created_at text not null, updated_at text not null
            );
            create virtual table knowledge_items_fts using fts5(id unindexed, title, body);
            create table knowledge_items_vec_fallback (knowledge_id text primary key, embedding_json text not null, embedding_dimension integer not null, content_hash text not null, updated_at text not null);
            create table knowledge_items_vec_map (vec_rowid integer primary key autoincrement, knowledge_id text not null unique);
            create table sources (id text primary key, uri text not null);
            create table source_fragments (id text primary key, source_id text not null, locator text not null);
            create table knowledge_source_links (id text primary key, knowledge_id text not null, source_fragment_id text not null, link_type text not null, confidence real not null, metadata text not null, created_at text not null);
            create table knowledge_origin_links (id text primary key, knowledge_id text not null, origin_kind text not null, origin_uri text not null, origin_key text not null, confidence real not null, metadata text not null, created_at text not null, unique(knowledge_id, origin_kind, origin_uri));
            create table audit_logs (id text primary key, event_type text not null, actor text not null, payload text not null, created_at text not null);
            create table distillation_queue_events (id text primary key, queue_name text not null, queue_job_id text not null, event_type text not null, message text, metadata text not null, created_at text not null default CURRENT_TIMESTAMP);
        "#).unwrap();
    connection.execute_batch(r#"
            insert into finding_candidate_queue (id,source_kind,source_key,source_uri) values ('finding-1','vibe_memory','memory-1','vibe-memory://memory-1');
            insert into found_candidates (id,finding_job_id) values ('candidate-1','finding-1');
            insert into vibe_memories values ('memory-1','{"rustAgentLogSync":true,"projectRoot":"/work/project"}');
            insert into evidence_coverage_results (id,found_candidate_id,status,stage,type,title,body,importance,confidence,applies_to,"references",duplicate_refs,tool_events,reason) values (
              'evidence-1','candidate-1','knowledge_ready','final','rule','Rust Finalize','Use the resident worker after verification.',80,90,
              '{"technologies":["Rust"],"changeTypes":["bugfix"],"domains":["queue"],"repoPath":"/tmp/project"}',
              '[]','[]','[]',null
            );
            insert into finalize_distille_queue (id,evidence_result_id,status,attempt_count,locked_by) values ('finalize-1','evidence-1','running',0,'rust-worker');
        "#).unwrap();
    connection
}

fn serve_embedding() -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0u8; 8192];
        let _ = stream.read(&mut request);
        let body = r#"{"embeddings":[[0.1,0.2,0.3]],"dimension":3}"#;
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
    });
    (format!("http://{address}"), handle)
}

fn embedding_config(daemon_url: String) -> FinalizeEmbeddingConfig {
    FinalizeEmbeddingConfig {
        larm_control_url: None,
        larm_audience: "saaa-desktop".to_string(),
        larm_state_path: None,
        provider: "daemon".to_string(),
        daemon_url,
        access_token: None,
        timeout_seconds: 2,
        expected_dimension: Some(3),
        openai_api_base_url: None,
        openai_api_version: None,
        openai_model: None,
        openai_api_key: None,
    }
}

#[test]
fn rust_finalize_persists_knowledge_embedding_and_completed_state() {
    let connection = setup();
    let (url, server) = serve_embedding();
    let status = run_finalize_distille_job_for_connection(
        &connection,
        "finalize-1",
        "rust-worker",
        &embedding_config(url),
        20.0,
    )
    .unwrap();
    server.join().unwrap();
    assert_eq!(status, FinalizeExecutionStatus::Completed);
    let queue = connection.query_row("select status, attempt_count, last_outcome_kind, knowledge_id is not null from finalize_distille_queue where id = 'finalize-1'", [], |row| Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,String>(2)?,row.get::<_,i64>(3)?))).unwrap();
    assert_eq!(queue, ("completed".to_string(), 1, "stored".to_string(), 1));
    let knowledge: i64 = connection.query_row("select count(*) from knowledge_items where status = 'draft' and classification_status = 'classified' and repo_path = '/tmp/project'", [], |row| row.get(0)).unwrap();
    let vectors: i64 = connection
        .query_row(
            "select count(*) from knowledge_items_vec_fallback where embedding_dimension = 3",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!((knowledge, vectors), (1, 1));
}

#[test]
fn finalize_queue_uses_local_embedding_when_larm_is_unreachable() {
    let connection = setup();
    let (url, server) = serve_embedding();
    let mut config = embedding_config(url);
    config.provider = "auto".to_string();
    config.larm_control_url = Some("http://127.0.0.1:9".to_string());
    let status = run_finalize_distille_job_for_connection(
        &connection,
        "finalize-1",
        "rust-worker",
        &config,
        20.0,
    )
    .unwrap();
    server.join().unwrap();
    assert_eq!(status, FinalizeExecutionStatus::Completed);
    let (queue_status, vector_count): (String, i64) = connection.query_row(
        "select q.status, (select count(*) from knowledge_items_vec_fallback where knowledge_id=q.knowledge_id) from finalize_distille_queue q where q.id='finalize-1'",
        [], |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert_eq!(queue_status, "completed");
    assert_eq!(vector_count, 1);
}

#[test]
fn rust_finalize_persists_identity_free_knowledge_as_global() {
    let connection = setup();
    connection
            .execute(
                "update evidence_coverage_results set applies_to = '{\"technologies\":[\"Rust\"],\"changeTypes\":[\"bugfix\"],\"domains\":[\"queue\"]}' where id = 'evidence-1'",
                [],
            )
            .unwrap();
    connection
        .execute(
            "update vibe_memories set metadata = '{}' where id = 'memory-1'",
            [],
        )
        .unwrap();
    let (url, server) = serve_embedding();

    let status = run_finalize_distille_job_for_connection(
        &connection,
        "finalize-1",
        "rust-worker",
        &embedding_config(url),
        20.0,
    )
    .unwrap();
    server.join().unwrap();

    assert_eq!(status, FinalizeExecutionStatus::Completed);
    let knowledge = connection
            .query_row(
                "select scope, classification_status, project_ref is null, repo_key is null, repo_path is null, json_extract(metadata, '$.scopeDecision') from knowledge_items",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .unwrap();
    assert_eq!(
        knowledge,
        (
            "global".to_string(),
            "classified".to_string(),
            1,
            1,
            1,
            "identity_absent_reusable_knowledge".to_string(),
        )
    );
}

#[test]
fn finalize_identity_backfill_recovers_trusted_legacy_project_root_idempotently() {
    let connection = setup();
    connection
        .execute(
            "update finalize_distille_queue set status = 'pending' where id = 'finalize-1'",
            [],
        )
        .unwrap();
    connection
            .execute(
                "update finding_candidate_queue set metadata = '{\"projectIdentity\":null}' where id = 'finding-1'",
                [],
            )
            .unwrap();
    let first = backfill_finalize_project_identity_for_connection(&connection, 100).unwrap();
    let second = backfill_finalize_project_identity_for_connection(&connection, 100).unwrap();

    assert_eq!(first, 1);
    assert_eq!(second, 0);
    let identity = connection
            .query_row(
                "select json_extract(e.applies_to, '$.repoPath'), json_extract(f.metadata, '$.projectIdentity.repoPath') from evidence_coverage_results e join found_candidates c on c.id=e.found_candidate_id join finding_candidate_queue f on f.id=c.finding_job_id where e.id='evidence-1'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .unwrap();
    assert_eq!(
        identity,
        ("/work/project".to_string(), "/work/project".to_string())
    );
    let audits: i64 = connection
        .query_row(
            "select count(*) from audit_logs where event_type='PROJECT_IDENTITY_BACKFILL_APPLIED'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(audits, 1);
}

#[test]
fn rust_finalize_skips_non_ready_evidence() {
    let connection = setup();
    connection.execute("update evidence_coverage_results set status = 'insufficient', reason = 'missing support' where id = 'evidence-1'", []).unwrap();
    let status = run_finalize_distille_job_for_connection(
        &connection,
        "finalize-1",
        "rust-worker",
        &embedding_config("http://127.0.0.1:1".to_string()),
        20.0,
    )
    .unwrap();
    assert_eq!(status, FinalizeExecutionStatus::Skipped);
    let queue = connection.query_row("select status, last_outcome_kind, last_error from finalize_distille_queue where id = 'finalize-1'", [], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?))).unwrap();
    assert_eq!(
        queue,
        (
            "skipped".to_string(),
            "rejected".to_string(),
            "missing support".to_string()
        )
    );
}

#[test]
fn rust_finalize_keeps_embedding_outage_resumable_after_configured_max_attempts() {
    let connection = setup();
    connection
        .execute(
            "update finalize_distille_queue set max_attempts = 1 where id = 'finalize-1'",
            [],
        )
        .unwrap();
    let status = run_finalize_distille_job_for_connection(
        &connection,
        "finalize-1",
        "rust-worker",
        &embedding_config("http://127.0.0.1:1".to_string()),
        20.0,
    )
    .unwrap();
    assert_eq!(status, FinalizeExecutionStatus::Retrying);
    let queue = connection.query_row("select status, attempt_count, last_outcome_kind, next_run_at is not null from finalize_distille_queue where id = 'finalize-1'", [], |row| Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,String>(2)?,row.get::<_,i64>(3)?))).unwrap();
    let knowledge: i64 = connection
        .query_row("select count(*) from knowledge_items", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        queue,
        (
            "pending".to_string(),
            1,
            "embedding_unavailable_retry".to_string(),
            1
        )
    );
    assert_eq!(knowledge, 0);

    connection
            .execute(
                "update finalize_distille_queue set status='running', locked_by='rust-worker', next_run_at=null where id='finalize-1'",
                [],
            )
            .unwrap();
    let (url, server) = serve_embedding();
    let recovered = run_finalize_distille_job_for_connection(
        &connection,
        "finalize-1",
        "rust-worker",
        &embedding_config(url),
        20.0,
    )
    .unwrap();
    server.join().unwrap();

    assert_eq!(recovered, FinalizeExecutionStatus::Completed);
    let recovered_queue = connection.query_row("select status, attempt_count, last_outcome_kind, knowledge_id is not null from finalize_distille_queue where id = 'finalize-1'", [], |row| Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,String>(2)?,row.get::<_,i64>(3)?))).unwrap();
    assert_eq!(
        recovered_queue,
        ("completed".to_string(), 2, "stored".to_string(), 1)
    );
}

#[test]
fn rust_finalize_retries_transient_embedding_failure_without_partial_knowledge() {
    let connection = setup();
    let status = run_finalize_distille_job_for_connection(
        &connection,
        "finalize-1",
        "rust-worker",
        &embedding_config("http://127.0.0.1:1".to_string()),
        50.0,
    )
    .unwrap();

    assert_eq!(status, FinalizeExecutionStatus::Retrying);
    let queue = connection
            .query_row(
                "select status, attempt_count, last_outcome_kind, next_run_at is not null from finalize_distille_queue where id = 'finalize-1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .unwrap();
    assert_eq!(
        queue,
        (
            "pending".to_string(),
            1,
            "embedding_unavailable_retry".to_string(),
            1,
        )
    );
    let knowledge: i64 = connection
        .query_row("select count(*) from knowledge_items", [], |row| row.get(0))
        .unwrap();
    assert_eq!(knowledge, 0);
}

#[test]
fn rust_finalize_repairs_existing_knowledge_when_embedding_is_missing() {
    let connection = setup();
    connection.execute(
            "insert into knowledge_items (id,type,status,scope,classification_status,repo_path,polarity,intent_tags,title,body,applies_to,confidence,importance,metadata,created_at,updated_at) values ('existing-1','rule','draft','repo','classified','/tmp/project','positive','[]','Rust Finalize','Use the resident worker after verification.','{}',90,80,?1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
            [json!({"sourceUri":"cover-evidence-result://evidence-1"}).to_string()],
        ).unwrap();
    let (url, server) = serve_embedding();

    let status = run_finalize_distille_job_for_connection(
        &connection,
        "finalize-1",
        "rust-worker",
        &embedding_config(url),
        20.0,
    )
    .unwrap();
    server.join().unwrap();

    assert_eq!(status, FinalizeExecutionStatus::Completed);
    let vector_count: i64 = connection
            .query_row(
                "select count(*) from knowledge_items_vec_fallback where knowledge_id='existing-1' and embedding_dimension=3",
                [],
                |row| row.get(0),
            )
            .unwrap();
    let knowledge_id: String = connection
        .query_row(
            "select knowledge_id from finalize_distille_queue where id='finalize-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(vector_count, 1);
    assert_eq!(knowledge_id, "existing-1");
}

#[test]
fn rust_finalize_reuses_current_embedding_and_repairs_fts() {
    let connection = setup();
    connection
            .execute_batch(
                "create table knowledge_items_vec (rowid integer primary key, embedding text not null);",
            )
            .unwrap();
    connection.execute(
            "insert into knowledge_items (id,type,status,scope,classification_status,repo_path,polarity,intent_tags,title,body,applies_to,confidence,importance,metadata,created_at,updated_at) values ('existing-1','rule','draft','repo','classified','/tmp/project','positive','[]','Rust Finalize','Use the resident worker after verification.','{}',90,80,?1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
            [json!({"sourceUri":"cover-evidence-result://evidence-1"}).to_string()],
        ).unwrap();
    let content_hash = format!(
        "{:x}",
        Sha256::digest(b"Rust Finalize\nUse the resident worker after verification.")
    );
    connection.execute(
            "insert into knowledge_items_vec_fallback (knowledge_id,embedding_json,embedding_dimension,content_hash,updated_at) values ('existing-1','[0.1,0.2,0.3]',3,?1,CURRENT_TIMESTAMP)",
            [content_hash],
        ).unwrap();

    let status = run_finalize_distille_job_for_connection(
        &connection,
        "finalize-1",
        "rust-worker",
        &embedding_config("http://127.0.0.1:1".to_string()),
        20.0,
    )
    .unwrap();

    assert_eq!(status, FinalizeExecutionStatus::Completed);
    let fts_count: i64 = connection
        .query_row(
            "select count(*) from knowledge_items_fts where id='existing-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let indexed_vector_count: i64 = connection
            .query_row(
                "select count(*) from knowledge_items_vec v join knowledge_items_vec_map m on m.vec_rowid = v.rowid where m.knowledge_id='existing-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
    assert_eq!(fts_count, 1);
    assert_eq!(indexed_vector_count, 1);
}

#[test]
fn rust_finalize_does_not_overwrite_a_reclaimed_job() {
    let connection = setup();
    connection
            .execute(
                "update finalize_distille_queue set locked_by='replacement-worker' where id='finalize-1'",
                [],
            )
            .unwrap();

    let error = run_finalize_distille_job_for_connection(
        &connection,
        "finalize-1",
        "rust-worker",
        &embedding_config("http://127.0.0.1:1".to_string()),
        20.0,
    )
    .unwrap_err();

    assert!(error.to_string().contains("claim ownership lost"));
    let queue = connection
            .query_row(
                "select status, locked_by, attempt_count from finalize_distille_queue where id='finalize-1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .unwrap();
    assert_eq!(
        queue,
        ("running".to_string(), "replacement-worker".to_string(), 0)
    );
}

#[test]
fn finalize_retries_transient_daemon_and_openai_failures() {
    for error in [
        "embedding daemon HTTP 429 Too Many Requests",
        "undefined is not an object (evaluating 'text.replace')",
        "OpenAI embedding request failed: connection reset",
        "OpenAI embedding HTTP 503 Service Unavailable",
        "failed to parse OpenAI embedding response: unexpected EOF",
    ] {
        assert!(is_retryable_embedding_error(error), "{error}");
    }
    assert!(!is_retryable_embedding_error(
        "OpenAI embedding API key is not configured"
    ));
}
