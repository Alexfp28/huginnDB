//! What the silent updater is doing, for Settings → About.
//!
//! Read-only: the schedule follows the `updates.autoInstall` preference, which
//! `prefs::update_preferences` reconciles when it changes, and the app's
//! startup reconciles on its own. There is nothing to command from here.

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
