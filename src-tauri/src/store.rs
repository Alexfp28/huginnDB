//! On-disk persistence for connection profile metadata.
//!
//! Profiles live in a single JSON file inside the platform config
//! directory:
//!
//! * Windows — `%APPDATA%\HuginnDB\profiles.json`
//! * Linux   — `$XDG_CONFIG_HOME/HuginnDB/profiles.json`
//!                 (or `~/.config/HuginnDB/profiles.json`)
//! * macOS   — `~/Library/Application Support/HuginnDB/profiles.json`
//!
//! **Passwords are never written here** — see [`crate::keychain`].

use crate::error::{AppError, AppResult};
use crate::state::ConnectionProfile;
use std::path::PathBuf;

/// File name used for the persisted profile list.
const PROFILES_FILE: &str = "profiles.json";

/// Application directory within the platform's config base.
const APP_DIR: &str = "HuginnDB";

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

/// Profiles that should reach disk — everything except ephemeral (session-only)
/// ones. Pulled out of [`save_profiles`] so the filtering rule is unit-testable
/// without touching the filesystem.
fn persistable(profiles: &[ConnectionProfile]) -> Vec<&ConnectionProfile> {
    profiles.iter().filter(|p| !p.ephemeral).collect()
}

/// Write the profile list to disk, pretty-printed for human review.
///
/// Ephemeral profiles (CLI ad-hoc connections — see
/// [`ConnectionProfile::ephemeral`]) are filtered out: they exist only in
/// memory for the lifetime of the session and must never reach disk.
pub fn save_profiles(profiles: &[ConnectionProfile]) -> AppResult<()> {
    let path = profiles_path()?;
    let bytes = serde_json::to_vec_pretty(&persistable(profiles))?;
    std::fs::write(&path, bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Driver;

    fn profile(id: &str, ephemeral: bool) -> ConnectionProfile {
        ConnectionProfile {
            id: id.into(),
            name: id.into(),
            driver: Driver::Postgres,
            host: "localhost".into(),
            port: 5432,
            database: String::new(),
            username: "u".into(),
            ssl: false,
            ssh_tunnel: None,
            connection_string: None,
            auth_source: None,
            ephemeral,
            group: None,
            visible_databases: None,
        }
    }

    #[test]
    fn persistable_drops_ephemeral_profiles() {
        let profiles = vec![
            profile("saved-1", false),
            profile("cli-temp", true),
            profile("saved-2", false),
        ];
        let kept: Vec<&str> = persistable(&profiles)
            .iter()
            .map(|p| p.id.as_str())
            .collect();
        assert_eq!(kept, ["saved-1", "saved-2"]);
    }
}
