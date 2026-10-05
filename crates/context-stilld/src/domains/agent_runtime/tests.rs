#![cfg(test)]

use super::{
    budget::Window,
    ledger::{self, Input, Run},
    measurement::Measurement,
    policy::{CandidateDraft, EvidenceDraft, State},
    source::{hash, Snapshot},
    transport::{Completion, Usage},
};
use crate::domains::{
    queue_lifecycle::{
        provider_execution::owns_provider_execution, types::ProviderLeaseAssignment,
    },
    sqlite_writer,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::PathBuf;

struct Fixture {
    dir: PathBuf,
    path: PathBuf,
    a: ProviderLeaseAssignment,
    input: Input,
}
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "contextstill-agent-review-{}-{}-{}",
            std::process::id(),
            {
                static SEQUENCE: std::sync::atomic::AtomicU64 =
                    std::sync::atomic::AtomicU64::new(0);
                SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            },
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("test.sqlite");
        crate::domains::vector_index::service::register_sqlite_vec();
        let mut c = Connection::open(&path).unwrap();
        sqlite_writer::schema::migrate(&mut c, 3).unwrap();
        c.execute("insert into finding_candidate_queue(id,source_key,source_kind,source_uri,status,locked_by,protocol_version) values('job','source','vibe_memory','vibe://source','running','worker',3)",[]).unwrap();
        c.execute("insert into llm_provider_leases(id,pool_id,target_id,queue_name,queue_job_id,worker_id,expires_at) values('lease','pool','target','findingCandidate','job','worker',datetime(CURRENT_TIMESTAMP,'+120 seconds'))",[]).unwrap();
        let source = Snapshot::new(
            "vibe://source".into(),
            "primary".into(),
            "重要な条件と独立した根拠".into(),
        )
        .unwrap();
        let a = ProviderLeaseAssignment {
            id: "lease".into(),
            pool_id: "pool".into(),
            target_id: "target".into(),
            queue_name: "findingCandidate".into(),
            queue_job_id: "job".into(),
            worker_id: "worker".into(),
        };
        let input = Input {
            preview: false,
            generation: 0,
            identity: json!({"repoKey":"repo-a"}),
            source_key: "source".into(),
            source_kind: "vibe_memory".into(),
            source_uri: "vibe://source".into(),
            source_metadata: json!({"apiKey":"must-not-be-copied"}),
            distillation_version: "v1".into(),
            priority: 50,
            bundle: None,
            deferred_source: false,
            provided: false,
            provided_attributes: json!({}),
            initial_state: State::new(source, None),
        };
        Self {
            dir,
            path,
            a,
            input,
        }
    }
    fn run(&self) -> Run {
        ledger::prepare(&self.path, self.a.clone(), self.input.clone()).unwrap()
    }
    fn measurement(&self) -> Measurement {
        Measurement {
            input_tokens: 100,
            request_hash: hash("request"),
            tokenizer_digest: hash("tokenizer"),
            template_digest: hash("template"),
            lease_epoch: 1,
            expires_at_ms: super::measurement::now_ms() + 120_000,
            binding: json!({"measurementId":"receipt-1","runtime":"test-runtime","allocationId":"test-allocation","release":"test-release"}),
            window: Window {
                max_tokens: 36_864,
                output_reserve_tokens: 4_096,
                safety_margin_tokens: 1_024,
            },
        }
    }
}

#[test]
fn a_measurement_that_expires_while_waiting_for_the_writer_cannot_start_a_request() {
    let f = Fixture::new();
    let mut run = f.run();
    let mut measured = f.measurement();
    measured.expires_at_ms = 0;
    let budget = run.state.budget.clone();
    assert_eq!(
        run.begin_llm(&measured, 100).unwrap_err(),
        "measurement_receipt_expired"
    );
    assert_eq!(run.state.budget.used, budget.used);
    assert_eq!(run.state.budget.reserved, budget.reserved);
    assert_eq!(run.state.budget.calls, budget.calls);
    let c = Connection::open(&f.path).unwrap();
    assert_eq!(
        c.query_row("select count(*) from agent_steps", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn response_receipt_keeps_measurement_and_unknown_usage_reservation() {
    let f = Fixture::new();
    let mut run = f.run();
    let step = run.begin_llm(&f.measurement(), 4_096).unwrap();
    run.finish_llm(
        step,
        &Completion {
            content: "{}".into(),
            usage: None,
            finish_reason: Some("stop".into()),
            terminal_error: None,
            request_id: Some("request-id".into()),
        },
    )
    .unwrap();
    assert_eq!(run.state.budget.reserved, 4_196);
    let c = Connection::open(&f.path).unwrap();
    let (metadata, status) = c
        .query_row("select result_json,status from agent_steps", [], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .unwrap();
    let metadata: Value = serde_json::from_str(&metadata).unwrap();
    assert_eq!(metadata["content"], "{}");
    assert_eq!(metadata["tokenizerDigest"], hash("tokenizer"));
    assert_eq!(status, "succeeded");
    assert!(owns_provider_execution(&c, &f.a).unwrap());
    assert!(c
        .execute("update agent_steps set reserved_tokens=0", [])
        .is_err());
    assert!(c.execute("delete from agent_steps", []).is_err());
    let saved: String = c
        .query_row("select state_json from agent_runs", [], |r| r.get(0))
        .unwrap();
    assert!(!saved.contains("must-not-be-copied"));
}
#[test]
fn truncated_response_is_accounted_and_never_applied_after_restart() {
    let f = Fixture::new();
    let mut run = f.run();
    let step = run.begin_llm(&f.measurement(), 4096).unwrap();
    let error = run
        .finish_llm(
            step,
            &Completion {
                content: String::new(),
                terminal_error: Some(
                    "structured_output_incomplete finish_reason=\"length\"".into(),
                ),
                usage: Some(Usage {
                    input: 100,
                    output: 4096,
                    cached_input: 20,
                }),
                finish_reason: Some("length".into()),
                request_id: Some("truncated-response".into()),
            },
        )
        .unwrap_err();
    assert!(error.starts_with("structured_output_incomplete"));
    assert_eq!(
        (run.state.budget.used, run.state.budget.reserved),
        (4196, 0)
    );
    run.yield_queue(&error, Some(0), false).unwrap();
    let c = Connection::open(&f.path).unwrap();
    let mut assignment = f.a.clone();
    assignment.id = "resumed-truncated".into();
    c.execute(
        "update finding_candidate_queue set status='running',locked_by='worker'",
        [],
    )
    .unwrap();
    c.execute("insert into llm_provider_leases(id,pool_id,target_id,queue_name,queue_job_id,worker_id,expires_at) values('resumed-truncated','pool','target','findingCandidate','job','worker',datetime(CURRENT_TIMESTAMP,'+120 seconds'))", []).unwrap();
    // An unreachable provider proves the saved rejected response stops before any new request.
    let target = crate::domains::queue_lifecycle::episode_executor::LocalLlmTargetConfig {
        codex: false,
        quota_db: None,
        target_id: "target".into(),
        api_base_url: "http://127.0.0.1:1".into(),
        api_path: "/v1/chat/completions".into(),
        model: "model".into(),
    };
    assert!(!super::engine::tick(
        &f.path,
        assignment,
        super::engine::TickRequest {
            target: &target,
            key: None,
            settings: &json!({"advanced":{"agentRuntime":{"enabled":true}}}),
            timeout: 1,
            covering: None,
            source_root: &f.dir,
        },
        &mut || {}
    )
    .unwrap());
    let (status, reason): (String, String) = c
        .query_row(
            "select status,last_outcome_kind from finding_candidate_queue",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (status.as_str(), reason.as_str()),
        (
            "paused",
            "structured_output_incomplete finish_reason=\"length\""
        )
    );
    assert_eq!(
        c.query_row("select count(*) from agent_steps", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        c.query_row("select count(*) from found_candidates", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row(
            "select count(*) from llm_provider_leases where status='active'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    super::ingress::handle(
        &f.path,
        json!({"operation":"reprocess","queue":"findingCandidate","jobId":"job"}),
    )
    .unwrap();
}

#[test]
fn provider_budget_violation_is_saved_before_stopping() {
    let f = Fixture::new();
    let mut run = f.run();
    run.state.budget.hard = 40_000;
    let step = run.begin_llm(&f.measurement(), 4_096).unwrap();
    let error = run
        .finish_llm(
            step,
            &Completion {
                content: "{}".into(),
                usage: Some(Usage {
                    input: 41_000,
                    output: 1,
                    cached_input: 0,
                }),
                finish_reason: Some("stop".into()),
                terminal_error: None,
                request_id: None,
            },
        )
        .unwrap_err();
    assert_eq!(error, "provider_budget_violation");
    assert_eq!(run.state.budget.used, 41_001);
    let c = Connection::open(&f.path).unwrap();
    let raw: String = c
        .query_row(
            "select usage_json from agent_steps where status='succeeded'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(raw.contains("41000"));
    assert!(run.state.budget.reserve(1, true).is_err());
}
#[test]
fn stale_owner_cannot_update_after_request_lease_is_released() {
    let f = Fixture::new();
    let run = f.run();
    run.release_for_io().unwrap();
    let c = Connection::open(&f.path).unwrap();
    assert!(owns_provider_execution(&c, &f.a).unwrap());
    c.execute("update agent_runs set claim_epoch='different-lease'", [])
        .unwrap();
    assert!(!owns_provider_execution(&c, &f.a).unwrap());
    assert!(run.yield_queue("late", Some(0), false).is_err());
    let status: String = c
        .query_row("select status from finding_candidate_queue", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(status, "running");
}
#[test]
fn restart_keeps_budget_and_immutable_original_source() {
    let f = Fixture::new();
    let mut run = f.run();
    run.state.budget.reserve(1_000, false).unwrap();
    run.yield_queue("wait", Some(0), false).unwrap();
    let c = Connection::open(&f.path).unwrap();
    c.execute(
        "update finding_candidate_queue set status='running',locked_by='worker'",
        [],
    )
    .unwrap();
    c.execute("update llm_provider_leases set status='active'", [])
        .unwrap();
    let mut changed = f.input.clone();
    changed.initial_state.sources[0] = Snapshot::new(
        "vibe://source".into(),
        "primary".into(),
        "updated source".into(),
    )
    .unwrap();
    let restored = ledger::prepare(&f.path, f.a.clone(), changed).unwrap();
    assert_eq!(restored.state.budget.reserved, 1_000);
    assert_eq!(restored.state.sources[0].text, "重要な条件と独立した根拠");
    assert!(c.execute("delete from agent_snapshots", []).is_err());
    assert!(c
        .execute("update agent_snapshots set content='changed'", [])
        .is_err());
}

#[test]
fn changed_input_generation_or_protocol_invalidates_every_run_write_even_with_an_active_lease() {
    for column in ["input_generation", "protocol_version"] {
        let f = Fixture::new();
        let run = f.run();
        let c = Connection::open(&f.path).unwrap();
        c.execute(
            &format!("update finding_candidate_queue set {column}={column}+1"),
            [],
        )
        .unwrap();
        assert!(!ledger::owns_run(&c, &f.a).unwrap());
        assert!(
            !crate::domains::queue_lifecycle::provider_execution::owns_provider_execution(&c, &f.a)
                .unwrap()
        );
        assert_eq!(
            run.checkpoint("ready", None).unwrap_err(),
            "agent_run_fence_changed"
        );
        assert_eq!(
            super::projection::finish_finding(&run, "sufficient").unwrap_err(),
            "agent_run_fence_changed"
        );
        assert_eq!(
            ledger::prepare(&f.path, f.a.clone(), f.input.clone())
                .err()
                .unwrap(),
            "agent_run_fence_changed"
        );
        assert_eq!(
            c.query_row("select status from finding_candidate_queue", [], |r| r
                .get::<_, String>(
                0
            ))
            .unwrap(),
            "running"
        );
    }
}
#[test]
fn finding_projects_immutable_candidate_bundle_and_protocol_three_covering() {
    let f = Fixture::new();
    let mut run = f.run();
    let source = run.state.sources[0].clone();
    run.state
        .read_ranges
        .push((source.hash.clone(), 0, source.text.len()));
    let candidate = json!({"type":"rule","polarity":"negative","title":"条件を確認する","content":"重要な条件と独立した根拠がなければ採用しない。"});
    run.state.candidates.push(CandidateDraft {
        candidate,
        evidence: vec![EvidenceDraft {
            snapshot_hash: source.hash,
            text: "重要な条件".into(),
            role: "supports".into(),
            from_byte: Some(0),
        }],
        unresolved_questions: vec![],
    });
    assert!(super::projection::finish_finding(&run, "sufficient").unwrap());
    let c = Connection::open(&f.path).unwrap();
    let (count, protocol) = c
        .query_row(
            "select count(*),max(protocol_version) from covering_evidence_queue",
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )
        .unwrap();
    assert_eq!((count, protocol), (1, 3));
    assert!(c.execute("delete from agent_evidence_bundles", []).is_err());
    assert!(c
        .execute("update agent_evidence_bundles set bundle_json='{}'", [])
        .is_err());
    assert!(super::projection::finish_finding(&run, "duplicate commit").is_err());
}
#[test]
fn missing_claimed_provider_metadata_cannot_fall_back_to_legacy() {
    let f = Fixture::new();
    let c = Connection::open(&f.path).unwrap();
    assert!(super::engine::should_run(&c, &json!({}), &f.a).unwrap());
    let config = super::config::Config::default();
    assert_eq!(
        config
            .request_capability(
                &c,
                &f.a.id,
                &crate::domains::queue_lifecycle::episode_executor::LocalLlmTargetConfig {
                    codex: false,
                    quota_db: None,
                    target_id: "target".into(),
                    api_base_url: "http://127.0.0.1:1/v1".into(),
                    api_path: "/v1/chat/completions".into(),
                    model: "model".into()
                }
            )
            .unwrap_err(),
        "provider_metadata_invalid"
    );
}

#[path = "http_tests.rs"]
mod http_tests;

#[test]
fn saved_successful_response_is_applied_after_restart_without_another_request() {
    let f = Fixture::new();
    let mut run = f.run();
    let source = run.state.sources[0].clone();
    run.state
        .read_ranges
        .push((source.hash.clone(), 0, source.text.len()));
    let content=json!({"version":1,"candidates":[],"assessment":null,"questions":[],"evidence":[],"next":{"kind":"finish","reason":"no_signal"}}).to_string();
    let step = run.begin_llm(&f.measurement(), 4_096).unwrap();
    run.finish_llm(
        step,
        &Completion {
            content,
            usage: Some(Usage {
                input: 100,
                output: 10,
                cached_input: 0,
            }),
            finish_reason: Some("stop".into()),
            terminal_error: None,
            request_id: None,
        },
    )
    .unwrap();
    // Crash boundary: response saved, policy projection not yet applied. The original raw source
    // has disappeared; the frozen input remains sufficient to restore the run.
    run.yield_queue("crash boundary", Some(0), false).unwrap();
    let c = Connection::open(&f.path).unwrap();
    c.execute(
        "update finding_candidate_queue set status='running',locked_by='worker'",
        [],
    )
    .unwrap();
    c.execute("update llm_provider_leases set status='active'", [])
        .unwrap();
    drop(c);
    let target = crate::domains::queue_lifecycle::episode_executor::LocalLlmTargetConfig {
        codex: false,
        quota_db: None,
        target_id: "target".into(),
        api_base_url: "http://127.0.0.1:1".into(),
        api_path: "/v1/chat/completions".into(),
        model: "model".into(),
    };
    assert!(!super::engine::tick(
        &f.path,
        f.a.clone(),
        super::engine::TickRequest {
            target: &target,
            key: None,
            settings: &json!({}),
            timeout: 10,
            covering: None,
            source_root: &f.dir
        },
        &mut || {}
    )
    .unwrap());
    let c = Connection::open(&f.path).unwrap();
    let (calls,applied)=c.query_row("select json_extract(state_json,'$.state.budget.calls'),json_extract(state_json,'$.state.appliedStep') from agent_runs",[],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?))).unwrap();
    assert_eq!((calls, applied), (1, 1));
    assert_eq!(
        c.query_row("select count(*) from agent_steps", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn acquisition_restart_reuses_receipt_and_never_repeats_an_unknown_attempt() {
    let f = Fixture::new();
    let run = f.run();
    run.release_for_io().unwrap();
    assert!(matches!(
        super::acquisition::begin(&run, "a").unwrap(),
        super::acquisition::Acquisition::Start { attempt: 1 }
    ));
    assert!(matches!(
        super::acquisition::begin(&run, "a").unwrap(),
        super::acquisition::Acquisition::Unknown
    ));
    super::acquisition::complete(&run, "a", 1, Some(&run.state.sources[0]), false).unwrap();
    match super::acquisition::begin(&run, "a").unwrap() {
        super::acquisition::Acquisition::Saved(snapshot) => {
            assert_eq!(snapshot.hash, run.state.sources[0].hash)
        }
        _ => panic!("saved receipt was not reused"),
    }
    let c = Connection::open(&f.path).unwrap();
    assert!(c
        .execute("update agent_acquisitions set status='failed'", [])
        .is_err());
    assert!(c.execute("delete from agent_acquisitions", []).is_err());
}
#[test]
fn confirmed_acquisition_failure_allows_at_most_one_retry() {
    let f = Fixture::new();
    let run = f.run();
    run.release_for_io().unwrap();
    assert!(matches!(
        super::acquisition::begin(&run, "a").unwrap(),
        super::acquisition::Acquisition::Start { attempt: 1 }
    ));
    super::acquisition::complete(&run, "a", 1, None, true).unwrap();
    assert!(matches!(
        super::acquisition::begin(&run, "a").unwrap(),
        super::acquisition::Acquisition::Start { attempt: 2 }
    ));
    super::acquisition::complete(&run, "a", 2, None, true).unwrap();
    assert!(matches!(
        super::acquisition::begin(&run, "a").unwrap(),
        super::acquisition::Acquisition::Exhausted
    ));
}
#[test]
fn matching_candidate_content_cannot_borrow_another_finding_jobs_bundle() {
    use crate::domains::queue_lifecycle::{
        covering_executor, episode_executor::LocalLlmTargetConfig, types::ClaimedProviderLeaseJob,
    };
    let f = Fixture::new();
    let mut run = f.run();
    let source = run.state.sources[0].clone();
    run.state
        .read_ranges
        .push((source.hash.clone(), 0, source.text.len()));
    run.state.candidates.push(CandidateDraft{candidate:json!({"type":"rule","polarity":"negative","title":"条件を確認する","content":"重要な条件と独立した根拠がなければ採用しない。"}),evidence:vec![EvidenceDraft{snapshot_hash:source.hash,text:"重要な条件".into(),role:"supports".into(),from_byte:Some(0)}],unresolved_questions:vec![]});
    super::projection::finish_finding(&run, "sufficient").unwrap();
    let c = Connection::open(&f.path).unwrap();
    let cover_id: String = c
        .query_row("select id from covering_evidence_queue", [], |r| r.get(0))
        .unwrap();
    c.execute(
        "update covering_evidence_queue set status='running',locked_by='cover-worker'",
        [],
    )
    .unwrap();
    c.execute("insert into llm_provider_leases(id,pool_id,target_id,queue_name,queue_job_id,worker_id,expires_at) values('cover-lease','pool','target','coveringEvidence',?1,'cover-worker',datetime(CURRENT_TIMESTAMP,'+120 seconds'))",[&cover_id]).unwrap();
    let a = ProviderLeaseAssignment {
        id: "cover-lease".into(),
        pool_id: "pool".into(),
        target_id: "target".into(),
        queue_name: "coveringEvidence".into(),
        queue_job_id: cover_id.clone(),
        worker_id: "cover-worker".into(),
    };
    let execution = covering_executor::load_claimed_covering_execution(
        &c,
        ClaimedProviderLeaseJob {
            queue_name: "coveringEvidence".into(),
            id: cover_id,
            provider_lease: a,
        },
        LocalLlmTargetConfig {
            codex: false,
            quota_db: None,
            target_id: "target".into(),
            api_base_url: "http://127.0.0.1:1".into(),
            api_path: "/v1/chat/completions".into(),
            model: "model".into(),
        },
        None,
        50,
        f.dir.clone(),
        covering_executor::CoveringExternalSearchConfig::default(),
    )
    .unwrap();
    let captured = covering_executor::capture_agent_input(&c, &execution).unwrap();
    assert_eq!(captured.identity, run.input.identity);
    assert_eq!(captured.initial_state.sources[0].text, source.text);
    assert!(c
        .execute("update found_candidates set title='overwritten'", [])
        .is_err());
    c.execute("insert into found_candidates(id,finding_job_id,candidate_index,type,title,content,origin) select 'forged','different-job',0,type,title,content,origin from found_candidates limit 1",[]).unwrap();
    let mut forged = execution;
    forged.found_candidate_id = "forged".into();
    assert_eq!(
        covering_executor::capture_agent_input(&c, &forged).unwrap_err(),
        "evidence_bundle_provenance_mismatch"
    );
}

#[test]
fn source_locations_in_model_context_do_not_disclose_signed_url_credentials() {
    let snapshot = Snapshot::new(
        "https://user:password@example.com/docs?access_token=private#secret".into(),
        "primary".into(),
        "原資料".into(),
    )
    .unwrap();
    assert_eq!(snapshot.uri, "https://example.com/docs");
}

#[test]
fn provided_candidate_uses_legacy_defaults_and_zero_llm_calls() {
    let f = Fixture::new();
    let c = Connection::open(&f.path).unwrap();
    c.execute("update finding_candidate_queue set input_kind='provided_candidate',source_kind='knowledge_candidate',payload=?1",[json!({"title":"  再試行に条件を付ける  ","body":"  結果が不明な処理を無条件に再送してはいけない。  "}).to_string()]).unwrap();
    let input =
        crate::domains::queue_lifecycle::finding_executor::capture_agent_input(&c, "job").unwrap();
    assert!(input.provided);
    assert_eq!(input.initial_state.candidates[0].candidate["type"], "rule");
    assert_eq!(
        input.initial_state.candidates[0].candidate["polarity"],
        "positive"
    );
    let run = ledger::prepare(&f.path, f.a.clone(), input).unwrap();
    super::projection::finish_finding(&run, "provided_candidate").unwrap();
    assert_eq!(
        c.query_row("select count(*) from agent_steps", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn provided_candidate_preserves_annotations_but_cannot_forge_host_lineage_or_scope() {
    let f = Fixture::new();
    let c = Connection::open(&f.path).unwrap();
    let payload = json!({"title":"条件を確認する","body":"重要な条件を確認する。","intentTags":["review"," review "],
        "applicability":{"general":false,"technologies":["Rust"],"changeTypes":["fix"],"domains":["queue"]},
        "origin":{"referenceKey":"user-reference","agentRuntime":{"runId":"forged"},"projectIdentity":{"repoKey":"foreign"},"apiKey":"never-copy"}});
    c.execute("update finding_candidate_queue set input_kind='provided_candidate',source_kind='knowledge_candidate',payload=?1",[payload.to_string()]).unwrap();
    let input =
        crate::domains::queue_lifecycle::finding_executor::capture_agent_input(&c, "job").unwrap();
    let run = ledger::prepare(&f.path, f.a.clone(), input).unwrap();
    super::projection::finish_finding(&run, "provided_candidate").unwrap();
    let origin: String = c
        .query_row("select origin from found_candidates", [], |r| r.get(0))
        .unwrap();
    assert!(!origin.contains("never-copy"));
    let origin: Value = serde_json::from_str(&origin).unwrap();
    assert_eq!(origin["referenceKey"], "user-reference");
    assert_eq!(origin["intentTags"], json!(["review"]));
    assert_eq!(origin["appliesTo"]["technologies"], json!(["Rust"]));
    assert_eq!(origin["applicabilityGeneral"], false);
    assert_eq!(origin["agentRuntime"]["runId"], run.id);
    assert!(origin.get("projectIdentity").is_none());

    let f = Fixture::new();
    let c = Connection::open(&f.path).unwrap();
    let mut payload = payload;
    payload["applicability"]["repoKey"] = json!("foreign");
    c.execute("update finding_candidate_queue set input_kind='provided_candidate',source_kind='knowledge_candidate',payload=?1",[payload.to_string()]).unwrap();
    assert_eq!(
        crate::domains::queue_lifecycle::finding_executor::capture_agent_input(&c, "job")
            .unwrap_err(),
        "provided_applicability_scope_mismatch"
    );
}
#[test]
fn future_protocol_is_never_downgraded_to_the_current_agent_or_legacy_worker() {
    let f = Fixture::new();
    let c = Connection::open(&f.path).unwrap();
    c.execute("update finding_candidate_queue set protocol_version=4", [])
        .unwrap();
    assert_eq!(
        super::engine::should_run(&c, &json!({}), &f.a).unwrap_err(),
        "agent_protocol_unsupported"
    );
    assert_eq!(
        c.query_row(
            "select protocol_version from finding_candidate_queue",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        4
    );
}

#[test]
fn zero_candidates_with_unread_primary_ranges_is_insufficient_context_not_no_signal() {
    let f = Fixture::new();
    let mut run = f.run();
    run.state
        .read_ranges
        .push((run.state.sources[0].hash.clone(), 0, 6));
    assert!(!super::projection::finish_finding(&run, "no_signal").unwrap());
    let c = Connection::open(&f.path).unwrap();
    let (status, reason) = c
        .query_row(
            "select status,last_outcome_kind from finding_candidate_queue",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .unwrap();
    assert_eq!(
        (status.as_str(), reason.as_str()),
        ("paused", "insufficient_context")
    );
}

#[test]
fn activation_pins_new_enqueues_before_a_legacy_worker_can_claim_them() {
    let f = Fixture::new();
    let c = Connection::open(&f.path).unwrap();
    c.execute(
        "insert into settings(id,namespace,key,value) values('runtime-settings','runtime','settings.v1',?1)",
        [json!({"advanced":{"agentRuntime":{"enabled":true}}}).to_string()],
    )
    .unwrap();
    c.execute("insert into finding_candidate_queue(id,source_key,source_kind,source_uri) values('new-job','source','vibe_memory','vibe://source')",[]).unwrap();
    assert_eq!(
        c.query_row(
            "select protocol_version from finding_candidate_queue where id='new-job'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        3
    );
    assert_eq!(c.query_row("select count(*) from finding_candidate_queue where id='new-job' and protocol_version<3",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    c.execute("update settings set value='{}'", []).unwrap();
    assert_eq!(
        c.query_row(
            "select protocol_version from finding_candidate_queue where id='new-job'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        3
    );
}

#[test]
fn schema_ten_migration_preserves_legacy_queue_data_and_adds_agent_fences() {
    crate::domains::vector_index::service::register_sqlite_vec();
    let mut c = Connection::open_in_memory().unwrap();
    c.execute_batch(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test/fixtures/agent-runtime/schema-10-finding.sql"
    )))
    .unwrap();
    sqlite_writer::schema::migrate(&mut c, 3).unwrap();
    let (source,protocol,generation)=c.query_row("select source_key,protocol_version,input_generation from finding_candidate_queue where id='legacy-source'",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?))).unwrap();
    assert_eq!((source.as_str(), protocol, generation), ("source", 1, 0));
    assert_eq!(
        sqlite_writer::schema::schema_revision(&c).unwrap(),
        sqlite_writer::schema::CURRENT_SCHEMA_REVISION
    );
    assert_eq!(
        c.query_row(
            "select count(*) from sqlite_master where type='table' and name='agent_runs'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}

#[test]
fn native_preview_does_not_publish_and_reprocessing_preserves_immutable_old_candidates() {
    let f = Fixture::new();
    let mut run = f.run();
    let s = run.state.sources[0].clone();
    run.state
        .read_ranges
        .push((s.hash.clone(), 0, s.text.len()));
    run.state.candidates.push(super::policy::CandidateDraft{candidate:json!({"type":"rule","polarity":"positive","title":"開始前に条件を確認","content":"処理開始前に重要な条件を確認する。"}),evidence:vec![super::policy::EvidenceDraft{snapshot_hash:s.hash,text:"重要な条件".into(),role:"supports".into(),from_byte:Some(0)}],unresolved_questions:vec![]});
    run.input.preview = true;
    super::projection::finish_finding(&run, "sufficient").unwrap();
    let c = Connection::open(&f.path).unwrap();
    assert_eq!(
        c.query_row("select count(*) from found_candidates", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row("select count(*) from covering_evidence_queue", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    super::ingress::handle(
        &f.path,
        json!({"operation":"reprocess","queue":"findingCandidate","jobId":"job"}),
    )
    .unwrap();
    assert_eq!(
        c.query_row(
            "select input_generation from finding_candidate_queue where id='job'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        c.query_row("select count(*) from agent_runs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn gateway_uses_a_dedicated_principal_and_refuses_arbitrary_models_before_claiming_a_slot() {
    let f = Fixture::new();
    let c = Connection::open(&f.path).unwrap();
    c.execute("insert into settings(id,namespace,key,value) values('agent-settings','runtime','settings.v1',?1)",[json!({"settings":{"advanced":{"agentRuntime":{"enabled":true,"research":{"baseUrl":"http://127.0.0.1:4310/api/integrations/contextstill/agent/v1","credentialKey":"researchKey","gatewayCredentialKey":"gatewayKey","gatewayUrl":"http://127.0.0.1:1/integrations/deepstill/agent/v1/chat/completions"}}}}}).to_string()]).unwrap();
    c.execute("insert into settings(id,namespace,key,value) values('gateway-key','runtime.secret','gatewayKey',?1)",[json!({"value":"dedicated-gateway-token"}).to_string()]).unwrap();
    let body = json!({"model":"another-model","stream":false});
    assert_eq!(
        super::gateway::handle(&f.path, "writer-token", body.clone()).unwrap_err(),
        "research_gateway_unauthorized"
    );
    assert_eq!(
        super::gateway::handle(&f.path, "dedicated-gateway-token", body).unwrap_err(),
        "research_gateway_request_invalid"
    );
    assert_eq!(
        c.query_row("select count(*) from agent_research_requests", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn unknown_child_provider_request_is_not_recovered_as_an_idle_queue_lease() {
    let f = Fixture::new();
    let c = Connection::open(&f.path).unwrap();
    c.execute("insert into llm_provider_leases(id,pool_id,target_id,queue_name,queue_job_id,worker_id,expires_at,heartbeat_at) values('unknown-child','pool','child-target','agentResearch','delegation','worker',datetime(CURRENT_TIMESTAMP,'-1 hour'),datetime(CURRENT_TIMESTAMP,'-1 hour'))",[]).unwrap();
    crate::domains::queue_lifecycle::service::recover_stale_provider_leases_for_connection(
        &c, "pool", 30,
    )
    .unwrap();
    assert_eq!(
        c.query_row(
            "select status from llm_provider_leases where id='unknown-child'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "active"
    );
}

#[path = "research_tests.rs"]
mod research_tests;

#[test]
fn native_covering_imports_stored_legacy_candidates_only_when_writing() {
    let f = Fixture::new();
    let c = Connection::open(&f.path).unwrap();
    c.execute("insert into distillation_target_states(id,target_kind,target_key,source_uri,distillation_version,priority_group,sort_key,metadata) values('target','vibe_memory','source','vibe://source','v1','vibe','1','{\"repoKey\":\"repo-a\"}')",[]).unwrap();
    c.execute("insert into find_candidate_results(id,target_state_id,candidate_index,title,content,origin) values('legacy-candidate','target',0,'確認条件','開始前に入力条件を確認する','{\"type\":\"rule\"}')",[]).unwrap();
    let preview = super::ingress::handle(
        &f.path,
        json!({"operation":"covering","candidateId":"legacy-candidate","preview":true}),
    )
    .unwrap();
    assert!(preview["jobId"].as_str().is_some());
    assert_eq!(
        c.query_row("select count(*) from found_candidates", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let written = super::ingress::handle(
        &f.path,
        json!({"operation":"covering","candidateId":"legacy-candidate","preview":false}),
    )
    .unwrap();
    assert_ne!(preview["jobId"], written["jobId"]);
    assert_eq!(
        c.query_row("select count(*) from found_candidates", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        c.query_row("select count(*) from find_candidate_results", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
