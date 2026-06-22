use std::path::PathBuf;

use crate::shared::config::EnvProvider;

use super::types::{AgentLogSource, AgentLogSourceId};

pub(crate) fn build_sources<E: EnvProvider>(env: &E) -> Vec<AgentLogSource> {
    let home = home_dir(env);
    vec![
        AgentLogSource {
            id: AgentLogSourceId::Codex,
            roots: unique_non_empty(vec![
                env.var("CODEX_SESSION_DIR")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".codex").join("sessions")),
                env.var("CODEX_ARCHIVED_SESSION_DIR")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".codex").join("archived_sessions")),
            ])
            .into_iter()
            .chain(parse_paths(env.var("CODEX_SESSION_DIRS")))
            .chain(parse_paths(env.var("CODEX_ARCHIVED_SESSION_DIRS")))
            .collect(),
            initial_lookback_hours: 168,
        },
        AgentLogSource {
            id: AgentLogSourceId::Antigravity,
            roots: unique_non_empty(vec![
                env.var("ANTIGRAVITY_LOG_DIR")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".gemini").join("antigravity").join("brain")),
                home.join(".gemini").join("antigravity-cli").join("brain"),
                home.join(".gemini").join("antigravity-ide").join("brain"),
                home.join(".gemini").join("antigravity").join("brain"),
            ])
            .into_iter()
            .chain(parse_paths(env.var("ANTIGRAVITY_LOG_DIRS")))
            .collect(),
            initial_lookback_hours: 24,
        },
        AgentLogSource {
            id: AgentLogSourceId::Claude,
            roots: unique_non_empty(vec![home.join(".claude").join("projects")])
                .into_iter()
                .chain(parse_paths(env.var("CLAUDE_LOG_DIRS")))
                .collect(),
            initial_lookback_hours: 24,
        },
    ]
}

fn parse_paths(raw: Option<String>) -> Vec<PathBuf> {
    raw.unwrap_or_default()
        .split([',', '\n', ';'])
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(PathBuf::from)
        .collect()
}

fn unique_non_empty(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = std::collections::BTreeSet::new();
    paths
        .into_iter()
        .filter(|path| !path.as_os_str().is_empty())
        .filter(|path| seen.insert(path.to_string_lossy().to_string()))
        .collect()
}

fn home_dir<E: EnvProvider>(env: &E) -> PathBuf {
    env.var("HOME")
        .or_else(|| env.var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}
