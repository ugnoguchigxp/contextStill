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
        assert!(request.to_ascii_lowercase().contains("prefer: wait=300"));
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
    *client.discovered_profile.lock().unwrap() = Some((
        "contextstill-background".to_string(),
        "expected-model".to_string(),
        "catalog-1".to_string(),
    ));
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
