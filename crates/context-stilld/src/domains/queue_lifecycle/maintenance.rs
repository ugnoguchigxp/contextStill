use rusqlite::Connection;
use serde::Serialize;
use serde_json::json;

use crate::domains::{
    bootstrap::service::resolve_paths, daemon::repository::ProcessState, sqlite_writer,
};
use crate::shared::{config::EnvProvider, errors::CliError, process};

use super::claim::stale_recovery_sql;
use super::common::queue_table_name;
use super::finalize_executor::is_retryable_embedding_error;
use super::types::{QUEUE_SUPERVISOR, QUEUE_TABLES};

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueMaintenanceReport {
    pub process: &'static str,
    pub action: &'static str,
    pub status: String,
    pub sqlite_status: &'static str,
    pub sqlite_core_path: String,
    pub recovered_provider_leases: u64,
    pub recovered_queue_jobs: u64,
    pub message: String,
}

pub fn run_maintenance_once_report<E: EnvProvider>(
    env: &E,
) -> Result<QueueMaintenanceReport, CliError> {
    let paths = resolve_paths(env);
    let sqlite_core_path = process::path_to_string(&paths.sqlite_core_path);
    if !paths.sqlite_core_path.exists() {
        return Ok(QueueMaintenanceReport {
            process: QUEUE_SUPERVISOR.state_name,
            action: "maintenance",
            status: "missing_sqlite".to_string(),
            sqlite_status: "missing",
            sqlite_core_path,
            recovered_provider_leases: 0,
            recovered_queue_jobs: 0,
            message: "queue-supervisor Rust maintenance skipped; SQLite core database is missing"
                .to_string(),
        });
    }

    let stale_seconds = env_u64_default(env, "CONTEXT_STILL_QUEUE_STALE_SECONDS", 120).max(30);
    let (recovered_provider_leases, recovered_queue_jobs) = sqlite_writer::execute_for_path(
        &paths.sqlite_core_path,
        "queue.maintenance",
        move |connection| {
            let recovered_provider_leases =
                recover_stale_provider_leases(connection, stale_seconds)
                    .map_err(|error| error.to_string())?;
            let recovered_queue_jobs = recover_stale_queue_jobs(connection, stale_seconds)
                .map_err(|error| error.to_string())?
                + recover_retryable_finalize_embedding_failures(connection)
                    .map_err(|error| error.to_string())?;
            Ok((recovered_provider_leases, recovered_queue_jobs))
        },
    )
    .map_err(|error| CliError::io(format!("SQLite writer maintenance failed: {error}")))?;
    let message = format!(
        "queue-supervisor Rust maintenance completed; recoveredProviderLeases={recovered_provider_leases} recoveredQueueJobs={recovered_queue_jobs}"
    );
    let executor_enabled = env_flag_default(env, "CONTEXT_STILL_RESIDENT_QUEUE_EXECUTOR", true);
    let state = ProcessState {
        pid: None,
        status: "scheduled".to_string(),
        log_path: paths
            .logs_dir
            .join(QUEUE_SUPERVISOR.log_file)
            .to_string_lossy()
            .into_owned(),
        started_at: None,
        updated_at: Some(crate::domains::process_lifecycle::service::now_timestamp()),
        last_error: None,
        command: Some("context-stilld".to_string()),
        args: Some(vec!["queue".to_string(), "maintenance".to_string()]),
        sqlite_core_path: Some(sqlite_core_path.clone()),
        metadata: Some(json!({
            "executor":if executor_enabled { "rust" } else { "maintenance_only" },
            "executorEnabled":executor_enabled,
            "residentPid":std::process::id(),
            "executionLanes":if executor_enabled {
                json!(["local_finalize","provider_pool"])
            } else {
                json!([])
            },
            "rustCoveringMode":env
                .var("CONTEXT_STILL_RUST_COVERING_MODE")
                .map(|value| value.trim().to_ascii_lowercase())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "off".to_string()),
            "rustFindingExecutionMode":env
                .var("CONTEXT_STILL_RUST_FINDING_EXECUTION_MODE")
                .map(|value| value.trim().to_ascii_lowercase())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "legacy".to_string()),
            "rustEpisodeExecutionMode":env
                .var("CONTEXT_STILL_RUST_EPISODE_EXECUTION_MODE")
                .map(|value| value.trim().to_ascii_lowercase())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "legacy".to_string())
        })),
        ..ProcessState::default()
    };
    crate::domains::process_lifecycle::service::write_process_state(
        &QUEUE_SUPERVISOR,
        &paths.run_dir,
        &state,
    )?;

    Ok(QueueMaintenanceReport {
        process: QUEUE_SUPERVISOR.state_name,
        action: "maintenance",
        status: "scheduled".to_string(),
        sqlite_status: "ok",
        sqlite_core_path,
        recovered_provider_leases,
        recovered_queue_jobs,
        message,
    })
}

fn recover_stale_provider_leases(
    connection: &Connection,
    stale_seconds: u64,
) -> Result<u64, CliError> {
    if !table_exists(connection, "llm_provider_leases")? {
        return Ok(0);
    }
    let changed = connection
        .execute(
            "
            update llm_provider_leases
            set
              status = 'stale_recovered',
              released_at = CURRENT_TIMESTAMP,
              release_reason = 'stale_heartbeat',
              updated_at = CURRENT_TIMESTAMP
            where status = 'active'
              and coalesce(heartbeat_at, locked_at, updated_at) < datetime(CURRENT_TIMESTAMP, '-' || ?1 || ' seconds')
            ",
            [stale_seconds as i64],
        )
        .map_err(|error| CliError::io(format!("failed to recover stale provider leases: {error}")))?;
    Ok(changed as u64)
}

fn recover_stale_queue_jobs(connection: &Connection, stale_seconds: u64) -> Result<u64, CliError> {
    let mut recovered = 0;
    for (queue_name, table_name) in QUEUE_TABLES {
        if !table_exists(connection, table_name)? {
            continue;
        }
        let canonical_table_name = queue_table_name(queue_name)?;
        let sql = stale_recovery_sql(queue_name, canonical_table_name);
        let changed = connection
            .execute(&sql, [stale_seconds as i64])
            .map_err(|error| {
                CliError::io(format!(
                    "failed to recover stale {queue_name} jobs: {error}"
                ))
            })?;
        recovered += changed as u64;
    }
    Ok(recovered)
}

fn recover_retryable_finalize_embedding_failures(connection: &Connection) -> Result<u64, CliError> {
    if !table_exists(connection, "finalize_distille_queue")? {
        return Ok(0);
    }
    let mut statement = connection
        .prepare(
            "select id, last_error from finalize_distille_queue where status = 'failed' and last_outcome_kind = 'worker_failed' and knowledge_id is null and last_error is not null",
        )
        .map_err(|error| {
            CliError::io(format!(
                "failed to prepare retryable finalize embedding recovery: {error}"
            ))
        })?;
    let candidates = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| {
            CliError::io(format!(
                "failed to query retryable finalize embedding failures: {error}"
            ))
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            CliError::io(format!(
                "failed to read retryable finalize embedding failures: {error}"
            ))
        })?;
    drop(statement);

    let transaction = connection.unchecked_transaction().map_err(|error| {
        CliError::io(format!(
            "failed to start retryable finalize embedding recovery: {error}"
        ))
    })?;
    let mut recovered = 0_u64;
    for (job_id, last_error) in candidates {
        if !is_retryable_embedding_error(&last_error) {
            continue;
        }
        recovered += transaction
            .execute(
                "update finalize_distille_queue set status = 'pending', next_run_at = CURRENT_TIMESTAMP, completed_at = null, locked_by = null, locked_at = null, heartbeat_at = null, last_outcome_kind = 'embedding_unavailable_retry', updated_at = CURRENT_TIMESTAMP where id = ?1 and status = 'failed' and last_outcome_kind = 'worker_failed' and knowledge_id is null",
                [&job_id],
            )
            .map_err(|error| {
                CliError::io(format!(
                    "failed to recover retryable finalize embedding job {job_id}: {error}"
                ))
            })? as u64;
    }
    transaction.commit().map_err(|error| {
        CliError::io(format!(
            "failed to commit retryable finalize embedding recovery: {error}"
        ))
    })?;
    Ok(recovered)
}

fn table_exists(connection: &Connection, table_name: &str) -> Result<bool, CliError> {
    connection
        .query_row(
            "select exists(select 1 from sqlite_master where type = 'table' and name = ?1)",
            [table_name],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(|error| {
            CliError::io(format!(
                "failed to inspect SQLite table {table_name}: {error}"
            ))
        })
}

fn env_u64_default<E: EnvProvider>(env: &E, key: &str, default: u64) -> u64 {
    env.var(key)
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn env_flag_default<E: EnvProvider>(env: &E, key: &str, default: bool) -> bool {
    match env.var(key).as_deref() {
        Some("0") | Some("false") | Some("FALSE") | Some("no") | Some("off") => false,
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("on") => true,
        Some(_) => default,
        None => default,
    }
}

impl QueueMaintenanceReport {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        self.message.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domains::queue_lifecycle::test_support::*;
    use crate::shared::config::MapEnv;
    use rusqlite::Connection;

    #[test]
    fn rust_queue_maintenance_recovers_stale_leases_and_jobs() {
        let app_dir = temp_app_dir("queue_maintenance");
        let sqlite_path = app_dir.join("queue.sqlite");
        let connection = Connection::open(&sqlite_path).unwrap();
        create_claim_queue_table(&connection, "finding_candidate_queue");
        connection
            .execute_batch(
                r#"
                create table llm_provider_leases (
                  id text primary key,
                  pool_id text not null,
                  target_id text not null,
                  queue_name text not null,
                  queue_job_id text not null,
                  worker_id text not null,
                  status text not null,
                  locked_at text,
                  heartbeat_at text,
                  expires_at text,
                  released_at text,
                  release_reason text,
                  metadata text,
                  created_at text not null,
                  updated_at text not null
                );
                insert into finding_candidate_queue (
                  id, status, priority, locked_by, locked_at, heartbeat_at, created_at, updated_at
                ) values (
                  'job-stale', 'running', 10, 'worker-1',
                  datetime(CURRENT_TIMESTAMP, '-10 minutes'),
                  datetime(CURRENT_TIMESTAMP, '-10 minutes'),
                  datetime(CURRENT_TIMESTAMP, '-20 minutes'),
                  datetime(CURRENT_TIMESTAMP, '-10 minutes')
                );
                insert into llm_provider_leases (
                  id, pool_id, target_id, queue_name, queue_job_id, worker_id, status,
                  locked_at, heartbeat_at, expires_at, metadata, created_at, updated_at
                ) values (
                  'lease-stale', 'pool', 'target', 'findingCandidate', 'job-stale', 'worker-1', 'active',
                  datetime(CURRENT_TIMESTAMP, '-10 minutes'),
                  datetime(CURRENT_TIMESTAMP, '-10 minutes'),
                  datetime(CURRENT_TIMESTAMP, '-5 minutes'),
                  '{}',
                  datetime(CURRENT_TIMESTAMP, '-10 minutes'),
                  datetime(CURRENT_TIMESTAMP, '-10 minutes')
                );
                "#,
            )
            .unwrap();
        drop(connection);

        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            (
                "CONTEXT_STILL_SQLITE_CORE_PATH",
                sqlite_path.to_str().unwrap(),
            ),
            ("CONTEXT_STILL_QUEUE_STALE_SECONDS", "30"),
            ("CONTEXT_STILL_RUST_COVERING_MODE", "negative"),
            ("CONTEXT_STILL_RESIDENT_QUEUE_EXECUTOR", "0"),
        ]);
        let report = run_maintenance_once_report(&env).unwrap();
        assert_eq!(report.status, "scheduled");
        assert_eq!(report.recovered_provider_leases, 1);
        assert_eq!(report.recovered_queue_jobs, 1);

        let connection = Connection::open(&sqlite_path).unwrap();
        let job_status: String = connection
            .query_row(
                "select status from finding_candidate_queue where id = 'job-stale'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let lease_status: String = connection
            .query_row(
                "select status from llm_provider_leases where id = 'lease-stale'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(job_status, "paused");
        assert_eq!(lease_status, "stale_recovered");
        let state = crate::domains::daemon::repository::read_state(
            &app_dir.join("run"),
            QUEUE_SUPERVISOR.state_name,
        )
        .unwrap()
        .unwrap();
        let metadata = state.metadata.unwrap();
        assert_eq!(metadata["rustCoveringMode"], "negative");
        assert_eq!(metadata["executorEnabled"], false);
        assert_eq!(metadata["executionLanes"], json!([]));

        std::fs::remove_dir_all(app_dir).unwrap();
    }

    #[test]
    fn rust_queue_maintenance_does_not_create_missing_sqlite() {
        let app_dir = temp_app_dir("queue_maintenance_missing");
        let sqlite_path = app_dir.join("missing.sqlite");
        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            (
                "CONTEXT_STILL_SQLITE_CORE_PATH",
                sqlite_path.to_str().unwrap(),
            ),
        ]);
        let report = run_maintenance_once_report(&env).unwrap();
        assert_eq!(report.sqlite_status, "missing");
        assert!(!std::path::Path::new(&sqlite_path).exists());

        std::fs::remove_dir_all(app_dir).unwrap();
    }

    #[test]
    fn rust_queue_maintenance_requeues_only_retryable_finalize_embedding_failures() {
        let connection = Connection::open_in_memory().unwrap();
        create_claim_queue_table(&connection, "finalize_distille_queue");
        connection
            .execute_batch(
                r#"
                alter table finalize_distille_queue add column knowledge_id text;
                insert into finalize_distille_queue (
                  id, status, attempt_count, last_error, last_outcome_kind,
                  created_at, updated_at
                ) values (
                  'retryable', 'failed', 5,
                  'embedding daemon request failed: connection refused', 'worker_failed',
                  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                );
                insert into finalize_distille_queue (
                  id, status, attempt_count, last_error, last_outcome_kind,
                  created_at, updated_at
                ) values (
                  'invalid-config', 'failed', 1,
                  'embedding provider is disabled', 'worker_failed',
                  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                );
                "#,
            )
            .unwrap();

        assert_eq!(
            recover_retryable_finalize_embedding_failures(&connection).unwrap(),
            1
        );
        assert_eq!(
            recover_retryable_finalize_embedding_failures(&connection).unwrap(),
            0
        );
        let retryable = connection
            .query_row(
                "select status, attempt_count, last_outcome_kind, next_run_at is not null from finalize_distille_queue where id='retryable'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            retryable,
            (
                "pending".to_string(),
                5,
                "embedding_unavailable_retry".to_string(),
                1
            )
        );
        let invalid_status: String = connection
            .query_row(
                "select status from finalize_distille_queue where id='invalid-config'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(invalid_status, "failed");
    }
}
