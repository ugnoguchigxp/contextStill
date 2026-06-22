use super::provider_lease::*;
use super::test_support::*;
use rusqlite::Connection;

#[test]
fn rust_provider_claim_picks_route_preferred_target_and_inserts_lease() {
    let app_dir = temp_app_dir("provider_claim_preferred");
    let sqlite_path = app_dir.join("queue.sqlite");
    let mut connection = Connection::open(&sqlite_path).unwrap();
    create_provider_claim_queue_table(&connection, "finding_candidate_queue");
    create_provider_lease_table(&connection);
    connection
        .execute_batch(
            r#"
            insert into finding_candidate_queue (
              id, status, priority, created_at, updated_at, next_run_at, source_kind
            ) values (
              'job-source', 'pending', 10, '2026-06-22 01:00:00', '2026-06-22 01:00:00', null, 'source'
            );
            "#,
        )
        .unwrap();

    let claimed = claim_next_job_with_provider_lease_for_connection(
        &mut connection,
        &provider_pool(),
        &[finding_candidate_spec()],
        "worker-1",
        "lease-1",
        90,
    )
    .unwrap()
    .unwrap();

    assert_eq!(claimed.id, "job-source");
    assert_eq!(claimed.provider_lease.target_id, "local-a");
    let lease = connection
        .query_row(
            "select pool_id, target_id, queue_name, queue_job_id, worker_id, status from llm_provider_leases where id = 'lease-1'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        lease,
        (
            "local-llm-default".to_string(),
            "local-a".to_string(),
            "findingCandidate".to_string(),
            "job-source".to_string(),
            "worker-1".to_string(),
            "active".to_string()
        )
    );

    std::fs::remove_dir_all(&app_dir).unwrap();
}

#[test]
fn rust_provider_claim_accepts_iso8601_next_run_at() {
    let app_dir = temp_app_dir("provider_claim_iso8601_next_run_at");
    let sqlite_path = app_dir.join("queue.sqlite");
    let mut connection = Connection::open(&sqlite_path).unwrap();
    create_provider_claim_queue_table(&connection, "finding_candidate_queue");
    create_provider_lease_table(&connection);
    connection
        .execute_batch(
            r#"
            insert into finding_candidate_queue (
              id, status, priority, created_at, updated_at, next_run_at, source_kind
            ) values (
              'job-iso-ready', 'pending', 10, '2026-06-22 01:00:00', '2026-06-22 01:00:00',
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute'), 'source'
            );
            "#,
        )
        .unwrap();

    let claimed = claim_next_job_with_provider_lease_for_connection(
        &mut connection,
        &provider_pool(),
        &[finding_candidate_spec()],
        "worker-iso",
        "lease-iso",
        90,
    )
    .unwrap()
    .unwrap();

    assert_eq!(claimed.id, "job-iso-ready");
    assert_eq!(claimed.provider_lease.target_id, "local-a");

    std::fs::remove_dir_all(&app_dir).unwrap();
}

#[test]
fn rust_provider_claim_keeps_queue_order_ahead_of_older_higher_priority_episode_jobs() {
    let app_dir = temp_app_dir("provider_claim_queue_order");
    let sqlite_path = app_dir.join("queue.sqlite");
    let mut connection = Connection::open(&sqlite_path).unwrap();
    create_provider_claim_queue_table(&connection, "finding_candidate_queue");
    create_provider_claim_queue_table(&connection, "episode_distiller_queue");
    create_provider_lease_table(&connection);
    connection
        .execute_batch(
            r#"
            insert into finding_candidate_queue (
              id, status, priority, created_at, updated_at, next_run_at, source_kind
            ) values (
              'job-finding', 'pending', 50,
              datetime(CURRENT_TIMESTAMP, '-1 hour'),
              datetime(CURRENT_TIMESTAMP, '-1 hour'),
              null, 'source'
            );
            insert into episode_distiller_queue (
              id, status, priority, created_at, updated_at, next_run_at, provider_policy
            ) values (
              'job-episode', 'pending', 95,
              datetime(CURRENT_TIMESTAMP, '-24 hours'),
              datetime(CURRENT_TIMESTAMP, '-24 hours'),
              null, 'default'
            );
            "#,
        )
        .unwrap();
    let mut pool = provider_pool();
    pool.targets = vec!["local-a".to_string()];
    pool.max_concurrent = 1;
    pool.low_priority_aging_seconds = 60;
    let episode_spec = super::types::ProviderQueueClaimSpec {
        queue_name: "episodeDistiller".to_string(),
        preferred_target_ids: vec!["local-a".to_string()],
        route_target_column: None,
        route_target_preferences: Vec::new(),
    };

    let claimed = claim_next_job_with_provider_lease_for_connection(
        &mut connection,
        &pool,
        &[finding_candidate_spec(), episode_spec],
        "worker-queue-order",
        "lease-queue-order",
        90,
    )
    .unwrap()
    .unwrap();

    assert_eq!(claimed.queue_name, "findingCandidate");
    assert_eq!(claimed.id, "job-finding");

    std::fs::remove_dir_all(&app_dir).unwrap();
}

#[test]
fn rust_provider_claim_waits_for_route_target_instead_of_using_other_free_target() {
    let app_dir = temp_app_dir("provider_claim_wait_target");
    let sqlite_path = app_dir.join("queue.sqlite");
    let mut connection = Connection::open(&sqlite_path).unwrap();
    create_provider_claim_queue_table(&connection, "finding_candidate_queue");
    create_provider_lease_table(&connection);
    connection
        .execute_batch(
            r#"
            insert into finding_candidate_queue (
              id, status, priority, created_at, updated_at, next_run_at, source_kind
            ) values (
              'job-source', 'pending', 10, '2026-06-22 01:00:00', '2026-06-22 01:00:00', null, 'source'
            );
            insert into llm_provider_leases (
              id, pool_id, target_id, queue_name, queue_job_id, worker_id, status,
              locked_at, heartbeat_at, expires_at, metadata, created_at, updated_at
            ) values (
              'lease-active', 'local-llm-default', 'local-a', 'findingCandidate', 'job-running',
              'worker-old', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
              datetime(CURRENT_TIMESTAMP, '+120 seconds'), '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            );
            "#,
        )
        .unwrap();

    let claimed = claim_next_job_with_provider_lease_for_connection(
        &mut connection,
        &provider_pool(),
        &[finding_candidate_spec()],
        "worker-1",
        "lease-1",
        90,
    )
    .unwrap();

    assert_eq!(claimed, None);
    let status = connection
        .query_row(
            "select status from finding_candidate_queue where id = 'job-source'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    assert_eq!(status, "pending");

    std::fs::remove_dir_all(&app_dir).unwrap();
}

#[test]
fn rust_provider_claim_allows_same_queue_different_route_on_free_target() {
    let app_dir = temp_app_dir("provider_claim_different_route");
    let sqlite_path = app_dir.join("queue.sqlite");
    let mut connection = Connection::open(&sqlite_path).unwrap();
    create_provider_claim_queue_table(&connection, "finding_candidate_queue");
    create_provider_lease_table(&connection);
    connection
        .execute_batch(
            r#"
            insert into finding_candidate_queue (
              id, status, priority, created_at, updated_at, next_run_at, source_kind,
              locked_by, locked_at, heartbeat_at
            ) values (
              'job-source-running', 'running', 10, '2026-06-22 01:00:00', CURRENT_TIMESTAMP, null, 'source',
              'worker-old', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            );
            insert into finding_candidate_queue (
              id, status, priority, created_at, updated_at, next_run_at, source_kind
            ) values (
              'job-vibe', 'pending', 9, '2026-06-22 02:00:00', '2026-06-22 02:00:00', null, 'vibe_memory'
            );
            insert into llm_provider_leases (
              id, pool_id, target_id, queue_name, queue_job_id, worker_id, status,
              locked_at, heartbeat_at, expires_at, metadata, created_at, updated_at
            ) values (
              'lease-active', 'local-llm-default', 'local-a', 'findingCandidate', 'job-source-running',
              'worker-old', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
              datetime(CURRENT_TIMESTAMP, '+120 seconds'), '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            );
            "#,
        )
        .unwrap();

    let claimed = claim_next_job_with_provider_lease_for_connection(
        &mut connection,
        &provider_pool(),
        &[finding_candidate_spec()],
        "worker-1",
        "lease-1",
        90,
    )
    .unwrap()
    .unwrap();

    assert_eq!(claimed.id, "job-vibe");
    assert_eq!(claimed.provider_lease.target_id, "local-b");

    std::fs::remove_dir_all(&app_dir).unwrap();
}

#[test]
fn rust_provider_claim_recovers_stale_lease_and_reuses_target() {
    let app_dir = temp_app_dir("provider_claim_stale_lease");
    let sqlite_path = app_dir.join("queue.sqlite");
    let mut connection = Connection::open(&sqlite_path).unwrap();
    create_provider_claim_queue_table(&connection, "finding_candidate_queue");
    create_provider_lease_table(&connection);
    connection
        .execute_batch(
            r#"
            insert into finding_candidate_queue (
              id, status, priority, created_at, updated_at, next_run_at, source_kind
            ) values (
              'job-source', 'pending', 10, '2026-06-22 01:00:00', '2026-06-22 01:00:00', null, 'source'
            );
            insert into llm_provider_leases (
              id, pool_id, target_id, queue_name, queue_job_id, worker_id, status,
              locked_at, heartbeat_at, expires_at, metadata, created_at, updated_at
            ) values (
              'lease-stale', 'local-llm-default', 'local-a', 'findingCandidate', 'job-old',
              'worker-old', 'active', '2000-01-01 00:00:00', '2000-01-01 00:00:00',
              '2000-01-01 00:02:00', '{}', '2000-01-01 00:00:00', '2000-01-01 00:00:00'
            );
            "#,
        )
        .unwrap();

    let claimed = claim_next_job_with_provider_lease_for_connection(
        &mut connection,
        &provider_pool(),
        &[finding_candidate_spec()],
        "worker-1",
        "lease-1",
        90,
    )
    .unwrap()
    .unwrap();

    assert_eq!(claimed.provider_lease.target_id, "local-a");
    let stale_status = connection
        .query_row(
            "select status, release_reason from llm_provider_leases where id = 'lease-stale'",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .unwrap();
    assert_eq!(
        stale_status,
        ("stale_recovered".to_string(), "stale_heartbeat".to_string())
    );

    std::fs::remove_dir_all(&app_dir).unwrap();
}

#[test]
fn rust_provider_claim_blocks_when_pool_capacity_is_full() {
    let app_dir = temp_app_dir("provider_claim_capacity");
    let sqlite_path = app_dir.join("queue.sqlite");
    let mut connection = Connection::open(&sqlite_path).unwrap();
    create_provider_claim_queue_table(&connection, "finding_candidate_queue");
    create_provider_lease_table(&connection);
    connection
        .execute_batch(
            r#"
            insert into finding_candidate_queue (
              id, status, priority, created_at, updated_at, next_run_at, source_kind
            ) values (
              'job-vibe', 'pending', 10, '2026-06-22 01:00:00', '2026-06-22 01:00:00', null, 'vibe_memory'
            );
            insert into llm_provider_leases (
              id, pool_id, target_id, queue_name, queue_job_id, worker_id, status,
              locked_at, heartbeat_at, expires_at, metadata, created_at, updated_at
            ) values (
              'lease-active', 'local-llm-default', 'local-a', 'findingCandidate', 'job-source',
              'worker-old', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
              datetime(CURRENT_TIMESTAMP, '+120 seconds'), '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            );
            "#,
        )
        .unwrap();
    let mut pool = provider_pool();
    pool.max_concurrent = 1;

    let claimed = claim_next_job_with_provider_lease_for_connection(
        &mut connection,
        &pool,
        &[finding_candidate_spec()],
        "worker-1",
        "lease-1",
        90,
    )
    .unwrap();

    assert_eq!(claimed, None);

    std::fs::remove_dir_all(&app_dir).unwrap();
}

#[test]
fn rust_provider_lease_manager_counts_slots_after_stale_recovery() {
    let app_dir = temp_app_dir("provider_slots");
    let sqlite_path = app_dir.join("queue.sqlite");
    let connection = Connection::open(&sqlite_path).unwrap();
    create_provider_lease_table(&connection);
    connection
        .execute_batch(
            r#"
            insert into llm_provider_leases (
              id, pool_id, target_id, queue_name, queue_job_id, worker_id, status,
              locked_at, heartbeat_at, expires_at, metadata, created_at, updated_at
            ) values (
              'lease-stale', 'local-llm-default', 'local-a', 'findingCandidate', 'job-old',
              'worker-old', 'active', '2000-01-01 00:00:00', '2000-01-01 00:00:00',
              '2000-01-01 00:02:00', '{}', '2000-01-01 00:00:00', '2000-01-01 00:00:00'
            );
            insert into llm_provider_leases (
              id, pool_id, target_id, queue_name, queue_job_id, worker_id, status,
              locked_at, heartbeat_at, expires_at, metadata, created_at, updated_at
            ) values (
              'lease-active', 'local-llm-default', 'local-b', 'findingCandidate', 'job-live',
              'worker-live', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
              datetime(CURRENT_TIMESTAMP, '+120 seconds'), '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            );
            "#,
        )
        .unwrap();

    let available =
        count_available_provider_pool_slots_for_connection(&connection, &provider_pool()).unwrap();

    assert_eq!(available, 1);
    let stale = connection
        .query_row(
            "select status, release_reason from llm_provider_leases where id = 'lease-stale'",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .unwrap();
    assert_eq!(
        stale,
        ("stale_recovered".to_string(), "stale_heartbeat".to_string())
    );

    std::fs::remove_dir_all(&app_dir).unwrap();
}

#[test]
fn rust_provider_lease_manager_heartbeats_and_releases_active_lease() {
    let app_dir = temp_app_dir("provider_heartbeat_release");
    let sqlite_path = app_dir.join("queue.sqlite");
    let connection = Connection::open(&sqlite_path).unwrap();
    create_provider_lease_table(&connection);
    connection
        .execute_batch(
            r#"
            insert into llm_provider_leases (
              id, pool_id, target_id, queue_name, queue_job_id, worker_id, status,
              locked_at, heartbeat_at, expires_at, metadata, created_at, updated_at
            ) values (
              'lease-active', 'local-llm-default', 'local-a', 'findingCandidate', 'job-live',
              'worker-live', 'active', '2000-01-01 00:00:00', '2000-01-01 00:00:00',
              datetime(CURRENT_TIMESTAMP, '+120 seconds'), '{}', '2000-01-01 00:00:00', '2000-01-01 00:00:00'
            );
            "#,
        )
        .unwrap();

    assert_eq!(
        heartbeat_provider_lease_for_connection(&connection, "lease-active").unwrap(),
        1
    );
    let heartbeat_at = connection
        .query_row(
            "select heartbeat_at from llm_provider_leases where id = 'lease-active'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    assert_ne!(heartbeat_at, "2000-01-01 00:00:00");

    assert_eq!(
        release_provider_lease_for_connection(&connection, "lease-active", "worker_finished")
            .unwrap(),
        1
    );
    assert_eq!(
        release_provider_lease_for_connection(&connection, "lease-active", "duplicate").unwrap(),
        0
    );
    let released = connection
        .query_row(
            "select status, release_reason from llm_provider_leases where id = 'lease-active'",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .unwrap();
    assert_eq!(
        released,
        ("released".to_string(), "worker_finished".to_string())
    );

    std::fs::remove_dir_all(&app_dir).unwrap();
}
