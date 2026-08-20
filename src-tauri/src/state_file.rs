//! One place for "a JSON file in the app's config directory".
//!
//! Five modules own a state file — `store` (`profiles.json`), `prefs`
//! (`prefs.json`), `tab_state` (`tab_state.json`), `json_schemas`
//! (`json_schemas.json`) and `ssh_known_hosts` (`known_hosts.json`) — and each
//! had its own copy of the same three steps: resolve the path under
//! `app_identity::APP_DIR`, read it back tolerating absence, and write it
//! atomically.
//!
//! Two reasons that mattered beyond line count.
//!
//! **One of the copies had drifted.** `store::save_profiles` wrote with a plain
//! [`std::fs::write`] while the other four used a temp-file + rename. It is the
//! file whose loss costs the most: every saved connection, plus the keychain
//! entries, JSON-Schema bindings and shared-origin links keyed on those profile
//! ids. Routing it through [`save_atomic`] fixes that as a side effect of having
//! one implementation.
//!
//! **Canary isolation is only as good as its weakest call site.** Gotcha #26's
//! rule is that no state path may hardcode `"HuginnDB"`, because the canary
//! build flips `APP_DIR` to keep its state away from a real install's. That was
//! six independent chances to get it wrong; it is now one.
//!
//! Loading deliberately comes in two flavours. [`load_or_default`] is the
//! silent-degradation policy the app wants for user *preferences* — a corrupted
//! prefs file must never block startup. [`read_bytes`] stops one step earlier
//! and hands back the bytes, for the two files whose parse is not a plain
//! `serde_json::from_slice`: `tab_state` migrates v1–v4 blobs and returns an
//! origin remap alongside the state, and `json_schemas` warns about a
//! future-version file before accepting it.

use serde::{de::DeserializeOwned, Serialize};
use std::path::PathBuf;

use crate::app_identity::APP_DIR;
use crate::error::{AppError, AppResult};

/// Resolve (and create on demand) the path of `file` inside the app's config
/// directory.
pub fn path(file: &str) -> AppResult<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| AppError::InvalidInput("no config dir available".into()))?;
    let dir = base.join(APP_DIR);
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(file))
}

/// The raw contents of `file`, or `None` when it does not exist yet, cannot be
/// located, or cannot be read.
///
/// `tag` prefixes the diagnostic written to stderr (`[prefs]`, `[tab_state]`, …)
/// so a log line still says which file gave up. A missing file is silent: it is
/// the normal state of a fresh install, not a problem.
pub fn read_bytes(file: &str, tag: &str) -> Option<Vec<u8>> {
    let path = match path(file) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[{tag}] cannot resolve path: {e}; using defaults");
            return None;
        }
    };
    if !path.exists() {
        return None;
    }
    match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(e) => {
            eprintln!("[{tag}] failed to read {path:?}: {e}; using defaults");
            None
        }
    }
}

/// Parse `file` into `T`, falling back to `T::default()` when it is missing,
/// unreadable or unparseable.
///
/// Never returns an error: this is the policy for state whose loss is an
/// inconvenience rather than a failure, and it is what keeps a corrupted file
/// from turning into a launch that does nothing.
pub fn load_or_default<T: DeserializeOwned + Default>(file: &str, tag: &str) -> T {
    let Some(bytes) = read_bytes(file, tag) else {
        return T::default();
    };
    match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(e) => {
            eprintln!("[{tag}] failed to parse {file}: {e}; using defaults");
            T::default()
        }
    }
}

/// Serialise `value` into `file`, pretty-printed, via a temp file and a rename.
///
/// The rename is what makes the write atomic on every platform we ship: a
/// reader either sees the previous file or the new one, never a truncated one,
/// so being killed mid-save (or filling the disk) cannot destroy what was
/// already there.
pub fn save_atomic<T: Serialize + ?Sized>(file: &str, value: &T) -> AppResult<()> {
    let path = path(file)?;
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value)?;
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}
