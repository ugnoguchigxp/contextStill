use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use reqwest::blocking::{Client, Response};
use serde_json::{json, Value};

#[derive(Debug, PartialEq, Eq)]
enum FailureClass {
    TcpConnect,
    Timeout,
    Http(u16),
    InvalidContract,
}

fn classify_transport(error: &reqwest::Error) -> FailureClass {
    if error.is_connect() {
        FailureClass::TcpConnect
    } else if error.is_timeout() {
        FailureClass::Timeout
    } else {
        FailureClass::InvalidContract
    }
}

fn checked_json(response: Response) -> Result<Value, FailureClass> {
    let status = response.status();
    if !status.is_success() {
        return Err(FailureClass::Http(status.as_u16()));
    }
    response
        .json::<Value>()
        .map_err(|_| FailureClass::InvalidContract)
}

fn authenticated(client: &Client, url: String) -> reqwest::blocking::RequestBuilder {
    client.get(url).header(
        "authorization",
        crate::domains::secret_store::header("deterministic-test-value", true).unwrap(),
    )
}

fn read_request(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
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
    request.push_str("\r\n");
    if content_length > 0 {
        let mut body = vec![0_u8; content_length];
        reader.read_exact(&mut body).unwrap();
        request.push_str(&String::from_utf8(body).unwrap());
    }
    request
}

fn response(status: u16, request_id: Option<&str>, body: Value) -> String {
    let body = body.to_string();
    let reason = match status {
        200 => "OK",
        429 => "Too Many Requests",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let request_id = request_id
        .map(|value| format!("X-Request-Id: {value}\r\n"))
        .unwrap_or_default();
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\n{request_id}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn serve_sequence(
    listener: TcpListener,
    responses: Vec<String>,
) -> (thread::JoinHandle<()>, mpsc::Receiver<String>) {
    let (requests_tx, requests_rx) = mpsc::channel();
    let server = thread::spawn(move || {
        for response in responses {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = requests_tx.send(read_request(&mut stream));
            stream.write_all(response.as_bytes()).unwrap();
        }
    });
    (server, requests_rx)
}

fn client() -> Client {
    Client::builder()
        .connect_timeout(Duration::from_millis(250))
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap()
}

#[test]
fn ready_larm_contract_covers_health_models_and_chat() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let release = "release-under-test";
    let revision = "config-under-test";
    let (server, requests_rx) = serve_sequence(
        listener,
        vec![
            response(
                200,
                None,
                json!({
                    "status": "ok",
                    "ready": true,
                    "releaseCommit": release,
                    "configRevision": revision,
                    "bootEpoch": "epoch-ready"
                }),
            ),
            response(200, None, json!({"data": [{"id": "qwen-agent-worker"}]})),
            response(
                200,
                Some("req-contract-ready"),
                json!({
                    "model": "qwen-agent-worker",
                    "choices": [{"message": {"role": "assistant", "content": "OK"}}]
                }),
            ),
        ],
    );
    let client = client();

    let health = checked_json(
        authenticated(&client, format!("{origin}/health"))
            .send()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(health["status"], "ok");
    assert_eq!(health["ready"], true);
    assert_eq!(health["releaseCommit"], release);
    assert_eq!(health["configRevision"], revision);

    let models = checked_json(
        authenticated(&client, format!("{origin}/v1/models"))
            .send()
            .unwrap(),
    )
    .unwrap();
    assert!(models["data"]
        .as_array()
        .unwrap()
        .iter()
        .any(|model| model["id"] == "qwen-agent-worker"));

    let chat = client
        .post(format!("{origin}/v1/chat/completions"))
        .header(
            "authorization",
            crate::domains::secret_store::header("deterministic-test-value", true).unwrap(),
        )
        .json(&json!({
            "model": "qwen-agent-worker",
            "messages": [{"role": "user", "content": "Reply with OK."}],
            "stream": false
        }))
        .send()
        .unwrap();
    assert_eq!(
        chat.headers()
            .get("x-request-id")
            .unwrap()
            .to_str()
            .unwrap(),
        "req-contract-ready"
    );
    assert_eq!(
        checked_json(chat).unwrap()["choices"][0]["message"]["content"],
        "OK"
    );

    server.join().unwrap();
    let requests = requests_rx.try_iter().collect::<Vec<_>>();
    assert_eq!(requests.len(), 3);
    assert!(requests[0].starts_with("GET /health HTTP/1.1"));
    assert!(requests[1].starts_with("GET /v1/models HTTP/1.1"));
    assert!(requests[2].starts_with("POST /v1/chat/completions HTTP/1.1"));
    assert!(requests
        .iter()
        .all(|request| request.to_ascii_lowercase().contains("authorization:")));
}

#[test]
fn not_ready_and_http_queue_errors_stay_distinct_from_tcp_failures() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (server, _) = serve_sequence(
        listener,
        vec![
            response(
                503,
                None,
                json!({"status": "ok", "ready": false, "reason": "listener_probe_pending"}),
            ),
            response(
                429,
                Some("req-contract-queue-timeout"),
                json!({"error": {"code": "queue_timeout", "retryable": true}}),
            ),
        ],
    );
    let client = client();

    let not_ready = authenticated(&client, format!("{origin}/health"))
        .send()
        .unwrap();
    assert_eq!(checked_json(not_ready), Err(FailureClass::Http(503)));

    let queue_timeout = client
        .post(format!("{origin}/v1/chat/completions"))
        .send()
        .unwrap();
    assert_eq!(
        queue_timeout
            .headers()
            .get("x-request-id")
            .unwrap()
            .to_str()
            .unwrap(),
        "req-contract-queue-timeout"
    );
    assert_eq!(checked_json(queue_timeout), Err(FailureClass::Http(429)));
    server.join().unwrap();
}

#[test]
fn listener_restart_boundary_reports_tcp_connect_then_recovers_after_rebind() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address: SocketAddr = listener.local_addr().unwrap();
    drop(listener);

    let error = client()
        .get(format!("http://{address}/health"))
        .send()
        .unwrap_err();
    assert_eq!(classify_transport(&error), FailureClass::TcpConnect);

    let rebound = TcpListener::bind(address).unwrap();
    let (server, _) = serve_sequence(
        rebound,
        vec![response(
            200,
            None,
            json!({"status": "ok", "ready": true, "bootEpoch": "epoch-rebound"}),
        )],
    );
    let health = client()
        .get(format!("http://{address}/health"))
        .send()
        .unwrap();
    assert_eq!(checked_json(health).unwrap()["bootEpoch"], "epoch-rebound");
    server.join().unwrap();
}
