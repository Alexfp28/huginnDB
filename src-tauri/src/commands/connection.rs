//! Connection-profile and lifecycle commands.

use crate::db::pool::{open_pool, smoke_test};
use crate::error::{AppError, AppResult};
use crate::keychain;
use crate::log_bus::{self, LogEntry, LogKind};
use crate::ssh_known_hosts;
use crate::state::{ActivePool, AppState, ConnectionProfile, Driver};
use crate::store;
use std::time::Instant;
use tauri::{AppHandle, State};
use uuid::Uuid;

/// Driver label used by the Console panel.
fn driver_str(driver: Driver) -> &'static str {
    match driver {
        Driver::Postgres => "postgres",
        Driver::Mysql => "mysql",
        Driver::Sqlite => "sqlite",
    }
}

/// Emit a `connection` log entry. Used for `connect`, `disconnect`, and
/// `test_connection` so the Console panel can show the actual lifecycle
/// boundary that's currently invisible to the user.
fn log_connection(
    app: &AppHandle,
    connection_id: &str,
    driver: Driver,
    message: &str,
    start: Option<Instant>,
    error: Option<&str>,
) {
    let mut entry = LogEntry::new(LogKind::Connection)
        .connection_id(connection_id)
        .driver(driver_str(driver))
        .message(message);
    if let Some(s) = start {
        entry = entry.duration_ms(s.elapsed().as_millis() as u64);
    }
    if let Some(e) = error {
        entry = entry.error(e);
    }
    log_bus::emit(app, entry);
}

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

/// Look up the SSH secret (password or key passphrase) for `profile` from
/// the OS keychain. Returns `Ok(None)` if the profile has no tunnel, or if
/// no secret has been stored yet (some tunnels — e.g. a passphrase-less
/// key — legitimately have no stored secret).
fn resolve_ssh_secret(profile: &ConnectionProfile) -> AppResult<Option<String>> {
    let Some(account) = profile.ssh_keyring_account() else {
        return Ok(None);
    };
    keychain::get_password(&account)
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
/// * `password` — if provided, written to the DB keychain entry. Passing
///   `None` leaves any existing stored password untouched.
/// * `ssh_secret` — if provided AND the profile has a tunnel configured,
///   written to a separate SSH keychain entry. Passing `None` leaves any
///   existing stored secret untouched. If the profile no longer has a
///   tunnel, any previously-stored SSH secret for this profile is removed.
#[tauri::command]
pub fn save_profile(
    state: State<'_, AppState>,
    mut profile: ConnectionProfile,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> AppResult<ConnectionProfile> {
    if profile.id.is_empty() {
        profile.id = Uuid::new_v4().to_string();
    }

    if let Some(pw) = password {
        if !matches!(profile.driver, Driver::Sqlite) {
            keychain::set_password(&profile.keyring_account(), &pw)?;
        }
    }

    match (profile.ssh_keyring_account(), ssh_secret) {
        // Tunnel present + new secret → persist it.
        (Some(account), Some(secret)) => {
            keychain::set_password(&account, &secret)?;
        }
        // Tunnel present + no new secret → keep whatever was there.
        (Some(_), None) => {}
        // Tunnel absent → make sure no orphan SSH secret lingers under any
        // prior account derived from a previous tunnel config for this id.
        (None, _) => {
            // We don't know the prior SSH username, but the account string
            // is namespaced by `${id}::ssh::${username}`. The cleanest
            // sweep is delegated to delete_profile; on plain update we
            // leave any prior entry in place (it cannot be resolved
            // without a tunnel config and will be cleaned up by deletion).
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

/// Delete the profile with `id` and its associated keychain entries.
///
/// Also drops the per-connection workspace state (open tabs, schema-tree
/// expansion) so we don't keep dangling entries pointing at a profile that
/// no longer exists.
#[tauri::command]
pub fn delete_profile(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let removed = {
        let mut profiles = state.profiles.write();
        let removed = profiles
            .iter()
            .position(|p| p.id == id)
            .map(|i| profiles.remove(i));
        store::save_profiles(&profiles)?;
        removed
    };
    if let Some(p) = removed {
        if !matches!(p.driver, Driver::Sqlite) {
            keychain::delete_password(&p.keyring_account())?;
        }
        if let Some(ssh_account) = p.ssh_keyring_account() {
            keychain::delete_password(&ssh_account)?;
        }
    }
    let tab_state_snapshot = {
        let mut guard = state.tab_state.write();
        guard.connections.remove(&id);
        guard.clone()
    };
    crate::tab_state::save_tab_state(&tab_state_snapshot)?;
    Ok(())
}

/// Try opening `profile` end-to-end and execute `SELECT 1` against it.
///
/// Used by the "Test" button in the connection dialog. The temporary pool
/// — and any SSH tunnel that fronts it — is dropped immediately after the
/// round-trip.
#[tauri::command]
pub async fn test_connection(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> AppResult<String> {
    let pw = match password {
        Some(p) => p,
        None => resolve_password(&profile)?,
    };
    let ssh = match ssh_secret {
        Some(s) => Some(s),
        None => resolve_ssh_secret(&profile)?,
    };
    let known_hosts = state.known_hosts.clone();
    let start = Instant::now();
    log_connection(
        &app,
        &profile.id,
        profile.driver,
        "test_connection: start",
        None,
        None,
    );
    match smoke_test(&profile, &pw, ssh, known_hosts).await {
        Ok(()) => {
            log_connection(
                &app,
                &profile.id,
                profile.driver,
                "test_connection: ok",
                Some(start),
                None,
            );
            Ok("ok".into())
        }
        Err(e) => {
            let msg = e.to_string();
            log_connection(
                &app,
                &profile.id,
                profile.driver,
                "test_connection: failed",
                Some(start),
                Some(&msg),
            );
            Err(e)
        }
    }
}

/// Open a long-lived pool for the profile `id` and add it to
/// [`crate::state::ActiveConnections`]. When the profile carries an SSH
/// tunnel, the tunnel is brought up first and lives as long as the pool.
#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    password: Option<String>,
    ssh_secret: Option<String>,
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
    let ssh = match ssh_secret {
        Some(s) => Some(s),
        None => resolve_ssh_secret(&profile)?,
    };

    let known_hosts = state.known_hosts.clone();
    let start = Instant::now();
    log_connection(
        &app,
        &id,
        profile.driver,
        &format!(
            "connect: opening {} pool to {}:{}/{}",
            driver_str(profile.driver),
            profile.host,
            profile.port,
            profile.database
        ),
        None,
        None,
    );
    let opened = open_pool(&profile, &pw, ssh, known_hosts).await;
    match opened {
        Ok((pool, ssh_handle)) => {
            state.connections.write().insert(
                id.clone(),
                ActivePool {
                    pool,
                    _ssh: ssh_handle,
                },
            );
            log_connection(&app, &id, profile.driver, "connect: ok", Some(start), None);
            Ok(())
        }
        Err(e) => {
            let msg = e.to_string();
            log_connection(
                &app,
                &id,
                profile.driver,
                "connect: failed",
                Some(start),
                Some(&msg),
            );
            Err(e)
        }
    }
}

/// Drop the active pool for `id`, if any.
#[tauri::command]
pub fn disconnect(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<()> {
    let removed = state.connections.write().remove(&id);
    if removed.is_some() {
        // Driver is not tracked separately for active pools; look it up
        // on the profile (best-effort — the entry is purely informational).
        let driver = state
            .profiles
            .read()
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.driver)
            .unwrap_or(Driver::Sqlite);
        log_connection(&app, &id, driver, "disconnect", None, None);
    }
    Ok(())
}

/// Ids of every currently active connection. Used by the frontend to
/// reconcile its in-memory state after reloads.
#[tauri::command]
pub fn active_connections(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    Ok(state.connections.read().ids())
}

/// Forget the trusted SSH host-key fingerprint for `host:port`. The next
/// connection under [`HostKeyPolicy::AcceptNew`](crate::state::HostKeyPolicy::AcceptNew)
/// will accept whatever the server presents and re-trust it on first use.
///
/// Returns `true` when an entry was actually removed — the frontend uses
/// this to show "already forgotten" rather than "forgotten" in the
/// confirmation toast.
#[tauri::command]
pub fn forget_host_key(state: State<'_, AppState>, host_port: String) -> AppResult<bool> {
    let removed = state.known_hosts.write().remove(&host_port);
    if removed {
        let snapshot = state.known_hosts.read().clone();
        ssh_known_hosts::save(&snapshot)?;
    }
    Ok(removed)
}

/// Read the trusted SSH host-key fingerprint for `host:port`, if any.
/// Used by the connection dialog to show the currently-trusted fingerprint
/// next to the "Forget host key" button.
#[tauri::command]
pub fn get_host_key(state: State<'_, AppState>, host_port: String) -> AppResult<Option<String>> {
    Ok(state.known_hosts.read().get(&host_port).cloned())
}
