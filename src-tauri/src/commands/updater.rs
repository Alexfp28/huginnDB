//! What the silent updater is doing, for Settings → About.
//!
//! [`note_update_check`] is the one write: the interface's own check reports
//! what it found, so the MCP connector can mention an update that has been
//! waiting (`updater::pending_notice`) on a machine where the schedule never
//! runs. Otherwise read-only: the schedule follows the `updates.autoInstall`
//! preference, which `prefs::update_preferences` reconciles when it changes,
//! and the app's startup reconciles on its own.

use serde::Serialize;

use crate::updater::record::{self, UpdaterRecord};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoUpdateStatus {
    /// Whether background installs can happen on this build at all: Windows,
    /// and not a development build (which never registers its dev executable).
    pub supported: bool,
    #[serde(flatten)]
    pub record: UpdaterRecord,
}

#[tauri::command]
pub fn get_auto_update_status() -> AutoUpdateStatus {
    AutoUpdateStatus {
        supported: cfg!(windows) && !cfg!(debug_assertions),
        record: record::load(),
    }
}

/// The interface's updater check found `version` (or nothing newer, `None`).
#[tauri::command]
pub fn note_update_check(version: Option<String>) {
    record::note_available(version.as_deref());
}
