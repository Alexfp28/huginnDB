//! Preferences and per-connection tab-state command surface.
//!
//! The frontend hydrates from [`get_preferences`] / [`get_tab_state`] at
//! startup and writes back via the matching setters (debounced on the
//! frontend side to avoid hammering the disk while a user drags a slider).

use crate::error::AppResult;
use crate::prefs::{self, Preferences};
use crate::state::AppState;
use crate::tab_state::{self, ConnectionTabState};
use tauri::{AppHandle, Emitter, State};

/// Broadcast (unscoped — every window) after a successful `update_preferences`,
/// carrying the full persisted snapshot. Each window's frontend hydrates its
/// own private `Preferences` copy once at boot and otherwise has no way to
/// learn another window changed a setting; without this, two windows racing
/// to save (each sending its *entire* blob, not a diff) silently lose
/// whichever one saved first the moment the other's debounce timer fires —
/// see issue #18. The listener just adopts the payload as its new baseline
/// (no re-save), so this is idempotent for the window that triggered it too.
pub const PREFS_CHANGED_EVENT: &str = "huginndb://prefs-changed";

/// Return the in-memory preferences snapshot.
#[tauri::command]
pub fn get_preferences(state: State<'_, AppState>) -> AppResult<Preferences> {
    Ok(state.prefs.read().clone())
}

/// Replace the entire preferences blob and persist it to disk.
///
/// The frontend always sends a full [`Preferences`] value; partial updates
/// are merged client-side. This keeps the wire shape trivial and lets us
/// keep the on-disk file as a faithful mirror of frontend state.
#[tauri::command]
pub fn update_preferences(
    app: AppHandle,
    state: State<'_, AppState>,
    prefs: Preferences,
) -> AppResult<()> {
    {
        let mut guard = state.prefs.write();
        *guard = prefs.clone();
    }
    prefs::save_preferences(&prefs)?;
    let _ = app.emit(PREFS_CHANGED_EVENT, prefs);
    Ok(())
}

/// Look up the persisted tab state for `connection_id`. Returns `None`
/// when the connection has never been opened, has been pruned, or its
/// entry was cleared after the profile was deleted.
///
/// Only the main window ever calls this — secondary windows (opened via
/// "New window") never hydrate or save tab state, which is what makes
/// them ephemeral.
#[tauri::command]
pub fn get_tab_state(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Option<ConnectionTabState>> {
    let guard = state.tab_state.read();
    Ok(guard.connections.get(&connection_id).cloned())
}

/// Replace the persisted tab state for `connection_id` and write the full
/// blob to disk. The frontend stamps `last_opened` before sending; we run
/// a final pass to drop oversize query bodies and to LRU-prune the map.
#[tauri::command]
pub fn save_tab_state(
    state: State<'_, AppState>,
    connection_id: String,
    mut tab_state_value: ConnectionTabState,
) -> AppResult<()> {
    tab_state::normalise_for_save(&mut tab_state_value);
    let snapshot = {
        let mut guard = state.tab_state.write();
        guard.connections.insert(connection_id, tab_state_value);
        guard.prune();
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}

/// Drop the persisted tab state for `connection_id`. Invoked when a
/// profile is deleted so a removed connection can't keep a dangling tab
/// reference around.
#[tauri::command]
pub fn clear_tab_state(state: State<'_, AppState>, connection_id: String) -> AppResult<()> {
    let snapshot = {
        let mut guard = state.tab_state.write();
        guard.connections.remove(&connection_id);
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}

/// Return the session-level inner-dockview geometry, or `None` for the
/// default tabbed layout. Session-level rather than per-connection: the
/// inner dockview is a single shared instance hosting every connection's
/// tabs, so its geometry belongs to the session (see
/// `tab_state::PersistedTabState::internal_layout`). Main-window-only, same
/// as the per-connection tab-state calls.
#[tauri::command]
pub fn get_workspace_layout(state: State<'_, AppState>) -> AppResult<Option<serde_json::Value>> {
    Ok(state.tab_state.read().internal_layout.clone())
}

/// Persist the session-level inner-dockview geometry (or `None` to clear it
/// back to the default tabbed layout) and write the full blob to disk.
#[tauri::command]
pub fn save_workspace_layout(
    state: State<'_, AppState>,
    layout: Option<serde_json::Value>,
) -> AppResult<()> {
    let snapshot = {
        let mut guard = state.tab_state.write();
        guard.internal_layout = layout;
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}

/// Return the connection ids that were live in the main window when it last
/// closed, so the launch flow can auto-reconnect them (gated on the
/// `reconnectOnLaunch` preference).
#[tauri::command]
pub fn get_active_connections(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    Ok(state.tab_state.read().active_connections.clone())
}

/// Record which connections are currently live in the main window, so the
/// next launch can restore them. Written on window close (and opportunistically
/// as the active set changes) — see `src/stores/persistedTabs.ts`.
#[tauri::command]
pub fn save_active_connections(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<()> {
    let snapshot = {
        let mut guard = state.tab_state.write();
        guard.active_connections = ids;
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}
