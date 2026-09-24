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

/// What the app may offer the person using it on each connection — locked
/// controls read this. `connection_ids` may be profile ids or
/// `<parent>::db::<name>` view ids, since a rule can be about one database.
///
/// Advisory for the interface only: every command refuses on its own
/// (`commands::guard`), so a stale answer here can show a control that then
/// fails, never let one through.
#[tauri::command]
pub fn policy_access(
    state: State<'_, AppState>,
    connection_ids: Vec<String>,
) -> crate::policy::PolicyAccess {
    crate::policy::access(state.inner(), &connection_ids)
}

/// A relation, as `policy_relation_access` is asked about it.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationRef {
    pub schema: Option<String>,
    pub name: String,
}

/// What the person may do on each of `relations`, in one call per listing or
/// tab rather than one per row. The globs, the deny-wins rule and the
/// MySQL/MongoDB schema-is-the-database rule all live in Rust, so the
/// frontend cannot answer this on its own.
#[tauri::command]
pub fn policy_relation_access(
    state: State<'_, AppState>,
    connection_id: String,
    relations: Vec<RelationRef>,
) -> Vec<crate::policy::RelationAccess> {
    let pairs: Vec<(Option<String>, String)> =
        relations.into_iter().map(|r| (r.schema, r.name)).collect();
    crate::policy::relation_access(state.inner(), &connection_id, &pairs)
}
