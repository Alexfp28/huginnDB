//! On-disk persistence for connection profile metadata.
//!
//! Profiles live in a single JSON file inside the platform config
//! directory:
//!
//! * Windows — `%APPDATA%\Huginn\profiles.json`
//! * Linux   — `$XDG_CONFIG_HOME/Huginn/profiles.json`
//!                 (or `~/.config/Huginn/profiles.json`)
//! * macOS   — `~/Library/Application Support/Huginn/profiles.json`
//!
//! **Passwords are never written here** — see [`crate::keychain`].

use crate::error::{AppError, AppResult};
use crate::state::ConnectionProfile;
use std::path::PathBuf;

/// File name used for the persisted profile list.
const PROFILES_FILE: &str = "profiles.json";

/// Application directory within the platform's config base.
const APP_DIR: &str = "Huginn";

/// Resolve (and create on demand) the path where profiles live.
fn profiles_path() -> AppResult<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| AppError::InvalidInput("no config dir available".into()))?;
    let dir = base.join(APP_DIR);
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(PROFILES_FILE))
}

/// Read the profile list from disk. Returns an empty list if the file
/// does not yet exist; surfaces I/O or JSON errors if it does but is
/// unreadable.
pub fn load_profiles() -> AppResult<Vec<ConnectionProfile>> {
    let path = profiles_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = std::fs::read(&path)?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// Write the profile list to disk, pretty-printed for human review.
pub fn save_profiles(profiles: &[ConnectionProfile]) -> AppResult<()> {
    let path = profiles_path()?;
    let bytes = serde_json::to_vec_pretty(profiles)?;
    std::fs::write(&path, bytes)?;
    Ok(())
}
