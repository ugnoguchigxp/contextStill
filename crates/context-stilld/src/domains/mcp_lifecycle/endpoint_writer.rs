use super::{constant_time_eq, json_response, DispatchConfig, HttpRequest};
use serde_json::json;

pub(super) fn handle_writer_request(request: HttpRequest, dispatch: &DispatchConfig) -> String {
    let Some((sqlite_core_path, writer_token)) = dispatch.writer() else {
        return json_response(404, json!({"ok":false,"error":"not_found"}), &[]);
    };
    let supplied_token = request
        .headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    if !constant_time_eq(supplied_token.as_bytes(), writer_token.as_bytes()) {
        return json_response(
            401,
            json!({"ok": false, "error": "writer_unauthorized"}),
            &[],
        );
    }
    if request.path == "/internal/context-compile" {
        if request.method != "POST" {
            return json_response(405, json!({"ok":false,"error":"method_not_allowed"}), &[]);
        }
        if request.headers.contains_key("origin") {
            return json_response(403, json!({"ok":false,"error":"origin_forbidden"}), &[]);
        }
        let valid_host = request
            .headers
            .get("host")
            .and_then(|host| reqwest::Url::parse(&format!("http://{host}")).ok())
            .is_some_and(|url| {
                url.username().is_empty()
                    && matches!(
                        url.host_str(),
                        Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
                    )
            });
        if !valid_host {
            return json_response(403, json!({"ok":false,"error":"host_mismatch"}), &[]);
        }
        if request.body.len() > 65536 {
            return json_response(
                413,
                json!({"ok":false,"error":"compile_request_too_large"}),
                &[],
            );
        }
        let payload = match serde_json::from_str(&request.body) {
            Ok(value) => value,
            Err(_) => {
                return json_response(
                    400,
                    json!({"ok":false,"error":"compile_request_invalid"}),
                    &[],
                )
            }
        };
        let Some(context) = dispatch.native_context() else {
            return json_response(404, json!({"ok":false,"error":"not_found"}), &[]);
        };
        let result = super::super::native_compile::client::compile(payload, &context);
        return json_response(if result["ok"] == true { 200 } else { 422 }, result, &[]);
    }
    if request.path == "/writer/secrets" && request.method == "POST" {
        let payload =
            match serde_json::from_str::<crate::domains::secret_store::Request>(&request.body) {
                Ok(payload) => payload,
                Err(_) => {
                    return json_response(
                        400,
                        json!({"ok":false,"error":"secret_request_invalid"}),
                        &[],
                    )
                }
            };
        return match crate::domains::secret_store::handle(
            &crate::domains::secret_store::OsSecretStore,
            &payload,
        ) {
            Ok(response) => json_response(200, response, &[]),
            Err(error) => json_response(503, json!({"ok":false,"error":error}), &[]),
        };
    }
    if request.path == "/writer/health" && request.method == "GET" {
        return match crate::domains::sqlite_writer::global_writer_for_path(sqlite_core_path) {
            Ok(writer) => json_response(200, json!({"ok": true, "writer": writer.status()}), &[]),
            Err(error) => json_response(503, json!({"ok": false, "error": error}), &[]),
        };
    }
    if request.path != "/writer/query" || request.method != "POST" {
        return json_response(
            405,
            json!({"ok": false, "error": "method_not_allowed"}),
            &[("Allow", "POST".to_string())],
        );
    }
    let writer_request = match serde_json::from_str::<
        crate::domains::sqlite_writer::protocol::SqliteWriterRequest,
    >(&request.body)
    {
        Ok(request) => request,
        Err(error) => {
            return json_response(
                400,
                json!({"ok": false, "error": format!("invalid writer request: {error}")}),
                &[],
            )
        }
    };
    match crate::domains::sqlite_writer::protocol::execute_request(sqlite_core_path, writer_request)
    {
        Ok(response) => json_response(200, json!(response), &[]),
        Err(error) => json_response(500, json!({"ok": false, "error": error}), &[]),
    }
}
