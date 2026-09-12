use super::foundation::{run, summary};
use crate::domains::cli::routing::ContextCompileAction;
use crate::shared::config::MapEnv;
use crate::shared::process::MockSupervisor;
use serde_json::json;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_dir() -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("context-still-foundation-{nanos}"));
    fs::create_dir_all(&path).unwrap();
    path
}

fn env_for(dir: &std::path::Path) -> MapEnv {
    MapEnv::from_pairs(vec![
        (
            "CONTEXT_STILL_APP_DATA_DIR",
            dir.to_string_lossy().into_owned(),
        ),
        (
            "CONTEXT_STILL_SQLITE_CORE_PATH",
            dir.join("core.sqlite").to_string_lossy().into_owned(),
        ),
    ])
}

#[test]
fn summary_reads_report_fields_with_fallbacks() {
    assert_eq!(
        summary(&json!({})),
        "reportKind=unknown\npromotionEligible=false\ncohortIncluded=0"
    );
    assert_eq!(
        summary(&json!({
            "reportKind": "baseline",
            "promotionEligible": true,
            "cohort": {"included": 4}
        })),
        "reportKind=baseline\npromotionEligible=true\ncohortIncluded=4"
    );
}

#[test]
fn capabilities_writes_an_offline_report() {
    let dir = temp_dir();
    let out = dir.join("capabilities.json");
    let report = run(
        ContextCompileAction::Capabilities {
            out: Some(out.clone()),
        },
        &env_for(&dir),
        &MockSupervisor::new(),
    )
    .expect("capabilities");
    assert_eq!(report["reportKind"], "capabilities");
    assert_eq!(report["promotionEligible"], false);
    assert!(out.is_file());
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn probe_and_experiment_require_explicit_allow_flags() {
    let dir = temp_dir();
    let env = env_for(&dir);
    let supervisor = MockSupervisor::new();
    let probe_error = run(
        ContextCompileAction::Probe {
            manifest: dir.join("missing.json"),
            entry_report: dir.join("entry.json"),
            out: dir.join("probe.json"),
            calls: 1,
            allow_live_writes: false,
        },
        &env,
        &supervisor,
    )
    .unwrap_err();
    assert!(probe_error
        .to_string()
        .contains("probe requires the exact --allow-live-writes flag"));
    let experiment_error = run(
        ContextCompileAction::Experiment {
            manifest: dir.join("missing.json"),
            out: dir.join("experiment.json"),
            allow_provider_calls: false,
        },
        &env,
        &supervisor,
    )
    .unwrap_err();
    assert!(experiment_error
        .to_string()
        .contains("experiment requires the exact --allow-provider-calls flag"));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn load_manifest_rejects_missing_invalid_and_unknown_fields() {
    let dir = temp_dir();
    let env = env_for(&dir);
    let supervisor = MockSupervisor::new();
    let missing = run(
        ContextCompileAction::Baseline {
            manifest: dir.join("missing.json"),
            out: dir.join("baseline.json"),
            probe: None,
        },
        &env,
        &supervisor,
    )
    .unwrap_err();
    assert!(missing
        .to_string()
        .contains("failed to read Foundation manifest"));

    fs::write(dir.join("not-object.json"), "[]").unwrap();
    let not_object = run(
        ContextCompileAction::Baseline {
            manifest: dir.join("not-object.json"),
            out: dir.join("baseline.json"),
            probe: None,
        },
        &env,
        &supervisor,
    )
    .unwrap_err();
    assert!(not_object
        .to_string()
        .contains("Foundation manifest must be a JSON object"));

    fs::write(dir.join("unknown.json"), r#"{"id":"x","unexpected":true}"#).unwrap();
    let unknown = run(
        ContextCompileAction::Baseline {
            manifest: dir.join("unknown.json"),
            out: dir.join("baseline.json"),
            probe: None,
        },
        &env,
        &supervisor,
    )
    .unwrap_err();
    assert!(unknown
        .to_string()
        .contains("unknown Foundation manifest field"));

    fs::write(
        dir.join("bad-version.json"),
        r#"{
          "id":"x",
          "pipelineVersion":"other",
          "inputs":{},
          "runtimeBinding":{},
          "cohorts":{},
          "performance":{},
          "availability":{},
          "ranking":{},
          "telemetry":{},
          "statistics":{},
          "safety":{},
          "stopConditions":["stop"]
        }"#,
    )
    .unwrap();
    let version = run(
        ContextCompileAction::Baseline {
            manifest: dir.join("bad-version.json"),
            out: dir.join("baseline.json"),
            probe: None,
        },
        &env,
        &supervisor,
    )
    .unwrap_err();
    assert!(version
        .to_string()
        .contains("unsupported Foundation pipelineVersion"));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn experiment_refuses_to_overwrite_an_existing_output() {
    let dir = temp_dir();
    let out = dir.join("experiment.json");
    fs::write(&out, "{}").unwrap();
    let error = run(
        ContextCompileAction::Experiment {
            manifest: dir.join("missing.json"),
            out,
            allow_provider_calls: true,
        },
        &env_for(&dir),
        &MockSupervisor::new(),
    )
    .unwrap_err();
    assert!(error
        .to_string()
        .contains("experiment output already exists"));
    let _ = fs::remove_dir_all(dir);
}
