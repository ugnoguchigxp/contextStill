//! Claimed Provider round trip through admission, inference, resume and projection.
use super::*;

#[test]
fn finding_and_covering_use_claimed_provider_without_auxiliary_api_and_verify_before_finalize() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::{Duration, Instant};
    let f = Fixture::new();
    let run = f.run();
    let c = Connection::open(&f.path).unwrap();
    let (_created, expires): (String, String) = c.query_row(
        "select strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 second'),strftime('%Y-%m-%dT%H:%M:%SZ','now','+120 seconds')",
        [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let window = f.measurement().window;
    c.execute("update llm_provider_leases set metadata=?1",[json!({"connectionId":"test-connection","allocationId":"test-allocation","publicModel":"test-model","providerBaseUrl":origin,"credentialExpiresAt":expires,"contextWindow":window}).to_string()]).unwrap();
    let source = run.state.sources[0].clone();
    let envelope = json!({"version":1,"candidates":[{"candidate":{"type":"rule","polarity":"positive","title":"重要な条件を確認する","content":"処理を開始する前に、重要な条件と独立した根拠を確認する。"},"evidence":[{"snapshotHash":source.hash,"fromByte":0,"text":"重要な条件","role":"supports"}],"unresolvedQuestions":[]}],"assessment":null,"questions":[],"evidence":[],"next":{"kind":"finish","reason":"sufficient"}});
    let server = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for _ in 0..3 {
            let deadline = Instant::now() + Duration::from_secs(15);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(e) => panic!("test HTTP server did not receive a request: {e}"),
                }
            };
            // Darwin inherits O_NONBLOCK from the listening socket.
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut bytes = Vec::new();
            let (headers, body_start, length) = loop {
                let mut chunk = [0u8; 4096];
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8(bytes[..end].to_vec()).unwrap();
                    let length = headers
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    break (headers, end + 4, length);
                }
            };
            while bytes.len() < body_start + length {
                let mut chunk = [0u8; 4096];
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
            }
            let body: Value = if length == 0 {
                Value::Null
            } else {
                serde_json::from_slice(&bytes[body_start..body_start + length]).unwrap()
            };
            let response = {
                assert!(headers.starts_with("POST /v1/chat/completions "));
                assert!(headers
                    .to_ascii_lowercase()
                    .contains("authorization: bearer synthetic-provider-token"));
                assert_eq!(body["model"], "test-model");
                let user: Value =
                    serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
                let envelope = if user["policy"] == "covering" {
                    let result = json!({"status":"knowledge_ready","stage":"final","candidate":{"type":"rule","title":"重要な条件を確認する","body":"処理を開始する前に、重要な条件と独立した根拠を確認する。","importance":80,"confidence":80,"appliesTo":{"general":false,"technologies":["Rust"],"changeTypes":["fix"],"domains":["queue"]}}});
                    if user["finalizing"] == true {
                        assert!(user["assessment"].is_null());
                        assert_eq!(user["finalArtifact"], result);
                    }
                    json!({"version":1,"candidates":[],"assessment":{"status":"supported","result":result,"claims":[{"claim":"開始前に条件と根拠を確認する。","supported":true,"evidence":[{"snapshotHash":source.hash,"fromByte":0,"text":"重要な条件と独立した根拠","role":"supports"}]}],"materialGaps":[]},"questions":[],"evidence":[],"next":{"kind":"finish","reason":"sufficient"}})
                } else {
                    envelope.clone()
                };
                json!({"choices":[{"message":{"content":envelope.to_string()},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":100}})
            };
            requests.push((headers.lines().next().unwrap().to_owned(), body));
            let response = response.to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
        }
        requests
    });
    let target = crate::domains::queue_lifecycle::episode_executor::LocalLlmTargetConfig {
        codex: false,
        quota_db: None,
        target_id: "target".into(),
        api_base_url: origin.clone(),
        api_path: "/v1/chat/completions".into(),
        model: "test-model".into(),
    };
    let settings = json!({"advanced":{"agentRuntime":{"enabled":true}}});
    let tick = |a| {
        crate::domains::agent_runtime::engine::tick(
            &f.path,
            a,
            crate::domains::agent_runtime::engine::TickRequest {
                target: &target,
                key: Some("synthetic-provider-token"),
                settings: &settings,
                timeout: 5,
                covering: None,
                source_root: &f.dir,
            },
            &mut || {},
        )
        .unwrap()
    };
    assert!(!tick(f.a.clone()));
    let mut next = f.a.clone();
    next.id = "second-claim".into();
    c.execute(
        "update finding_candidate_queue set status='running',locked_by='worker'",
        [],
    )
    .unwrap();
    c.execute("insert into llm_provider_leases(id,pool_id,target_id,queue_name,queue_job_id,worker_id,expires_at) values('second-claim','pool','target','findingCandidate','job','worker',datetime(CURRENT_TIMESTAMP,'+120 seconds'))",[]).unwrap();
    assert!(tick(next));
    assert_eq!(
        c.query_row("select count(*) from agent_steps", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        c.query_row("select status from finding_candidate_queue", [], |r| r
            .get::<_, String>(
            0
        ))
        .unwrap(),
        "completed"
    );
    assert_eq!(
        c.query_row(
            "select protocol_version from covering_evidence_queue",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        3
    );
    let (used,window_tokens):(i64,i64) = c.query_row("select json_extract(r.state_json,'$.state.budget.used'),s.window_tokens from agent_runs r join agent_steps s on s.run_id=r.id",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(used, 200);
    assert!(window_tokens > 8192 && window_tokens <= 32768);
    let cover_id: String = c
        .query_row("select id from covering_evidence_queue", [], |r| r.get(0))
        .unwrap();
    for phase in 0..3 {
        let assignment = ProviderLeaseAssignment {
            id: format!("cover-claim-{phase}"),
            pool_id: "pool".into(),
            target_id: "target".into(),
            queue_name: "coveringEvidence".into(),
            queue_job_id: cover_id.clone(),
            worker_id: "cover-worker".into(),
        };
        c.execute(
            "update covering_evidence_queue set status='running',locked_by='cover-worker'",
            [],
        )
        .unwrap();
        c.execute("insert into llm_provider_leases(id,pool_id,target_id,queue_name,queue_job_id,worker_id,expires_at,metadata) values(?1,'pool','target','coveringEvidence',?2,'cover-worker',datetime(CURRENT_TIMESTAMP,'+120 seconds'),?3)",rusqlite::params![assignment.id,cover_id,json!({"connectionId":"test-connection","allocationId":"test-allocation","publicModel":"test-model","providerBaseUrl":origin,"credentialExpiresAt":expires,"contextWindow":window}).to_string()]).unwrap();
        let execution =
            crate::domains::queue_lifecycle::covering_executor::load_claimed_covering_execution(
                &c,
                crate::domains::queue_lifecycle::types::ClaimedProviderLeaseJob {
                    queue_name: "coveringEvidence".into(),
                    id: cover_id.clone(),
                    provider_lease: assignment.clone(),
                },
                target.clone(),
                None,
                50,
                f.dir.clone(),
                Default::default(),
            )
            .unwrap();
        let done = crate::domains::agent_runtime::engine::tick(
            &f.path,
            assignment,
            crate::domains::agent_runtime::engine::TickRequest {
                target: &target,
                key: Some("synthetic-provider-token"),
                settings: &settings,
                timeout: 5,
                covering: Some(&execution),
                source_root: &f.dir,
            },
            &mut || {},
        )
        .unwrap();
        let diagnostic: (String, Option<String>) = c
            .query_row(
                "select status,last_outcome_kind from covering_evidence_queue",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(done, phase == 2, "phase {phase}: {diagnostic:?}");
        let finalizes: i64 = c
            .query_row("select count(*) from finalize_distille_queue", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            finalizes,
            if phase == 2 { 1 } else { 0 },
            "phase {phase} must not finalize before independent verification"
        );
    }
    let requests = server.join().unwrap();
    for (no, (_, body)) in requests.iter().enumerate() {
        assert_eq!(
            body["max_tokens"],
            super::super::budget::AGENT_OUTPUT_TOKENS
        );
        let (digest, upper, binding): (String, u64, String) = c.query_row(
            "select request_hash,measured_input,result_json from agent_steps order by rowid limit 1 offset ?1",
            [no as i64], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(digest, hash(&body.to_string()));
        assert_eq!(upper, body.to_string().len() as u64 + 512);
        let binding: Value = serde_json::from_str(&binding).unwrap();
        assert_eq!(binding["measurementBinding"]["exact"], false);
    }
    assert_eq!(
        c.query_row("select count(*) from agent_steps", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        3
    );
    let (status,used):(String,i64) = c.query_row("select status,json_extract(state_json,'$.state.budget.used') from agent_runs where queue_name='coveringEvidence'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!((status, used), ("completed".into(), 400));
}
