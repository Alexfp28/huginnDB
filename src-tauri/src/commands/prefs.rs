//! Preferences and per-connection tab-state command surface.
//!
//! The frontend hydrates from [`get_preferences`] / [`get_tab_state`] at
//! startup and writes back via the matching setters (debounced on the
//! frontend side to avoid hammering the disk while a user drags a slider).

use crate::error::AppResult;
use crate::prefs::{self, Preferences};
use crate::state::AppState;
use crate::tab_state::{self, ConnectionTabState};
use tauri::State;

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
pub fn update_preferences(state: State<'_, AppState>, prefs: Preferences) -> AppResult<()> {
    {
        let mut guard = state.prefs.write();
        *guard = prefs.clone();
    }
    prefs::save_preferences(&prefs)?;
    Ok(())
}

/// Look up the persisted tab state for `connection_id` **inside the
/// currently active workspace**. Returns `None` when the connection has
/// never been opened in this workspace, has been pruned, or its entry
/// was cleared after the profile was deleted.
///
/// Scoping by workspace means switching workspaces hides the other
/// workspace's tabs without closing the underlying pool — exactly what
/// the user is asking for when they switch.
#[tauri::command]
pub fn get_tab_state(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Option<ConnectionTabState>> {
    let guard = state.tab_state.read();
    Ok(guard
        .active_workspace()
        .connections
        .get(&connection_id)
        .cloned())
}

/// Replace the persisted tab state for `connection_id` in the active
/// workspace and write the full blob to disk. The frontend stamps
/// `last_opened` before sending; we run a final pass to drop oversize
/// query bodies and to LRU-prune per-workspace.
#[tauri::command]
pub fn save_tab_state(
    state: State<'_, AppState>,
    connection_id: String,
    mut tab_state_value: ConnectionTabState,
) -> AppResult<()> {
    tab_state::normalise_for_save(&mut tab_state_value);
    let snapshot = {
        let mut guard = state.tab_state.write();
        guard
            .active_workspace_mut()
            .connections
            .insert(connection_id, tab_state_value);
        guard.prune();
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}

/// Drop the persisted tab state for `connection_id` across **every**
/// workspace. Invoked when a profile is deleted so a removed connection
/// can't keep dangling tab references in workspaces the user isn't
/// currently looking at.
#[tauri::command]
pub fn clear_tab_state(state: State<'_, AppState>, connection_id: String) -> AppResult<()> {
    let snapshot = {
        let mut guard = state.tab_state.write();
        for ws in &mut guard.workspaces {
            ws.connections.remove(&connection_id);
        }
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}
