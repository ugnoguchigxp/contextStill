use serde::Serialize;

use crate::{
    domains::daemon,
    shared::{config::EnvProvider, process::ProcessSupervisor},
};

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarRegistryReport {
    pub action: &'static str,
    pub runtime_host: &'static str,
    pub resident_owned_temporary_count: usize,
    pub forbidden_resident_count: usize,
    pub sidecars: Vec<SidecarEntry>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarEntry {
    pub id: &'static str,
    pub surface: &'static str,
    pub classification: SidecarClassification,
    pub command: &'static str,
    pub args: Vec<&'static str>,
    pub owner: &'static str,
    pub enabled_by_default: bool,
    pub runtime_status: String,
    pub removal_task_id: Option<&'static str>,
    pub notes: &'static str,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SidecarClassification {
    UiTime,
    ManualOneShot,
    ResidentOwnedTemporary,
    ForbiddenResident,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
struct SidecarDefinition {
    id: &'static str,
    surface: &'static str,
    classification: SidecarClassification,
    command: &'static str,
    args: &'static [&'static str],
    owner: &'static str,
    enabled_by_default: bool,
    removal_task_id: Option<&'static str>,
    notes: &'static str,
}

const SIDECARS: &[SidecarDefinition] = &[
    SidecarDefinition {
        id: "mcp-tool-dispatch-typescript-one-shot",
        surface: "mcp-tools",
        classification: SidecarClassification::ManualOneShot,
        command: "bun",
        args: &["run", "src/cli/mcp-dispatch-once.ts"],
        owner: "rust-mcp-endpoint",
        enabled_by_default: true,
        removal_task_id: Some("R3/R4"),
        notes: "Rust owns the MCP endpoint and sessions; non-migrated tool handlers execute through short-lived TypeScript one-shot dispatch.",
    },
    SidecarDefinition {
        id: "queue-executor-typescript-manual-one-shot",
        surface: "queue-supervisor",
        classification: SidecarClassification::ManualOneShot,
        command: "bun",
        args: &[
            "run",
            "src/cli/queue-supervisor.ts",
            "--once",
            "--limit",
            "1",
            "--json",
        ],
        owner: "operator",
        enabled_by_default: false,
        removal_task_id: Some("R7"),
        notes: "Resident queue scheduling and maintenance are Rust-owned; the TypeScript queue business executor is manual fallback until Rust executors are complete.",
    },
    SidecarDefinition {
        id: "hono-admin-api-child",
        surface: "admin-api",
        classification: SidecarClassification::UiTime,
        command: "bun",
        args: &["run", "api/index.ts"],
        owner: "ui-time-or-explicit-daemon-flag",
        enabled_by_default: false,
        removal_task_id: None,
        notes: "Hono admin API is allowed as a UI-time child and is not part of the resident Rust-only daemon goal.",
    },
    SidecarDefinition {
        id: "manual-maintenance-typescript-cli",
        surface: "manual-maintenance",
        classification: SidecarClassification::ManualOneShot,
        command: "bun",
        args: &["run", "src/cli/<maintenance-command>.ts"],
        owner: "operator",
        enabled_by_default: false,
        removal_task_id: None,
        notes: "Migration, import, export, repair, backfill, and smoke CLIs may remain manual one-shot TypeScript commands.",
    },
    SidecarDefinition {
        id: "legacy-queue-launchagent",
        surface: "queue-supervisor",
        classification: SidecarClassification::ForbiddenResident,
        command: "launchctl",
        args: &["bootstrap", "gui/$UID", "com.context-still.queue-supervisor"],
        owner: "legacy-launchagent",
        enabled_by_default: false,
        removal_task_id: Some("R0/R10"),
        notes: "Legacy queue LaunchAgent must not independently own durable queue work while context-stilld owns resident runtime.",
    },
    SidecarDefinition {
        id: "legacy-agent-log-sync-launchagent",
        surface: "agent-log-sync",
        classification: SidecarClassification::ForbiddenResident,
        command: "launchctl",
        args: &["bootstrap", "gui/$UID", "com.context-still.agent-log-sync"],
        owner: "legacy-launchagent",
        enabled_by_default: false,
        removal_task_id: Some("R0/R10"),
        notes: "Legacy agent-log-sync LaunchAgent must not independently own scheduled sync while context-stilld owns scheduling.",
    },
];

pub fn sidecars_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> SidecarRegistryReport {
    let status = daemon::service::status_with_supervisor(env, supervisor);
    let sidecars = SIDECARS
        .iter()
        .map(|definition| SidecarEntry {
            id: definition.id,
            surface: definition.surface,
            classification: definition.classification,
            command: definition.command,
            args: definition.args.to_vec(),
            owner: definition.owner,
            enabled_by_default: definition.enabled_by_default,
            runtime_status: runtime_status_for_definition(definition, &status),
            removal_task_id: definition.removal_task_id,
            notes: definition.notes,
        })
        .collect::<Vec<_>>();

    SidecarRegistryReport {
        action: "sidecars",
        runtime_host: "rust-resident",
        resident_owned_temporary_count: sidecars
            .iter()
            .filter(|entry| entry.classification == SidecarClassification::ResidentOwnedTemporary)
            .count(),
        forbidden_resident_count: sidecars
            .iter()
            .filter(|entry| entry.classification == SidecarClassification::ForbiddenResident)
            .count(),
        sidecars,
    }
}

fn runtime_status_for_definition(
    definition: &SidecarDefinition,
    status: &daemon::service::RuntimeStatus,
) -> String {
    if definition.classification == SidecarClassification::ForbiddenResident {
        return "not-inspected".to_string();
    }

    match definition.surface {
        "mcp-server" | "mcp-tools" => status.mcp_server.clone(),
        "queue-supervisor" => status.queue_supervisor.clone(),
        "agent-log-sync" => status.agent_log_sync.clone(),
        "admin-api" => status.hono_admin_api.clone(),
        "manual-maintenance" => "manual".to_string(),
        _ => "unknown".to_string(),
    }
}

impl SidecarRegistryReport {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        format!(
            "runtime sidecars: residentOwnedTemporary={} forbiddenResident={}",
            self.resident_owned_temporary_count, self.forbidden_resident_count
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::{config::MapEnv, process::MockSupervisor};

    #[test]
    fn sidecar_registry_classifies_every_resident_temporary_entry_for_removal() {
        let env = MapEnv::from_pairs(vec![("CONTEXT_STILL_APP_DATA_DIR", "/tmp/contextStill")]);
        let supervisor = MockSupervisor::new();

        let report = sidecars_report(&env, &supervisor);

        assert_eq!(report.action, "sidecars");
        assert_eq!(report.runtime_host, "rust-resident");
        assert_eq!(report.resident_owned_temporary_count, 0);
        assert_eq!(report.forbidden_resident_count, 2);
        assert!(report.sidecars.iter().all(|entry| {
            entry.classification != SidecarClassification::ResidentOwnedTemporary
                || entry.removal_task_id.is_some()
        }));
        assert!(report.sidecars.iter().any(|entry| {
            entry.id == "queue-executor-typescript-manual-one-shot"
                && entry.classification == SidecarClassification::ManualOneShot
                && entry.removal_task_id == Some("R7")
        }));
        assert!(report.sidecars.iter().any(|entry| {
            entry.id == "mcp-tool-dispatch-typescript-one-shot"
                && entry.classification == SidecarClassification::ManualOneShot
                && entry.removal_task_id == Some("R3/R4")
        }));
        assert!(report.sidecars.iter().any(|entry| {
            entry.id == "hono-admin-api-child"
                && entry.classification == SidecarClassification::UiTime
                && entry.removal_task_id.is_none()
        }));
    }
}
