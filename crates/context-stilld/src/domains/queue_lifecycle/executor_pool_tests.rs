use super::*;
use crate::domains::queue_lifecycle::test_support::*;
use crate::shared::config::MapEnv;
use rusqlite::Connection;
use serde_json::json;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
#[test]
fn split_pool_sends_two_requests_before_either_response_finishes() {
    assert_parallel_pool_requests(false, false, false, false);
}

#[test]
fn covering_and_finding_share_pool_workers_without_serial_wait() {
    assert_parallel_pool_requests(true, false, false, false);
}

#[test]
fn paused_finalize_does_not_block_other_pool_queues() {
    assert_parallel_pool_requests(false, true, false, false);
}

#[test]
fn covering_persistence_failure_returns_job_and_releases_pool_slot() {
    assert_parallel_pool_requests(true, false, true, false);
}

#[test]
fn free_worker_uses_remaining_claim_budget_before_slow_worker_finishes() {
    assert_parallel_pool_requests(false, false, false, true);
}

fn assert_parallel_pool_requests(
    with_covering: bool,
    paused_finalize: bool,
    fail_covering_persistence: bool,
    refill: bool,
) {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (observed_tx, observed_rx) = mpsc::channel();
    let expected_requests = if refill { 3 } else { 2 };
    let server = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut streams = Vec::new();
        let respond = |(mut stream, finding): (std::net::TcpStream, bool)| {
            let content = if finding {
                "[]".to_string()
            } else {
                json!({"status":"insufficient","polarity":"negative","distilled":{"failure":"Insufficient evidence for a reusable rule"}}).to_string()
            };
            let body = json!({"choices":[{"message":{"content":content},"finish_reason":"stop"}]})
                .to_string();
            let _ = write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
        };
        let mut accepted = 0;
        while accepted < expected_requests && Instant::now() < deadline {
            match listener.accept() {
                Ok((stream, _)) => {
                    // macOS may inherit the listener nonblocking flag on accepted sockets.
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut reader = BufReader::new(stream);
                    let mut length = 0;
                    loop {
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        if line == "\r\n" || line.is_empty() {
                            break;
                        }
                        if let Some(value) =
                            line.to_ascii_lowercase().strip_prefix("content-length:")
                        {
                            length = value.trim().parse::<usize>().unwrap();
                        }
                    }
                    let mut body = vec![0; length];
                    reader.read_exact(&mut body).unwrap();
                    let request: Value = serde_json::from_slice(&body).unwrap();
                    let finding = request["messages"][0]["content"]
                        .as_str()
                        .unwrap()
                        .contains("findCandidate");
                    streams.push((reader.into_inner(), finding));
                    accepted += 1;
                    if refill && accepted == 2 {
                        respond(streams.pop().unwrap());
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10))
                }
                Err(e) => panic!("{e}"),
            }
        }
        observed_tx.send(accepted).unwrap();
        for item in streams {
            respond(item);
        }
    });
    let app_dir = temp_app_dir("parallel_provider_requests");
    let sqlite_path = app_dir.join("queue.sqlite");
    crate::domains::vector_index::service::register_sqlite_vec();
    let mut connection = Connection::open(&sqlite_path).unwrap();
    crate::domains::sqlite_writer::schema::configure_writer_connection(&connection).unwrap();
    crate::domains::sqlite_writer::schema::migrate(&mut connection, 3).unwrap();
    let settings = json!({"settings":{
      "providers":{"local-llm":{"enabled":true,"models":[{"id":"a","model":"qwen","apiBaseUrl":origin},{"id":"b","model":"qwen","apiBaseUrl":origin}]}},
      "providerPools":[{"id":"mixed","enabled":true,"maxConcurrent":2,"targets":[{"provider":"local-llm","localLlmModelId":"a"},{"provider":"local-llm","localLlmModelId":"b"}]}],
      "taskRouting":{"findCandidate":{"source":{"provider":"auto","providerPoolId":"mixed"},"vibe":{"provider":"auto","providerPoolId":"mixed"}},"coverEvidence":{"sourceSupport":{"provider":"auto","providerPoolId":"mixed"}}}
    }});
    connection
        .execute(
            "insert into settings(id,namespace,key,value) values('s','runtime','settings.v1',?1)",
            [settings.to_string()],
        )
        .unwrap();
    for i in 0..expected_requests {
        connection.execute("insert into vibe_memories(id,session_id,content,memory_type,metadata,created_at) values(?1,?2,'Use only verified evidence for knowledge.','chat','{}',CURRENT_TIMESTAMP)",rusqlite::params![format!("memory-{i}"),format!("session-{i}")]).unwrap();
        connection.execute("insert into finding_candidate_queue(id,input_kind,source_kind,source_key,source_uri,distillation_version,status,priority,attempt_count,metadata,created_at,updated_at) values(?1,'source_target','vibe_memory',?2,?2,'v1','pending',100,0,'{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",rusqlite::params![format!("job-{i}"),format!("memory-{i}")]).unwrap();
    }
    if with_covering {
        connection
            .execute(
                "update finding_candidate_queue set status='completed' where id='job-1'",
                [],
            )
            .unwrap();
        connection.execute("insert into found_candidates(id,finding_job_id,candidate_index,type,title,content,origin) values('candidate-1','job-1',0,'rule','Keep writer ownership','Use one resident writer to prevent conflicts.','{\"polarity\":\"negative\"}')", []).unwrap();
        connection.execute("insert into covering_evidence_queue(id,found_candidate_id,status,priority,provider_policy) values('cover-1','candidate-1','pending',100,'default')", []).unwrap();
    }
    if paused_finalize {
        connection.execute("insert into settings(id,namespace,key,value) values('controls','runtime','queue.controls.v1','{\"queues\":{\"finalizeDistille\":{\"paused\":true}}}')", []).unwrap();
        connection.execute("insert into finalize_distille_queue(id,evidence_result_id,distillation_version,status) values('paused-finalize','unused','v1','pending')", []).unwrap();
    }
    if fail_covering_persistence {
        connection.execute_batch("create trigger reject_covering_completion before update on covering_evidence_queue when new.status='completed' begin select raise(fail, 'injected persistence failure'); end;").unwrap();
    }
    drop(connection);
    let writer = crate::domains::sqlite_writer::SqliteWriterRuntime::start_existing_for_test(
        &sqlite_path,
        32,
    )
    .unwrap();
    crate::domains::sqlite_writer::install_global_writer(writer.handle()).unwrap();
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        (
            "CONTEXT_STILL_SQLITE_CORE_PATH",
            sqlite_path.to_str().unwrap(),
        ),
        ("CONTEXT_STILL_RUST_FINDING_EXECUTION_MODE", "split"),
        (
            "CONTEXT_STILL_RUST_QUEUE_EXECUTOR_MAX_CLAIMS",
            if refill { "3" } else { "2" },
        ),
        (
            "CONTEXT_STILL_RUST_COVERING_MODE",
            if with_covering { "all" } else { "off" },
        ),
    ]);
    let result = run_executor_tick_report(&env);
    assert_eq!(
        observed_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        expected_requests,
        "free pool slots must send work without waiting for the blocked response"
    );
    server.join().unwrap();
    if fail_covering_persistence {
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("injected persistence failure"));
    } else {
        let report = result.unwrap();
        assert_eq!(report.claimed, expected_requests);
        assert_eq!(report.completed, expected_requests);
    }
    let reader = Connection::open(&sqlite_path).unwrap();
    assert_eq!(
        reader
            .query_row(
                "select count(*) from llm_provider_leases where status='active'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    if fail_covering_persistence {
        assert_eq!(
            reader
                .query_row(
                    "select status from covering_evidence_queue where id='cover-1'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "pending"
        );
    }
    writer.shutdown().unwrap();
    drop(reader);
    std::fs::remove_dir_all(app_dir).unwrap();
}

#[test]
fn every_pool_target_can_claim_every_llm_queue() {
    let route = json!({"provider":"auto","providerPoolId":"shared","model":"old-fixed-model"});
    let settings = json!({"taskRouting": {
        "findCandidate":{"source":route,"vibe":route},
        "episodeDistiller":route,"landscapeCuration":route,
        "coverEvidence":{"sourceSupport":route,"externalEvidence":route,"mcpEvidence":route}
    }});
    for (queue, table) in [
        ("findingCandidate", "finding_candidate_queue"),
        ("coveringEvidence", "covering_evidence_queue"),
        ("episodeDistiller", "episode_distiller_queue"),
        ("landscapeCuration", "landscape_curation_queue"),
    ] {
        for target in ["qwen", "muse", "spark"] {
            let mut connection = Connection::open_in_memory().unwrap();
            create_provider_claim_queue_table(&connection, table);
            create_provider_lease_table(&connection);
            connection.execute(&format!("insert into {table}(id,status,source_kind,provider_policy,created_at,updated_at) values('job','pending','vibe_memory','default',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"), []).unwrap();
            let mut pool = provider_pool();
            pool.pool_id = "shared".into();
            pool.targets = vec![target.into()];
            let spec = queue_spec_for_pool(&settings, queue, "shared").unwrap();
            assert!(spec.preferred_target_ids.is_empty());
            assert!(spec.route_target_preferences.is_empty());
            let claim = claim_next_job_with_provider_lease_for_connection(
                &mut connection,
                &pool,
                &[spec],
                "worker",
                "lease",
                90,
            )
            .unwrap()
            .unwrap();
            assert_eq!(claim.provider_lease.target_id, target, "{queue}");
            assert_eq!(claim.queue_name, queue);
        }
    }
}

#[test]
fn disabled_local_provider_does_not_disable_spark_in_the_same_pool() {
    let settings = json!({
        "providers":{"local-llm":{"enabled":false,"models":[{"id":"qwen","model":"qwen","apiBaseUrl":"http://localhost:1"}]},"codex":{"enabled":true}},
        "providerPools":[{"id":"shared","targets":[{"provider":"local-llm","localLlmModelId":"qwen"},{"provider":"codex","targetId":"spark","model":"gpt-5.3-codex-spark"}]}]
    });
    assert!(local_llm_target_config(&settings, "qwen")
        .unwrap_err()
        .to_string()
        .contains("disabled"));
    assert!(local_llm_target_config(&settings, "spark").unwrap().codex);
}
