use super::*;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;

mod activity_tests;
mod claim_tests;

#[test]
fn client_runs_activity_discovery_and_connection_lifecycle_without_leaking_token() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let origin = format!("http://{address}");
    let (requests_tx, requests_rx) = mpsc::channel::<String>();
    let server_origin = origin.clone();
    let server = thread::spawn(move || {
        let connection_json = connection_json();
        let claim_json = claim_json(&server_origin);
        let responses = vec![
            json_response(
                200,
                serde_json::json!({
                    "contractVersion": SERVICE_ACTIVITY_CONTRACT,
                    "state": "idle",
                    "activeWorkloads": 0,
                    "observedAt": current_rfc3339_for_test(),
                    "validForMs": 1_000,
                    "retryAfterMs": 0,
                    "reservationGuaranteed": false,
                    "bootEpoch": "epoch-1",
                    "configRevision": "catalog-1"
                }),
            ),
            json_response(200, profile_catalog_json("catalog-1")),
            json_response(201, connection_json.clone()),
            json_response(
                200,
                serde_json::json!({
                    "id": "aconn_epoch_1",
                    "status": "ready",
                    "ready": true,
                    "acceptingRequests": true,
                    "checkedAt": current_rfc3339_for_test(),
                    "providers": [{
                        "name": "llm",
                        "capability": "chat-completions",
                        "ready": true,
                        "acceptingRequests": true
                    }]
                }),
            ),
            json_response(200, claim_json),
            json_response(200, connection_json),
            "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
        ];
        for response in responses {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            requests_tx.send(request).unwrap();
            stream.write_all(response.as_bytes()).unwrap();
        }
    });

    let client = LarmControlClient::new(config(&origin)).unwrap();
    let activity = client.service_activity().unwrap();
    assert_eq!(activity.state, ServiceActivityState::Idle);
    client
        .discover_configured_profile(&activity.config_revision)
        .unwrap();
    let created = client.create("contextstill:create:test-1").unwrap();
    assert_eq!(created.status, LarmConnectionStatus::Ready);
    let health = client.health(&created.id).unwrap();
    assert!(health.ready);
    assert!(health.accepting_requests);
    let target = client.claim(&created).unwrap();
    assert_eq!(target.api_base_url, format!("{origin}/v1"));
    assert_eq!(target.model, "contextstill-background");
    assert!(!format!("{target:?}").contains("secret-token"));
    let renewed = client
        .renew(&created.id, "contextstill:renew:test-1")
        .unwrap();
    assert_eq!(renewed.id, created.id);
    client.release(&created.id).unwrap();
    server.join().unwrap();

    let requests = requests_rx.try_iter().collect::<Vec<_>>();
    assert!(requests.iter().all(|request| request
        .to_ascii_lowercase()
        .contains("authorization: bearer test-control-credential")));
    assert!(requests[0].starts_with("GET /v1/activity HTTP/1.1\r\n"));
    assert!(!requests[0].contains("GET /v1/activity?"));
    assert!(!requests[0].to_ascii_lowercase().contains("content-length:"));
    assert!(requests[1].starts_with("GET /v3/agent-profiles?profile=contextStill HTTP/1.1\r\n"));
    assert!(requests[2].contains("POST /v1/agent-connections HTTP/1.1"));
    assert!(requests[2]
        .to_ascii_lowercase()
        .contains("idempotency-key: contextstill:create:test-1"));
    assert!(requests[2].contains("\"allowFallback\":false"));
    assert!(requests[2].contains("\"profile\":\"contextStill\""));
    assert!(!requests[2].contains("\"agentProfile\""));
    assert!(!requests[2].contains("\"explicitAgentProfile\""));
    assert!(requests[2].contains("\"deploymentPolicy\":\"existing-only\""));
    assert!(requests[3].contains("/health HTTP/1.1"));
    assert!(requests[4].contains("/claim HTTP/1.1"));
    assert!(requests[5].contains("/renew HTTP/1.1"));
    assert!(requests[6].starts_with("DELETE /v1/agent-connections/"));
}

#[test]
fn create_directly_returns_ready_without_discovery() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let request = read_request(&mut stream);
        assert!(request.starts_with("POST /v1/agent-connections HTTP/1.1"));
        assert!(request.to_ascii_lowercase().contains("prefer: wait=1"));
        assert!(request.contains("\"profile\":\"contextStill\""));
        assert!(request.contains("\"audience\":\"same-host\""));
        assert!(request.contains("\"ttlSeconds\":300"));
        assert!(!request.contains("\"agentProfile\""));
        assert!(!request.contains("\"explicitAgentProfile\""));
        stream
            .write_all(json_response(201, connection_json()).as_bytes())
            .unwrap();
    });
    let client = LarmControlClient::new(config(&format!("http://{address}"))).unwrap();
    assert_eq!(
        client.create("contextstill:create:direct").unwrap().status,
        LarmConnectionStatus::Ready
    );
    server.join().unwrap();
}

#[test]
fn create_distinguishes_revision_selector_idempotency_and_terminal_errors() {
    for (status, code, expected_kind) in [
        (
            409,
            "catalog_revision_mismatch",
            "catalog_revision_mismatch",
        ),
        (404, "unknown_selector", "unknown_selector"),
        (409, "idempotency_conflict", "idempotency_conflict"),
        (503, "provider_unavailable", "terminal_unavailable"),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_request(&mut stream);
            stream
                .write_all(
                    json_response(status, serde_json::json!({"error":{"code":code}})).as_bytes(),
                )
                .unwrap();
        });
        let error = LarmControlClient::new(config(&format!("http://{address}")))
            .unwrap()
            .create("contextstill:create:error-case")
            .unwrap_err();
        assert_eq!(error.kind, expected_kind);
        assert!(!error.retryable);
        server.join().unwrap();
    }
}

#[test]
fn create_accepts_an_asynchronous_202_connection_response() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (request_tx, request_rx) = mpsc::channel();
    let mut pending = connection_json();
    pending["status"] = Value::String("pending".to_string());
    pending["providers"][0]["readiness"] = Value::String("pending".to_string());
    pending["providers"][0]["claimable"] = Value::Bool(false);
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        request_tx.send(read_request(&mut stream)).unwrap();
        let response = json_response(202, pending).replacen(
            "Content-Type: application/json\r\n",
            "Content-Type: application/json\r\nLocation: /v1/agent-connections/aconn_epoch_1\r\n",
            1,
        );
        stream.write_all(response.as_bytes()).unwrap();
        let (mut stream, _) = listener.accept().unwrap();
        request_tx.send(read_request(&mut stream)).unwrap();
        stream
            .write_all(json_response(200, connection_json()).as_bytes())
            .unwrap();
    });

    let client = LarmControlClient::new(config(&format!("http://{address}"))).unwrap();
    let created = client.create("contextstill:create:async-test").unwrap();

    assert_eq!(created.status, LarmConnectionStatus::Pending);
    assert_eq!(
        client.wait_until_ready(created).unwrap().status,
        LarmConnectionStatus::Ready
    );
    server.join().unwrap();
    let requests = request_rx.try_iter().collect::<Vec<_>>();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].starts_with("POST /v1/agent-connections HTTP/1.1"));
    assert!(requests[0].contains("\"profile\":\"contextStill\""));
    assert!(!requests[0].contains("\"expectedCatalogRevision\""));
    assert!(requests[1].starts_with("GET /v1/agent-connections/aconn_epoch_1 HTTP/1.1"));
}

#[test]
fn claim_accepts_a_validated_dynamic_port_on_the_control_host() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let control_origin = format!("http://{address}");
    let provider_port = if address.port() == u16::MAX {
        address.port() - 1
    } else {
        address.port() + 1
    };
    let provider_origin = format!("http://127.0.0.1:{provider_port}");
    let response_origin = provider_origin.clone();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let _ = read_request(&mut stream);
        let response = json_response(200, claim_json(&response_origin));
        stream.write_all(response.as_bytes()).unwrap();
    });

    let client = LarmControlClient::new(config(&control_origin)).unwrap();
    let connection = serde_json::from_value::<PublicLarmConnection>(connection_json()).unwrap();
    let target = client.claim(&connection).unwrap();

    assert_eq!(target.api_base_url, format!("{provider_origin}/v1"));
    server.join().unwrap();
}

#[test]
fn readiness_poll_rejects_connection_identity_changes() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let mut initial_json = connection_json();
    initial_json["status"] = Value::String("pending".to_string());
    initial_json["providers"][0]["readiness"] = Value::String("pending".to_string());
    initial_json["providers"][0]["claimable"] = Value::Bool(false);
    let initial = serde_json::from_value::<PublicLarmConnection>(initial_json).unwrap();
    let mut changed_json = connection_json();
    changed_json["allocationId"] = Value::String("alloc-replaced".to_string());
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let _ = read_request(&mut stream);
        let response = json_response(200, changed_json);
        stream.write_all(response.as_bytes()).unwrap();
    });

    let error = LarmControlClient::new(config(&format!("http://{address}")))
        .unwrap()
        .wait_until_ready(initial)
        .unwrap_err();

    assert_eq!(error.kind, "protocol");
    assert!(error.message.contains("identity changed"));
    server.join().unwrap();
}

#[test]
fn target_renewal_is_required_before_request_lifetime_becomes_too_short() {
    let client = LarmControlClient::new(config("http://127.0.0.1:9")).unwrap();
    let target = |expires_at| ClaimedLarmTarget {
        context_window: None,
        connection_id: "aconn_epoch_1".to_string(),
        allocation_id: "alloc_epoch_1".to_string(),
        api_base_url: "http://127.0.0.1:9/v1".to_string(),
        model: "contextstill-background".to_string(),
        bearer_token: Zeroizing::new("secret-token".to_string()),
        expires_at,
    };
    let short = target(rfc3339_for_test(now_epoch_ms() + 1_000));
    let sufficient = target(rfc3339_for_test(
        now_epoch_ms() + 300_000 + REQUEST_CLEANUP_MARGIN_MS + 10_000,
    ));

    assert!(client.target_requires_renewal(&short).unwrap());
    assert!(!client.target_requires_renewal(&sufficient).unwrap());
}

#[test]
fn claim_uses_credential_expiry_and_rejects_a_token_that_expires_too_soon() {
    let origin = "http://127.0.0.1:9810";
    let client = LarmControlClient::new(config(origin)).unwrap();
    let connection_expiry = rfc3339_for_test(now_epoch_ms() + 300_000);
    let credential_expiry = rfc3339_for_test(now_epoch_ms() + 280_000);
    let mut connection_value = connection_json();
    connection_value["expiresAt"] = serde_json::json!(connection_expiry);
    let connection: PublicLarmConnection = serde_json::from_value(connection_value).unwrap();
    let mut claim_value = claim_json(origin);
    claim_value["expiresAt"] = serde_json::json!(connection_expiry);
    claim_value["providers"][0]["credential"]["expiresAt"] = serde_json::json!(credential_expiry);
    let claim: LarmClaim = serde_json::from_value(claim_value.clone()).unwrap();
    let target = client.validate_claim(&connection, claim).unwrap();
    assert_eq!(target.expires_at, credential_expiry);

    claim_value["providers"][0]["credential"]["expiresAt"] =
        serde_json::json!(rfc3339_for_test(now_epoch_ms() + 200_000));
    let short_claim: LarmClaim = serde_json::from_value(claim_value).unwrap();
    assert_eq!(
        client
            .validate_claim(&connection, short_claim)
            .unwrap_err()
            .kind,
        "protocol"
    );
}

#[test]
fn control_credential_uses_only_larm_api_token_and_rejects_blank_values() {
    let token = control_bearer_token_from_environment(|name| {
        assert_eq!(name, "LARM_API_TOKEN");
        Ok("  test-control-credential  ".to_string())
    })
    .expect("nonblank credential must be retained");
    assert_eq!(token.as_str(), "test-control-credential");

    for blank in ["", " \t\n "] {
        assert!(control_bearer_token_from_environment(|name| {
            assert_eq!(name, "LARM_API_TOKEN");
            Ok(blank.to_string())
        })
        .is_none());
    }
    assert!(control_bearer_token_from_environment(|name| {
        assert_eq!(name, "LARM_API_TOKEN");
        Err(std::env::VarError::NotPresent)
    })
    .is_none());
}

#[test]
fn credential_observability_and_debug_output_do_not_expose_its_value() {
    let client = LarmControlClient::new(config("http://127.0.0.1:9810")).unwrap();
    assert!(client.credential_configured());
    assert_eq!(client.credential_source(), "LARM_API_TOKEN");
    let debug = format!("{client:?}");
    assert!(debug.contains("[REDACTED]"));
    assert!(!debug.contains("test-control-credential"));
}

fn config(origin: &str) -> LarmConnectionConfig {
    LarmConnectionConfig {
        id: "contextstill-background".to_string(),
        control_base_url: origin.to_string(),
        audience: "same-host".to_string(),
        availability_poll_ms: 5_000,
        availability_timeout_ms: 2_000,
        control_timeout_ms: 5_000,
        ready_timeout_ms: 180_000,
        ttl_seconds: 300,
        request_timeout_ms: 240_000,
        max_concurrent_requests: 1,
        control_bearer_token: Some(Zeroizing::new("test-control-credential".to_string())),
    }
}

fn connection_json() -> Value {
    serde_json::json!({
        "id": "aconn_epoch_1",
        "allocationId": "alloc_epoch_1",
        "bootEpoch": "epoch-1",
        "catalogRevision": "catalog-1",
        "profile": "contextStill",
        "agentProfile": "contextstill-background",
        "profileRevision": "1".repeat(64),
        "audience": "same-host",
        "audienceRevision": "2".repeat(64),
        "status": "ready",
        "providers": [{
            "name": "llm",
            "capability": "llm.coding",
            "route": "llm-agent-worker",
            "protocol": OPENAI_PROTOCOL,
            "endpoint": "/v1/chat/completions",
            "model": "contextstill-background",
            "publicModel": "contextstill-background",
            "readiness": "ready",
            "claimable": true
        }],
        "createdAt": "2026-09-06T12:00:00.000Z",
        "expiresAt": "2099-09-06T12:15:00.000Z"
    })
}

fn profile_catalog_json(revision: &str) -> Value {
    serde_json::json!({
        "contractVersion": AGENT_PROFILE_CATALOG_CONTRACT,
        "requestedProfile": "contextStill",
        "catalogRevision": revision,
        "profiles": [{
            "id": "contextstill-background",
            "canonicalProfile": "contextstill-background",
            "description": "ContextStill background provider",
            "selectionPolicy": "explicit-only",
            "deprecated": false,
            "providers": [{
                "name": "llm",
                "capability": "llm.coding",
                "supportedCapabilities": ["llm.coding"],
                "protocol": OPENAI_PROTOCOL,
                "endpoint": "/v1/chat/completions",
                "model": "contextstill-background"
            }]
        }],
        "audiences": ["same-host"]
    })
}

#[test]
fn discovery_rejects_invalid_selector_cardinality_and_provider_contract() {
    let client = LarmControlClient::new(config("http://127.0.0.1:9810")).unwrap();
    let valid = profile_catalog_json("catalog-1");
    let mut cases = Vec::new();
    let mut mismatched = valid.clone();
    mismatched["requestedProfile"] = serde_json::json!("SAAA");
    cases.push(mismatched);
    let mut empty = valid.clone();
    empty["profiles"] = serde_json::json!([]);
    cases.push(empty);
    let mut multiple = valid.clone();
    multiple["profiles"]
        .as_array_mut()
        .unwrap()
        .push(valid["profiles"][0].clone());
    cases.push(multiple);
    for (field, replacement) in [
        ("deprecated", serde_json::json!(true)),
        ("selectionPolicy", serde_json::json!("default")),
        ("canonicalProfile", serde_json::json!("other")),
    ] {
        let mut case = valid.clone();
        case["profiles"][0][field] = replacement;
        cases.push(case);
    }
    for (field, replacement) in [
        ("protocol", serde_json::json!("other")),
        (
            "endpoint",
            serde_json::json!("https://other.local/v1/chat/completions"),
        ),
        ("endpoint", serde_json::json!("/v1/../chat/completions")),
        ("model", serde_json::json!("")),
    ] {
        let mut case = valid.clone();
        case["profiles"][0]["providers"][0][field] = replacement;
        cases.push(case);
    }
    for case in cases {
        let catalog: LarmAgentProfileCatalog = serde_json::from_value(case).unwrap();
        assert!(client
            .validate_profile_catalog(&catalog, "catalog-1")
            .is_err());
    }
    let mut missing_model = valid;
    missing_model["profiles"][0]["providers"][0]
        .as_object_mut()
        .unwrap()
        .remove("model");
    assert!(serde_json::from_value::<LarmAgentProfileCatalog>(missing_model).is_err());
}

#[test]
fn discovery_maps_unauthorized_and_unknown_profile_to_non_retryable_errors() {
    for status in [401, 404] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            assert!(request.starts_with("GET /v3/agent-profiles?profile=contextStill HTTP/1.1"));
            stream
                .write_all(
                    json_response(
                        status,
                        serde_json::json!({"error":{"code":"unknown_agent_profile"}}),
                    )
                    .as_bytes(),
                )
                .unwrap();
        });
        let client = LarmControlClient::new(config(&origin)).unwrap();
        let error = client.discover_configured_profile("catalog-1").unwrap_err();
        assert_eq!(error.http_status, Some(status));
        assert!(!error.retryable);
        server.join().unwrap();
    }
}

#[test]
fn connection_model_conflicting_with_discovery_is_rejected_before_claim() {
    let client = LarmControlClient::new(config("http://127.0.0.1:9810")).unwrap();
    *client.discovered_profile.lock().unwrap() = Some(DiscoveredLarmProfile {
        canonical_profile: "contextstill-background".into(),
        model: "expected-model".into(),
        catalog_revision: "catalog-1".into(),
        context_window: None,
    });
    let connection: PublicLarmConnection = serde_json::from_value(connection_json()).unwrap();
    assert!(client.validate_connection(&connection).is_err());
}

fn claim_json(origin: &str) -> Value {
    serde_json::json!({
        "id": "aconn_epoch_1",
        "allocationId": "alloc_epoch_1",
        "status": "ready",
        "audience": "same-host",
        "providers": [{
            "name": "llm",
            "capability": "llm.coding",
            "apiStyle": "openai",
            "protocol": OPENAI_PROTOCOL,
            "scheme": "http",
            "host": "127.0.0.1",
            "port": Url::parse(origin).unwrap().port().unwrap(),
            "baseUrl": format!("{origin}/v1"),
            "model": "contextstill-background",
            "health": {
                "url": format!("{origin}/v1/agent-connections/aconn_epoch_1/providers/llm/health"),
                "kind": "semantic-inference",
                "maxAgeMs": 10000
            },
            "credential": {
                "type": "bearer",
                "token": "secret-token",
                "expiresAt": "2099-09-06T12:15:00.000Z"
            },
            "configuration": {
                "kind": AGENT_CONNECTION_CONTRACT,
                "fields": {
                    "baseURL": format!("{origin}/v1"),
                    "model": "contextstill-background"
                },
                "secretFields": { "apiKey": "credential.token" }
            }
        }],
        "expiresAt": "2099-09-06T12:15:00.000Z"
    })
}

fn json_response(status: u16, body: Value) -> String {
    let body = body.to_string();
    let reason = match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        _ => "Unknown",
    };
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn read_request(stream: &mut TcpStream) -> String {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut request = String::new();
    let mut content_length = 0_usize;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line.is_empty() || line == "\r\n" {
            break;
        }
        if let Some(value) = line
            .to_ascii_lowercase()
            .strip_prefix("content-length:")
            .and_then(|value| value.trim().parse::<usize>().ok())
        {
            content_length = value;
        }
        request.push_str(&line);
    }
    if content_length > 0 {
        let mut body = vec![0_u8; content_length];
        reader.read_exact(&mut body).unwrap();
        request.push_str(&String::from_utf8(body).unwrap());
    }
    request
}

#[test]
fn context_window_must_match_discovery_and_remain_stable() {
    let client = LarmControlClient::new(config("http://127.0.0.1:9810")).unwrap();
    let mut raw = connection_json();
    let window = LarmContextWindow {
        max_tokens: 32768,
        output_reserve_tokens: 4096,
        safety_margin_tokens: 0,
    };
    raw["providers"][0]["contextWindow"] = serde_json::to_value(&window).unwrap();
    let connection: PublicLarmConnection = serde_json::from_value(raw).unwrap();
    *client.discovered_profile.lock().unwrap() = Some(DiscoveredLarmProfile {
        canonical_profile: connection.agent_profile.clone(),
        model: connection.providers[0].model.clone(),
        catalog_revision: connection.catalog_revision.clone(),
        context_window: Some(window.clone()),
    });
    assert!(client.validate_connection(&connection).is_ok());
    let mut changed = connection.clone();
    changed.providers[0]
        .context_window
        .as_mut()
        .unwrap()
        .max_tokens = 16384;
    assert!(client.validate_connection(&changed).is_err());
    assert!(ensure_same_connection_identity(&connection, &changed).is_err());
    changed.providers[0].context_window = None;
    assert!(client.validate_connection(&changed).is_err());
    let mut claim = claim_json("http://127.0.0.1:9810");
    claim["providers"][0]["contextWindow"] = serde_json::to_value(&window).unwrap();
    assert!(client
        .validate_claim(&connection, serde_json::from_value(claim.clone()).unwrap())
        .is_ok());
    claim["providers"][0]["contextWindow"]["maxTokens"] = serde_json::json!(16384);
    assert!(client
        .validate_claim(&connection, serde_json::from_value(claim).unwrap())
        .is_err());
}

#[test]
fn discovery_rejects_empty_or_overflowing_context_window_budgets() {
    let client = LarmControlClient::new(config("http://127.0.0.1:9810")).unwrap();
    for (max, reserve, margin) in [
        (0, 0, 0),
        (32768, 32768, 0),
        (32768, 4096, 32768),
        (u64::MAX, u64::MAX, 1),
    ] {
        let mut catalog = profile_catalog_json("catalog-1");
        catalog["profiles"][0]["providers"][0]["contextWindow"] = serde_json::json!({"maxTokens":max,"outputReserveTokens":reserve,"safetyMarginTokens":margin});
        assert!(client
            .validate_profile_catalog(&serde_json::from_value(catalog).unwrap(), "catalog-1")
            .is_err());
    }
}

#[test]
fn provider_deployment_states_are_pending_without_extending_connection_statuses() {
    for readiness in ["waiting", "deploying"] {
        let provider: PublicLarmConnectionProvider = serde_json::from_value(serde_json::json!({
            "name":"llm","capability":"llm.coding","route":"route","protocol":"openai.chat-completions.v1", "endpoint":"http://127.0.0.1:8080/v1", "model":"ornith-contextstill", "readiness":readiness,"claimable":false
        })).unwrap();
        assert_eq!(provider.readiness, LarmConnectionStatus::Pending);
        assert!(
            serde_json::from_value::<LarmConnectionStatus>(Value::String(readiness.into()))
                .is_err()
        );
    }
}

#[test]
fn expired_claimability_hint_must_still_pass_the_authoritative_claim() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let _ = read_request(&mut stream);
        stream
            .write_all(
                json_response(
                    503,
                    serde_json::json!({"error":{"code":"provider_semantic_not_ready"}}),
                )
                .as_bytes(),
            )
            .unwrap();
    });
    let client = LarmControlClient::new(config(&origin)).unwrap();
    let mut raw = connection_json();
    raw["providers"][0]["claimable"] = Value::Bool(false);
    let connection: PublicLarmConnection = serde_json::from_value(raw).unwrap();
    client.validate_connection(&connection).unwrap();
    let error = client.claim(&connection).unwrap_err();
    assert!(error.retryable);
    server.join().unwrap();
}

#[test]
fn ready_status_waits_for_claimable_provider_and_respects_expiry_and_retry_after() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        assert!(read_request(&mut stream).starts_with("GET /v1/agent-connections/aconn_epoch_1 "));
        stream
            .write_all(json_response(200, connection_json()).as_bytes())
            .unwrap();
    });
    let client = LarmControlClient::new(config(&origin)).unwrap();
    let mut raw = connection_json();
    raw["providers"][0]["claimable"] = Value::Bool(false);
    raw["providers"][0]["readiness"] = Value::String("probing".into());
    let current: PublicLarmConnection = serde_json::from_value(raw.clone()).unwrap();
    client.validate_connection(&current).unwrap();
    let ready = client.wait_until_ready(current).unwrap();
    assert!(ready.providers[0].claimable);
    server.join().unwrap();
    raw["expiresAt"] = serde_json::json!("2000-01-01T00:00:00Z");
    assert_eq!(
        client
            .wait_until_ready(serde_json::from_value(raw.clone()).unwrap())
            .unwrap_err()
            .kind,
        "ready_timeout"
    );
    raw["expiresAt"] = serde_json::json!("2099-01-01T00:00:00Z");
    *client.ready_retry_after.lock().unwrap() = Duration::from_secs(600);
    let start = Instant::now();
    assert_eq!(
        client
            .wait_until_ready(serde_json::from_value(raw).unwrap())
            .unwrap_err()
            .kind,
        "ready_timeout"
    );
    assert!(start.elapsed() < Duration::from_secs(1));
}

#[test]
#[ignore = "requires a reachable LARM control origin and an authorized control credential"]
fn live_common_connection_provider_round_trip() {
    let origin = std::env::var("CONTEXT_STILL_LARM_CONTROL_ORIGIN").expect("LARM origin");
    let mut cfg = config(&origin);
    cfg.audience = "saaa-desktop".into();
    cfg.control_bearer_token = control_bearer_token_from_environment(|name| std::env::var(name));
    cfg.ttl_seconds = 900;
    cfg.request_timeout_ms = 120000;
    cfg.control_timeout_ms = 10000;
    cfg.max_concurrent_requests = 4;
    let mut manager = super::super::manager::LarmConnectionManager::new(cfg).unwrap();
    let result =
        (|| {
            assert!(manager.reconcile(true)?.ready);
            let capacity = manager.request_capacity()?;
            let claimed = manager.target().expect("claimed provider");
            let target = crate::domains::queue_lifecycle::episode_executor::LocalLlmTargetConfig {
                codex: false,
                quota_db: None,
                target_id: "larm-common-canary".into(),
                api_base_url: claimed.api_base_url.clone(),
                api_path: "/v1/chat/completions".into(),
                model: claimed.model.clone(),
            };
            let response = crate::domains::agent_runtime::transport::send(
            crate::domains::agent_runtime::transport::CompletionRequest {
                target: &target, api_key: Some(&claimed.bearer_token),
                messages: &serde_json::json!([{"role":"user","content":"Reply with exactly OK."}]),
                max_output: 32, response_format: None, timeout_seconds: 120
            }).map_err(|_| LarmControlError::protocol("claimed Provider inference failed"))?;
            assert!(response.terminal_error.is_none());
            assert!(!response.content.trim().is_empty());
            assert!(response.usage.is_some());
            println!(
                "profile=contextStill connection={} model={} capacity={} usage={:?}",
                claimed.connection_id, claimed.model, capacity, response.usage
            );
            Ok::<(), LarmControlError>(())
        })();
    let released = manager.release();
    result.unwrap();
    released.unwrap();
}

#[test]
fn release_accepts_a_gone_connection_after_larm_restart() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        assert!(
            read_request(&mut stream).starts_with("DELETE /v1/agent-connections/old-connection ")
        );
        stream
            .write_all(
                json_response(
                    410,
                    serde_json::json!({"error":{"code":"connection_expired"}}),
                )
                .as_bytes(),
            )
            .unwrap();
    });
    LarmControlClient::new(config(&origin))
        .unwrap()
        .release("old-connection")
        .unwrap();
    server.join().unwrap();
}
