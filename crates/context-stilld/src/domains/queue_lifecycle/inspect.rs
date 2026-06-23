use std::{collections::BTreeSet, path::PathBuf};

use rusqlite::{Connection, OpenFlags};

use crate::domains::{bootstrap::service::resolve_paths, daemon::repository};
use crate::shared::{
    config::EnvProvider,
    errors::CliError,
    process::{self, ProcessSupervisor},
};

use super::service::status_report;
use super::types::{
    ActiveProviderLease, QueueInspectReport, QueueStatusCount, QueueTableInspect, QUEUE_SUPERVISOR,
    QUEUE_TABLES,
};

pub fn inspect_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<QueueInspectReport, CliError> {
    let lifecycle = status_report(env, supervisor)?;
    let paths = resolve_paths(env);
    let sqlite_path = effective_sqlite_core_path(env, supervisor, &paths);
    let sqlite_core_path = process::path_to_string(&sqlite_path);
    if !sqlite_path.exists() {
        return Ok(QueueInspectReport {
            process: QUEUE_SUPERVISOR.state_name,
            action: "inspect",
            status: lifecycle.status,
            worker_pid: lifecycle.pid,
            executor_mode: "missing_sqlite".to_string(),
            executor_running: false,
            executor_pid: None,
            runnable_pending_count: 0,
            blocked_reason: Some("SQLite core database is missing".to_string()),
            sqlite_status: "missing",
            sqlite_core_path,
            queues: Vec::new(),
            active_lease_count: 0,
            active_target_ids: Vec::new(),
            active_leases: Vec::new(),
            last_heartbeat_at: None,
        });
    }

    let connection = Connection::open_with_flags(&sqlite_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| {
            CliError::io(format!(
                "failed to open SQLite core database read-only: {error}"
            ))
        })?;
    let queues = inspect_queue_tables(&connection)?;
    let active_leases = inspect_active_leases(&connection)?;
    let active_target_ids = active_leases
        .iter()
        .map(|lease| lease.target_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let runnable_pending_count = queues.iter().map(|queue| queue.runnable_pending).sum();
    let rust_executor_running = active_leases
        .iter()
        .any(ActiveProviderLease::is_rust_executor);
    let rust_executor_pid = active_leases
        .iter()
        .find_map(ActiveProviderLease::rust_executor_pid);
    let external_worker_running = !active_leases.is_empty() && !rust_executor_running;
    let executor_running =
        lifecycle.pid.is_some() || rust_executor_running || external_worker_running;
    let executor_mode = if lifecycle.pid.is_some() {
        "legacy_process".to_string()
    } else if rust_executor_running {
        "rust_native".to_string()
    } else if external_worker_running {
        "external_worker".to_string()
    } else if runnable_pending_count > 0 {
        "maintenance_only".to_string()
    } else {
        "idle".to_string()
    };
    let blocked_reason = if executor_mode == "maintenance_only" {
        Some("runnable queue jobs exist but no executor is active".to_string())
    } else {
        None
    };
    let last_heartbeat_at = latest_timestamp(
        queues
            .iter()
            .filter_map(|queue| queue.last_heartbeat_at.clone())
            .chain(active_leases.iter().map(|lease| lease.heartbeat_at.clone())),
    );

    Ok(QueueInspectReport {
        process: QUEUE_SUPERVISOR.state_name,
        action: "inspect",
        status: lifecycle.status,
        worker_pid: lifecycle.pid,
        executor_mode,
        executor_running,
        executor_pid: lifecycle.pid.or(rust_executor_pid),
        runnable_pending_count,
        blocked_reason,
        sqlite_status: "ok",
        sqlite_core_path,
        queues,
        active_lease_count: active_leases.len() as u64,
        active_target_ids,
        active_leases,
        last_heartbeat_at,
    })
}

fn effective_sqlite_core_path<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
    paths: &crate::domains::bootstrap::service::PathReport,
) -> PathBuf {
    if env.var("CONTEXT_STILL_SQLITE_CORE_PATH").is_some() {
        return paths.sqlite_core_path.clone();
    }
    let Ok(Some(state)) = repository::read_state(&paths.run_dir, "context-stilld") else {
        return paths.sqlite_core_path.clone();
    };
    let Some(pid) = state.pid else {
        return paths.sqlite_core_path.clone();
    };
    if !supervisor.is_alive(pid) {
        return paths.sqlite_core_path.clone();
    }
    state
        .sqlite_core_path
        .map(PathBuf::from)
        .unwrap_or_else(|| paths.sqlite_core_path.clone())
}

fn inspect_queue_tables(connection: &Connection) -> Result<Vec<QueueTableInspect>, CliError> {
    let mut queues = Vec::new();
    for (queue_name, table_name) in QUEUE_TABLES {
        if !table_exists(connection, table_name)? {
            queues.push(QueueTableInspect {
                queue_name,
                table_name,
                table_status: "missing",
                status_counts: Vec::new(),
                oldest_pending_at: None,
                runnable_pending: 0,
                running: 0,
                last_heartbeat_at: None,
            });
            continue;
        }
        let status_counts = status_counts(connection, table_name)?;
        let running = status_counts
            .iter()
            .find(|count| count.status == "running")
            .map(|count| count.count)
            .unwrap_or(0);
        queues.push(QueueTableInspect {
            queue_name,
            table_name,
            table_status: "ok",
            oldest_pending_at: scalar_string(
                connection,
                &format!(
                    "select min(created_at) from {table_name} where status in ('pending', 'paused')"
                ),
            )?,
            runnable_pending: runnable_pending(connection, queue_name, table_name)?,
            last_heartbeat_at: scalar_string(
                connection,
                &format!(
                    "select max(heartbeat_at) from {table_name} where heartbeat_at is not null"
                ),
            )?,
            status_counts,
            running,
        });
    }
    Ok(queues)
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

fn status_counts(
    connection: &Connection,
    table_name: &str,
) -> Result<Vec<QueueStatusCount>, CliError> {
    let mut statement = connection
        .prepare(&format!(
            "select status, count(*) from {table_name} group by status order by status"
        ))
        .map_err(|error| {
            CliError::io(format!(
                "failed to prepare queue status count query: {error}"
            ))
        })?;
    let rows = statement
        .query_map([], |row| {
            Ok(QueueStatusCount {
                status: row.get(0)?,
                count: row.get::<_, i64>(1)? as u64,
            })
        })
        .map_err(|error| CliError::io(format!("failed to query queue status counts: {error}")))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| CliError::io(format!("failed to read queue status counts: {error}")))
}

fn scalar_string(connection: &Connection, sql: &str) -> Result<Option<String>, CliError> {
    connection
        .query_row(sql, [], |row| row.get::<_, Option<String>>(0))
        .map_err(|error| CliError::io(format!("failed to query queue timestamp: {error}")))
}

fn runnable_pending(
    connection: &Connection,
    queue_name: &str,
    table_name: &str,
) -> Result<u64, CliError> {
    let next_run_condition = if queue_name == "finalizeDistille"
        || !table_has_column(connection, table_name, "next_run_at")?
    {
        ""
    } else {
        "and (next_run_at is null or datetime(next_run_at) <= CURRENT_TIMESTAMP)"
    };
    connection
        .query_row(
            &format!(
                "
                select count(*)
                from {table_name}
                where status in ('pending', 'paused')
                  {next_run_condition}
                "
            ),
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count as u64)
        .map_err(|error| CliError::io(format!("failed to count runnable queue jobs: {error}")))
}

fn table_has_column(
    connection: &Connection,
    table_name: &str,
    column_name: &str,
) -> Result<bool, CliError> {
    let mut statement = connection
        .prepare(&format!("pragma table_info({table_name})"))
        .map_err(|error| CliError::io(format!("failed to inspect table columns: {error}")))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| CliError::io(format!("failed to query table columns: {error}")))?;
    let columns = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| CliError::io(format!("failed to read table columns: {error}")))?;
    Ok(columns.iter().any(|column| column == column_name))
}

fn inspect_active_leases(connection: &Connection) -> Result<Vec<ActiveProviderLease>, CliError> {
    if !table_exists(connection, "llm_provider_leases")? {
        return Ok(Vec::new());
    }
    let mut statement = connection
        .prepare(
            "select pool_id, target_id, queue_name, queue_job_id, worker_id, heartbeat_at, expires_at \
             from llm_provider_leases \
             where status = 'active' \
             order by pool_id, target_id, queue_name, queue_job_id",
        )
        .map_err(|error| CliError::io(format!("failed to prepare active lease query: {error}")))?;
    let rows = statement
        .query_map([], |row| {
            Ok(ActiveProviderLease {
                pool_id: row.get(0)?,
                target_id: row.get(1)?,
                queue_name: row.get(2)?,
                queue_job_id: row.get(3)?,
                worker_id: row.get(4)?,
                heartbeat_at: row.get(5)?,
                expires_at: row.get(6)?,
            })
        })
        .map_err(|error| CliError::io(format!("failed to query active leases: {error}")))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| CliError::io(format!("failed to read active leases: {error}")))
}

fn latest_timestamp(values: impl Iterator<Item = String>) -> Option<String> {
    values.max()
}

impl QueueInspectReport {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        format!(
            "queue-supervisor inspect: {} sqlite={} activeLeases={}",
            self.status, self.sqlite_status, self.active_lease_count
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domains::queue_lifecycle::test_support::*;
    use crate::shared::config::MapEnv;
    use crate::shared::process::{MockSupervisor, ProcessSupervisor};

    #[test]
    fn inspect_reports_missing_sqlite_without_creating_database() {
        let app_dir = temp_app_dir("missing");
        let sqlite_path = app_dir.join("missing.sqlite");
        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            (
                "CONTEXT_STILL_SQLITE_CORE_PATH",
                sqlite_path.to_str().unwrap(),
            ),
        ]);
        let supervisor = MockSupervisor::new();

        let report = inspect_report(&env, &supervisor).unwrap();

        assert_eq!(report.sqlite_status, "missing");
        assert_eq!(report.status, "stopped");
        assert!(report.queues.is_empty());
        assert!(!sqlite_path.exists());

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn inspect_reads_queue_counts_and_active_leases() {
        let app_dir = temp_app_dir("active");
        let sqlite_path = app_dir.join("queue.sqlite");
        let connection = Connection::open(&sqlite_path).unwrap();
        connection
        .execute_batch(
            r#"
            create table finding_candidate_queue (
              id text primary key,
              status text not null,
              created_at text not null,
              heartbeat_at text
            );
            create table episode_distiller_queue (
              id text primary key,
              status text not null,
              created_at text not null,
              heartbeat_at text
            );
            create table llm_provider_leases (
              id text primary key,
              pool_id text not null,
              target_id text not null,
              queue_name text not null,
              queue_job_id text not null,
              worker_id text not null,
              status text not null,
              heartbeat_at text not null,
              expires_at text not null
            );
            insert into finding_candidate_queue (id, status, created_at, heartbeat_at)
              values ('job-1', 'pending', '2026-06-22T01:00:00.000Z', null);
            insert into finding_candidate_queue (id, status, created_at, heartbeat_at)
              values ('job-2', 'running', '2026-06-22T02:00:00.000Z', '2026-06-22T02:01:00.000Z');
            insert into episode_distiller_queue (id, status, created_at, heartbeat_at)
              values ('job-3', 'completed', '2026-06-22T03:00:00.000Z', '2026-06-22T03:01:00.000Z');
            insert into llm_provider_leases (
              id, pool_id, target_id, queue_name, queue_job_id, worker_id, status, heartbeat_at, expires_at
            ) values (
              'lease-1', 'local-llm-default', 'local-llm:qwen-a', 'findingCandidate', 'job-2',
              'worker-1', 'active', '2026-06-22T04:00:00.000Z', '2026-06-22T04:05:00.000Z'
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
        ]);
        let supervisor = MockSupervisor::new();
        let queue_pid = supervisor
            .spawn(
                "bun",
                &[
                    "run",
                    "src/cli/queue-supervisor.ts",
                    "--continuous",
                    "--limit",
                    "1",
                ],
                &app_dir.join("logs/queue-supervisor.log"),
                &app_dir,
            )
            .unwrap();
        crate::domains::daemon::repository::write_pid(
            &app_dir.join("run"),
            "queue-supervisor",
            queue_pid,
        )
        .unwrap();

        let report = inspect_report(&env, &supervisor).unwrap();

        assert_eq!(report.sqlite_status, "ok");
        assert_eq!(report.status, "running");
        assert_eq!(report.worker_pid, Some(queue_pid));
        assert_eq!(report.active_lease_count, 1);
        assert_eq!(
            report.active_target_ids,
            vec!["local-llm:qwen-a".to_string()]
        );
        assert_eq!(
            report.last_heartbeat_at,
            Some("2026-06-22T04:00:00.000Z".to_string())
        );
        let finding = report
            .queues
            .iter()
            .find(|queue| queue.queue_name == "findingCandidate")
            .unwrap();
        assert_eq!(finding.table_status, "ok");
        assert_eq!(finding.running, 1);
        assert_eq!(
            finding.oldest_pending_at,
            Some("2026-06-22T01:00:00.000Z".to_string())
        );
        assert!(
            report
                .queues
                .iter()
                .any(|queue| queue.queue_name == "coveringEvidence"
                    && queue.table_status == "missing")
        );

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn inspect_uses_live_resident_sqlite_path_when_shell_env_omits_it() {
        let app_dir = temp_app_dir("resident_path");
        let live_sqlite_path = app_dir.join("live.sqlite");
        let connection = Connection::open(&live_sqlite_path).unwrap();
        connection
            .execute_batch(
                r#"
            create table finding_candidate_queue (
              id text primary key,
              status text not null,
              created_at text not null,
              heartbeat_at text
            );
            insert into finding_candidate_queue (id, status, created_at, heartbeat_at)
              values ('job-1', 'pending', '2026-06-22T01:00:00.000Z', null);
            "#,
            )
            .unwrap();
        drop(connection);

        let env = MapEnv::from_pairs(vec![(
            "CONTEXT_STILL_APP_DATA_DIR",
            app_dir.to_str().unwrap(),
        )]);
        let supervisor = MockSupervisor::new();
        let resident_pid = supervisor
            .spawn(
                "context-stilld",
                &["run"],
                &app_dir.join("logs/context-stilld.log"),
                &app_dir,
            )
            .unwrap();
        std::fs::create_dir_all(app_dir.join("run")).unwrap();
        crate::domains::daemon::repository::write_state(
            &app_dir.join("run"),
            "context-stilld",
            &crate::domains::daemon::repository::ProcessState {
                pid: Some(resident_pid),
                status: "running".to_string(),
                log_path: app_dir
                    .join("logs/context-stilld.log")
                    .to_string_lossy()
                    .into_owned(),
                sqlite_core_path: Some(live_sqlite_path.to_string_lossy().into_owned()),
                ..crate::domains::daemon::repository::ProcessState::default()
            },
        )
        .unwrap();

        let report = inspect_report(&env, &supervisor).unwrap();

        assert_eq!(report.sqlite_status, "ok");
        assert_eq!(report.sqlite_core_path, live_sqlite_path.to_string_lossy());
        assert_eq!(
            report
                .queues
                .iter()
                .find(|queue| queue.queue_name == "findingCandidate")
                .unwrap()
                .oldest_pending_at,
            Some("2026-06-22T01:00:00.000Z".to_string())
        );

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn inspect_reports_rust_executor_pid_from_active_lease_worker_id() {
        let app_dir = temp_app_dir("rust_executor_pid");
        let sqlite_path = app_dir.join("queue.sqlite");
        let connection = Connection::open(&sqlite_path).unwrap();
        connection
            .execute_batch(
                r#"
            create table episode_distiller_queue (
              id text primary key,
              status text not null,
              created_at text not null,
              heartbeat_at text
            );
            create table llm_provider_leases (
              id text primary key,
              pool_id text not null,
              target_id text not null,
              queue_name text not null,
              queue_job_id text not null,
              worker_id text not null,
              status text not null,
              heartbeat_at text not null,
              expires_at text not null
            );
            insert into episode_distiller_queue (id, status, created_at, heartbeat_at)
              values ('job-1', 'running', '2026-06-22T01:00:00.000Z', '2026-06-22T01:01:00.000Z');
            insert into llm_provider_leases (
              id, pool_id, target_id, queue_name, queue_job_id, worker_id, status, heartbeat_at, expires_at
            ) values (
              'lease-1', 'local-llm-default', 'local-llm:qwen-a', 'episodeDistiller', 'job-1',
              'context-stilld-rust-executor:local-llm-default:4242-123456789', 'active',
              '2026-06-22T01:01:00.000Z', '2026-06-22T01:03:00.000Z'
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
        ]);
        let supervisor = MockSupervisor::new();

        let report = inspect_report(&env, &supervisor).unwrap();

        assert_eq!(report.executor_mode, "rust_native");
        assert!(report.executor_running);
        assert_eq!(report.executor_pid, Some(4242));
        assert_eq!(report.worker_pid, None);

        std::fs::remove_dir_all(&app_dir).unwrap();
    }
}
