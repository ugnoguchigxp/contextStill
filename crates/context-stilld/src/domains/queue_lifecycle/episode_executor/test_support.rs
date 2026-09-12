use super::types::{CanonicalEpisode, EpisodeScores};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::thread;

pub(super) fn insert_two_segment_memory(connection: &Connection) {
    connection
            .execute(
                "
                insert into vibe_memories (id, session_id, content, metadata, created_at)
                values ('memory-1', 'session-1', 'Rust queue executor should save each completed episode segment before continuing to later LocalLLM calls.', '{\"projectIdentity\":{\"contractVersion\":1,\"classificationStatus\":\"classified\",\"scope\":\"repo\",\"scopeMode\":\"project\",\"repoKey\":\"contextstill\",\"repoPath\":\"/repo\"}}', '2026-06-23T00:00:00.000Z')
                ",
                [],
            )
            .unwrap();
    connection
            .execute(
                "
                insert into agent_diff_entries (
                  id, vibe_memory_id, file_path, diff_hunk, change_type, language,
                  symbol_name, symbol_kind, signature, start_line, end_line, created_at
                ) values (
                  'diff-1', 'memory-1', 'src/first.rs',
                  'Implemented the first segment of EpisodeDistiller incremental persistence and verified it writes EpisodeCard rows immediately.',
                  'modify', 'rust', 'first', 'function', 'fn first()', 10, 20, '2026-06-23T00:01:00.000Z'
                )
                ",
                [],
            )
            .unwrap();
    connection
            .execute(
                "
                insert into agent_diff_entries (
                  id, vibe_memory_id, file_path, diff_hunk, change_type, language,
                  symbol_name, symbol_kind, signature, start_line, end_line, created_at
                ) values (
                  'diff-2', 'memory-1', 'src/second.rs',
                  'Continued with a second segment so the worker must perform a later LocalLLM call after saving the first segment.',
                  'modify', 'rust', 'second', 'function', 'fn second()', 30, 40, '2026-06-23T00:02:00.000Z'
                )
                ",
                [],
            )
            .unwrap();
}

pub(super) fn insert_episode_job(connection: &Connection, job_id: &str, metadata: Value) {
    connection
            .execute(
                "
                insert into episode_distiller_queue (
                  id, source_kind, source_key, status, priority, attempt_count, max_attempts,
                  locked_by, locked_at, heartbeat_at, metadata, created_at, updated_at
                ) values (
                  ?1, 'vibe_memory', 'memory-1', 'running', 10, 0, 2,
                  'worker-1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
                ",
                params![job_id, metadata.to_string()],
            )
            .unwrap();
}

pub(super) fn create_episode_runtime_tables(connection: &Connection) {
    connection
        .execute_batch(
            r#"
                create table vibe_memories (
                  id text primary key,
                  session_id text not null,
                  content text not null,
                  metadata text,
                  created_at text not null
                );
                create table episode_distiller_queue (
                  id text primary key,
                  source_kind text not null,
                  source_key text not null,
                  status text not null,
                  priority integer not null default 0,
                  attempt_count integer not null default 0,
                  max_attempts integer not null default 2,
                  locked_by text,
                  locked_at text,
                  heartbeat_at text,
                  next_run_at text,
                  completed_at text,
                  last_error text,
                  last_outcome_kind text,
                  metadata text,
                  created_at text not null,
                  updated_at text not null
                );
                create table episode_cards (
                  id text primary key,
                  title text not null,
                  situation text not null,
                  observations text not null,
                  action text not null,
                  outcome text not null,
                  lesson text not null,
                  applicability text not null,
                  anti_applicability text not null,
                  domains text not null,
                  technologies text not null,
                  change_types text not null,
                  tools text not null,
                  classification_status text not null,
                  scope text not null,
                  project_ref text,
                  repo_path text,
                  repo_key text,
                  source_kind text not null,
                  source_key text not null,
                  outcome_kind text not null,
                  importance integer not null,
                  confidence integer not null,
                  compile_use_count integer not null default 0,
                  decision_use_count integer not null default 0,
                  status text not null,
                  stale_at text,
                  metadata text not null,
                  created_at text not null,
                  updated_at text not null
                );
                create table episode_refs (
                  id text primary key,
                  episode_card_id text not null,
                  ref_kind text not null,
                  ref_value text not null,
                  locator text,
                  query_hint text,
                  metadata text not null,
                  created_at text not null
                );
                create table distillation_queue_events (
                  id text primary key,
                  queue_name text not null,
                  queue_job_id text not null,
                  event_type text not null,
                  message text,
                  metadata text not null default '{}',
                  created_at text not null default CURRENT_TIMESTAMP
                );
                create table audit_logs (
                  id text primary key,
                  event_type text not null,
                  actor text not null,
                  payload text not null default '{}',
                  created_at text not null
                );
                create table llm_provider_leases (
                  id text primary key,
                  pool_id text not null,
                  target_id text not null,
                  queue_name text not null,
                  queue_job_id text not null,
                  worker_id text not null,
                  status text not null,
                  locked_at text not null,
                  heartbeat_at text not null,
                  expires_at text not null,
                  released_at text,
                  release_reason text,
                  metadata text not null default '{}',
                  created_at text not null,
                  updated_at text not null
                );
                create table agent_diff_entries (
                  id text primary key,
                  vibe_memory_id text not null,
                  file_path text not null,
                  diff_hunk text not null,
                  change_type text,
                  language text,
                  symbol_name text,
                  symbol_kind text,
                  signature text,
                  start_line integer,
                  end_line integer,
                  created_at text not null
                );
                "#,
        )
        .unwrap();
}

pub(super) fn test_canonical_episode() -> CanonicalEpisode {
    CanonicalEpisode {
        title: "Atomic EpisodeCard insert".to_string(),
        context: "Rust should not leave partial EpisodeCard rows.".to_string(),
        intent: "Protect retry semantics.".to_string(),
        key_decisions: vec!["Use one transaction for card, FTS, and refs.".to_string()],
        action_taken: "Wrapped EpisodeCard persistence in BEGIN IMMEDIATE.".to_string(),
        outcome: "Partial inserts roll back on downstream failure.".to_string(),
        failed_approach: String::new(),
        reusable_lesson: "Queue completion must follow confirmed persistence.".to_string(),
        useful_future_triggers: vec!["EpisodeCard persistence failure".to_string()],
        open_loops: Vec::new(),
        generation_kind: "task_episode".to_string(),
        outcome_kind: "success".to_string(),
        domains: vec!["contextStill".to_string()],
        technologies: vec!["Rust".to_string(), "SQLite".to_string()],
        change_types: vec!["runtime".to_string()],
        tools: vec!["cargo".to_string()],
        scores: EpisodeScores {
            importance: 85,
            confidence: 75,
            reusability: 80,
            decision_density: 70,
            failure_value: 65,
            causal_clarity: 75,
            project_specificity: 80,
            evidence_quality: 70,
            compression_quality: 70,
            staleness_risk: 20,
        },
    }
}

pub(super) fn llm_response_body(title: &str, generation_kind: &str) -> String {
    json!({
            "choices": [{"finish_reason":"stop",
                "message": {
                    "content": json!([{
                        "title": title,
                        "context": "Rust EpisodeDistiller is processing segmented source evidence.",
                        "intent": "Persist useful EpisodeCards as each segment completes.",
                        "keyDecisions": ["Save segment output immediately instead of waiting for job completion."],
                        "actionTaken": "The Rust worker persisted a segment result and updated queue progress metadata.",
                        "outcome": "Completed segment output remains available even if a later segment needs retry.",
                        "failedApproach": "",
                        "reusableLesson": "Long-running LLM jobs should publish durable partial outputs at natural boundaries.",
                        "usefulFutureTriggers": ["EpisodeDistiller long run", "queue retry after partial progress"],
                        "openLoops": [],
                        "generationKind": generation_kind,
                        "outcomeKind": "success",
                        "domains": ["contextStill"],
                        "technologies": ["Rust", "SQLite", "LocalLLM"],
                        "changeTypes": ["runtime"],
                        "tools": ["cargo"],
                        "scores": {
                            "importance": 86,
                            "confidence": 76,
                            "reusability": 82,
                            "decision_density": 74,
                            "failure_value": 60,
                            "causal_clarity": 78,
                            "project_specificity": 82,
                            "evidence_quality": 75,
                            "compression_quality": 72,
                            "staleness_risk": 25
                        }
                    }]).to_string()
                }
            }]
        })
        .to_string()
}

pub(super) fn spawn_single_response_server(status: u16, body: String) -> String {
    spawn_response_sequence_server(vec![(status, body)])
}

pub(super) fn spawn_response_sequence_server(responses: Vec<(u16, String)>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    thread::spawn(move || {
        for (status, body) in responses {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            let mut content_length = 0;
            loop {
                line.clear();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("content-length") {
                        content_length = value.trim().parse::<usize>().unwrap();
                    }
                }
            }
            let mut request_body = vec![0; content_length];
            reader.read_exact(&mut request_body).unwrap();
            let request: Value = serde_json::from_slice(&request_body).unwrap();
            assert_eq!(request["response_format"]["type"], "json_schema");
            assert_eq!(request["response_format"]["json_schema"]["strict"], true);
            assert!(matches!(
                request["response_format"]["json_schema"]["name"].as_str(),
                Some("episode" | "episode_duplicate")
            ));
            assert!(matches!(
                request["max_tokens"].as_i64(),
                Some(1536 | 4096 | 8192)
            ));
            let reason = if status == 200 {
                "OK"
            } else {
                "Service Unavailable"
            };
            let response = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
            stream.write_all(response.as_bytes()).unwrap();
        }
    });
    format!("http://{address}")
}
