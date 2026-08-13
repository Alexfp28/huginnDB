//! Preferences and per-connection tab-state command surface.
//!
//! The frontend hydrates from [`get_preferences`] / [`get_tab_state`] at
//! startup and writes back via the matching setters (debounced on the
//! frontend side to avoid hammering the disk while a user drags a slider).

use crate::error::{AppError, AppResult};
use crate::prefs::{self, Preferences};
use crate::state::AppState;
use crate::tab_state::{self, ConnectionTabState, Environment, LaunchState};
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
pub async fn update_preferences(
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
    // Most preferences take effect just by being readable, but the MCP bridge
    // owns a socket: toggling it has to actually start or stop the listener.
    // `reconcile` is idempotent and cheap when nothing changed, so it runs on
    // every write rather than trying to detect which field moved — the
    // preferences arrive as a whole snapshot, so there is no diff to inspect.
    // `async` for this one reason; the command's IPC shape is unchanged.
    crate::bridge::server::reconcile(&app).await;
    Ok(())
}

/// Look up the persisted tab state for `connection_id` **in the active
/// environment**. Returns `None` when the connection has never been opened
/// there, has been pruned, or its entry was cleared after the profile was
/// deleted.
///
/// Only the main window ever calls this — secondary windows (opened via
/// "New window") never hydrate or save tab state, which is what makes
/// them ephemeral. The active environment is likewise a main-window concept.
#[tauri::command]
pub fn get_tab_state(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Option<ConnectionTabState>> {
    let guard = state.tab_state.read();
    Ok(guard
        .active_environment()
        .and_then(|env| env.connections.get(&connection_id))
        .cloned())
}

/// Replace the persisted tab state for `connection_id` in the active
/// environment and write the full blob to disk. The frontend stamps
/// `last_opened` before sending; we run a final pass to drop oversize query
/// bodies and to LRU-prune each environment's map.
#[tauri::command]
pub fn save_tab_state(
    state: State<'_, AppState>,
    connection_id: String,
    mut tab_state_value: ConnectionTabState,
) -> AppResult<()> {
    tab_state::normalise(&mut tab_state_value);
    let snapshot = {
        let mut guard = state.tab_state.write();
        guard
            .active_environment_mut()
            .connections
            .insert(connection_id, tab_state_value);
        guard.prune();
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}

/// Drop the persisted tab state for `connection_id`. Invoked when a
/// profile is deleted so a removed connection can't keep a dangling tab
/// reference around.
///
/// Sweeps **every** environment, not just the active one: the profile is gone
/// globally, so an entry left behind in another environment would resurface as
/// a tab pointing at a connection that no longer exists the moment the user
/// switched there.
#[tauri::command]
pub fn clear_tab_state(state: State<'_, AppState>, connection_id: String) -> AppResult<()> {
    let snapshot = {
        let mut guard = state.tab_state.write();
        for env in &mut guard.environments {
            env.connections.remove(&connection_id);
            env.launch
                .active_connections
                .retain(|id| id != &connection_id);
            if env.launch.selected_connection_id.as_deref() == Some(connection_id.as_str()) {
                env.launch.selected_connection_id = None;
            }
        }
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
    Ok(state
        .tab_state
        .read()
        .active_environment()
        .and_then(|env| env.internal_layout.clone()))
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
        guard.active_environment_mut().internal_layout = layout;
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}

/// Return the active environment's launch-restore state.
///
/// The DTO used to be declared here; it now lives in `tab_state` next to the
/// rest of the persisted shape, so there is one definition instead of two kept
/// in sync by hand.
#[tauri::command]
pub fn get_launch_state(state: State<'_, AppState>) -> AppResult<LaunchState> {
    let guard = state.tab_state.read();
    Ok(guard
        .active_environment()
        .map(|env| env.launch.clone())
        .unwrap_or_default())
}

/// Record the launch-restore state (live connections, focused connection,
/// active tab) so the next launch — or the next switch back into this
/// environment — can restore it. Written on window close and opportunistically
/// on connect/disconnect; see `src/stores/persistedTabs.ts`.
#[tauri::command]
pub fn save_launch_state(state: State<'_, AppState>, launch_state: LaunchState) -> AppResult<()> {
    let snapshot = {
        let mut guard = state.tab_state.write();
        guard.active_environment_mut().launch = launch_state;
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}

// --- Environments ------------------------------------------------------------
// A named set of connections plus the session state belonging to them. The
// active one scopes every tab-state / layout / launch call above.
//
// All of these are main-window-only in practice, for the same reason tab state
// is (CLAUDE.md gotcha #8): a secondary window writing here would reshape the
// main window's session out from under it.

/// Every environment in display order, plus which one is active.
#[tauri::command]
pub fn list_environments(state: State<'_, AppState>) -> AppResult<EnvironmentList> {
    let guard = state.tab_state.read();
    let mut environments = guard.environments.clone();
    environments.sort_by_key(|e| e.order);
    Ok(EnvironmentList {
        active_environment_id: guard
            .active_environment()
            .map(|e| e.id.clone())
            .unwrap_or_default(),
        environments,
    })
}

/// What [`list_environments`] returns: the list and the active id together, so
/// the frontend can't render a switcher out of step with the backend's notion of
/// which one is current.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentList {
    pub environments: Vec<Environment>,
    pub active_environment_id: String,
}

/// Create a new environment, or update an existing one's presentation fields.
///
/// Deliberately narrow: this never touches `connections`, `internal_layout` or
/// `launch`. Those are owned by the session-state commands above and a
/// round-trip through the frontend's editing form would drop whatever the user
/// had open — the same class of bug as gotcha #14, but caused by an incomplete
/// payload rather than by serde.
#[tauri::command]
pub fn save_environment(
    state: State<'_, AppState>,
    id: Option<String>,
    name: String,
    color: Option<String>,
    icon: Option<String>,
    theme_id: Option<String>,
) -> AppResult<Environment> {
    let (snapshot, saved) = {
        let mut guard = state.tab_state.write();
        let saved = match id {
            Some(id) => {
                let env = guard
                    .environments
                    .iter_mut()
                    .find(|e| e.id == id)
                    .ok_or_else(|| {
                        AppError::InvalidInput(format!("no environment with id {id}"))
                    })?;
                env.name = name;
                env.color = color;
                env.icon = icon;
                env.theme_id = theme_id;
                env.clone()
            }
            None => {
                let order = guard
                    .environments
                    .iter()
                    .map(|e| e.order)
                    .max()
                    .unwrap_or(0)
                    + 1;
                let env = Environment {
                    id: uuid::Uuid::new_v4().to_string(),
                    name,
                    color,
                    icon,
                    order,
                    theme_id,
                    ..Environment::default()
                };
                guard.environments.push(env.clone());
                env
            }
        };
        (guard.clone(), saved)
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(saved)
}

/// Delete an environment and everything it remembered.
///
/// Refuses to delete the last one: the invariant every session-state command
/// relies on is that an active environment always exists, and "delete the only
/// environment" has no sensible outcome — an empty switcher is not a state the
/// user can act from. Deleting the active one moves focus to the first survivor.
///
/// Connection *profiles* are untouched. An environment owns session state, not
/// the connections themselves (they live in `profiles.json`), so removing one
/// discards tabs and layout, never credentials.
#[tauri::command]
pub fn delete_environment(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let snapshot = {
        let mut guard = state.tab_state.write();
        if guard.environments.len() <= 1 {
            return Err(AppError::InvalidInput(
                "cannot delete the last environment".into(),
            ));
        }
        let before = guard.environments.len();
        guard.environments.retain(|e| e.id != id);
        if guard.environments.len() == before {
            return Err(AppError::InvalidInput(format!(
                "no environment with id {id}"
            )));
        }
        if guard.active_environment_id.as_deref() == Some(id.as_str()) {
            guard.active_environment_id = guard.environments.first().map(|e| e.id.clone());
        }
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}

/// Switch the active environment.
///
/// Backend-side this is just a pointer move plus a write; the expensive part is
/// the frontend's job and its order is load-bearing (flush the outgoing
/// session → disconnect → set active → reconnect → restore layout → restore
/// focus). See `src/stores/environments.ts`.
#[tauri::command]
pub fn set_active_environment(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let snapshot = {
        let mut guard = state.tab_state.write();
        if !guard.environments.iter().any(|e| e.id == id) {
            return Err(AppError::InvalidInput(format!(
                "no environment with id {id}"
            )));
        }
        guard.active_environment_id = Some(id);
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}

/// Persist the switcher's display order.
#[tauri::command]
pub fn reorder_environments(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<()> {
    let snapshot = {
        let mut guard = state.tab_state.write();
        for (i, id) in ids.iter().enumerate() {
            if let Some(env) = guard.environments.iter_mut().find(|e| &e.id == id) {
                env.order = i as i32;
            }
        }
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}
