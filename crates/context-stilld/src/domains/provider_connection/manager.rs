use std::path::PathBuf;
use std::time::{Duration, Instant};

use super::service::{
    ensure_same_connection_identity, ClaimedLarmTarget, LarmConnectionConfig, LarmConnectionStatus,
    LarmControlClient, LarmControlError, LarmServiceActivity, PublicLarmConnection,
    ServiceActivityState,
};

const TRANSIENT_BACKOFF_MAX_MS: u64 = 60_000;
const UNAVAILABLE_BACKOFF_MS: u64 = 300_000;

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum LarmConnectionManagerState {
    WaitingActivity,
    Creating,
    WaitingReady,
    Claiming,
    Ready,
    Renewing,
    Releasing,
    Backoff,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct LarmReconcileResult {
    pub state: LarmConnectionManagerState,
    pub ready: bool,
    pub reason_code: Option<String>,
    pub retry_after_ms: u64,
}

#[derive(Debug)]
pub struct LarmConnectionManager {
    client: LarmControlClient,
    state: LarmConnectionManagerState,
    connection: Option<PublicLarmConnection>,
    target: Option<ClaimedLarmTarget>,
    next_poll_at: Option<Instant>,
    transient_backoff_ms: u64,
    pending_create_key: Option<String>,
    recovered_connection_id: Option<String>,
    state_path: Option<PathBuf>,
    pending_reason: Option<String>,
    create_attempted: bool,
}

impl LarmConnectionManager {
    pub fn new(config: LarmConnectionConfig) -> Result<Self, LarmControlError> {
        Ok(Self {
            client: LarmControlClient::new(config)?,
            state: LarmConnectionManagerState::WaitingActivity,
            connection: None,
            target: None,
            next_poll_at: None,
            transient_backoff_ms: 0,
            pending_create_key: None,
            recovered_connection_id: None,
            state_path: None,
            pending_reason: None,
            create_attempted: false,
        })
    }

    pub fn new_persistent(
        config: LarmConnectionConfig,
        state_path: PathBuf,
    ) -> Result<Self, LarmControlError> {
        let mut manager = Self::new(config)?;
        if state_path.exists() {
            let bytes = std::fs::read(&state_path).map_err(|error| {
                LarmControlError::configuration(format!("failed to read LARM state: {error}"))
            })?;
            let value: serde_json::Value = serde_json::from_slice(&bytes)
                .map_err(|_| LarmControlError::configuration("invalid persisted LARM state"))?;
            manager.pending_create_key = value["key"].as_str().map(str::to_string);
            manager.recovered_connection_id = value["id"].as_str().map(str::to_string);
            manager.pending_reason = value["reason"].as_str().map(str::to_string);
            manager.create_attempted = value["createAttempted"].as_bool().unwrap_or(false);
            if manager.pending_create_key.is_none() {
                return Err(LarmControlError::configuration(
                    "persisted LARM state has no idempotency key",
                ));
            }
        }
        manager.state_path = Some(state_path);
        Ok(manager)
    }

    fn persist(&self) -> Result<(), LarmControlError> {
        let Some(path) = self.state_path.as_ref() else {
            return Ok(());
        };
        let value = serde_json::json!({"key":self.pending_create_key,"id":self.connection_id(),"reason":self.pending_reason,"createAttempted":self.create_attempted});
        let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
        std::fs::write(&temporary, value.to_string()).map_err(|error| {
            LarmControlError::configuration(format!("failed to persist LARM state: {error}"))
        })?;
        std::fs::rename(&temporary, path).map_err(|error| {
            LarmControlError::configuration(format!("failed to commit LARM state: {error}"))
        })
    }

    fn rotate_key_after_release(&mut self) -> Result<(), LarmControlError> {
        self.connection = None;
        self.recovered_connection_id = None;
        self.pending_create_key = Some(self.client.new_idempotency_key("create")?);
        self.pending_reason = None;
        self.create_attempted = false;
        self.persist()
    }

    pub fn state(&self) -> LarmConnectionManagerState {
        self.state
    }

    pub fn config(&self) -> &LarmConnectionConfig {
        self.client.config()
    }

    pub fn target(&self) -> Option<&ClaimedLarmTarget> {
        self.target.as_ref()
    }

    pub fn connection_id(&self) -> Option<&str> {
        self.connection
            .as_ref()
            .map(|connection| connection.id.as_str())
            .or(self.recovered_connection_id.as_deref())
    }

    pub fn reconcile(
        &mut self,
        due_job_exists: bool,
    ) -> Result<LarmReconcileResult, LarmControlError> {
        let _ = due_job_exists;
        if let Some(next_poll_at) = self.next_poll_at {
            if Instant::now() < next_poll_at {
                return Ok(LarmReconcileResult {
                    state: self.state,
                    ready: false,
                    reason_code: Some("backoff".to_string()),
                    retry_after_ms: next_poll_at
                        .saturating_duration_since(Instant::now())
                        .as_millis()
                        .try_into()
                        .unwrap_or(u64::MAX),
                });
            }
            self.next_poll_at = None;
        }

        self.state = LarmConnectionManagerState::WaitingActivity;
        let activity = match self.client.service_activity() {
            Ok(activity) => activity,
            Err(error) => {
                self.fail_closed(&error);
                return Err(error);
            }
        };
        match activity.state {
            ServiceActivityState::Idle => {}
            ServiceActivityState::Active => {}
            ServiceActivityState::Draining => {
                self.release()?;
                let retry_after_ms = self.schedule_poll(activity.retry_after_ms, false);
                return Ok(self.waiting_result("service_draining", retry_after_ms));
            }
        }

        self.transient_backoff_ms = 0;
        self.next_poll_at = None;
        if let Some(id) = self.recovered_connection_id.clone() {
            let recovered = self.client.get(&id)?;
            if recovered.status == LarmConnectionStatus::Released {
                self.rotate_key_after_release()?;
            } else {
                self.connection = Some(recovered);
                self.recovered_connection_id = None;
            }
        }
        if self.connection.as_ref().is_some_and(|connection| {
            connection.boot_epoch != activity.boot_epoch
                || connection.catalog_revision != activity.config_revision
        }) {
            self.discard_connection_best_effort();
        }
        if let Some(previous) = self.connection.clone() {
            let current = match self.client.get(&previous.id) {
                Ok(current) => current,
                Err(error) => {
                    self.fail_closed(&error);
                    return Err(error);
                }
            };
            if let Err(error) = ensure_same_connection_identity(&previous, &current) {
                self.fail_closed(&error);
                return Err(error);
            }
            if matches!(
                current.status,
                LarmConnectionStatus::Failed
                    | LarmConnectionStatus::Released
                    | LarmConnectionStatus::Expired
            ) {
                self.release()?;
            } else {
                self.connection = Some(current);
            }
        }
        if let Some(target) = self.target.as_ref() {
            let requires_renewal = match self.client.target_requires_renewal(target) {
                Ok(requires_renewal) => requires_renewal,
                Err(error) => {
                    self.fail_closed(&error);
                    return Err(error);
                }
            };
            if requires_renewal {
                self.renew_and_reclaim()?;
            }
        }
        if self.target.is_none() {
            if let Err(error) = self.acquire_target(&activity) {
                self.fail_closed(&error);
                return Err(error);
            }
        }
        self.state = LarmConnectionManagerState::Ready;
        self.pending_reason = None;
        self.persist()?;
        Ok(LarmReconcileResult {
            state: self.state,
            ready: true,
            reason_code: Some("connection_ready".to_string()),
            retry_after_ms: 0,
        })
    }

    pub fn renew_and_reclaim(&mut self) -> Result<(), LarmControlError> {
        let connection_id = self
            .connection_id()
            .map(str::to_string)
            .ok_or_else(|| LarmControlError::configuration("no LARM connection to renew"))?;
        self.target = None;
        self.state = LarmConnectionManagerState::Renewing;
        let key = match self.client.new_idempotency_key("renew") {
            Ok(key) => key,
            Err(error) => {
                self.fail_closed(&error);
                return Err(error);
            }
        };
        let renewed = match self.client.renew(&connection_id, &key) {
            Ok(connection) => connection,
            Err(error) => {
                self.fail_closed(&error);
                return Err(error);
            }
        };
        if let Some(previous) = self.connection.as_ref() {
            if let Err(error) = ensure_same_connection_identity(previous, &renewed) {
                self.fail_closed(&error);
                return Err(error);
            }
        }
        self.connection = Some(renewed.clone());
        self.state = LarmConnectionManagerState::WaitingReady;
        let ready = match self.client.wait_until_ready(renewed) {
            Ok(connection) => connection,
            Err(error) => {
                self.fail_closed(&error);
                return Err(error);
            }
        };
        self.state = LarmConnectionManagerState::Claiming;
        let target = match self.client.claim(&ready) {
            Ok(target) => target,
            Err(error) => {
                self.fail_closed(&error);
                return Err(error);
            }
        };
        self.connection = Some(ready);
        self.target = Some(target);
        self.state = LarmConnectionManagerState::Ready;
        self.transient_backoff_ms = 0;
        self.next_poll_at = None;
        Ok(())
    }

    pub fn release(&mut self) -> Result<(), LarmControlError> {
        self.target = None;
        if self.connection_id().is_none() && self.create_attempted {
            let key = self.pending_create_key.clone().ok_or_else(|| {
                LarmControlError::configuration("ambiguous create has no idempotency key")
            })?;
            if let Ok(activity) = self.client.service_activity() {
                let _ = self
                    .client
                    .discover_configured_profile(&activity.config_revision);
            }
            match self.client.create(&key) {
                Ok(connection) => {
                    self.connection = Some(connection);
                    self.persist()?;
                }
                Err(error) if error.kind == "provider_conflict" => return Ok(()),
                Err(error) => return Err(error),
            }
        }
        let Some(connection_id) = self.connection_id().map(str::to_string) else {
            self.state = LarmConnectionManagerState::WaitingActivity;
            self.next_poll_at = None;
            self.transient_backoff_ms = 0;
            return Ok(());
        };
        self.state = LarmConnectionManagerState::Releasing;
        let result = self.client.release(&connection_id);
        match result {
            Ok(()) => {
                self.rotate_key_after_release()?;
                self.state = LarmConnectionManagerState::WaitingActivity;
                self.next_poll_at = None;
                self.transient_backoff_ms = 0;
                Ok(())
            }
            Err(error) => {
                self.state = LarmConnectionManagerState::Backoff;
                if error.retryable {
                    self.schedule_transient_backoff(0);
                } else {
                    self.schedule_unavailable_backoff(0);
                }
                Err(error)
            }
        }
    }

    fn acquire_target(&mut self, activity: &LarmServiceActivity) -> Result<(), LarmControlError> {
        let ready = if let Some(connection) = self.connection.clone() {
            if connection.boot_epoch != activity.boot_epoch
                || connection.catalog_revision != activity.config_revision
            {
                return Err(LarmControlError::protocol(
                    "LARM connection control-plane identity does not match service activity",
                ));
            }
            self.state = LarmConnectionManagerState::WaitingReady;
            self.client.wait_until_ready(connection)?
        } else {
            self.client
                .discover_configured_profile(&activity.config_revision)?;
            self.state = LarmConnectionManagerState::Creating;
            let key = match self.pending_create_key.clone() {
                Some(key) => key,
                None => {
                    let key = self.client.new_idempotency_key("create")?;
                    self.pending_create_key = Some(key.clone());
                    self.persist()?;
                    key
                }
            };
            self.create_attempted = true;
            self.persist()?;
            let created = match self.client.create(&key) {
                Ok(connection) => connection,
                Err(error) => {
                    return Err(error);
                }
            };
            self.connection = Some(created.clone());
            self.persist()?;
            if created.boot_epoch != activity.boot_epoch
                || created.catalog_revision != activity.config_revision
            {
                return Err(LarmControlError::protocol(
                    "LARM control-plane identity changed between activity and create",
                ));
            }
            self.state = LarmConnectionManagerState::WaitingReady;
            self.client.wait_until_ready(created)?
        };
        if ready.status != LarmConnectionStatus::Ready {
            return Err(LarmControlError::protocol(
                "LARM connection was not ready after readiness polling",
            ));
        }
        let ready = if self.client.connection_requires_renewal(&ready)? {
            self.state = LarmConnectionManagerState::Renewing;
            let key = self.client.new_idempotency_key("renew")?;
            let renewed = self.client.renew(&ready.id, &key)?;
            ensure_same_connection_identity(&ready, &renewed)?;
            self.state = LarmConnectionManagerState::WaitingReady;
            self.client.wait_until_ready(renewed)?
        } else {
            ready
        };
        self.connection = Some(ready.clone());
        self.state = LarmConnectionManagerState::Claiming;
        self.target = Some(self.client.claim(&ready)?);
        Ok(())
    }

    fn discard_connection_best_effort(&mut self) {
        self.target = None;
        if let Some(connection_id) = self.connection_id().map(str::to_string) {
            self.state = LarmConnectionManagerState::Releasing;
            if self.client.release(&connection_id).is_ok() {
                let _ = self.rotate_key_after_release();
            }
        }
        self.state = LarmConnectionManagerState::WaitingActivity;
    }

    fn fail_closed(&mut self, error: &LarmControlError) {
        self.target = None;
        if !error.retryable || error.kind == "foreground_preempted" {
            self.discard_connection_best_effort();
        }
        self.pending_reason = Some(error.kind.to_string());
        let retry_after_ms = if error.retryable {
            self.schedule_transient_backoff(error.retry_after_ms.unwrap_or(0))
        } else {
            self.schedule_unavailable_backoff(error.retry_after_ms.unwrap_or(0))
        };
        self.state = LarmConnectionManagerState::Backoff;
        self.set_next_poll(retry_after_ms);
        let _ = self.persist();
    }

    fn schedule_poll(&mut self, retry_after_ms: u64, unavailable: bool) -> u64 {
        let base = if unavailable {
            UNAVAILABLE_BACKOFF_MS
        } else {
            self.client.config().availability_poll_ms
        };
        let delay = retry_after_ms.max(jittered_delay(base)).min(86_400_000);
        self.state = LarmConnectionManagerState::Backoff;
        self.set_next_poll(delay);
        delay
    }

    fn schedule_transient_backoff(&mut self, retry_after_ms: u64) -> u64 {
        self.transient_backoff_ms = if self.transient_backoff_ms == 0 {
            self.client.config().availability_poll_ms
        } else {
            self.transient_backoff_ms.saturating_mul(2)
        }
        .min(TRANSIENT_BACKOFF_MAX_MS);
        let delay = retry_after_ms
            .max(jittered_delay(self.transient_backoff_ms))
            .min(86_400_000);
        self.state = LarmConnectionManagerState::Backoff;
        self.set_next_poll(delay);
        delay
    }

    fn schedule_unavailable_backoff(&mut self, retry_after_ms: u64) -> u64 {
        self.schedule_poll(retry_after_ms, true)
    }

    fn waiting_result(&self, reason_code: &str, retry_after_ms: u64) -> LarmReconcileResult {
        LarmReconcileResult {
            state: self.state,
            ready: false,
            reason_code: Some(reason_code.to_string()),
            retry_after_ms,
        }
    }

    fn set_next_poll(&mut self, delay_ms: u64) {
        let now = Instant::now();
        self.next_poll_at = now
            .checked_add(Duration::from_millis(delay_ms))
            .or(Some(now));
    }
}

fn jittered_delay(base_ms: u64) -> u64 {
    let mut entropy = [0_u8; 2];
    if getrandom::fill(&mut entropy).is_err() {
        return base_ms;
    }
    let sample = u16::from_le_bytes(entropy) as u64;
    let percent = 80 + (sample % 41);
    base_ms.saturating_mul(percent) / 100
}

#[cfg(test)]
mod tests {
    use super::super::service::PublicLarmConnectionProvider;
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;
    use std::thread;
    use zeroize::Zeroizing;

    #[test]
    fn desired_connection_reconciles_even_when_queue_is_idle() {
        let mut manager = LarmConnectionManager::new(config("http://127.0.0.1:9")).unwrap();
        assert!(manager.reconcile(false).is_err());
        assert_eq!(manager.state(), LarmConnectionManagerState::Backoff);
    }

    #[test]
    fn pending_key_and_connection_id_survive_manager_reconstruction() {
        let path = std::env::temp_dir().join(format!(
            "contextstill-larm-state-{}.json",
            std::process::id()
        ));
        let mut manager =
            LarmConnectionManager::new_persistent(config("http://127.0.0.1:9"), path.clone())
                .unwrap();
        manager.pending_create_key = Some("contextstill:create:stable".into());
        manager.connection = Some(public_connection("epoch-1"));
        manager.persist().unwrap();
        let recovered =
            LarmConnectionManager::new_persistent(config("http://127.0.0.1:9"), path.clone())
                .unwrap();
        assert_eq!(
            recovered.pending_create_key.as_deref(),
            Some("contextstill:create:stable")
        );
        assert_eq!(recovered.connection_id(), Some("aconn_epoch_1"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn active_service_activity_defers_to_create_provider_conflict() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                request_tx.send(read_request(&mut stream)).unwrap();
                let response = json_response(serde_json::json!({
                    "contractVersion": "larm-service-activity.v1",
                    "state": "active",
                    "activeWorkloads": 1,
                    "observedAt": super::super::service::current_rfc3339_for_test(),
                    "validForMs": 1_000,
                    "retryAfterMs": 1_000,
                    "reservationGuaranteed": false,
                    "bootEpoch": "epoch-1",
                    "configRevision": "catalog-1"
                }));
                stream.write_all(response.as_bytes()).unwrap();
                let (mut stream, _) = listener.accept().unwrap();
                request_tx.send(read_request(&mut stream)).unwrap();
                stream
                    .write_all(json_response(profile_catalog_json("catalog-1")).as_bytes())
                    .unwrap();
                let (mut stream, _) = listener.accept().unwrap();
                request_tx.send(read_request(&mut stream)).unwrap();
                let body = r#"{"error":{"code":"provider_conflict"}}"#;
                let response = format!("HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nRetry-After: 2\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                stream.write_all(response.as_bytes()).unwrap();
            }
        });

        let mut manager = LarmConnectionManager::new(config(&format!("http://{address}"))).unwrap();
        let error = manager.reconcile(true).unwrap_err();
        assert_eq!(error.kind, "provider_conflict");
        assert_eq!(error.retry_after_ms, Some(2_000));
        assert_eq!(manager.state(), LarmConnectionManagerState::Backoff);
        assert!(manager.target().is_none());
        assert!(manager.pending_create_key.is_some());
        manager.next_poll_at = None;
        assert_eq!(
            manager.reconcile(true).unwrap_err().kind,
            "provider_conflict"
        );
        let requests = request_rx.try_iter().collect::<Vec<_>>();
        assert_eq!(requests.len(), 6);
        assert!(requests[2].starts_with("POST /v1/agent-connections HTTP/1.1"));
        assert_eq!(
            header_value(&requests[2], "idempotency-key"),
            header_value(&requests[5], "idempotency-key")
        );
        server.join().unwrap();
    }

    #[test]
    fn provider_conflict_recovers_and_claims_with_the_same_create_key() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let origin = format!("http://{address}");
        let claim_origin = origin.clone();
        let (request_tx, request_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let mut ready = connection_json("epoch-1");
            ready["catalogRevision"] = serde_json::json!("catalog-1");
            let conflict = r#"{"error":{"code":"provider_conflict"}}"#;
            let responses = [
                json_response(service_activity_json("active", 1, 1_000, "epoch-1", "catalog-1")),
                json_response(profile_catalog_json("catalog-1")),
                format!("HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nRetry-After: 1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{conflict}", conflict.len()),
                json_response(service_activity_json("idle", 0, 0, "epoch-1", "catalog-1")),
                json_response(profile_catalog_json("catalog-1")),
                json_response_with_status(201, "Created", ready),
                json_response(claim_json(&claim_origin)),
            ];
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                request_tx.send(read_request(&mut stream)).unwrap();
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let mut manager = LarmConnectionManager::new(config(&origin)).unwrap();
        assert_eq!(
            manager.reconcile(true).unwrap_err().kind,
            "provider_conflict"
        );
        manager.next_poll_at = None;
        assert!(manager.reconcile(false).unwrap().ready);
        let requests = request_rx.try_iter().collect::<Vec<_>>();
        assert_eq!(
            header_value(&requests[2], "idempotency-key"),
            header_value(&requests[5], "idempotency-key")
        );
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.starts_with("POST /v1/agent-connections HTTP/1.1"))
                .count(),
            2
        );
        assert!(manager.target().is_some());
        server.join().unwrap();
    }

    #[test]
    fn active_service_does_not_release_a_still_ready_llm_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let origin = format!("http://{address}");
        let (request_tx, request_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let mut ready = connection_json("epoch-1");
            ready["catalogRevision"] = serde_json::json!("catalog-1");
            for response in [
                json_response(service_activity_json(
                    "active",
                    1,
                    1_000,
                    "epoch-1",
                    "catalog-1",
                )),
                json_response(ready),
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                request_tx.send(read_request(&mut stream)).unwrap();
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let mut manager = LarmConnectionManager::new(config(&origin)).unwrap();
        manager.connection = Some(public_connection("epoch-1"));
        manager.target = Some(ClaimedLarmTarget {
            connection_id: "aconn_epoch_1".into(),
            allocation_id: "alloc_epoch_1".into(),
            api_base_url: format!("{origin}/v1"),
            model: "contextstill-background".into(),
            bearer_token: Zeroizing::new("secret".into()),
            expires_at: "2099-09-06T12:15:00.000Z".into(),
        });
        assert!(manager.reconcile(false).unwrap().ready);
        assert_eq!(manager.connection_id(), Some("aconn_epoch_1"));
        assert_eq!(
            request_rx
                .try_iter()
                .filter(|request| request.starts_with("DELETE "))
                .count(),
            0
        );
        server.join().unwrap();
    }

    #[test]
    fn draining_service_activity_does_not_create_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            request_tx.send(read_request(&mut stream)).unwrap();
            stream
                .write_all(
                    json_response(service_activity_json(
                        "draining",
                        0,
                        1_000,
                        "epoch-1",
                        "catalog-1",
                    ))
                    .as_bytes(),
                )
                .unwrap();
        });

        let mut manager = LarmConnectionManager::new(config(&format!("http://{address}"))).unwrap();
        let result = manager.reconcile(true).unwrap();

        assert!(!result.ready);
        assert_eq!(result.reason_code.as_deref(), Some("service_draining"));
        assert!(manager.target().is_none());
        assert_eq!(request_rx.try_iter().count(), 1);
        server.join().unwrap();
    }

    #[test]
    fn invalid_http_stale_and_timeout_activity_never_create_connection() {
        let mut unknown = service_activity_json("idle", 0, 0, "epoch-1", "catalog-1");
        unknown["unexpected"] = serde_json::Value::Bool(true);
        assert_activity_failure_does_not_create(Some(json_response(unknown)));
        assert_activity_failure_does_not_create(Some(
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_string(),
        ));
        let mut stale = service_activity_json("idle", 0, 0, "epoch-1", "catalog-1");
        stale["observedAt"] = serde_json::Value::String("2020-01-01T00:00:00.000Z".to_string());
        assert_activity_failure_does_not_create(Some(json_response(stale)));
        assert_activity_failure_does_not_create(None);
    }

    #[test]
    fn missing_configured_profile_does_not_create_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let mut catalog = profile_catalog_json("catalog-1");
            catalog["profiles"] = serde_json::json!([]);
            for response in [
                json_response(service_activity_json("idle", 0, 0, "epoch-1", "catalog-1")),
                json_response(catalog),
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                request_tx.send(read_request(&mut stream)).unwrap();
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let mut manager = LarmConnectionManager::new(config(&format!("http://{address}"))).unwrap();

        assert!(manager.reconcile(true).is_err());
        server.join().unwrap();

        let requests = request_rx.try_iter().collect::<Vec<_>>();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].starts_with("GET /v1/activity HTTP/1.1"));
        assert!(requests[1].starts_with("GET /v3/agent-profiles?profile=contextStill HTTP/1.1"));
    }

    #[test]
    fn next_job_boundary_keeps_a_still_ready_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let origin = format!("http://{address}");
        let response_origin = origin.clone();
        let (request_tx, request_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let responses = [
                json_response(service_activity_json("idle", 0, 0, "epoch-2", "catalog-2")),
                json_response(profile_catalog_json("catalog-2")),
                json_response_with_status(201, "Created", connection_json("epoch-2")),
                json_response(claim_json(&response_origin)),
                json_response(service_activity_json(
                    "active",
                    1,
                    1_000,
                    "epoch-2",
                    "catalog-2",
                )),
                json_response(connection_json("epoch-2")),
            ];
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                request_tx.send(read_request(&mut stream)).unwrap();
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let mut manager = LarmConnectionManager::new(config(&origin)).unwrap();

        assert!(manager.reconcile(true).unwrap().ready);
        assert!(manager.reconcile(true).unwrap().ready);
        assert!(manager.target().is_some());

        let requests = request_rx.try_iter().collect::<Vec<_>>();
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.starts_with("GET /v1/activity HTTP/1.1"))
                .count(),
            2
        );
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.starts_with("POST /v1/agent-connections HTTP/1.1"))
                .count(),
            1
        );
        assert!(requests[4].starts_with("GET /v1/activity HTTP/1.1"));
        assert!(requests[5].starts_with("GET /v1/agent-connections/aconn_epoch_1 HTTP/1.1"));
        server.join().unwrap();
    }

    #[test]
    fn ambiguous_create_retry_reuses_the_same_idempotency_key() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            for request_index in 0..4 {
                let (mut stream, _) = listener.accept().unwrap();
                request_tx.send(read_request(&mut stream)).unwrap();
                if request_index % 2 == 0 {
                    stream
                        .write_all(json_response(profile_catalog_json("catalog-1")).as_bytes())
                        .unwrap();
                }
            }
        });
        let mut manager = LarmConnectionManager::new(config(&format!("http://{address}"))).unwrap();

        let activity = idle_activity();
        assert!(manager.acquire_target(&activity).is_err());
        assert!(manager.acquire_target(&activity).is_err());
        server.join().unwrap();

        let requests = request_rx.try_iter().collect::<Vec<_>>();
        assert!(requests[0].starts_with("GET /v3/agent-profiles?profile=contextStill HTTP/1.1"));
        assert!(requests[2].starts_with("GET /v3/agent-profiles?profile=contextStill HTTP/1.1"));
        let first_key = header_value(&requests[1], "idempotency-key").unwrap();
        let second_key = header_value(&requests[3], "idempotency-key").unwrap();
        assert_eq!(first_key, second_key);
    }

    #[test]
    fn existing_connection_is_not_reused_after_catalog_revision_changes() {
        let mut manager = LarmConnectionManager::new(config("http://127.0.0.1:9")).unwrap();
        manager.connection = Some(public_connection("epoch-1"));
        let mut activity = idle_activity();
        activity.config_revision = "catalog-2".to_string();

        let error = manager.acquire_target(&activity).unwrap_err();

        assert_eq!(error.kind, "protocol");
        assert!(error.message.contains("control-plane identity"));
    }

    #[test]
    fn fail_closed_retains_connection_identity_when_remote_release_fails() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            assert!(request.starts_with("DELETE /v1/agent-connections/aconn_epoch_1"));
            stream
                .write_all(
                    b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
        });
        let mut manager = LarmConnectionManager::new(config(&format!("http://{address}"))).unwrap();
        manager.connection = Some(public_connection("epoch-1"));
        manager.target = Some(ClaimedLarmTarget {
            connection_id: "aconn_epoch_1".to_string(),
            allocation_id: "alloc_epoch_1".to_string(),
            api_base_url: format!("http://{address}/v1"),
            model: "contextstill-background".to_string(),
            bearer_token: Zeroizing::new("old-secret".to_string()),
            expires_at: "2099-09-06T12:15:00.000Z".to_string(),
        });

        manager.fail_closed(&LarmControlError::protocol("invalid claim"));

        assert!(manager.connection.is_some());
        assert!(manager.target.is_none());
        assert_eq!(manager.state(), LarmConnectionManagerState::Backoff);
        server.join().unwrap();
    }

    #[test]
    fn release_failure_retains_connection_identity_without_credential() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            assert!(request.starts_with("DELETE /v1/agent-connections/aconn_epoch_1"));
            stream
                .write_all(
                    b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
        });
        let mut manager = LarmConnectionManager::new(config(&format!("http://{address}"))).unwrap();
        manager.connection = Some(public_connection("epoch-1"));
        manager.target = Some(ClaimedLarmTarget {
            connection_id: "aconn_epoch_1".to_string(),
            allocation_id: "alloc_epoch_1".to_string(),
            api_base_url: format!("http://{address}/v1"),
            model: "contextstill-background".to_string(),
            bearer_token: Zeroizing::new("old-secret".to_string()),
            expires_at: "2099-09-06T12:15:00.000Z".to_string(),
        });

        let error = manager.release().unwrap_err();

        assert_eq!(error.http_status, Some(503));
        assert!(manager.connection.is_some());
        assert!(manager.target().is_none());
        assert_eq!(manager.state(), LarmConnectionManagerState::Backoff);
        server.join().unwrap();
    }

    #[test]
    fn renew_discards_the_old_token_and_reclaims() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let origin = format!("http://{address}");
        let response_origin = origin.clone();
        let (request_tx, request_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let mut renewed = connection_json("epoch-1");
            renewed["catalogRevision"] = serde_json::Value::String("catalog-1".to_string());
            let responses = [
                json_response(renewed),
                json_response(claim_json(&response_origin)),
            ];
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                request_tx.send(read_request(&mut stream)).unwrap();
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let mut manager = LarmConnectionManager::new(config(&origin)).unwrap();
        manager.connection = Some(public_connection("epoch-1"));
        manager.target = Some(ClaimedLarmTarget {
            connection_id: "aconn_epoch_1".to_string(),
            allocation_id: "alloc_epoch_1".to_string(),
            api_base_url: format!("{origin}/v1"),
            model: "contextstill-background".to_string(),
            bearer_token: Zeroizing::new("old-secret".to_string()),
            expires_at: "2099-09-06T12:15:00.000Z".to_string(),
        });

        manager.renew_and_reclaim().unwrap();

        assert_eq!(
            manager.target().unwrap().bearer_token.as_str(),
            "new-secret"
        );
        let requests = request_rx.try_iter().collect::<Vec<_>>();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].contains("/renew HTTP/1.1"));
        assert!(requests[1].contains("/claim HTTP/1.1"));
        server.join().unwrap();
    }

    #[test]
    fn boot_epoch_change_discards_the_old_claim_before_reacquiring() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let origin = format!("http://{address}");
        let (request_tx, request_rx) = mpsc::channel();
        let response_origin = origin.clone();
        let server = thread::spawn(move || {
            let responses = [
                json_response(service_activity_json("idle", 0, 0, "epoch-2", "catalog-2")),
                "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_string(),
                json_response(profile_catalog_json("catalog-2")),
                json_response_with_status(201, "Created", connection_json("epoch-2")),
                json_response(claim_json(&response_origin)),
            ];
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                request_tx.send(read_request(&mut stream)).unwrap();
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let mut manager = LarmConnectionManager::new(config(&origin)).unwrap();
        manager.connection = Some(public_connection("epoch-1"));
        manager.target = Some(ClaimedLarmTarget {
            connection_id: "aconn_epoch_1".to_string(),
            allocation_id: "alloc_epoch_1".to_string(),
            api_base_url: format!("{origin}/v1"),
            model: "contextstill-background".to_string(),
            bearer_token: Zeroizing::new("old-secret".to_string()),
            expires_at: "2099-09-06T12:15:00.000Z".to_string(),
        });

        let result = manager.reconcile(true).unwrap();

        assert!(result.ready);
        assert_eq!(manager.connection.as_ref().unwrap().boot_epoch, "epoch-2");
        assert_eq!(
            manager.target().unwrap().bearer_token.as_str(),
            "new-secret"
        );
        let requests = request_rx.try_iter().collect::<Vec<_>>();
        assert!(requests[0].starts_with("GET /v1/activity HTTP/1.1"));
        assert!(!requests[0].contains('?'));
        assert!(requests[1].starts_with("DELETE /v1/agent-connections/aconn_epoch_1"));
        assert!(requests[2].starts_with("GET /v3/agent-profiles?profile=contextStill HTTP/1.1"));
        assert!(requests[3].starts_with("POST /v1/agent-connections"));
        assert!(requests[4].contains("/claim HTTP/1.1"));
        server.join().unwrap();
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

    fn idle_activity() -> super::super::service::LarmServiceActivity {
        super::super::service::LarmServiceActivity {
            contract_version: "larm-service-activity.v1".to_string(),
            state: ServiceActivityState::Idle,
            active_workloads: 0,
            observed_at: "2099-09-06T12:34:56.789Z".to_string(),
            valid_for_ms: 1_000,
            retry_after_ms: 0,
            reservation_guaranteed: false,
            boot_epoch: "epoch-1".to_string(),
            config_revision: "catalog-1".to_string(),
        }
    }

    fn json_response(body: serde_json::Value) -> String {
        json_response_with_status(200, "OK", body)
    }

    fn service_activity_json(
        state: &str,
        active_workloads: u64,
        retry_after_ms: u64,
        boot_epoch: &str,
        config_revision: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "contractVersion": "larm-service-activity.v1",
            "state": state,
            "activeWorkloads": active_workloads,
            "observedAt": super::super::service::current_rfc3339_for_test(),
            "validForMs": 1_000,
            "retryAfterMs": retry_after_ms,
            "reservationGuaranteed": false,
            "bootEpoch": boot_epoch,
            "configRevision": config_revision
        })
    }

    fn profile_catalog_json(revision: &str) -> serde_json::Value {
        serde_json::json!({
            "contractVersion": "agent-connection.v3",
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
                    "protocol": "openai.chat-completions.v1",
                    "endpoint": "/v1/chat/completions",
                    "model": "contextstill-background"
                }]
            }],
            "audiences": ["same-host"]
        })
    }

    fn json_response_with_status(status: u16, reason: &str, body: serde_json::Value) -> String {
        let body = body.to_string();
        format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn public_connection(boot_epoch: &str) -> PublicLarmConnection {
        PublicLarmConnection {
            id: "aconn_epoch_1".to_string(),
            allocation_id: "alloc_epoch_1".to_string(),
            boot_epoch: boot_epoch.to_string(),
            catalog_revision: "catalog-1".to_string(),
            profile: "contextStill".to_string(),
            agent_profile: "contextstill-background".to_string(),
            profile_revision: "1".repeat(64),
            audience: "same-host".to_string(),
            audience_revision: "2".repeat(64),
            status: LarmConnectionStatus::Ready,
            providers: vec![PublicLarmConnectionProvider {
                name: "llm".to_string(),
                capability: "llm.coding".to_string(),
                route: "llm-agent-worker".to_string(),
                protocol: "openai.chat-completions.v1".to_string(),
                endpoint: "/v1/chat/completions".to_string(),
                model: "contextstill-background".to_string(),
                public_model: "contextstill-background".to_string(),
                readiness: LarmConnectionStatus::Ready,
                claimable: true,
            }],
            created_at: "2026-09-06T12:00:00.000Z".to_string(),
            expires_at: "2099-09-06T12:15:00.000Z".to_string(),
            released_at: None,
            error: None,
        }
    }

    fn connection_json(boot_epoch: &str) -> serde_json::Value {
        serde_json::json!({
            "id": "aconn_epoch_1",
            "allocationId": "alloc_epoch_1",
            "bootEpoch": boot_epoch,
            "catalogRevision": "catalog-2",
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
                "protocol": "openai.chat-completions.v1",
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

    fn claim_json(origin: &str) -> serde_json::Value {
        serde_json::json!({
            "id": "aconn_epoch_1",
            "allocationId": "alloc_epoch_1",
            "status": "ready",
            "audience": "same-host",
            "providers": [{
                "name": "llm",
                "capability": "llm.coding",
                "apiStyle": "openai",
                "protocol": "openai.chat-completions.v1",
                "scheme": "http",
                "host": "127.0.0.1",
                "port": reqwest::Url::parse(origin).unwrap().port().unwrap(),
                "baseUrl": format!("{origin}/v1"),
                "model": "contextstill-background",
                "health": {
                    "url": format!("{origin}/v1/agent-connections/aconn_epoch_1/providers/llm/health"),
                    "kind": "semantic-inference",
                    "maxAgeMs": 10000
                },
                "credential": {
                    "type": "bearer",
                    "token": "new-secret",
                    "expiresAt": "2099-09-06T12:15:00.000Z"
                },
                "configuration": {
                    "kind": "openai-provider-v1",
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

    fn header_value<'a>(request: &'a str, name: &str) -> Option<&'a str> {
        request.lines().find_map(|line| {
            let (header_name, value) = line.split_once(':')?;
            header_name
                .eq_ignore_ascii_case(name)
                .then_some(value.trim())
        })
    }

    fn assert_activity_failure_does_not_create(response: Option<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            request_tx.send(read_request(&mut stream)).unwrap();
            if let Some(response) = response {
                stream.write_all(response.as_bytes()).unwrap();
            } else {
                thread::sleep(Duration::from_millis(350));
            }
        });
        let mut test_config = config(&format!("http://{address}"));
        test_config.availability_timeout_ms = 250;
        let mut manager = LarmConnectionManager::new(test_config).unwrap();

        assert!(manager.reconcile(true).is_err());
        server.join().unwrap();

        let requests = request_rx.try_iter().collect::<Vec<_>>();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("GET /v1/activity HTTP/1.1"));
    }
}
