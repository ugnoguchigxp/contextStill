use std::path::PathBuf;

use super::config::EnvProvider;

pub fn default_app_data_dir<E: EnvProvider>(env: &E) -> PathBuf {
    if cfg!(target_os = "macos") {
        return home_dir(env)
            .join("Library")
            .join("Application Support")
            .join("contextStill");
    }

    if cfg!(target_os = "windows") {
        if let Some(app_data) = env.var("APPDATA") {
            return PathBuf::from(app_data).join("contextStill");
        }
    }

    if let Some(xdg_data_home) = env.var("XDG_DATA_HOME") {
        return PathBuf::from(xdg_data_home).join("contextStill");
    }

    home_dir(env)
        .join(".local")
        .join("share")
        .join("contextStill")
}

fn home_dir<E: EnvProvider>(env: &E) -> PathBuf {
    env.var("HOME")
        .or_else(|| env.var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}
