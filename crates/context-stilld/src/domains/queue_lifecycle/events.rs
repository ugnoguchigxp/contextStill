use rusqlite::{params, Connection};

use crate::shared::errors::CliError;

use super::common::queue_table_name;

pub fn append_queue_event_for_connection(
    connection: &Connection,
    event_id: &str,
    queue_name: &str,
    queue_job_id: &str,
    event_type: &str,
    message: Option<&str>,
    metadata_json: Option<&str>,
) -> Result<(), CliError> {
    queue_table_name(queue_name)?;
    let metadata_json = metadata_json.unwrap_or("{}");
    connection
        .execute(
            "
            insert into distillation_queue_events (
              id, queue_name, queue_job_id, event_type, message, metadata, created_at
            ) values (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)
            ",
            params![
                event_id,
                queue_name,
                queue_job_id,
                event_type,
                message,
                metadata_json
            ],
        )
        .map_err(|error| CliError::io(format!("failed to append queue event: {error}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domains::queue_lifecycle::test_support::*;
    use rusqlite::Connection;

    #[test]
    fn rust_queue_events_append_compatible_sqlite_row() {
        let app_dir = temp_app_dir("queue_event_append");
        let sqlite_path = app_dir.join("queue.sqlite");
        let connection = Connection::open(&sqlite_path).unwrap();
        create_queue_events_table(&connection);

        append_queue_event_for_connection(
            &connection,
            "event-1",
            "findingCandidate",
            "job-1",
            "claimed",
            Some("job claimed"),
            Some(r#"{"workerId":"worker-1"}"#),
        )
        .unwrap();

        let row = connection
        .query_row(
            "select queue_name, queue_job_id, event_type, message, json_extract(metadata, '$.workerId') from distillation_queue_events where id = 'event-1'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .unwrap();
        assert_eq!(
            row,
            (
                "findingCandidate".to_string(),
                "job-1".to_string(),
                "claimed".to_string(),
                "job claimed".to_string(),
                "worker-1".to_string()
            )
        );

        std::fs::remove_dir_all(&app_dir).unwrap();
    }
}
