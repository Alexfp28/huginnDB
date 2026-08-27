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
use std::path::{Path, PathBuf};

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
    write_atomic(&path(file)?, &serde_json::to_vec_pretty(value)?)
}

/// [`save_atomic`]'s mechanism, for an **arbitrary** path.
///
/// Extracted because the shared-origin editor writes a file the app does not
/// own: a document on a UNC share, which [`path`] cannot express — it only ever
/// resolves names relative to the config directory, by design (gotcha #26's
/// canary isolation depends on that being the only way in). The atomicity
/// matters more there than it does here: consumers read that file with
/// `std::fs::read` and no coordination whatsoever, so a plain
/// [`std::fs::write`] over a share is precisely the truncated read that
/// `commands::origins::disappearance_is_trustworthy` exists to paper over —
/// a publisher mid-save looks exactly like an admin who deleted half the
/// roster.
///
/// The temp file is created **in the destination's own directory**, not in a
/// temp dir: `rename` is only atomic within a filesystem, and a share is a
/// different volume from anything `std::env::temp_dir` would hand back. On
/// Windows `rename` also refuses to clobber an existing file, so the previous
/// revision is removed first — which is safe in this order because the temp
/// file is already fully written and `fsync`ed by then, and unsafe in any
/// other.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let dir = path.parent().ok_or_else(|| {
        AppError::InvalidInput(format!("{path:?} has no parent directory to write into"))
    })?;
    let tmp = dir.join(format!(
        ".{}.tmp",
        path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "huginndb".into())
    ));
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        // Without this the rename can land while the data is still in the page
        // cache, which on a network share means a reader can see an empty file
        // under the final name.
        f.sync_all()?;
    }
    if path.exists() {
        // Best-effort: `rename` succeeds over an existing file on Unix, so a
        // failure here is only fatal on Windows, where the rename below reports
        // it anyway.
        let _ = std::fs::remove_file(path);
    }
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Leaving a stray `.name.tmp` next to a team's document would look
            // like a corrupt publish to the next person who lists the folder.
            let _ = std::fs::remove_file(&tmp);
            Err(e.into())
        }
    }
}

/// Copy `path` to `path` + `.bak`, so the revision being replaced survives one
/// generation.
///
/// A copy rather than a rename: the original has to stay in place until the
/// [`write_atomic`] rename lands, or a failure between the two steps would
/// leave the share with no current file at all.
///
/// Returns `false` when there was nothing to back up, and errors are the
/// caller's to swallow: a `.bak` another user left read-only must not be what
/// stops today's publish.
pub fn backup_previous(path: &Path) -> AppResult<bool> {
    if !path.exists() {
        return Ok(false);
    }
    let mut bak = path.as_os_str().to_os_string();
    bak.push(".bak");
    std::fs::copy(path, PathBuf::from(bak))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch directory of our own. Deliberately **not** [`path`]: that
    /// resolves through the developer's real config dir under `cargo test`, and
    /// writing there is how three tests once overwrote a live `profiles.json`
    /// (CLAUDE.md gotcha #52).
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("huginndb-state-file-{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    /// The temp file has to be created next to the destination, not in a temp
    /// dir: `rename` is only atomic within one filesystem, and an origin
    /// document lives on a share, which is always a different volume.
    #[test]
    fn write_atomic_writes_beside_its_destination() {
        let dir = scratch("beside");
        let target = dir.join("team.json");
        write_atomic(&target, b"{\"a\":1}").unwrap();
        assert_eq!("{\"a\":1}", std::fs::read_to_string(&target).unwrap());

        // Nothing left behind for the next person who lists the folder.
        let stray: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n != "team.json")
            .collect();
        assert!(stray.is_empty(), "left {stray:?}");
    }

    /// Overwriting is the normal case for a published document, and on Windows
    /// `rename` refuses to clobber — so this is the assertion that keeps the
    /// remove-then-rename order in place.
    #[test]
    fn write_atomic_replaces_an_existing_file() {
        let dir = scratch("replace");
        let target = dir.join("team.json");
        write_atomic(&target, b"old").unwrap();
        write_atomic(&target, b"new").unwrap();
        assert_eq!("new", std::fs::read_to_string(&target).unwrap());
    }

    /// The previous revision survives one generation, and the original stays in
    /// place while it does — a rename would leave the share with no current file
    /// at all if the write that follows failed.
    #[test]
    fn backup_previous_copies_rather_than_moves() {
        let dir = scratch("backup");
        let target = dir.join("team.json");

        assert!(
            !backup_previous(&target).unwrap(),
            "nothing to back up on a first publish"
        );

        write_atomic(&target, b"rev-1").unwrap();
        assert!(backup_previous(&target).unwrap());
        assert_eq!("rev-1", std::fs::read_to_string(&target).unwrap());
        assert_eq!(
            "rev-1",
            std::fs::read_to_string(dir.join("team.json.bak")).unwrap()
        );

        write_atomic(&target, b"rev-2").unwrap();
        assert_eq!("rev-2", std::fs::read_to_string(&target).unwrap());
        assert_eq!(
            "rev-1",
            std::fs::read_to_string(dir.join("team.json.bak")).unwrap()
        );
    }
}
