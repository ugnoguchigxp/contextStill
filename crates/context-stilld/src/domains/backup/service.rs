use serde::Serialize;

use crate::domains::{
    admin_api_lifecycle, agent_log_sync, bootstrap::service::resolve_paths,
    daemon::service::status_with_supervisor, queue_lifecycle,
};
use crate::shared::{config::EnvProvider, process, process::ProcessSupervisor};

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreflight {
    pub status: &'static str,
    pub sqlite_core_path: String,
    pub backup_dir: String,
    pub active_managed_writers: Vec<&'static str>,
    pub active_managed_writer_details: Vec<ActiveManagedWriter>,
    pub delegated_backup_command: &'static str,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveManagedWriter {
    pub name: &'static str,
    pub status: String,
    pub pid: Option<u32>,
    pub log_path: Option<String>,
}

pub fn preflight<E: EnvProvider, S: ProcessSupervisor>(env: &E, supervisor: &S) -> BackupPreflight {
    let paths = resolve_paths(env);
    let runtime = status_with_supervisor(env, supervisor);
    let mut active_managed_writers = Vec::new();
    let mut active_managed_writer_details = Vec::new();

    if runtime.queue_supervisor != "stopped" {
        active_managed_writers.push("queue-supervisor");
        if let Ok(report) = queue_lifecycle::service::status_report(env, supervisor) {
            active_managed_writer_details.push(ActiveManagedWriter {
                name: "queue-supervisor",
                status: report.status,
                pid: report.pid,
                log_path: report.log_path,
            });
        }
    }
    if runtime.agent_log_sync != "stopped" {
        active_managed_writers.push("agent-log-sync");
        if let Ok(report) = agent_log_sync::service::status_report(env, supervisor) {
            active_managed_writer_details.push(ActiveManagedWriter {
                name: "agent-log-sync",
                status: report.status,
                pid: report.pid,
                log_path: report.log_path,
            });
        }
    }
    if runtime.hono_admin_api != "stopped" {
        active_managed_writers.push("admin-api");
        if let Ok(report) = admin_api_lifecycle::service::status_report(env, supervisor) {
            active_managed_writer_details.push(ActiveManagedWriter {
                name: "admin-api",
                status: report.status,
                pid: report.pid,
                log_path: report.log_path,
            });
        }
    }

    let status = if !paths.sqlite_core_path.exists() {
        "sqlite_missing"
    } else if active_managed_writers.is_empty() {
        "ready"
    } else {
        "managed_writers_active"
    };

    BackupPreflight {
        status,
        sqlite_core_path: process::path_to_string(&paths.sqlite_core_path),
        backup_dir: process::path_to_string(&paths.backup_dir),
        active_managed_writers,
        active_managed_writer_details,
        delegated_backup_command:
            "CONTEXT_STILL_DB_BACKEND=sqlite bun run src/cli/sqlite-backup.ts",
    }
}

impl BackupPreflight {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        [
            format!("status={}", self.status),
            format!("sqliteCorePath={}", self.sqlite_core_path),
            format!("backupDir={}", self.backup_dir),
            format!(
                "activeManagedWriters={}",
                self.active_managed_writers.join(",")
            ),
            format!("delegatedBackupCommand={}", self.delegated_backup_command),
        ]
        .join("\n")
    }
}
