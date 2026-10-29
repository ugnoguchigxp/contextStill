use super::*;
use crate::shared::config::MapEnv;

pub(crate) fn isolated_dir() -> std::path::PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "cs_saaa_{}_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir(&dir).unwrap();
    dir
}
pub(crate) fn fixture(path: &Path) {
    if let Ok(from) = std::env::var("SAAA_EPISODE_FIXTURE_PATH") {
        std::fs::copy(from, path).unwrap();
        return;
    }
    let c = Connection::open(path).unwrap();
    c.execute_batch("CREATE TABLE memory_episode_grants(scope_key TEXT PRIMARY KEY,enabled INTEGER,revision INTEGER); INSERT INTO memory_episode_grants VALUES('user:test',1,1);
      CREATE TABLE memory_episode_changes(sequence INTEGER PRIMARY KEY,source_id TEXT); INSERT INTO memory_episode_changes VALUES(1,'origin');
      CREATE TABLE raw(source_id TEXT,version INTEGER,sequence INTEGER,role TEXT,content TEXT,recorded_at INTEGER,uttered_at INTEGER,principal TEXT,scope_key TEXT,scope_epoch INTEGER,access_revision INTEGER);
      INSERT INTO raw VALUES('origin',1,1,'user','2024年に京都へ行った。雨で散歩は中止した。',1,1,'test','user:test',1,0);
      CREATE VIEW memory_episode_source_v1 AS SELECT raw.*,g.revision AS policy_revision FROM raw JOIN memory_episode_grants g ON g.scope_key=raw.scope_key WHERE g.enabled=1;").unwrap();
}
#[test]
fn delta_import_restart_revoke_and_missing_source_never_resurrect() {
    let dir = isolated_dir();
    let raw_path = dir.join("saaa.sqlite");
    fixture(&raw_path);
    let target = dir.join("core.sqlite");
    crate::domains::vector_index::service::register_sqlite_vec();
    let mut c = Connection::open(&target).unwrap();
    crate::domains::sqlite_writer::schema::migrate(&mut c, 4).unwrap();
    drop(c);
    let env = MapEnv::from_pairs(vec![(
        "SAAA_MEMORY_SQLITE_PATH",
        raw_path.to_str().unwrap(),
    )]);
    assert!(sync(&env, &target).unwrap() > 0);
    assert_eq!(sync(&env, &target).unwrap(), 0);
    let c = Connection::open(&target).unwrap();
    let metadata: String = c
        .query_row("SELECT metadata FROM vibe_memories LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    let metadata: Value = serde_json::from_str(&metadata).unwrap();
    validate(&metadata).unwrap();
    let spec = contract(&metadata).unwrap().unwrap();
    assert!(spec
        .sources
        .iter()
        .all(|s| s.start < s.end && s.end <= s.byte_length));
    assert!(open(raw_path.to_str().unwrap())
        .unwrap()
        .execute("UPDATE memory_episode_grants SET enabled=0", [])
        .is_err());
    let raw = Connection::open(&raw_path).unwrap();
    raw.execute(
        "UPDATE memory_episode_grants SET enabled=0,revision=revision+1",
        [],
    )
    .unwrap();
    assert!(validate(&metadata).is_err());
    assert_eq!(sync(&env, &target).unwrap(), 0);
    assert_eq!(
        c.query_row("SELECT count(*) FROM vibe_memories", [], |r| r
            .get::<_, u32>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM episode_distiller_queue", [], |r| r
            .get::<_, u32>(0))
            .unwrap(),
        0
    );
    // No notification is required for immediate admission: an unavailable DB is held.
    std::fs::rename(&raw_path, dir.join("stopped.sqlite")).unwrap();
    assert!(validate(&metadata).is_err());
    assert!(sync(&env, &target).is_err());
    std::fs::rename(dir.join("stopped.sqlite"), &raw_path).unwrap();
    assert_eq!(sync(&env, &target).unwrap(), 0);
}

#[test]
fn malformed_contract_is_held_and_utf8_ranges_are_exact() {
    let dir = isolated_dir();
    let raw_path = dir.join("saaa.sqlite");
    fixture(&raw_path);
    let c = open(raw_path.to_str().unwrap()).unwrap();
    let scope: String = c
        .query_row(
            "SELECT scope_key FROM memory_episode_grants LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let (source, text, principal) = load(&c, "origin", &scope).unwrap().unwrap();
    let spec = SourceContract {
        contract_version: 1,
        sqlite_path: raw_path.to_str().unwrap().into(),
        principal,
        sources: vec![source],
    };
    let mut metadata = json!({"saaa":spec});
    validate(&metadata).unwrap();
    metadata["saaa"]["sources"][0]["end"] = json!(text.len() + 1);
    assert!(validate(&metadata).is_err());
    metadata["saaa"]["sources"][0]["end"] = json!(text.len());
    metadata["saaa"]["sources"][0]["version"] = json!(999);
    assert!(validate(&metadata).is_err());
    assert!(validate(&json!({"saaa":{"contractVersion":1}})).is_err());
}

#[test]
fn long_utf8_repeated_feed_and_partial_forget_preserve_only_surviving_evidence() {
    let dir = isolated_dir();
    let raw_path = dir.join("saaa.sqlite");
    fixture(&raw_path);
    let raw = Connection::open(&raw_path).unwrap();
    let production: bool = raw
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='conversation_messages')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let text = "京都の旅行記録。".repeat(6000);
    if production {
        raw.execute(
            "UPDATE conversation_messages SET content=?1 WHERE id='origin'",
            [&text],
        )
        .unwrap();
    } else {
        raw.execute(
            "UPDATE raw SET content=?1 WHERE source_id='origin'",
            [&text],
        )
        .unwrap();
        raw.execute("INSERT INTO raw VALUES('survivor',1,2,'user','次は博物館に行きたい。',1,1,'test','user:test',1,0)",[]).unwrap();
        raw.execute(
            "INSERT INTO memory_episode_changes VALUES(2,'survivor')",
            [],
        )
        .unwrap();
    }
    let target = dir.join("core.sqlite");
    crate::domains::vector_index::service::register_sqlite_vec();
    let mut c = Connection::open(&target).unwrap();
    crate::domains::sqlite_writer::schema::migrate(&mut c, 4).unwrap();
    let env = MapEnv::from_pairs(vec![(
        "SAAA_MEMORY_SQLITE_PATH",
        raw_path.to_str().unwrap(),
    )]);
    sync(&env, &target).unwrap();
    let before: u32 = c
        .query_row("SELECT count(*) FROM saaa_imported_fragments", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(before >= 5);
    raw.execute(
        "INSERT INTO memory_episode_changes(source_id) VALUES('origin')",
        [],
    )
    .unwrap();
    assert_eq!(sync(&env, &target).unwrap(), 0);
    assert_eq!(
        c.query_row("SELECT count(*) FROM saaa_imported_fragments", [], |r| r
            .get::<_, u32>(0))
            .unwrap(),
        before
    );
    if production {
        raw.execute("DELETE FROM conversation_messages WHERE id='origin'", [])
            .unwrap();
    } else {
        raw.execute("DELETE FROM raw WHERE source_id='origin'", [])
            .unwrap();
    }
    sync(&env, &target).unwrap();
    let rows: Vec<String> = c
        .prepare("SELECT metadata FROM vibe_memories")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(!rows.is_empty());
    for row in rows {
        let v: Value = serde_json::from_str(&row).unwrap();
        validate(&v).unwrap();
        assert!(contract(&v)
            .unwrap()
            .unwrap()
            .sources
            .iter()
            .all(|s| s.source_id != "origin"));
    }
    assert_eq!(sync(&env, &target).unwrap(), 0);
}
