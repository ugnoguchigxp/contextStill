use super::*;
use std::collections::HashMap;
use std::sync::Mutex;
#[derive(Default)]
struct MemoryStore {
    entries: Mutex<HashMap<String, String>>,
}
impl SecretStore for MemoryStore {
    fn get(&self, r: &str) -> Result<Zeroizing<String>, String> {
        self.entries
            .lock()
            .unwrap()
            .get(r)
            .cloned()
            .map(Zeroizing::new)
            .ok_or("secret_store_missing".into())
    }
    fn set(&self, r: &str, v: &str) -> Result<(), String> {
        self.entries.lock().unwrap().insert(r.into(), v.into());
        Ok(())
    }
    fn delete(&self, r: &str) -> Result<(), String> {
        self.entries.lock().unwrap().remove(r);
        Ok(())
    }
}
fn put(store: &impl SecretStore, profile: &str) -> String {
    handle(
        store,
        &Request {
            operation: "put".into(),
            profile: profile.into(),
            key: "openaiApiKey".into(),
            reference: None,
            value: Some("synthetic-secret".into()),
        },
    )
    .unwrap()["reference"]
        .as_str()
        .unwrap()
        .into()
}
#[test]
fn reference_roundtrip_profile_isolation_and_delete() {
    let store = MemoryStore::default();
    let reference = put(&store, "/profile-a");
    assert!(!reference.contains("synthetic-secret"));
    assert_eq!(
        resolve_with(&store, &reference).unwrap().as_str(),
        "synthetic-secret"
    );
    let mut request = Request {
        operation: "get".into(),
        profile: "/profile-b".into(),
        key: "openaiApiKey".into(),
        reference: Some(reference.clone()),
        value: None,
    };
    assert_eq!(
        handle(&store, &request).unwrap_err(),
        "secret_profile_mismatch"
    );
    request.profile = "/profile-a".into();
    request.operation = "delete".into();
    handle(&store, &request).unwrap();
    handle(&store, &request).unwrap();
    assert_eq!(
        resolve_with(&store, &reference).unwrap_err(),
        "secret_store_missing"
    );
}
#[test]
fn row_tokens_do_not_resolve_or_fall_back_for_disabled_credentials() {
    let store = MemoryStore::default();
    let reference = put(&store, "/profile");
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("create table settings(namespace text,key text,value text);")
        .unwrap();
    db.execute(
        "insert into settings values ('runtime.secret','openaiApiKey',?1)",
        [json!({"secretRef":reference}).to_string()],
    )
    .unwrap();
    assert_eq!(row_token(&db, "openaiApiKey"), Some(reference));
    db.execute("update settings set value = '{\"disabled\":true}'", [])
        .unwrap();
    assert_eq!(row_token(&db, "openaiApiKey").as_deref(), Some(BLOCKED));
    assert!(resolve_with(&store, BLOCKED).is_err());
}
#[test]
fn writer_thread_cannot_access_os_store() {
    let reference = put(&MemoryStore::default(), "/profile");
    let result = std::thread::Builder::new()
        .name("context-still-sqlite-writer".into())
        .spawn(move || resolve(&reference))
        .unwrap()
        .join()
        .unwrap();
    assert_eq!(result.unwrap_err(), "secret_store_requires_external_phase");
}
#[test]
fn ordinary_headers_are_sensitive_and_invalid_values_are_redacted() {
    assert!(header("synthetic-secret", true).unwrap().is_sensitive());
    assert_eq!(
        header("synthetic-secret\r\nx: y", true).unwrap_err(),
        "secret_header_invalid"
    );
}
#[test]
#[cfg(target_os = "macos")]
#[ignore = "writes and deletes only a synthetic Keychain item; run explicitly on supported hosts"]
fn os_keychain_roundtrip() {
    let profile = format!("contextstill-test-{}", std::process::id());
    let reference = put(&OsSecretStore, &profile);
    let result = OsSecretStore.get(&reference);
    let resolved_header = header(&reference, true);
    let removed = OsSecretStore.delete(&reference);
    assert_eq!(result.unwrap().as_str(), "synthetic-secret");
    assert_eq!(
        resolved_header.unwrap().to_str().unwrap(),
        "Bearer synthetic-secret"
    );
    removed.unwrap();
    assert!(OsSecretStore.get(&reference).is_err());
}

#[test]
fn malformed_rows_and_database_errors_do_not_enable_environment_fallback() {
    let db = Connection::open_in_memory().unwrap();
    assert!(row_token(&db, "openaiApiKey")
        .unwrap()
        .starts_with("cs-secret:"));
    db.execute_batch("create table settings(namespace text,key text,value text);insert into settings values('runtime.secret','openaiApiKey','broken-json');").unwrap();
    assert_eq!(
        row_token(&db, "openaiApiKey").as_deref(),
        Some("cs-secret:invalid")
    );
    assert_eq!(row_token(&db, "missing"), None);
}

#[test]
fn environment_choice_is_explicit_and_must_not_contain_a_reference() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("create table settings(namespace text,key text,value text);insert into settings values('runtime.secret','openaiApiKey','{\"environment\":true}');").unwrap();
    assert_eq!(row_token(&db, "openaiApiKey"), None);
    db.execute(
        "update settings set value=?1",
        [json!({"environment":true,"secretRef":"invalid"}).to_string()],
    )
    .unwrap();
    assert_eq!(
        row_token(&db, "openaiApiKey").as_deref(),
        Some("cs-secret:invalid")
    );
}
