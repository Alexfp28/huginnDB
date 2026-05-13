//! Connection-profile and lifecycle commands.

use crate::db::pool::{open_pool, smoke_test};
use crate::error::{AppError, AppResult};
use crate::keychain;
use crate::state::{AppState, ConnectionProfile, Driver};
use crate::store;
use tauri::State;
use uuid::Uuid;

/// Look up the password for `profile` from the OS keychain.
///
/// SQLite profiles never store a password (the database is a local file),
/// so we short-circuit with the empty string for them.
fn resolve_password(profile: &ConnectionProfile) -> AppResult<String> {
    if matches!(profile.driver, Driver::Sqlite) {
        return Ok(String::new());
    }
    keychain::require_password(&profile.keyring_account())
}

/// Return every saved profile.
#[tauri::command]
pub fn list_profiles(state: State<'_, AppState>) -> AppResult<Vec<ConnectionProfile>> {
    Ok(state.profiles.read().clone())
}

/// Create or update a profile.
///
/// * `profile` — profile to persist. If `profile.id` is empty a fresh
///   UUID is generated.
/// * `password` — if provided, written to the OS keychain. Passing `None`
///   leaves any existing stored password untouched.
#[tauri::command]
pub fn save_profile(
    state: State<'_, AppState>,
    mut profile: ConnectionProfile,
    password: Option<String>,
) -> AppResult<ConnectionProfile> {
    if profile.id.is_empty() {
        profile.id = Uuid::new_v4().to_string();
    }

    if let Some(pw) = password {
        if !matches!(profile.driver, Driver::Sqlite) {
            keychain::set_password(&profile.keyring_account(), &pw)?;
        }
    }

    {
        let mut profiles = state.profiles.write();
        if let Some(existing) = profiles.iter_mut().find(|p| p.id == profile.id) {
            *existing = profile.clone();
        } else {
            profiles.push(profile.clone());
        }
        store::save_profiles(&profiles)?;
    }
    Ok(profile)
}

/// Delete the profile with `id` and its associated keychain entry.
#[tauri::command]
pub fn delete_profile(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let mut profiles = state.profiles.write();
    let removed = profiles
        .iter()
        .position(|p| p.id == id)
        .map(|i| profiles.remove(i));
    if let Some(p) = removed {
        if !matches!(p.driver, Driver::Sqlite) {
            keychain::delete_password(&p.keyring_account())?;
        }
    }
    store::save_profiles(&profiles)?;
    Ok(())
}

/// Try opening `profile` end-to-end and execute `SELECT 1` against it.
///
/// Used by the "Test" button in the connection dialog. The temporary pool
/// is dropped immediately after the round-trip.
#[tauri::command]
pub async fn test_connection(
    profile: ConnectionProfile,
    password: Option<String>,
) -> AppResult<String> {
    let pw = match password {
        Some(p) => p,
        None => resolve_password(&profile)?,
    };
    smoke_test(&profile, &pw).await?;
    Ok("ok".into())
}

/// Open a long-lived pool for the profile `id` and add it to
/// [`crate::state::ActiveConnections`].
#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    id: String,
    password: Option<String>,
) -> AppResult<()> {
    let profile = state
        .profiles
        .read()
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("profile {id}")))?;

    let pw = match password {
        Some(p) => p,
        None => resolve_password(&profile)?,
    };

    let pool = open_pool(&profile, &pw).await?;
    state.connections.write().insert(id, pool);
    Ok(())
}

/// Drop the active pool for `id`, if any.
#[tauri::command]
pub fn disconnect(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.connections.write().remove(&id);
    Ok(())
}

/// Ids of every currently active connection. Used by the frontend to
/// reconcile its in-memory state after reloads.
#[tauri::command]
pub fn active_connections(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    Ok(state.connections.read().ids())
}
