use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;
use std::time::Instant;

#[path = "finding_executor/tests/parsing_tests.rs"]
mod parsing_tests;

#[test]
fn treats_transport_and_server_failures_as_retryable() {
    assert!(is_provider_unavailable(
        "local-llm request failed: No route to host"
    ));
    assert!(is_provider_unavailable("local-llm HTTP 500: overloaded"));
    assert!(is_provider_unavailable("local-llm HTTP 429: busy"));
    assert!(is_provider_unavailable(
        "failed to read local-llm response: connection reset"
    ));
    assert!(!is_provider_unavailable("finding candidate parse failed"));
}

#[test]
fn retry_and_failure_increment_attempt_count() {
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch(r#"
            create table finding_candidate_queue (
              id text primary key, status text, attempt_count integer not null default 0,
              locked_by text, locked_at text, heartbeat_at text, next_run_at text,
              completed_at text, last_error text, last_outcome_kind text, updated_at text
            );
            insert into finding_candidate_queue (id, status, attempt_count, updated_at)
              values ('retry-job', 'running', 2, CURRENT_TIMESTAMP), ('failed-job', 'running', 4, CURRENT_TIMESTAMP);
        "#).unwrap();

    mark_retrying(&connection, "retry-job", "temporarily unavailable").unwrap();
    mark_failed(&connection, "failed-job", "invalid output").unwrap();

    let retry: (String, i64, i64) = connection.query_row(
            "select status, attempt_count, next_run_at is not null from finding_candidate_queue where id='retry-job'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        ).unwrap();
    let failed: (String, i64) = connection
        .query_row(
            "select status, attempt_count from finding_candidate_queue where id='failed-job'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(retry, ("pending".to_string(), 3, 1));
    assert_eq!(failed, ("failed".to_string(), 5));
}

#[test]
fn normalizes_v1_chat_url() {
    assert_eq!(
        chat_url("http://localhost:5000/v1", "/v1/chat/completions"),
        "http://localhost:5000/v1/chat/completions"
    );
}

#[test]
fn persists_candidates_and_downstream_jobs_before_completing() {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            r#"
            create table finding_candidate_queue (
              id text primary key, status text, locked_by text, locked_at text, heartbeat_at text,
              next_run_at text, completed_at text, last_error text, last_outcome_kind text,
              metadata text not null default '{}', updated_at text
            );
            create table found_candidates (
              id text primary key, finding_job_id text, candidate_index integer, type text,
              title text, content text, source_summary text, origin text, metadata text,
              created_at text, updated_at text
            );
            create table covering_evidence_queue (
              id text primary key, found_candidate_id text, distillation_version text, status text,
              priority integer, provider_policy text, payload text, metadata text,
              created_at text, updated_at text
            );
            insert into finding_candidate_queue (id, status, metadata, updated_at)
              values ('job-1', 'running', '{}', CURRENT_TIMESTAMP);
        "#,
        )
        .unwrap();
    let job = FindingJob {
        id: "job-1".to_string(),
        input_kind: "source_target".to_string(),
        source_kind: "vibe_memory".to_string(),
        source_key: "memory-1".to_string(),
        source_uri: "vibe-memory://memory-1".to_string(),
        distillation_version: "v1".to_string(),
        priority: 42,
        attempt_count: 0,
        metadata: json!({}),
    };
    let candidates = vec![Candidate {
        kind: "rule".to_string(),
        polarity: "positive".to_string(),
        title: "Release leases".to_string(),
        content: "Release the provider lease.".to_string(),
    }];

    persist_result(&connection, &job, &candidates).unwrap();
    let updated_candidates = vec![Candidate {
        kind: "rule".to_string(),
        polarity: "negative".to_string(),
        title: "Do not leak leases".to_string(),
        content: "Always release provider leases.".to_string(),
    }];
    persist_result(&connection, &job, &updated_candidates).unwrap();

    let status: String = connection
        .query_row(
            "select status from finding_candidate_queue where id = 'job-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let candidates_count: i64 = connection
        .query_row("select count(*) from found_candidates", [], |row| {
            row.get(0)
        })
        .unwrap();
    let covering_count: i64 = connection
        .query_row(
            "select count(*) from covering_evidence_queue where status = 'pending'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "completed");
    assert_eq!(candidates_count, 1);
    assert_eq!(covering_count, 1);
    let persisted: (String, String, String) = connection
            .query_row(
                "select title, json_extract(origin, '$.sourceUri'), json_extract(metadata, '$.polarity') from found_candidates limit 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
    assert_eq!(
        persisted,
        (
            "Do not leak leases".to_string(),
            "vibe-memory://memory-1".to_string(),
            "negative".to_string()
        )
    );
}

#[test]
fn provider_unavailable_backoff_matches_queue_contract() {
    assert_eq!(provider_unavailable_backoff_seconds(0), 60);
    assert_eq!(provider_unavailable_backoff_seconds(1), 120);
    assert_eq!(provider_unavailable_backoff_seconds(2), 300);
    assert_eq!(provider_unavailable_backoff_seconds(3), 600);
    assert_eq!(provider_unavailable_backoff_seconds(4), 1_200);
    assert_eq!(provider_unavailable_backoff_seconds(5), 3_600);
    assert_eq!(provider_unavailable_backoff_seconds(500), 3_600);
}

#[test]
fn fenced_finding_persistence_pauses_exhausted_provider_and_discards_replay() {
    let mut connection = Connection::open_in_memory().unwrap();
    connection
            .execute_batch(
                r#"
                create table finding_candidate_queue (
                  id text primary key, status text, attempt_count integer not null default 0,
                  locked_by text, locked_at text, heartbeat_at text, next_run_at text,
                  completed_at text, last_error text, last_outcome_kind text,
                  metadata text not null default '{}', updated_at text
                );
                create table llm_provider_leases (
                  id text primary key, pool_id text, target_id text, queue_name text,
                  queue_job_id text, worker_id text, status text, locked_at text,
                  heartbeat_at text, expires_at text, released_at text, release_reason text,
                  metadata text, created_at text, updated_at text
                );
                create table distillation_queue_events (
                  id text primary key, queue_name text, queue_job_id text, event_type text,
                  message text, metadata text not null default '{}', created_at text
                );
                insert into finding_candidate_queue (
                  id, status, attempt_count, locked_by, locked_at, heartbeat_at, metadata, updated_at
                ) values (
                  'finding-job', 'running', 7, 'finding-worker', CURRENT_TIMESTAMP,
                  CURRENT_TIMESTAMP, '{}', CURRENT_TIMESTAMP
                );
                insert into llm_provider_leases (
                  id, pool_id, target_id, queue_name, queue_job_id, worker_id, status,
                  locked_at, heartbeat_at, expires_at, metadata, created_at, updated_at
                ) values (
                  'finding-lease', 'pool', 'local-a', 'findingCandidate', 'finding-job',
                  'finding-worker', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
                  datetime(CURRENT_TIMESTAMP, '+120 seconds'), '{}', CURRENT_TIMESTAMP,
                  CURRENT_TIMESTAMP
                );
                "#,
            )
            .unwrap();
    let execution = FindingExecution {
        job: FindingJob {
            id: "finding-job".to_string(),
            input_kind: "source_target".to_string(),
            source_kind: "vibe_memory".to_string(),
            source_key: "memory".to_string(),
            source_uri: "vibe-memory://memory".to_string(),
            distillation_version: "v1".to_string(),
            priority: 1,
            attempt_count: 7,
            metadata: json!({}),
        },
        source: Some("source".to_string()),
        self_ingestion_blocked: false,
        provider_lease: ProviderLeaseAssignment {
            id: "finding-lease".to_string(),
            pool_id: "pool".to_string(),
            target_id: "local-a".to_string(),
            queue_name: "findingCandidate".to_string(),
            queue_job_id: "finding-job".to_string(),
            worker_id: "finding-worker".to_string(),
        },
        target: LocalLlmTargetConfig {
            codex: false,
            quota_db: None,
            target_id: "local-a".to_string(),
            api_base_url: "http://127.0.0.1:1".to_string(),
            api_path: "/v1/chat/completions".to_string(),
            model: "qwen".to_string(),
        },
        api_key: None,
    };
    let result = FindingWorkerResult::ProviderUnavailable("connection refused".to_string());

    assert_eq!(
        persist_finding_result(&mut connection, &execution, &result).unwrap(),
        FindingPersistStatus::Paused
    );
    assert_eq!(
        persist_finding_result(&mut connection, &execution, &result).unwrap(),
        FindingPersistStatus::Superseded
    );
    assert_eq!(
        persist_finding_result(&mut connection, &execution, &result).unwrap(),
        FindingPersistStatus::Superseded
    );
    let row: (String, i64, String, String, i64) = connection
        .query_row(
            "select q.status, q.attempt_count, q.last_outcome_kind,
                        coalesce(l.release_reason, ''),
                        (select count(*) from distillation_queue_events)
                 from finding_candidate_queue q
                 join llm_provider_leases l on l.queue_job_id = q.id
                 where q.id = 'finding-job'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        row,
        (
            "paused".to_string(),
            8,
            "provider_unavailable_exhausted".to_string(),
            "provider_unavailable_retry".to_string(),
            2
        )
    );
}

#[test]
fn unsupported_input_is_paused_without_consuming_an_attempt() {
    let mut connection = Connection::open_in_memory().unwrap();
    connection
            .execute_batch(
                r#"
                create table finding_candidate_queue (
                  id text primary key, status text, attempt_count integer not null default 0,
                  locked_by text, locked_at text, heartbeat_at text, next_run_at text,
                  completed_at text, last_error text, last_outcome_kind text,
                  metadata text not null default '{}', updated_at text
                );
                create table llm_provider_leases (
                  id text primary key, pool_id text, target_id text, queue_name text,
                  queue_job_id text, worker_id text, status text, locked_at text,
                  heartbeat_at text, expires_at text, released_at text, release_reason text,
                  metadata text, created_at text, updated_at text
                );
                create table distillation_queue_events (
                  id text primary key, queue_name text, queue_job_id text, event_type text,
                  message text, metadata text not null default '{}', created_at text
                );
                insert into finding_candidate_queue (
                  id, status, attempt_count, locked_by, locked_at, heartbeat_at, metadata, updated_at
                ) values ('finding-job', 'running', 3, 'finding-worker', CURRENT_TIMESTAMP,
                  CURRENT_TIMESTAMP, '{}', CURRENT_TIMESTAMP);
                insert into llm_provider_leases (
                  id, pool_id, target_id, queue_name, queue_job_id, worker_id, status,
                  locked_at, heartbeat_at, expires_at, metadata, created_at, updated_at
                ) values ('finding-lease', 'pool', 'local-a', 'findingCandidate', 'finding-job',
                  'finding-worker', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
                  datetime(CURRENT_TIMESTAMP, '+120 seconds'), '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
                "#,
            )
            .unwrap();
    let execution = FindingExecution {
        job: FindingJob {
            id: "finding-job".to_string(),
            input_kind: "source_target".to_string(),
            source_kind: "wiki_file".to_string(),
            source_key: "rules.md".to_string(),
            source_uri: "wiki:rules.md".to_string(),
            distillation_version: "v1".to_string(),
            priority: 1,
            attempt_count: 3,
            metadata: json!({}),
        },
        source: None,
        self_ingestion_blocked: false,
        provider_lease: ProviderLeaseAssignment {
            id: "finding-lease".to_string(),
            pool_id: "pool".to_string(),
            target_id: "local-a".to_string(),
            queue_name: "findingCandidate".to_string(),
            queue_job_id: "finding-job".to_string(),
            worker_id: "finding-worker".to_string(),
        },
        target: LocalLlmTargetConfig {
            codex: false,
            quota_db: None,
            target_id: "local-a".to_string(),
            api_base_url: "http://127.0.0.1:1".to_string(),
            api_path: "/v1/chat/completions".to_string(),
            model: "qwen".to_string(),
        },
        api_key: None,
    };

    assert!(matches!(
        execute_finding(&execution, 30),
        FindingWorkerResult::UnsupportedInput(_)
    ));
    assert_eq!(
        persist_finding_result(
            &mut connection,
            &execution,
            &FindingWorkerResult::UnsupportedInput(
                "worker_capability_missing: source_target/wiki_file".to_string()
            ),
        )
        .unwrap(),
        FindingPersistStatus::Paused
    );
    let row: (String, i64, String, String) = connection
        .query_row(
            "select q.status, q.attempt_count, q.last_outcome_kind, coalesce(l.release_reason, '')
                 from finding_candidate_queue q join llm_provider_leases l on l.queue_job_id = q.id
                 where q.id = 'finding-job'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        row,
        (
            "paused".to_string(),
            3,
            "worker_capability_missing".to_string(),
            "worker_capability_missing".to_string()
        )
    );
}

#[test]
fn blocked_finding_provider_does_not_block_single_writer() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (accepted_tx, accepted_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buffer = [0_u8; 8192];
        let _ = stream.read(&mut buffer).unwrap();
        accepted_tx.send(()).unwrap();
        release_rx.recv().unwrap();
        let body = r#"{"choices":[{"finish_reason":"stop","message":{"content":"[]"}}]}"#;
        write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
    });
    let execution = FindingExecution {
        job: FindingJob {
            id: "blocked-job".to_string(),
            input_kind: "source_target".to_string(),
            source_kind: "vibe_memory".to_string(),
            source_key: "memory".to_string(),
            source_uri: "vibe-memory://memory".to_string(),
            distillation_version: "v1".to_string(),
            priority: 1,
            attempt_count: 0,
            metadata: json!({}),
        },
        source: Some("enough source evidence".to_string()),
        self_ingestion_blocked: false,
        provider_lease: ProviderLeaseAssignment {
            id: "blocked-lease".to_string(),
            pool_id: "pool".to_string(),
            target_id: "local-a".to_string(),
            queue_name: "findingCandidate".to_string(),
            queue_job_id: "blocked-job".to_string(),
            worker_id: "blocked-worker".to_string(),
        },
        target: LocalLlmTargetConfig {
            codex: false,
            quota_db: None,
            target_id: "local-a".to_string(),
            api_base_url: format!("http://{address}"),
            api_path: "/v1/chat/completions".to_string(),
            model: "qwen".to_string(),
        },
        api_key: None,
    };
    let worker = thread::spawn(move || execute_finding(&execution, 30));
    accepted_rx.recv().unwrap();

    let path = std::env::temp_dir().join(format!(
        "context-still-writer-sentinel-{}-{}.sqlite",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch("create table sentinel (id integer primary key, value text);")
        .unwrap();
    drop(connection);
    let runtime =
        crate::domains::sqlite_writer::SqliteWriterRuntime::start_existing_for_test(&path, 16)
            .unwrap();
    let started = Instant::now();
    runtime
        .handle()
        .execute("test.writer_sentinel", |connection| {
            connection
                .execute("insert into sentinel (value) values ('ok')", [])
                .map_err(|error| error.to_string())?;
            Ok(())
        })
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "writer sentinel exceeded 500 ms while provider was blocked: {:?}",
        started.elapsed()
    );

    release_tx.send(()).unwrap();
    assert!(matches!(
        worker.join().unwrap(),
        FindingWorkerResult::Candidates(candidates) if candidates.is_empty()
    ));
    server.join().unwrap();
    runtime.shutdown().unwrap();
    let _ = std::fs::remove_file(path);
}
