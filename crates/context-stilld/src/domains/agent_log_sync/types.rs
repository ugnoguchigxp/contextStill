use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Eq, PartialEq)]
pub(crate) enum AgentLogSourceId {
    Codex,
    Antigravity,
    Claude,
}

impl AgentLogSourceId {
    pub(crate) fn id(&self) -> &'static str {
        match self {
            Self::Codex => "codex_logs",
            Self::Antigravity => "antigravity_logs",
            Self::Claude => "claude_logs",
        }
    }

    pub(crate) fn label(&self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Antigravity => "Antigravity",
            Self::Claude => "Claude",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AgentLogSource {
    pub(crate) id: AgentLogSourceId,
    pub(crate) roots: Vec<PathBuf>,
    pub(crate) initial_lookback_hours: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct IngestCursorEntry {
    pub(crate) offset: u64,
    pub(crate) mtime_ms: u64,
}

pub(crate) type IngestCursor = BTreeMap<String, IngestCursorEntry>;

#[derive(Debug, Clone)]
pub(crate) struct ChatMessage {
    pub(crate) role: &'static str,
    pub(crate) content: String,
    pub(crate) metadata: Value,
}

#[derive(Debug, Clone)]
pub(crate) struct IngestResult {
    pub(crate) ok: bool,
    pub(crate) errors: Vec<String>,
    pub(crate) warnings: Vec<String>,
    pub(crate) messages: Vec<ChatMessage>,
    pub(crate) cursor: IngestCursor,
    pub(crate) max_observed_mtime_ms: u64,
    pub(crate) checked_files: u64,
    pub(crate) skipped: bool,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLogSourceSyncSummary {
    pub id: String,
    pub label: String,
    pub ok: bool,
    pub skipped: bool,
    pub checked_files: u64,
    pub messages: usize,
    pub inserted_memories: u64,
    pub inserted_diffs: u64,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
    pub last_synced_at: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLogSyncSummary {
    pub ok: bool,
    pub started_at: String,
    pub finished_at: String,
    pub imported: u64,
    pub inserted_diffs: u64,
    pub sources: Vec<AgentLogSourceSyncSummary>,
}

#[derive(Debug, Clone)]
pub(crate) struct StoreSourceResult {
    pub(crate) inserted_memories: u64,
    pub(crate) inserted_diffs: u64,
    pub(crate) last_synced_at: Option<String>,
}
