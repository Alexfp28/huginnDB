//! Shared connection origins (#108).
//!
//! An origin is a **file** on a path the OS already mounts — a UNC share, a
//! mapped drive, a synced folder — in the format `export_profiles` writes
//! (`crate::transfer` v1). One person curates it; everyone else pulls from it.
//! There is no protocol and no service here: reading one is `std::fs::read`, and
//! the share's ACL is the actual access control.
//!
//! This module owns the origin *registry* (add / rename / remove, scoped to the
//! active environment) and the keychain handling for an encrypted origin's
//! passphrase. The sync itself lands separately.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passphrase_account_cannot_collide_with_a_connection_account() {
        // Connection accounts are `<profile-id>::<username>`; origin accounts
        // carry a prefix instead, so the two namespaces can't overlap.
        let account = passphrase_account("2f1c8a0e-0000-4000-8000-000000000000");
        assert!(account.starts_with("origin::"));
        assert!(!account.contains("::origin"));
    }
}
