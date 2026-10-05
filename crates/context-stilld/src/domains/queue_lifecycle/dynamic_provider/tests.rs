#![cfg(test)]

use super::super::executor::{executor_priority_queues_for_pool, provider_pools};
use super::*;

fn larm_connection_config(id: &str) -> LarmConnectionConfig {
    let settings = json!({
        "providers": {
            "larm-agent-connection": {
                "enabled": true,
                "connections": [{
                    "id": id,
                    "controlBaseUrl": "http://127.0.0.1:9810",
                    "agentProfile": "contextstill-background",
                    "audience": "saaa-desktop",
                    "availabilityPollMs": 5000,
                    "availabilityTimeoutMs": 2000,
                    "controlTimeoutMs": 5000,
                    "readyTimeoutMs": 180000,
                    "ttlSeconds": 900,
                    "requestTimeoutMs": 300000
                }]
            }
        }
    });
    LarmConnectionConfig::from_settings(&settings, id)
        .unwrap()
        .expect("enabled test LARM connection must be present")
}

#[test]
fn draft_probe_cannot_add_a_fifth_request_or_release_queue_identity() {
    let path = std::env::temp_dir().join(format!("settings-probe-busy-{}", std::process::id()));
    let config=LarmConnectionConfig::from_settings(&json!({"providers":{"larm-agent-connection":{"enabled":true,"connections":[{"id":"busy-settings","controlBaseUrl":"http://127.0.0.1:12345","audience":"same-host","availabilityPollMs":5000,"availabilityTimeoutMs":2000,"controlTimeoutMs":5000,"readyTimeoutMs":180000,"ttlSeconds":900,"requestTimeoutMs":300000,"maxConcurrentRequests":4}]}}}),"busy-settings").unwrap().unwrap();
    let key = larm_manager_registry_key(&path, &config.id);
    let entry = Arc::new(Mutex::new(LarmManagerEntry {
        manager: None,
        checked_out: false,
        draining: false,
        cleanup_failed: false,
        active_requests: 4,
    }));
    LARM_CONNECTION_MANAGERS
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .unwrap()
        .insert(key.clone(), entry.clone());
    assert_eq!(
        settings_provider_probe(&path, config, false).unwrap_err(),
        "provider_slot_busy"
    );
    assert_eq!(entry.lock().unwrap().active_requests, 4);
    LARM_CONNECTION_MANAGERS
        .get()
        .unwrap()
        .lock()
        .unwrap()
        .remove(&key);
}

#[test]
fn manager_checkout_keeps_one_manager_per_runtime_connection() {
    let config = larm_connection_config("checkout-registry-test");
    let scope_path = std::env::temp_dir().join(format!(
        "context-stilld-checkout-registry-test-{}.sqlite",
        unique_suffix()
    ));
    let scope = scope_path.as_path();

    let first = LarmManagerCheckout::take(scope, &config).unwrap().unwrap();
    assert!(LarmManagerCheckout::take(scope, &config).unwrap().is_none());

    let first_entry = first.entry.clone();
    drop(first);

    let second = LarmManagerCheckout::take(scope, &config).unwrap().unwrap();
    assert!(Arc::ptr_eq(&first_entry, &second.entry));
}

#[test]
fn shared_checkout_waits_while_control_checkout_owns_manager() {
    let config = larm_connection_config("control-race-test");
    let entry = Arc::new(Mutex::new(LarmManagerEntry {
        manager: None,
        checked_out: true,
        draining: false,
        cleanup_failed: false,
        active_requests: 0,
    }));
    let mut checkout = LarmManagerCheckout {
        entry: entry.clone(),
        manager: None,
        request_permit: false,
        expected_config: config,
    };
    let (result, target) = checkout.reconcile(true).unwrap();
    assert!(!result.ready);
    assert!(target.is_none());
    assert_eq!(entry.lock().unwrap().active_requests, 0);
    assert!(entry.lock().unwrap().checked_out);
}

#[test]
fn shared_checkout_rejects_reconfigured_manager_before_admission() {
    let config = larm_connection_config("settings-race-test");
    let mut changed = config.clone();
    changed.ttl_seconds = 1200;
    let entry = Arc::new(Mutex::new(LarmManagerEntry {
        manager: Some(LarmConnectionManager::new(changed).unwrap()),
        checked_out: false,
        draining: false,
        cleanup_failed: false,
        active_requests: 0,
    }));
    let mut checkout = LarmManagerCheckout {
        entry: entry.clone(),
        manager: None,
        request_permit: false,
        expected_config: config,
    };
    assert!(!checkout.reconcile(true).unwrap().0.ready);
    assert_eq!(entry.lock().unwrap().active_requests, 0);
}

#[test]
fn checkout_retries_failed_cleanup_before_admitting_a_new_connection() {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut config = larm_connection_config("cleanup-retry-test");
    config.control_base_url = format!("http://{}", listener.local_addr().unwrap());
    config.control_bearer_token = Some(Zeroizing::new("test-control-token".into()));
    let server = std::thread::spawn(move || {
        for status in ["503 Service Unavailable", "204 No Content"] {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("DELETE /v1/agent-connections/retained-connection "));
            loop {
                line.clear();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
            }
            stream
                .write_all(
                    format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .as_bytes(),
                )
                .unwrap();
        }
    });
    let scope = std::env::temp_dir().join(format!(
        "context-stilld-cleanup-retry-{}.sqlite",
        unique_suffix()
    ));
    let state_path = scope.with_extension(format!("larm-{}.json", config.id));
    std::fs::write(
        &state_path,
        json!({"key":"retained-key","id":"retained-connection","createAttempted":true}).to_string(),
    )
    .unwrap();
    let checkout = LarmManagerCheckout::take(&scope, &config).unwrap().unwrap();
    let entry = checkout.entry.clone();
    drop(checkout);
    release_unreferenced_larm_managers(Some(&scope), &BTreeSet::new());
    assert!(entry.lock().unwrap().cleanup_failed);

    let checkout = LarmManagerCheckout::take(&scope, &config).unwrap().unwrap();
    assert!(!entry.lock().unwrap().cleanup_failed);
    assert!(!entry.lock().unwrap().draining);
    assert!(checkout.manager.as_ref().unwrap().connection_id().is_none());
    drop(checkout);
    server.join().unwrap();
    std::fs::remove_file(state_path).unwrap();
}

fn four_queue_settings() -> Value {
    let route = json!({"kind":"larm-agent-connection","connectionId":"four-queues"});
    json!({"providers":{"larm-agent-connection":{"enabled":true,"connections":[{
            "id":"four-queues","controlBaseUrl":"http://127.0.0.1:9810","audience":"same-host",
            "availabilityPollMs":5000,"availabilityTimeoutMs":2000,"controlTimeoutMs":5000,"readyTimeoutMs":180000,
            "ttlSeconds":900,"requestTimeoutMs":300000,"maxConcurrentRequests":4
        }]}},"taskRouting":{"findCandidate":{"source":route,"vibe":route},"episodeDistiller":route,
            "coverEvidence":{"sourceSupport":route,"externalEvidence":route,"mcpEvidence":route},"landscapeCuration":route}})
}

#[test]
fn claim_revalidation_observes_pause_route_and_connection_changes() {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            "create table settings(namespace text,key text,value text,unique(namespace,key));",
        )
        .unwrap();
    let mut settings = four_queue_settings();
    let expected = LarmConnectionConfig::from_settings(&settings, "four-queues")
        .unwrap()
        .unwrap();
    connection
        .execute(
            "insert into settings values('runtime','settings.v1',?1)",
            [settings.to_string()],
        )
        .unwrap();
    assert_eq!(
        revalidated_claim_queues(&connection, &expected, "all", &[])
            .unwrap()
            .len(),
        4
    );
    connection.execute("insert into settings values('runtime','queue.controls.v1',?1)",[json!({"queues":{"findingCandidate":{"paused":true},"episodeDistiller":{"paused":true}}}).to_string()]).unwrap();
    let queues = revalidated_claim_queues(&connection, &expected, "all", &[]).unwrap();
    assert_eq!(
        queues
            .iter()
            .map(|s| s.queue_name.as_str())
            .collect::<Vec<_>>(),
        vec!["coveringEvidence", "landscapeCuration"]
    );
    settings["taskRouting"]["coverEvidence"]["externalEvidence"] = json!({"provider":"local-llm"});
    connection
        .execute(
            "update settings set value=?1 where key='settings.v1'",
            [settings.to_string()],
        )
        .unwrap();
    assert_eq!(
        revalidated_claim_queues(&connection, &expected, "all", &[]).unwrap()[0].queue_name,
        "landscapeCuration"
    );
    settings["providers"]["larm-agent-connection"]["connections"][0]["maxConcurrentRequests"] =
        json!(3);
    connection
        .execute(
            "update settings set value=?1 where key='settings.v1'",
            [settings.to_string()],
        )
        .unwrap();
    assert!(revalidated_claim_queues(&connection, &expected, "all", &[])
        .unwrap()
        .is_empty());
}

#[test]
fn preparation_due_check_uses_covering_mode_polarity_and_canary_ids() {
    let connection = Connection::open_in_memory().unwrap();
    super::super::test_support::create_provider_claim_queue_table(
        &connection,
        "covering_evidence_queue",
    );
    connection.execute_batch(r#"alter table covering_evidence_queue add column found_candidate_id text;create table found_candidates(id text,origin text);insert into found_candidates values('positive','{"polarity":"positive"}');insert into covering_evidence_queue(id,status,created_at,updated_at,provider_policy,found_candidate_id) values('positive-job','pending',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'default','positive');"#).unwrap();
    let original = dynamic_provider_plans(&four_queue_settings(), &HashSet::new())
        .unwrap()
        .remove(0);
    for (mode, ids, expected) in [
        ("all", vec![], true),
        ("off", vec![], false),
        ("negative", vec![], false),
        ("canary", vec![], false),
        ("canary", vec!["other-job".into()], false),
        ("canary", vec!["positive-job".into()], true),
        ("invalid", vec![], false),
    ] {
        let mut plan = original.clone();
        apply_covering_mode(&mut plan, mode, &ids);
        assert_eq!(
            dynamic_plan_has_runnable_job(&connection, &plan).unwrap(),
            expected,
            "{mode} {ids:?}"
        );
    }
}

#[test]
fn builds_row_aware_larm_claim_plan() {
    let settings = json!({
        "providers": {
            "larm-agent-connection": {
                "enabled": true,
                "connections": [{
                    "id": "contextstill-background",
                    "controlBaseUrl": "http://127.0.0.1:9810",
                    "agentProfile": "contextstill-background",
                    "audience": "saaa-desktop",
                    "availabilityPollMs": 5000,
                    "availabilityTimeoutMs": 2000,
                    "controlTimeoutMs": 5000,
                    "readyTimeoutMs": 180000,
                    "ttlSeconds": 900,
                    "requestTimeoutMs": 300000
                }]
            }
        },
        "taskRouting": {
            "findCandidate": {
                "source": {"kind": "larm-agent-connection", "connectionId": "contextstill-background"},
                "vibe": {"kind": "larm-agent-connection", "connectionId": "contextstill-background"}
            },
            "episodeDistiller": {"kind": "larm-agent-connection", "connectionId": "contextstill-background"}
        }
    });

    let plans = dynamic_provider_plans(&settings, &HashSet::new()).unwrap();

    assert_eq!(plans.len(), 1);
    assert_eq!(
        plans[0].pool.pool_id,
        "larm-agent-connection:contextstill-background"
    );
    assert_eq!(plans[0].priority_queues.len(), 2);
    assert_eq!(plans[0].priority_queues[0].queue_name, "findingCandidate");
    assert_eq!(
        plans[0].priority_queues[0].allowed_route_values,
        Some(vec![
            "knowledge_candidate".to_string(),
            "web_ingest".to_string(),
            "wiki_file".to_string(),
            "source".to_string(),
            "vibe_memory".to_string(),
        ])
    );
    assert_eq!(plans[0].priority_queues[1].queue_name, "episodeDistiller");

    let startup_lines = provider_startup_selection_lines(&settings).unwrap();
    assert_eq!(startup_lines.len(), 1);
    assert!(startup_lines[0].contains("providerKind=larm-agent-connection"));
    assert!(startup_lines[0].contains("provider=contextstill-background"));
    assert!(startup_lines[0].contains("controlHost=127.0.0.1:9810"));
    assert!(startup_lines[0].contains("agentProfile=contextStill"));
    assert!(startup_lines[0].contains("audience=same-host"));
    assert!(startup_lines[0]
        .contains("routes=findCandidate.source,findCandidate.vibe,episodeDistiller"));
    assert!(!startup_lines[0].to_ascii_lowercase().contains("token"));
}

#[test]
fn four_queue_types_share_one_dynamic_connection_capacity() {
    let route = json!({"kind":"larm-agent-connection","connectionId":"four-queues"});
    let settings = json!({"providers":{"larm-agent-connection":{"enabled":true,"connections":[{
            "id":"four-queues","controlBaseUrl":"http://127.0.0.1:9810","audience":"same-host",
            "availabilityPollMs":5000,"availabilityTimeoutMs":2000,"controlTimeoutMs":5000,"readyTimeoutMs":180000,
            "ttlSeconds":900,"requestTimeoutMs":300000,"maxConcurrentRequests":4
        }]}},"taskRouting":{"findCandidate":{"source":route,"vibe":route},"episodeDistiller":route,
            "coverEvidence":{"sourceSupport":route,"externalEvidence":route,"mcpEvidence":route},"landscapeCuration":route}});
    let plans = dynamic_provider_plans(&settings, &HashSet::new()).unwrap();
    assert_eq!(plans.len(), 1);
    assert_eq!(plans[0].pool.max_concurrent, 4);
    assert_eq!(
        plans[0]
            .priority_queues
            .iter()
            .map(|s| s.queue_name.as_str())
            .collect::<Vec<_>>(),
        vec![
            "findingCandidate",
            "coveringEvidence",
            "episodeDistiller",
            "landscapeCuration"
        ]
    );
    assert_eq!(dynamic_worker_capacity(&settings).unwrap(), 4);
}

#[test]
fn startup_log_identifies_explicit_legacy_static_routes() {
    let settings = json!({
        "taskRouting": {
            "findCandidate": {
                "source": {"kind": "static", "provider": "local-llm", "fallback": []},
                "vibe": {"provider": "local-llm", "fallback": []}
            },
            "episodeDistiller": {"kind": "static", "provider": "local-llm", "fallback": []}
        }
    });

    let startup_lines = provider_startup_selection_lines(&settings).unwrap();

    assert_eq!(startup_lines.len(), 1);
    assert!(startup_lines[0].contains("providerKind=static provider=local-llm"));
    assert!(startup_lines[0].contains("controlHost=- agentProfile=- audience=-"));
}

#[test]
fn static_rust_executor_does_not_claim_larm_dynamic_routes() {
    let settings = json!({
        "providerPools": [{
            "id": "dynamic-background",
            "enabled": true,
            "targets": [{
                "provider": "larm-agent-connection",
                "connectionId": "contextstill-background"
            }],
            "maxConcurrent": 1
        }],
        "taskRouting": {
            "findCandidate": {
                "source": {
                    "kind": "larm-agent-connection",
                    "connectionId": "contextstill-background"
                },
                "vibe": {
                    "kind": "larm-agent-connection",
                    "connectionId": "contextstill-background"
                }
            }
        }
    });

    assert!(provider_pools(&settings).is_empty());
    assert!(
        executor_priority_queues_for_pool(&settings, "dynamic-background", &HashSet::new())
            .is_empty()
    );
}
#[test]
fn static_rust_executor_does_not_partially_execute_a_mixed_larm_pool() {
    let settings = json!({
        "providerPools": [{
            "id": "mixed-background",
            "enabled": true,
            "targets": [
                {
                    "provider": "local-llm",
                    "localLlmModelId": "local-a"
                },
                {
                    "provider": "larm-agent-connection",
                    "connectionId": "contextstill-background"
                }
            ],
            "maxConcurrent": 2
        }],
        "taskRouting": {
            "episodeDistiller": {
                "provider": "local-llm",
                "providerPoolId": "mixed-background",
                "fallback": []
            }
        }
    });

    assert!(provider_pools(&settings).is_empty());
}

#[test]
fn static_rust_executor_does_not_claim_a_dynamic_vibe_row_from_a_static_source_pool() {
    let settings = json!({
        "providerPools": [{
            "id": "static-source",
            "enabled": true,
            "targets": [{
                "provider": "local-llm",
                "localLlmModelId": "local-a"
            }],
            "maxConcurrent": 1
        }],
        "taskRouting": {
            "findCandidate": {
                "source": {
                    "provider": "local-llm",
                    "providerPoolId": "static-source",
                    "fallback": []
                },
                "vibe": {
                    "kind": "larm-agent-connection",
                    "connectionId": "contextstill-background"
                }
            }
        }
    });

    assert!(
        executor_priority_queues_for_pool(&settings, "static-source", &HashSet::new()).is_empty()
    );
}

#[test]
fn refresh_cannot_renew_until_all_four_old_credential_requests_have_drained() {
    let config = larm_connection_config("renew-drain-test");
    let path = std::env::temp_dir().join(format!("renew-drain-{}.sqlite", unique_suffix()));
    let initial = LarmManagerCheckout::take(&path, &config).unwrap().unwrap();
    let entry = initial.entry.clone();
    drop(initial);
    entry.lock().unwrap().active_requests = 4;
    for remaining in (1..=4).rev() {
        entry.lock().unwrap().active_requests = remaining;
        assert!(
            LarmManagerCheckout::take_for_reconcile(&path, &config, true)
                .unwrap()
                .is_none()
        );
        assert!(entry.lock().unwrap().manager.is_some());
    }
    entry.lock().unwrap().active_requests = 0;
    assert!(
        LarmManagerCheckout::take_for_reconcile(&path, &config, true)
            .unwrap()
            .unwrap()
            .manager
            .is_some()
    );
}
