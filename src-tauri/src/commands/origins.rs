//! Shared connection origins (#108).
//!
//! An origin is a **file** on a path the OS already mounts — a UNC share, a
//! mapped drive, a synced folder — in the format `export_profiles` writes
//! (`crate::transfer` v1). One person curates it; everyone else pulls from it.
//! There is no protocol and no service here: reading one is `std::fs::read`, and
//! the share's ACL is the actual access control.
//!
//! This module owns the origin *registry* (add / rename / remove, scoped to the
//! active environment), the keychain handling for an encrypted origin's
//! passphrase, and the pull itself ([`sync_origin`]).
//!
//! ## Why the passphrase goes in the keychain
//!
//! An encrypted export needs its passphrase on every pull, including the
//! unattended one at launch. Storing it in `tab_state.json` would put a secret
//! that decrypts a whole set of database passwords into a plaintext file that is
//! also, by design, the most-frequently-rewritten state we have — the exact
//! thing `profiles.json` avoids. It goes to the OS keychain under the same
//! service as connection passwords, keyed by origin id.
//!
//! Worth being explicit about the threat model, because the encryption invites
//! more confidence than it earns: read access to the share **plus** the
//! passphrase yields every password in the file. The passphrase travels
//! out-of-band (the admin tells the new hire), so the share's ACL is the real
//! perimeter. See `SECURITY.md`.

use crate::error::{AppError, AppResult};
use crate::keychain;
use crate::state::AppState;
use crate::tab_state::{self, Origin};
use tauri::State;

/// Keychain account for an origin's passphrase.
///
/// Namespaced with an `origin::` prefix so it can never collide with a
/// connection's account, which is `<profile-id>::<username>`. A profile id is a
/// UUID, so the prefix is what keeps the two spaces disjoint by construction
/// rather than by luck.
fn passphrase_account(origin_id: &str) -> String {
    format!("origin::{origin_id}")
}

/// Origins registered in the active environment, in insertion order.
#[tauri::command]
pub fn list_origins(state: State<'_, AppState>) -> AppResult<Vec<Origin>> {
    let guard = state.tab_state.read();
    Ok(guard
        .active_environment()
        .map(|env| env.origins.clone())
        .unwrap_or_default())
}

/// Register a shared origin in the active environment.
///
/// The path is **not** validated here beyond being non-empty. A share can be
/// legitimately unreachable at the moment it is configured — VPN down, laptop
/// off the corporate network — and refusing to save it then would force the user
/// to re-enter it later. Reachability is the sync's problem, where a failure has
/// somewhere sensible to be reported.
///
/// `passphrase` is stored in the keychain when the file is encrypted; pass
/// `None` for a plaintext export. It is never written to `tab_state.json`.
#[tauri::command]
pub fn add_origin(
    state: State<'_, AppState>,
    name: String,
    path: String,
    passphrase: Option<String>,
) -> AppResult<Origin> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("origin path is empty".into()));
    }
    let origin = Origin {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        path,
        last_synced_at: None,
    };

    // Keychain first: a failure here must not leave a registered origin whose
    // passphrase silently went nowhere, since the next sync would then report a
    // decryption error the user has no way to connect to this moment.
    if let Some(secret) = passphrase.as_deref().filter(|s| !s.is_empty()) {
        keychain::set_password(&passphrase_account(&origin.id), secret)?;
    }

    let snapshot = {
        let mut guard = state.tab_state.write();
        guard.active_environment_mut().origins.push(origin.clone());
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(origin)
}

/// Rename an origin, repoint it at a different file, and/or replace its stored
/// passphrase.
///
/// `passphrase` is tri-state on purpose: `None` leaves whatever is in the
/// keychain untouched (so a plain rename does not require the user to retype a
/// secret they already stored), while `Some("")` clears it — which is how an
/// origin that used to be encrypted becomes a plaintext one.
#[tauri::command]
pub fn update_origin(
    state: State<'_, AppState>,
    id: String,
    name: String,
    path: String,
    passphrase: Option<String>,
) -> AppResult<Origin> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("origin path is empty".into()));
    }
    match passphrase.as_deref() {
        Some("") => keychain::delete_password(&passphrase_account(&id))?,
        Some(secret) => keychain::set_password(&passphrase_account(&id), secret)?,
        None => {}
    }

    let (snapshot, updated) = {
        let mut guard = state.tab_state.write();
        let origin = guard
            .active_environment_mut()
            .origins
            .iter_mut()
            .find(|o| o.id == id)
            .ok_or_else(|| AppError::InvalidInput(format!("no origin with id {id}")))?;
        origin.name = name;
        origin.path = path;
        let updated = origin.clone();
        (guard.clone(), updated)
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(updated)
}

/// Unregister an origin and forget its passphrase.
///
/// The connections it imported are deliberately **left in place**, tagged with
/// its now-dangling `origin_id`. Removing an origin says "stop pulling from
/// here", not "delete these servers": the user may well have work open against
/// one, and silently deleting a batch of connections (plus their keychain
/// entries) on a config change is not a trade anyone would choose. A dangling
/// `origin_id` is harmless — no sync resolves against it any more, and the
/// frontend can offer to release those profiles into ordinary local ones.
#[tauri::command]
pub fn remove_origin(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let snapshot = {
        let mut guard = state.tab_state.write();
        let env = guard.active_environment_mut();
        let before = env.origins.len();
        env.origins.retain(|o| o.id != id);
        if env.origins.len() == before {
            return Err(AppError::InvalidInput(format!("no origin with id {id}")));
        }
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    // Best-effort: a missing entry is the desired end state, and failing the
    // whole command over it would leave the origin registered.
    let _ = keychain::delete_password(&passphrase_account(&id));
    Ok(())
}

/// Pull an origin: refresh what it publishes, report what disappeared.
///
/// Three outcomes are kept strictly apart, and the separation matters more than
/// the feature does:
///
/// 1. **Unreadable or unparseable** — share offline, VPN down, or the publisher
///    mid-save without an atomic rename. Returns `Err` and touches *nothing*: no
///    profiles, no `last_synced_at`. A failed read must never be mistaken for
///    "the file now says less".
/// 2. **Read cleanly, entries missing** — reported in `vanished` for the user to
///    decide on.
/// 3. **Read cleanly but suspiciously empty** — flagged via `suspicious` so the
///    frontend withholds removal offers. See [`disappearance_is_trustworthy`].
///
/// Metadata for an existing profile is refreshed in place, except while a pool is
/// open for it: repointing host/port under a running query changes the server
/// beneath the user, so those land in `deferred` and apply on disconnect.
///
/// Never writes to the origin's path.
#[tauri::command]
pub fn sync_origin(state: State<'_, AppState>, id: String) -> AppResult<OriginSyncReport> {
    let origin = {
        let guard = state.tab_state.read();
        guard
            .active_environment()
            .and_then(|env| env.origins.iter().find(|o| o.id == id).cloned())
            .ok_or_else(|| AppError::InvalidInput(format!("no origin with id {id}")))?
    };

    // State 1. Any failure here returns early, before a single profile is
    // touched.
    let data = std::fs::read_to_string(&origin.path).map_err(|e| {
        AppError::InvalidInput(format!("cannot read origin {:?}: {e}", origin.path))
    })?;
    let export: crate::transfer::ExportFile = serde_json::from_str(&data).map_err(|e| {
        AppError::InvalidInput(format!(
            "origin {:?} is not a HuginnDB export: {e}",
            origin.path
        ))
    })?;

    let passphrase = keychain::get_password(&passphrase_account(&id))?;
    if export.meta.encrypted && passphrase.is_none() {
        return Err(AppError::InvalidInput(
            "this origin is encrypted but no passphrase is stored for it".into(),
        ));
    }

    let incoming_ids: std::collections::HashSet<&str> = export
        .profiles
        .iter()
        .map(|p| p.profile.id.as_str())
        .collect();

    let mut report = OriginSyncReport::default();
    let live: Vec<String> = state.connections.read().ids();

    {
        let mut profiles = state.profiles.write();

        // Local profiles this origin owns, before the merge — the denominator for
        // the suspicion check.
        let owned: Vec<String> = profiles
            .iter()
            .filter(|p| p.origin_id.as_deref() == Some(id.as_str()))
            .map(|p| p.id.clone())
            .collect();
        report.vanished = owned
            .iter()
            .filter(|pid| !incoming_ids.contains(pid.as_str()))
            .cloned()
            .collect();
        report.suspicious = !disappearance_is_trustworthy(owned.len(), report.vanished.len());
        if report.suspicious {
            // Say nothing actionable about a read we don't trust.
            report.vanished.clear();
        }

        for entry in &export.profiles {
            let mut incoming = entry.profile.clone();
            incoming.origin_id = Some(id.clone());
            // An origin never publishes session-only profiles.
            incoming.ephemeral = false;

            match profiles.iter_mut().find(|p| p.id == incoming.id) {
                Some(existing) => {
                    // Only ever refresh a profile this origin already owns. A
                    // local profile that happens to share an id (an earlier
                    // import, later detached) is the user's, not the file's.
                    if existing.origin_id.as_deref() != Some(id.as_str()) {
                        continue;
                    }
                    if live.iter().any(|c| c == &incoming.id) {
                        report.deferred.push(incoming.id.clone());
                        continue;
                    }
                    *existing = incoming.clone();
                    report.updated.push(incoming.id);
                }
                None => {
                    report.added.push(incoming.id.clone());
                    profiles.push(incoming);
                }
            }
        }

        crate::store::save_profiles(&profiles)?;
    }

    // Secrets land in this user's own keychain, decrypted with their own stored
    // passphrase. Best-effort per profile: a secret that fails to decrypt leaves
    // that connection needing a password rather than failing the whole sync.
    for entry in &export.profiles {
        let Some(secrets) = &entry.secrets else {
            continue;
        };
        if let Some(blob) = &secrets.db_password {
            let plain = match &passphrase {
                Some(pass) => crate::transfer::decrypt_secret(blob, pass).ok(),
                None => Some(blob.clone()),
            };
            if let Some(p) = plain {
                let _ = keychain::set_password(&entry.profile.keyring_account(), &p);
            }
        }
        if let (Some(blob), Some(account)) =
            (&secrets.ssh_secret, entry.profile.ssh_keyring_account())
        {
            let plain = match &passphrase {
                Some(pass) => crate::transfer::decrypt_secret(blob, pass).ok(),
                None => Some(blob.clone()),
            };
            if let Some(p) = plain {
                let _ = keychain::set_password(&account, &p);
            }
        }
    }

    report.synced_at = chrono::Utc::now().to_rfc3339();
    let snapshot = {
        let mut guard = state.tab_state.write();
        if let Some(o) = guard
            .active_environment_mut()
            .origins
            .iter_mut()
            .find(|o| o.id == id)
        {
            o.last_synced_at = Some(report.synced_at.clone());
        }
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(report)
}

/// Below this many origin-tagged profiles, the "too many vanished at once" check
/// is skipped — with two or three connections, losing both is plausibly a real
/// deletion rather than a corrupt read.
const SUSPICION_FLOOR: usize = 4;

/// Fraction of an origin's profiles that has to disappear in one sync before the
/// result is treated as untrustworthy rather than as a batch of deletions.
const SUSPICION_RATIO: f32 = 0.5;

/// Should this set of disappearances be acted on, or is the file probably not
/// telling us the truth?
///
/// A publisher writing the export without an atomic rename, a share dropping
/// mid-read, or a truncated file can all parse successfully while listing far
/// fewer profiles than they should. Treating that as "the admin deleted 25
/// clients" would bury the user in removal notices for connections that are
/// perfectly alive — and the recovery (re-adopting each one) is manual.
///
/// Pure so the threshold is testable without a filesystem.
fn disappearance_is_trustworthy(local_count: usize, vanished_count: usize) -> bool {
    if vanished_count == 0 {
        return true;
    }
    if local_count < SUSPICION_FLOOR {
        return true;
    }
    (vanished_count as f32 / local_count as f32) < SUSPICION_RATIO
}

/// Outcome of one [`sync_origin`] run.
///
/// Note what is absent: nothing here deletes. Disappearances are *reported* and
/// the user decides per connection whether to adopt it as local or retire it
/// (#108) — another user's edit to a shared file must never destroy credentials
/// on this machine.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginSyncReport {
    /// Profile ids created by this sync.
    pub added: Vec<String>,
    /// Profile ids whose metadata was refreshed from the file.
    pub updated: Vec<String>,
    /// Ids whose metadata changed but which have a live pool, so the change is
    /// held back rather than repointing a server under a running query.
    pub deferred: Vec<String>,
    /// Ids present locally under this origin but absent from the file. Reported
    /// only; see the type-level note.
    pub vanished: Vec<String>,
    /// True when `vanished` was large enough relative to the origin's footprint
    /// that the read is more likely broken than authoritative. The frontend must
    /// not offer removals in this state.
    pub suspicious: bool,
    /// RFC 3339 stamp written back onto the origin on success.
    pub synced_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_single_disappearance_is_trusted() {
        assert!(disappearance_is_trustworthy(20, 1));
    }

    #[test]
    fn a_wholesale_disappearance_is_not() {
        // A truncated or half-written file looks exactly like this.
        assert!(!disappearance_is_trustworthy(20, 20));
        assert!(!disappearance_is_trustworthy(20, 10));
    }

    #[test]
    fn small_origins_are_exempt_from_the_ratio() {
        // With three connections, losing two is plausibly deliberate; the ratio
        // alone would call it suspicious and block a legitimate cleanup.
        assert!(disappearance_is_trustworthy(3, 2));
    }

    #[test]
    fn no_disappearances_is_always_trusted() {
        assert!(disappearance_is_trustworthy(0, 0));
    }

    #[test]
    fn passphrase_account_cannot_collide_with_a_connection_account() {
        // Connection accounts are `<profile-id>::<username>`; origin accounts
        // carry a prefix instead, so the two namespaces can't overlap.
        let account = passphrase_account("2f1c8a0e-0000-4000-8000-000000000000");
        assert!(account.starts_with("origin::"));
        assert!(!account.contains("::origin"));
    }
}
