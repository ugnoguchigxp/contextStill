use std::{cmp::Ordering, collections::BTreeSet};

use rusqlite::{Connection, Transaction};

use crate::shared::errors::CliError;

use super::claim::stale_recovery_sql;
use super::common::queue_table_name;
use super::types::{
    ClaimedProviderLeaseJob, ProviderLeaseAssignment, ProviderPoolClaimConfig,
    ProviderQueueClaimSpec, RunnableProviderCandidate,
};

pub fn claim_next_job_with_provider_lease_for_connection(
    connection: &mut Connection,
    pool: &ProviderPoolClaimConfig,
    priority_queues: &[ProviderQueueClaimSpec],
    worker_id: &str,
    lease_id: &str,
    queue_stale_seconds: u64,
) -> Result<Option<ClaimedProviderLeaseJob>, CliError> {
    if pool.targets.is_empty() || priority_queues.is_empty() {
        return Ok(None);
    }

    let capacity = active_pool_capacity(pool);
    let tx = connection.transaction().map_err(|error| {
        CliError::io(format!(
            "failed to begin provider lease claim transaction: {error}"
        ))
    })?;

    tx.execute(
        "
        update llm_provider_leases
        set
          status = 'stale_recovered',
          released_at = CURRENT_TIMESTAMP,
          release_reason = 'stale_heartbeat',
          updated_at = CURRENT_TIMESTAMP
        where pool_id = ?1
          and status = 'active'
          and coalesce(heartbeat_at, locked_at, updated_at) < datetime(CURRENT_TIMESTAMP, '-' || ?2 || ' seconds')
        ",
        (&pool.pool_id, normalized_stale_lease_seconds(pool) as i64),
    )
    .map_err(|error| CliError::io(format!("failed to recover stale provider leases: {error}")))?;

    let active_lease_count = tx
        .query_row(
            "select count(*) from llm_provider_leases where pool_id = ?1 and status = 'active'",
            [&pool.pool_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| {
            CliError::io(format!("failed to count active provider leases: {error}"))
        })?;
    if active_lease_count as u64 >= capacity {
        tx.commit().map_err(|error| {
            CliError::io(format!("failed to commit provider lease claim: {error}"))
        })?;
        return Ok(None);
    }

    let active_targets = active_provider_targets(&tx, &pool.pool_id)?;
    let free_targets = pool
        .targets
        .iter()
        .filter(|target| !active_targets.contains(*target))
        .cloned()
        .collect::<Vec<_>>();
    if free_targets.is_empty() {
        tx.commit().map_err(|error| {
            CliError::io(format!("failed to commit provider lease claim: {error}"))
        })?;
        return Ok(None);
    }

    let now_unix_seconds = tx
        .query_row("select cast(strftime('%s', 'now') as integer)", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|error| CliError::io(format!("failed to read sqlite current time: {error}")))?;
    let queue_stale_seconds = queue_stale_seconds.clamp(30, 120);
    let aging_seconds = (pool.low_priority_aging_seconds as i64).max(60);
    let mut candidates = Vec::new();

    for (queue_order, queue_spec) in priority_queues.iter().enumerate() {
        let table_name = queue_table_name(&queue_spec.queue_name)?;
        let stale_sql = stale_recovery_sql(&queue_spec.queue_name, table_name);
        tx.execute(&stale_sql, [queue_stale_seconds as i64])
            .map_err(|error| {
                CliError::io(format!("failed to recover stale queue jobs: {error}"))
            })?;
        candidates.extend(runnable_provider_candidates(
            &tx,
            queue_spec,
            table_name,
            queue_order,
            now_unix_seconds,
            aging_seconds,
        )?);
    }

    let Some((picked, selected_target_id)) = pick_provider_candidate(candidates, &free_targets)
    else {
        tx.commit().map_err(|error| {
            CliError::io(format!("failed to commit provider lease claim: {error}"))
        })?;
        return Ok(None);
    };

    let changed = tx
        .execute(
            &format!(
                "
                update {}
                set
                  status = 'running',
                  locked_by = ?1,
                  locked_at = CURRENT_TIMESTAMP,
                  heartbeat_at = CURRENT_TIMESTAMP,
                  updated_at = CURRENT_TIMESTAMP
                where id = ?2
                  and status in ('pending', 'paused')
                ",
                picked.table_name
            ),
            (&worker_id, &picked.id),
        )
        .map_err(|error| {
            CliError::io(format!(
                "failed to mark provider queue job running: {error}"
            ))
        })?;
    if changed == 0 {
        tx.commit().map_err(|error| {
            CliError::io(format!("failed to commit provider lease claim: {error}"))
        })?;
        return Ok(None);
    }

    tx.execute(
        "
        insert into llm_provider_leases (
          id, pool_id, target_id, queue_name, queue_job_id, worker_id,
          status, locked_at, heartbeat_at, expires_at, metadata, created_at, updated_at
        ) values (
          ?1, ?2, ?3, ?4, ?5, ?6, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
          datetime(CURRENT_TIMESTAMP, '+' || ?7 || ' seconds'), '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        ",
        (
            lease_id,
            &pool.pool_id,
            &selected_target_id,
            &picked.queue_name,
            &picked.id,
            worker_id,
            normalized_stale_lease_seconds(pool) as i64,
        ),
    )
    .map_err(|error| CliError::io(format!("failed to insert provider lease: {error}")))?;
    tx.commit()
        .map_err(|error| CliError::io(format!("failed to commit provider lease claim: {error}")))?;

    Ok(Some(ClaimedProviderLeaseJob {
        queue_name: picked.queue_name.clone(),
        id: picked.id.clone(),
        provider_lease: ProviderLeaseAssignment {
            id: lease_id.to_string(),
            pool_id: pool.pool_id.clone(),
            target_id: selected_target_id,
            queue_name: picked.queue_name,
            queue_job_id: picked.id,
            worker_id: worker_id.to_string(),
        },
    }))
}

pub fn recover_stale_provider_leases_for_connection(
    connection: &Connection,
    pool_id: &str,
    stale_lease_seconds: u64,
) -> Result<u64, CliError> {
    let changed = connection
        .execute(
            "
            update llm_provider_leases
            set
              status = 'stale_recovered',
              released_at = CURRENT_TIMESTAMP,
              release_reason = 'stale_heartbeat',
              updated_at = CURRENT_TIMESTAMP
            where pool_id = ?1
              and status = 'active'
              and coalesce(heartbeat_at, locked_at, updated_at) < datetime(CURRENT_TIMESTAMP, '-' || ?2 || ' seconds')
            ",
            (pool_id, stale_lease_seconds.max(30) as i64),
        )
        .map_err(|error| CliError::io(format!("failed to recover stale provider leases: {error}")))?;
    Ok(changed as u64)
}

pub fn heartbeat_provider_lease_for_connection(
    connection: &Connection,
    lease_id: &str,
) -> Result<u64, CliError> {
    let changed = connection
        .execute(
            "
            update llm_provider_leases
            set heartbeat_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            where id = ?1
              and status = 'active'
            ",
            [lease_id],
        )
        .map_err(|error| CliError::io(format!("failed to heartbeat provider lease: {error}")))?;
    Ok(changed as u64)
}

pub fn release_provider_lease_for_connection(
    connection: &Connection,
    lease_id: &str,
    reason: &str,
) -> Result<u64, CliError> {
    let changed = connection
        .execute(
            "
            update llm_provider_leases
            set status = 'released',
                released_at = CURRENT_TIMESTAMP,
                release_reason = ?2,
                updated_at = CURRENT_TIMESTAMP
            where id = ?1
              and status = 'active'
            ",
            (lease_id, reason),
        )
        .map_err(|error| CliError::io(format!("failed to release provider lease: {error}")))?;
    Ok(changed as u64)
}

pub fn count_available_provider_pool_slots_for_connection(
    connection: &Connection,
    pool: &ProviderPoolClaimConfig,
) -> Result<u64, CliError> {
    if pool.targets.is_empty() {
        return Ok(0);
    }
    recover_stale_provider_leases_for_connection(
        connection,
        &pool.pool_id,
        normalized_stale_lease_seconds(pool),
    )?;
    let active_lease_count = connection
        .query_row(
            "select count(*) from llm_provider_leases where pool_id = ?1 and status = 'active'",
            [&pool.pool_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| {
            CliError::io(format!("failed to count active provider leases: {error}"))
        })?;
    Ok(active_pool_capacity(pool).saturating_sub(active_lease_count as u64))
}

fn active_pool_capacity(pool: &ProviderPoolClaimConfig) -> u64 {
    pool.max_concurrent.max(1).min(pool.targets.len() as u64)
}

fn normalized_stale_lease_seconds(pool: &ProviderPoolClaimConfig) -> u64 {
    pool.stale_lease_seconds.max(30)
}

fn active_provider_targets(
    tx: &Transaction<'_>,
    pool_id: &str,
) -> Result<BTreeSet<String>, CliError> {
    let mut statement = tx
        .prepare(
            "select target_id from llm_provider_leases where pool_id = ?1 and status = 'active'",
        )
        .map_err(|error| {
            CliError::io(format!(
                "failed to prepare active provider target query: {error}"
            ))
        })?;
    let rows = statement
        .query_map([pool_id], |row| row.get::<_, String>(0))
        .map_err(|error| {
            CliError::io(format!("failed to query active provider targets: {error}"))
        })?;
    rows.collect::<Result<BTreeSet<_>, _>>()
        .map_err(|error| CliError::io(format!("failed to read active provider targets: {error}")))
}

fn runnable_provider_candidates(
    tx: &Transaction<'_>,
    queue_spec: &ProviderQueueClaimSpec,
    table_name: &'static str,
    queue_order: usize,
    now_unix_seconds: i64,
    aging_seconds: i64,
) -> Result<Vec<RunnableProviderCandidate>, CliError> {
    let route_target_column = route_target_column_sql(queue_spec.route_target_column)?;
    let sql = runnable_provider_sql(&queue_spec.queue_name, table_name, route_target_column);
    let mut statement = tx.prepare(&sql).map_err(|error| {
        CliError::io(format!(
            "failed to prepare runnable provider query: {error}"
        ))
    })?;
    let rows = statement
        .query_map([], |row| {
            let id = row.get::<_, String>(0)?;
            let priority = row.get::<_, i64>(1)?;
            let created_at = row.get::<_, String>(2)?;
            let created_at_unix_seconds = row.get::<_, Option<i64>>(3)?.unwrap_or(0);
            let route_key = row.get::<_, Option<String>>(4)?;
            let waiting_seconds = (now_unix_seconds - created_at_unix_seconds).max(0);
            let effective_priority = -(waiting_seconds / aging_seconds);
            Ok(RunnableProviderCandidate {
                queue_name: queue_spec.queue_name.clone(),
                table_name,
                id,
                queue_order,
                effective_priority,
                priority,
                created_at,
                preferred_target_ids: preferred_targets_for_route(queue_spec, route_key.as_deref()),
            })
        })
        .map_err(|error| {
            CliError::io(format!("failed to query runnable provider jobs: {error}"))
        })?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| CliError::io(format!("failed to read runnable provider jobs: {error}")))
}

fn route_target_column_sql(column: Option<&'static str>) -> Result<Option<&'static str>, CliError> {
    match column {
        None => Ok(None),
        Some("source_kind") => Ok(Some("source_kind")),
        Some("provider_policy") => Ok(Some("provider_policy")),
        Some(other) => Err(CliError::invalid_arguments(format!(
            "unsupported route target column: {other}"
        ))),
    }
}

fn runnable_provider_sql(
    queue_name: &str,
    table_name: &str,
    route_target_column: Option<&str>,
) -> String {
    let next_run_condition = if queue_name == "finalizeDistille" {
        ""
    } else {
        "and (next_run_at is null or datetime(next_run_at) <= CURRENT_TIMESTAMP)"
    };
    let route_projection = route_target_column
        .map(|column| format!("{column} as route_key"))
        .unwrap_or_else(|| "null as route_key".to_string());
    format!(
        "
        select
          id,
          priority,
          created_at,
          cast(strftime('%s', created_at) as integer) as created_at_unix_seconds,
          {route_projection}
        from {table_name}
        where status in ('pending', 'paused')
          {next_run_condition}
        order by priority desc, created_at asc, id asc
        limit 20
        "
    )
}

fn preferred_targets_for_route(
    queue_spec: &ProviderQueueClaimSpec,
    route_key: Option<&str>,
) -> Vec<String> {
    if let Some(route_key) = route_key {
        if let Some(preference) = queue_spec
            .route_target_preferences
            .iter()
            .find(|preference| preference.value == route_key)
        {
            return preference.preferred_target_ids.clone();
        }
    }
    queue_spec.preferred_target_ids.clone()
}

fn pick_provider_candidate(
    mut candidates: Vec<RunnableProviderCandidate>,
    free_targets: &[String],
) -> Option<(RunnableProviderCandidate, String)> {
    candidates.sort_by(compare_provider_candidates);
    for candidate in candidates {
        if let Some(target) = select_target_for_candidate(&candidate, free_targets) {
            return Some((candidate, target));
        }
    }
    None
}

fn compare_provider_candidates(
    a: &RunnableProviderCandidate,
    b: &RunnableProviderCandidate,
) -> Ordering {
    a.queue_order
        .cmp(&b.queue_order)
        .then_with(|| a.effective_priority.cmp(&b.effective_priority))
        .then_with(|| b.priority.cmp(&a.priority))
        .then_with(|| a.created_at.cmp(&b.created_at))
        .then_with(|| a.id.cmp(&b.id))
}

fn select_target_for_candidate(
    candidate: &RunnableProviderCandidate,
    free_targets: &[String],
) -> Option<String> {
    if candidate.preferred_target_ids.is_empty() {
        return free_targets.first().cloned();
    }
    candidate
        .preferred_target_ids
        .iter()
        .find(|target| free_targets.contains(*target))
        .cloned()
}
