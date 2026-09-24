//! Settings → Policy: the read-only view of this machine's managed policy —
//! where it was read from, who this is, which role that makes them, and what
//! each connection allows. See `crate::policy`.
//!
//! Read-only on purpose. The policy is written by an administrator, in a
//! place a standard user cannot write; nothing in the app edits it.

use crate::state::AppState;
use tauri::State;

/// The policy as it applies to this user on this machine, right now.
///
/// Synchronous: it reads two locks and no file — the policy was loaded by
/// `policy::install`'s thread, and the profiles are in memory.
#[tauri::command]
pub fn policy_status(state: State<'_, AppState>) -> crate::policy::PolicyStatus {
    crate::policy::status(state.inner())
}
