use std::time::{Duration, Instant};

use crate::domains::{
    bootstrap::service::resolve_paths,
    daemon::repository::{self, ProcessState},
    process_lifecycle::service::{self, LifecycleReport, ManagedProcessSpec},
};
use crate::shared::{config::EnvProvider, errors::CliError, process::ProcessSupervisor};

use super::{
    ingest::ingest_source,
    roots::build_sources,
    store::{open_database, read_cursor, store_source_result},
    types::{AgentLogSourceSyncSummary, AgentLogSyncSummary},
};

const AGENT_LOG_SYNC: ManagedProcessSpec = ManagedProcessSpec {
    state_name: "agent-log-sync",
    display_name: "agent-log-sync",
    command: "context-stilld",
    args: &["agent-log-sync", "run", "--wait"],
    log_file: "agent-log-sync.log",
};

pub fn run<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    Ok(run_report(env, supervisor)?.to_text())
}

pub fn run_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    run_and_wait_report(env, supervisor, Duration::from_secs(300))
}

pub fn run_and_wait_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    _supervisor: &S,
    timeout: Duration,
) -> Result<LifecycleReport, CliError> {
    let paths = resolve_paths(env);
    let started_at = service::now_timestamp();
    let pid = std::process::id();
    write_state(env, Some(pid), "running", Some(started_at.clone()), None)?;

    let started = Instant::now();
    let result = run_sync(env);
    let updated_at = service::now_timestamp();
    let timed_out = started.elapsed() > timeout;
    let status = if result.as_ref().is_ok_and(|summary| summary.ok) && !timed_out {
        "exited"
    } else {
        "failed"
    };
    let last_error = if timed_out {
        Some("agent-log-sync exceeded requested timeout".to_string())
    } else {
        result.as_ref().err().map(ToString::to_string)
    };
    let exit_code = if status == "exited" { Some(0) } else { Some(1) };
    let state = ProcessState {
        pid: None,
        status: status.to_string(),
        log_path: paths
            .logs_dir
            .join(AGENT_LOG_SYNC.log_file)
            .to_string_lossy()
            .into_owned(),
        started_at: Some(started_at),
        updated_at: Some(updated_at),
        exit_code,
        last_error: last_error.clone(),
        command: Some("context-stilld".to_string()),
        args: Some(vec![
            "agent-log-sync".to_string(),
            "run".to_string(),
            "--wait".to_string(),
        ]),
        ..ProcessState::default()
    };
    service::write_process_state(&AGENT_LOG_SYNC, &paths.run_dir, &state)?;
    let _ = repository::clear_pid(&paths.run_dir, AGENT_LOG_SYNC.state_name);

    let message = match result {
        Ok(summary) if status == "exited" => format!(
            "agent-log-sync completed in Rust (imported={}, insertedDiffs={})",
            summary.imported, summary.inserted_diffs
        ),
        Ok(_) => "agent-log-sync failed in Rust".to_string(),
        Err(error) => format!("agent-log-sync failed in Rust: {error}"),
    };
    Ok(service::report_from_state(
        &AGENT_LOG_SYNC,
        "run",
        status,
        message,
        state,
    ))
}

pub fn stop<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    Ok(stop_report(env, supervisor)?.to_text())
}

pub fn stop_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::stop_report(&AGENT_LOG_SYNC, env, supervisor)
}

pub fn status<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    service::status(&AGENT_LOG_SYNC, env, supervisor)
}

pub fn status_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::status_report(&AGENT_LOG_SYNC, env, supervisor)
}

pub(crate) fn run_sync<E: EnvProvider>(env: &E) -> Result<AgentLogSyncSummary, CliError> {
    let started_at = service::now_timestamp();
    let mut connection = open_database(env)?;
    let mut summary = AgentLogSyncSummary {
        ok: true,
        started_at: started_at.clone(),
        finished_at: started_at,
        imported: 0,
        inserted_diffs: 0,
        sources: Vec::new(),
    };
    let min_distillable_chars = env
        .var("AGENT_LOG_MIN_DISTILLABLE_CHARS")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(2000);

    for source in build_sources(env) {
        let cursor = read_cursor(&connection, source.id.id())?;
        let ingest = ingest_source(&source, cursor).map_err(CliError::runtime)?;
        if !ingest.ok {
            summary.ok = false;
            summary.sources.push(AgentLogSourceSyncSummary {
                id: source.id.id().to_string(),
                label: source.id.label().to_string(),
                ok: false,
                skipped: ingest.skipped,
                checked_files: ingest.checked_files,
                messages: 0,
                inserted_memories: 0,
                inserted_diffs: 0,
                warnings: ingest.warnings,
                errors: ingest.errors,
                last_synced_at: None,
            });
            continue;
        }

        let checked_files = ingest.checked_files;
        let message_count = ingest.messages.len();
        let warnings = ingest.warnings.clone();
        let skipped = ingest.skipped;
        let stored = store_source_result(&mut connection, &source, ingest, min_distillable_chars)?;
        summary.imported += stored.inserted_memories;
        summary.inserted_diffs += stored.inserted_diffs;
        summary.sources.push(AgentLogSourceSyncSummary {
            id: source.id.id().to_string(),
            label: source.id.label().to_string(),
            ok: true,
            skipped,
            checked_files,
            messages: message_count,
            inserted_memories: stored.inserted_memories,
            inserted_diffs: stored.inserted_diffs,
            warnings,
            errors: Vec::new(),
            last_synced_at: stored.last_synced_at,
        });
    }

    summary.finished_at = service::now_timestamp();
    Ok(summary)
}

fn write_state<E: EnvProvider>(
    env: &E,
    pid: Option<u32>,
    status: &str,
    started_at: Option<String>,
    last_error: Option<String>,
) -> Result<(), CliError> {
    let paths = resolve_paths(env);
    let state = ProcessState {
        pid,
        status: status.to_string(),
        log_path: paths
            .logs_dir
            .join(AGENT_LOG_SYNC.log_file)
            .to_string_lossy()
            .into_owned(),
        started_at,
        updated_at: Some(service::now_timestamp()),
        last_error,
        command: Some("context-stilld".to_string()),
        args: Some(vec![
            "agent-log-sync".to_string(),
            "run".to_string(),
            "--wait".to_string(),
        ]),
        ..ProcessState::default()
    };
    repository::write_state(&paths.run_dir, AGENT_LOG_SYNC.state_name, &state)
        .map_err(|error| CliError::io(format!("failed to write agent-log-sync state: {error}")))
}
