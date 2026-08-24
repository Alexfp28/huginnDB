//! On-disk persistence for connection profile metadata.
//!
//! Profiles live in a single JSON file inside the platform config
//! directory:
//!
//! * Windows — `%APPDATA%\HuginnDB\profiles.json`
//! * Linux   — `$XDG_CONFIG_HOME/HuginnDB/profiles.json`
//!   (or `~/.config/HuginnDB/profiles.json`)
//! * macOS   — `~/Library/Application Support/HuginnDB/profiles.json`
//!
//! **Passwords are never written here** — see [`crate::keychain`].

use crate::error::AppResult;
use crate::state::ConnectionProfile;

/// File name used for the persisted profile list.
const PROFILES_FILE: &str = "profiles.json";

/// Read the profile list from disk. Returns an empty list if the file
/// does not yet exist; surfaces I/O or JSON errors if it does but is
/// unreadable.
///
/// Deliberately *not* `state_file::load_or_default`: unlike preferences, a
/// profiles file that exists but will not parse must be loud. Silently
/// substituting an empty list would present the user with an app that has lost
/// every connection they ever saved — and the first save after that would make
/// it true on disk.
pub fn load_profiles() -> AppResult<Vec<ConnectionProfile>> {
    let path = crate::state_file::path(PROFILES_FILE)?;
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
    crate::state_file::save_atomic(PROFILES_FILE, &persistable(profiles))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str, ephemeral: bool) -> ConnectionProfile {
        ConnectionProfile {
            ephemeral,
            ..crate::testkit::profile(id)
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
