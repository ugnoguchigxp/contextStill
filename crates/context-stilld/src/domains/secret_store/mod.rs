//! Versioned OS-store references. No credential bytes are written to SQLite or subprocess files.
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

const PREFIX: &str = "cs-secret:v1:";
const BLOCKED: &str = "cs-secret:disabled";
#[cfg(target_os = "macos")]
const SERVICE: &str = "com.context-still.runtime-secrets.v1";

pub trait SecretStore {
    fn get(&self, reference: &str) -> Result<Zeroizing<String>, String>;
    fn set(&self, reference: &str, value: &str) -> Result<(), String>;
    fn delete(&self, reference: &str) -> Result<(), String>;
}

pub struct OsSecretStore;
#[cfg(target_os = "macos")]
static OS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(target_os = "macos")]
impl SecretStore for OsSecretStore {
    fn get(&self, reference: &str) -> Result<Zeroizing<String>, String> {
        let _lock = OS_LOCK
            .lock()
            .map_err(|_| "secret_store_unavailable".to_string())?;
        let _interaction =
            security_framework::os::macos::keychain::SecKeychain::disable_user_interaction()
                .map_err(|e| os_error(e.code()))?;
        let bytes = Zeroizing::new(
            security_framework::passwords::generic_password(
                security_framework::passwords::PasswordOptions::new_generic_password(
                    SERVICE, reference,
                ),
            )
            .map_err(|error| os_error(error.code()))?,
        );
        String::from_utf8(bytes.to_vec())
            .map(Zeroizing::new)
            .map_err(|_| "secret_store_invalid_encoding".to_string())
    }
    fn set(&self, reference: &str, value: &str) -> Result<(), String> {
        let _lock = OS_LOCK
            .lock()
            .map_err(|_| "secret_store_unavailable".to_string())?;
        let _interaction =
            security_framework::os::macos::keychain::SecKeychain::disable_user_interaction()
                .map_err(|e| os_error(e.code()))?;
        security_framework::passwords::set_generic_password(SERVICE, reference, value.as_bytes())
            .map_err(|error| os_error(error.code()))
    }
    fn delete(&self, reference: &str) -> Result<(), String> {
        let _lock = OS_LOCK
            .lock()
            .map_err(|_| "secret_store_unavailable".to_string())?;
        let _interaction =
            security_framework::os::macos::keychain::SecKeychain::disable_user_interaction()
                .map_err(|e| os_error(e.code()))?;
        match security_framework::passwords::delete_generic_password(SERVICE, reference) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == -25300 => Ok(()),
            Err(error) => Err(os_error(error.code())),
        }
    }
}
#[cfg(target_os = "macos")]
fn os_error(code: i32) -> String {
    match code {
        -25300 => "secret_store_missing",
        -25308 => "secret_store_locked",
        -25293 | -128 => "secret_store_denied",
        _ => "secret_store_unavailable",
    }
    .to_string()
}
#[cfg(not(target_os = "macos"))]
impl SecretStore for OsSecretStore {
    fn get(&self, _: &str) -> Result<Zeroizing<String>, String> {
        Err("secret_store_unsupported_use_environment".into())
    }
    fn set(&self, _: &str, _: &str) -> Result<(), String> {
        Err("secret_store_unsupported_use_environment".into())
    }
    fn delete(&self, _: &str) -> Result<(), String> {
        Err("secret_store_unsupported_use_environment".into())
    }
}

pub fn profile_id(profile: &str) -> String {
    format!("{:x}", Sha256::digest(profile.as_bytes()))
}
fn validate_reference(reference: &str) -> Result<(), String> {
    let parts = reference
        .strip_prefix(PREFIX)
        .ok_or("secret_reference_invalid")?
        .split(':')
        .collect::<Vec<_>>();
    if parts.len() != 3
        || parts[0].len() != 64
        || parts[2].len() != 32
        || !parts[0]
            .bytes()
            .chain(parts[2].bytes())
            .all(|b| b.is_ascii_hexdigit())
        || parts[1].is_empty()
        || parts[1].len() > 100
        || !parts[1].bytes().all(|b| b.is_ascii_alphanumeric())
    {
        return Err("secret_reference_invalid".into());
    }
    Ok(())
}

/// Reads only a reference while a writer may be held. Never performs OS I/O here.
pub fn row_token(connection: &Connection, key: &str) -> Option<String> {
    let raw = match connection.query_row(
        "select value from settings where namespace='runtime.secret' and key=?1",
        [key],
        |row| row.get::<_, String>(0),
    ) {
        Ok(raw) => raw,
        Err(rusqlite::Error::QueryReturnedNoRows) => return None,
        Err(_) => return Some("cs-secret:settings_unavailable".into()),
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Some("cs-secret:invalid".into());
    };
    if value.get("environment").and_then(Value::as_bool) == Some(true) {
        return if value.as_object().is_some_and(|v| v.len() == 1) {
            None
        } else {
            Some("cs-secret:invalid".into())
        };
    }
    if value.get("disabled").and_then(Value::as_bool) == Some(true) {
        return Some(BLOCKED.into());
    }
    if let Some(reference) = value.get("secretRef").and_then(Value::as_str) {
        if validate_reference(reference).is_err() {
            return Some("cs-secret:invalid".into());
        }
        if let Some(path) = connection.path().filter(|path| !path.is_empty()) {
            if !reference.starts_with(&format!(
                "{PREFIX}{}:",
                profile_id(
                    &std::fs::canonicalize(path)
                        .ok()
                        .and_then(|p| p.to_str().map(str::to_owned))
                        .unwrap_or_else(|| path.to_string())
                )
            )) {
                return Some("cs-secret:profile_mismatch".into());
            }
        }
        return Some(reference.into());
    }
    // Read-only compatibility during migration. New settings writes never use this shape.
    value
        .get("value")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .or_else(|| Some("cs-secret:invalid".into()))
}

pub fn resolve(value: &str) -> Result<Zeroizing<String>, String> {
    resolve_with(&OsSecretStore, value)
}
fn resolve_with(store: &impl SecretStore, value: &str) -> Result<Zeroizing<String>, String> {
    if !value.starts_with("cs-secret:") {
        return Ok(Zeroizing::new(value.to_string()));
    }
    validate_reference(value)?;
    if std::thread::current()
        .name()
        .is_some_and(|name| name.contains("sqlite-writer"))
    {
        return Err("secret_store_requires_external_phase".into());
    }
    store.get(value)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub operation: String,
    pub profile: String,
    pub key: String,
    pub reference: Option<String>,
    pub value: Option<String>,
}
impl Drop for Request {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.value.zeroize();
    }
}

pub fn handle(store: &impl SecretStore, request: &Request) -> Result<Value, String> {
    if request.profile.is_empty()
        || request.profile.len() > 4096
        || request.key.is_empty()
        || request.key.len() > 100
        || !request.key.bytes().all(|b| b.is_ascii_alphanumeric())
    {
        return Err("secret_request_invalid".into());
    }
    let prefix = format!("{PREFIX}{}:{}:", profile_id(&request.profile), request.key);
    if request.operation == "put" {
        let value = request
            .value
            .as_deref()
            .filter(|s| !s.is_empty() && s.len() <= 16384)
            .ok_or("secret_value_invalid")?;
        let mut generation = [0u8; 16];
        getrandom::fill(&mut generation).map_err(|_| "secret_random_unavailable")?;
        let generation = generation
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let reference = request
            .reference
            .clone()
            .unwrap_or_else(|| format!("{prefix}{generation}"));
        validate_reference(&reference)?;
        if !reference.starts_with(&prefix) {
            return Err("secret_profile_mismatch".into());
        }
        store.set(&reference, value)?;
        match store.get(&reference) {
            Ok(actual) if actual.as_str() == value => (),
            _ => {
                let _ = store.delete(&reference);
                return Err("secret_store_readback_failed".into());
            }
        }
        return Ok(json!({"ok":true,"reference":reference}));
    }
    let reference = request
        .reference
        .as_deref()
        .ok_or("secret_reference_required")?;
    validate_reference(reference)?;
    if !reference.starts_with(&prefix) {
        return Err("secret_profile_mismatch".into());
    }
    match request.operation.as_str() {
        "get" => Ok(json!({"ok":true,"value":store.get(reference)?.as_str()})),
        "delete" => {
            store.delete(reference)?;
            Ok(json!({"ok":true}))
        }
        _ => Err("secret_operation_invalid".into()),
    }
}

#[cfg(test)]
mod tests;

pub fn header(value: &str, bearer: bool) -> Result<reqwest::header::HeaderValue, String> {
    let value = resolve(value)?;
    let rendered = Zeroizing::new(if bearer {
        format!("Bearer {}", value.trim())
    } else {
        value.trim().to_string()
    });
    let mut header = reqwest::header::HeaderValue::from_str(&rendered)
        .map_err(|_| "secret_header_invalid".to_string())?;
    header.set_sensitive(true);
    Ok(header)
}
