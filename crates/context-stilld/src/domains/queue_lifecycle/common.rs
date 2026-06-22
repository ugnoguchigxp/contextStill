use crate::shared::errors::CliError;

use super::types::QUEUE_TABLES;

pub(crate) fn queue_table_name(queue_name: &str) -> Result<&'static str, CliError> {
    QUEUE_TABLES
        .iter()
        .find(|(name, _)| *name == queue_name)
        .map(|(_, table)| *table)
        .ok_or_else(|| CliError::invalid_arguments(format!("unknown queue name: {queue_name}")))
}
