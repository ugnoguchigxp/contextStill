use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
};
fn server(unknown: bool) -> (String, std::thread::JoinHandle<usize>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let handle = std::thread::spawn(move || {
        let mut submitted = Value::Null;
        let mut posts = 0;
        for no in 0..3 {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut part = [0; 4096];
            let (header, body) = loop {
                let n = stream.read(&mut part).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&part[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..end]).to_string();
                    let size = header
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|v| v.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + size {
                        break (header, bytes[end + 4..end + 4 + size].to_vec());
                    }
                }
            };
            assert!(header
                .to_ascii_lowercase()
                .contains("authorization: bearer synthetic-research-token"));
            let (status, result) = match no {
                0 => (
                    200,
                    json!({"contractVersion":"contextstill-research.v1","liveReady":true,"hostGateway":true,"usageReceipts":true,"cancelConfirmation":true,"scopeBinding":true}),
                ),
                1 => {
                    assert!(header.starts_with("POST "));
                    posts += 1;
                    let envelope: Value = serde_json::from_slice(&body).unwrap();
                    submitted =
                        serde_json::from_str(envelope["payloadJson"].as_str().unwrap()).unwrap();
                    assert_eq!(
                        envelope["requestHash"],
                        format!(
                            "sha256:{}",
                            super::super::source::hash(envelope["payloadJson"].as_str().unwrap())
                        )
                    );
                    if unknown {
                        (500, json!({"error":"lost_response"}))
                    } else {
                        (
                            201,
                            json!({"contractVersion":submitted["contractVersion"],"delegationId":submitted["delegationId"],"ownerRun":submitted["ownerRun"],"scopeHash":submitted["scopeHash"],"requestHash":envelope["requestHash"],"jobId":"remote-job"}),
                        )
                    }
                }
                _ => {
                    assert!(header.starts_with("GET "));
                    if unknown {
                        (404, json!({"error":"NOT_FOUND"}))
                    } else {
                        let text = "確認済みの追加資料です。独立した条件を確認する。";
                        (
                            200,
                            json!({"contractVersion":submitted["contractVersion"],"delegationId":submitted["delegationId"],"ownerRun":submitted["ownerRun"],"rootLineage":submitted["rootLineage"],"scopeHash":submitted["scopeHash"],"requestHash":format!("sha256:{}",super::super::source::hash(&submitted.to_string())),"jobId":"remote-job","terminal":true,"status":"completed","stopReason":"sufficient","usage":{"tokens":0,"queries":1,"documents":1,"urls":1},"sources":[{"uri":"https://example.invalid/test-document","text":text,"snapshotHash":super::super::source::hash(text)}],"evidence":[],"unresolved":[]}),
                        )
                    }
                }
            };
            let text = result.to_string();
            write!(stream,"HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",text.len()).unwrap();
        }
        posts
    });
    (origin, handle)
}
fn setup(
    unknown: bool,
) -> (
    Fixture,
    Run,
    super::super::config::ResearchConfig,
    std::thread::JoinHandle<usize>,
) {
    let f = Fixture::new();
    let mut run = f.run();
    let c = Connection::open(&f.path).unwrap();
    c.execute("insert into settings(id,namespace,key,value) values('research-key','runtime.secret','researchKey',?1)",[json!({"value":"synthetic-research-token"}).to_string()]).unwrap();
    run.state.questions.push(super::super::policy::Question {
        id: "q1".into(),
        candidate_key: "source".into(),
        question: "追加条件をどの資料で確認できるか".into(),
        success_criteria: "追加の独立した資料が得られる".into(),
        resolved: false,
    });
    let (origin, server) = server(unknown);
    let config = super::super::config::ResearchConfig {
        base_url: origin,
        credential_key: "researchKey".into(),
        gateway_credential_key: "gatewayKey".into(),
        gateway_url: "http://127.0.0.1:1/integrations/deepstill/agent/v1/chat/completions".into(),
    };
    (f, run, config, server)
}
fn resume(f: &Fixture) -> Run {
    let c = Connection::open(&f.path).unwrap();
    c.execute(
        "update finding_candidate_queue set status='running',locked_by='worker' where id='job'",
        [],
    )
    .unwrap();
    c.execute(
        "update llm_provider_leases set status='active' where id='lease'",
        [],
    )
    .unwrap();
    super::super::ledger::prepare(&f.path, f.a.clone(), f.input.clone()).unwrap()
}
#[test]
fn research_wait_releases_parent_slot_and_settles_only_once_from_host_receipts() {
    let (f, mut run, config, server) = setup(false);
    let mut released = 0;
    super::super::research::start(
        &mut run,
        &config,
        &["q1".into()],
        "追加条件",
        &mut || released += 1,
    )
    .unwrap();
    assert_eq!(released, 1);
    assert_eq!(run.state.budget.reserved, 262144);
    let c = Connection::open(&f.path).unwrap();
    assert_eq!(
        c.query_row(
            "select status from llm_provider_leases where id='lease'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "released"
    );
    let mut run = resume(&f);
    assert!(super::super::research::poll(&mut run, Some(&config), &mut || {}).unwrap());
    assert_eq!(run.state.budget.reserved, 0);
    assert_eq!(run.state.sources.len(), 2);
    assert_eq!(run.state.budget.used, 0);
    let mut run = resume(&f);
    assert!(!super::super::research::poll(&mut run, Some(&config), &mut || {}).unwrap());
    assert_eq!(server.join().unwrap(), 1);
    let (status, reserved): (String, i64) = c
        .query_row(
            "select status,reserved_tokens from agent_delegations",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "completed");
    assert_eq!(reserved, 262144);
}
#[test]
fn unknown_research_submission_is_looked_up_and_never_submitted_again() {
    let (f, mut run, config, server) = setup(true);
    super::super::research::start(&mut run, &config, &["q1".into()], "追加条件", &mut || {})
        .unwrap();
    let mut run = resume(&f);
    assert_eq!(
        super::super::research::poll(&mut run, Some(&config), &mut || {}).unwrap_err(),
        "research_submission_unknown_not_found"
    );
    assert_eq!(run.state.budget.reserved, 262144);
    assert_eq!(server.join().unwrap(), 1);
}
