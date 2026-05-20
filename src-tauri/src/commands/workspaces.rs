//! Workspace-management commands.
//!
//! A workspace bundles a name, presentation chrome (color, icon, order)
//! and the per-connection tab state for everything the user has touched
//! while it was active. The frontend uses these commands to power the
//! workspace switcher in the topbar.
//!
//! Every mutation persists the full [`PersistedTabState`] blob — the
//! file is small enough that incremental writes are not worth the
//! complexity, and the atomic rename guarantees we never leave a
//! half-written workspace on disk.

use crate::error::AppResult;
use crate::state::AppState;
use crate::tab_state::{self, WorkspaceMeta};
use tauri::State;

/// Ordered list of workspace summaries for the switcher UI.
#[tauri::command]
pub fn list_workspaces(state: State<'_, AppState>) -> AppResult<Vec<WorkspaceMeta>> {
    Ok(state.tab_state.read().workspace_metas())
}

/// Id of the workspace currently in focus. `None` is valid before
/// hydration; the frontend treats it as "use the first one".
#[tauri::command]
pub fn get_active_workspace_id(state: State<'_, AppState>) -> AppResult<Option<String>> {
    Ok(state.tab_state.read().active_workspace_id.clone())
}

/// Create a new workspace at the end of the list and return its meta.
/// Persists immediately so a crash right after creation doesn't lose
/// the entry.
#[tauri::command]
pub fn create_workspace(
    state: State<'_, AppState>,
    name: String,
    color: Option<String>,
    icon: Option<String>,
) -> AppResult<WorkspaceMeta> {
    let (meta, snapshot) = {
        let mut guard = state.tab_state.write();
        let meta = guard.create_workspace(name, color, icon);
        (meta, guard.clone())
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(meta)
}

/// Rename an existing workspace.
#[tauri::command]
pub fn rename_workspace(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> AppResult<()> {
    let snapshot = {
        let mut guard = state.tab_state.write();
        guard.rename_workspace(&id, name)?;
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}

/// Update the color / icon of a workspace. Both are nullable so the
/// user can clear them by sending `None`.
#[tauri::command]
pub fn update_workspace_appearance(
    state: State<'_, AppState>,
    id: String,
    color: Option<String>,
    icon: Option<String>,
) -> AppResult<()> {
    let snapshot = {
        let mut guard = state.tab_state.write();
        guard.update_workspace_appearance(&id, color, icon)?;
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}

/// Delete a workspace. Refuses to remove the last remaining one.
#[tauri::command]
pub fn delete_workspace(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let snapshot = {
        let mut guard = state.tab_state.write();
        guard.delete_workspace(&id)?;
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}

/// Reorder workspaces to match the supplied id sequence. The first id
/// in the array becomes `order=0`, the second `order=1`, and so on.
#[tauri::command]
pub fn reorder_workspaces(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<()> {
    let snapshot = {
        let mut guard = state.tab_state.write();
        guard.reorder_workspaces(&ids)?;
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}

/// Switch the active workspace. The tab-state commands then transparently
/// scope to the new workspace.
#[tauri::command]
pub fn set_active_workspace(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let snapshot = {
        let mut guard = state.tab_state.write();
        guard.set_active_workspace(&id)?;
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}
