//! Connection-profile and lifecycle commands.

use crate::db::pool::{open_pool, smoke_test};
use crate::error::{AppError, AppResult};
use crate::keychain;
use crate::log_bus::{self, LogEntry, LogKind};
use crate::ssh_known_hosts;
use crate::state::{ActivePool, AppState, ConnectionProfile, Driver, StartupArgs};
use crate::store;
use crate::transfer::{
    ConflictAction, ConflictResolution, ExportFile, ExportMetadata, ExportedProfile,
    ExportedSecret, ImportAnalysis, ImportConflict, ImportResult,
};
use std::time::Instant;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

/// Driver label used by the Console panel.
fn driver_str(driver: Driver) -> &'static str {
    match driver {
        Driver::Postgres => "postgres",
        Driver::Mysql => "mysql",
        Driver::Sqlite => "sqlite",
        Driver::Mongo => "mongodb",
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
    // MongoDB's password is optional: it may be embedded in the connection URI
    // (or the server may allow unauthenticated local access), so a missing
    // keychain entry is not an error — fall back to an empty string.
    if matches!(profile.driver, Driver::Mongo) {
        return Ok(keychain::get_password(&profile.keyring_account())?.unwrap_or_default());
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
/// Also drops the persisted per-connection tab state (open tabs, schema-tree
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

    // Persist a freshly-typed SSH secret to the OS keychain *before* the
    // smoke-test. This is what triggers the OS credential prompt
    // (Windows Credential Manager, libsecret, macOS Keychain) the first
    // time the user wires up a tunnel — matching the UX they already get
    // for the DB password on a regular connection. We guard on a
    // non-empty `profile.id` so the namespaced account
    // (`<id>::ssh::<user>`) cannot collide between draft profiles that
    // haven't been saved yet; the frontend assigns a stable UUID before
    // calling Test so this branch is reached on new profiles too.
    if let (Some(account), Some(secret)) = (profile.ssh_keyring_account(), ssh.as_ref()) {
        if !profile.id.is_empty() {
            keychain::set_password(&account, secret)?;
        }
    }

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
    // Clone the secrets before `open_pool` consumes `ssh`, so we can stash
    // them for child pools (open_database_view) on success.
    let ssh_for_cache = ssh.clone();
    let opened = open_pool(&profile, &pw, ssh, known_hosts).await;
    match opened {
        Ok((pool, ssh_handle)) => {
            // Cache the secrets used for this profile, session-only, so a
            // child pool opened for a specific database doesn't re-resolve
            // from the keychain — which fails for a password supplied via the
            // CLI / connect dialog and never persisted there.
            state.session_secrets.write().insert(
                id.clone(),
                crate::state::SessionSecret {
                    password: Some(pw.clone()),
                    ssh_secret: ssh_for_cache,
                },
            );
            // Surface the SSH tunnel's local-port fallback (see
            // `db::ssh::open_tunnel`): if the user pinned a port that was
            // unavailable, the tunnel transparently bound an OS-assigned one.
            // Log it so the reassignment isn't invisible inside the GUI.
            if let (Some(handle), Some(tunnel)) = (&ssh_handle, &profile.ssh_tunnel) {
                if tunnel.local_port != 0 && handle.local_port != tunnel.local_port {
                    log_connection(
                        &app,
                        &id,
                        profile.driver,
                        &format!(
                            "connect: local port {} was unavailable; tunnel bound {} instead",
                            tunnel.local_port, handle.local_port
                        ),
                        None,
                        None,
                    );
                }
            }
            let keepalive = crate::keepalive::spawn(app.clone(), id.clone(), pool.clone());
            state.connections.write().insert(
                id.clone(),
                ActivePool {
                    pool,
                    _ssh: ssh_handle,
                    _keepalive: Some(keepalive),
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

/// Drop the active pool for `id`, if any. Also drops every synthetic
/// per-database pool registered as `<id>::db::<db>` so multi-DB browsing
/// sessions don't leak when the parent connection is closed.
#[tauri::command]
pub fn disconnect(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<()> {
    // Drop the session-cached secret for this profile (children reuse the
    // parent's entry, so a single remove covers them).
    state.session_secrets.write().remove(&id);
    let removed = state.connections.write().remove(&id);
    // Sweep synthetic children. We collect ids first to avoid holding the
    // write lock while iterating (remove() takes &mut self).
    let prefix = format!("{id}::db::");
    let children: Vec<String> = state
        .connections
        .read()
        .ids()
        .into_iter()
        .filter(|cid| cid.starts_with(&prefix))
        .collect();
    {
        let mut conns = state.connections.write();
        for cid in &children {
            conns.remove(cid);
        }
    }
    if removed.is_some() || !children.is_empty() {
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

/// Synthetic connection id for a per-database browse session under
/// `parent_id`. Format is stable so callers can derive the id without a
/// round-trip when they only need to address an already-open child.
pub fn database_view_id(parent_id: &str, database: &str) -> String {
    format!("{parent_id}::db::{database}")
}

/// Open a secondary pool for `parent_id` bound to `database`, and register
/// it under `<parent_id>::db::<database>` so the existing commands can
/// address it like a regular connection.
///
/// Returns the synthetic id, or — if a child pool for that database is
/// already open — the existing id (idempotent).
///
/// Used by the schema explorer when the parent profile has an empty
/// `database` field: the parent pool connects to a maintenance catalog
/// (`postgres` on PG, no default DB on MySQL), and each database the user
/// expands in the tree spawns one of these children. This way every
/// downstream command (`list_tables`, `fetch_table_data`, `update_cell`,
/// …) keeps its existing single `connection_id` argument and doesn't need
/// to learn a `database` parameter.
#[tauri::command]
pub async fn open_database_view(
    app: AppHandle,
    state: State<'_, AppState>,
    parent_id: String,
    database: String,
) -> AppResult<String> {
    let child_id = database_view_id(&parent_id, &database);
    if state.connections.read().get(&child_id).is_some() {
        return Ok(child_id);
    }

    let parent = state
        .profiles
        .read()
        .iter()
        .find(|p| p.id == parent_id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("profile {parent_id}")))?;

    if matches!(parent.driver, Driver::Sqlite) {
        // SQLite has a single file = single database; per-DB browsing is
        // not meaningful. Treat this as a no-op alias.
        return Ok(parent_id);
    }

    // MongoDB: a single client reaches every database in the cluster, so a
    // per-database "view" reuses the parent's client and only re-tags the
    // target database — no new connection, no re-auth, no second tunnel. The
    // child carries no SSH handle of its own; it depends on the parent's tunnel
    // staying alive, and `disconnect` sweeps children before the parent drops.
    if matches!(parent.driver, Driver::Mongo) {
        let parent_pool = state.connections.read().get(&parent_id);
        if let Some(crate::state::DbPool::Mongo(conn)) = parent_pool {
            let child_pool = crate::state::DbPool::Mongo(crate::state::MongoConn {
                client: conn.client.clone(),
                database: Some(database.clone()),
            });
            state.connections.write().insert(
                child_id.clone(),
                ActivePool {
                    pool: child_pool,
                    _ssh: None,
                    _keepalive: None,
                },
            );
            return Ok(child_id);
        }
        return Err(AppError::NotConnected(parent_id));
    }

    // Clone the parent profile and substitute the database. The child uses
    // the same credentials and (if configured) SSH tunnel as the parent —
    // resolved from the keychain the same way `connect` does it.
    let mut child = parent.clone();
    child.database = database.clone();

    // Prefer the session-cached secrets from the parent's `connect` (they may
    // have come from the CLI / dialog and never touched the keychain); only
    // fall back to the keychain when nothing was cached.
    let cached = state.session_secrets.read().get(&parent_id).cloned();
    let pw = match cached.as_ref().and_then(|s| s.password.clone()) {
        Some(p) => p,
        None => resolve_password(&parent)?,
    };
    let ssh = match cached.as_ref().and_then(|s| s.ssh_secret.clone()) {
        Some(s) => Some(s),
        None => resolve_ssh_secret(&parent)?,
    };
    let known_hosts = state.known_hosts.clone();
    let start = Instant::now();
    log_connection(
        &app,
        &child_id,
        parent.driver,
        &format!("open_database_view: {database}"),
        None,
        None,
    );
    match open_pool(&child, &pw, ssh, known_hosts).await {
        Ok((pool, ssh_handle)) => {
            state.connections.write().insert(
                child_id.clone(),
                ActivePool {
                    pool,
                    _ssh: ssh_handle,
                    _keepalive: None,
                },
            );
            log_connection(
                &app,
                &child_id,
                parent.driver,
                "open_database_view: ok",
                Some(start),
                None,
            );
            Ok(child_id)
        }
        Err(e) => {
            let msg = e.to_string();
            log_connection(
                &app,
                &child_id,
                parent.driver,
                "open_database_view: failed",
                Some(start),
                Some(&msg),
            );
            Err(e)
        }
    }
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

// ---------------------------------------------------------------------------
// Import / Export
// ---------------------------------------------------------------------------

/// Read and parse an export file without decrypting secrets.
///
/// Returns metadata the frontend needs to present the conflict-resolution
/// step before committing to the import: whether it is encrypted, how many
/// profiles it contains, and which of those conflict with existing ones.
#[tauri::command]
pub fn analyze_import_file(
    state: State<'_, AppState>,
    file_path: String,
) -> AppResult<ImportAnalysis> {
    let data = std::fs::read_to_string(&file_path)?;
    let export: ExportFile = serde_json::from_str(&data)?;

    if export.meta.version != 1 {
        return Err(AppError::Transfer(format!(
            "unsupported export format version {}",
            export.meta.version
        )));
    }

    let profiles = state.profiles.read();
    let conflicts = export
        .profiles
        .iter()
        .filter_map(|ep| {
            profiles
                .iter()
                .find(|p| p.id == ep.profile.id)
                .map(|existing| ImportConflict {
                    id: ep.profile.id.clone(),
                    existing_name: existing.name.clone(),
                    incoming_name: ep.profile.name.clone(),
                })
        })
        .collect();

    Ok(ImportAnalysis {
        total: export.profiles.len(),
        encrypted: export.meta.encrypted,
        conflicts,
    })
}

/// Export the selected profiles to a JSON file chosen by the user.
///
/// When `include_passwords` is `true`, each profile's DB password and SSH
/// secret are read from the OS keychain and encrypted with AES-256-GCM using
/// the supplied `passphrase` before being written to the file. The file
/// dialog opens for the user to pick the destination.
#[tauri::command]
pub async fn export_profiles(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_ids: Option<Vec<String>>,
    include_passwords: bool,
    passphrase: Option<String>,
) -> AppResult<String> {
    if include_passwords && passphrase.is_none() {
        return Err(AppError::InvalidInput(
            "a passphrase is required when include_passwords is true".into(),
        ));
    }

    let profiles_snapshot: Vec<ConnectionProfile> = {
        let guard = state.profiles.read();
        match &profile_ids {
            Some(ids) => guard
                .iter()
                .filter(|p| ids.contains(&p.id))
                .cloned()
                .collect(),
            None => guard.clone(),
        }
    };

    let mut exported_profiles = Vec::with_capacity(profiles_snapshot.len());
    for profile in &profiles_snapshot {
        let secrets = if include_passwords {
            let pp = passphrase.as_deref().unwrap();
            let db_password = if matches!(profile.driver, Driver::Sqlite) {
                None
            } else {
                keychain::get_password(&profile.keyring_account())?
                    .map(|pw| crate::transfer::encrypt_secret(&pw, pp))
                    .transpose()?
            };
            let ssh_secret = profile
                .ssh_keyring_account()
                .and_then(|acct| keychain::get_password(&acct).ok().flatten())
                .map(|s| crate::transfer::encrypt_secret(&s, pp))
                .transpose()?;
            Some(ExportedSecret {
                db_password,
                ssh_secret,
            })
        } else {
            None
        };
        exported_profiles.push(ExportedProfile {
            profile: profile.clone(),
            secrets,
        });
    }

    let now = chrono::Utc::now().to_rfc3339();
    let file = ExportFile {
        meta: ExportMetadata {
            version: 1,
            app: "huginndb".into(),
            exported_at: now.clone(),
            encrypted: include_passwords,
        },
        profiles: exported_profiles,
    };

    let json = serde_json::to_string_pretty(&file)?;

    // Build a suggested filename like `huginndb-profiles-2025-06-02.json`.
    let date_part = now.get(..10).unwrap_or("export");
    let suggested = format!("huginndb-profiles-{date_part}.json");

    use tauri_plugin_dialog::DialogExt;
    let path = app
        .dialog()
        .file()
        .set_title("Export profiles")
        .set_file_name(&suggested)
        .add_filter("JSON", &["json"])
        .blocking_save_file()
        .ok_or_else(|| AppError::Transfer("export cancelled".into()))?;

    let dest = path.to_string();
    std::fs::write(&dest, json)?;
    Ok(dest)
}

/// Import profiles from a previously exported JSON file.
///
/// Callers should first call [`analyze_import_file`] to detect conflicts and,
/// if the file is encrypted, collect the passphrase. Then pass
/// `conflict_resolutions` to express how each conflicting profile should be
/// handled.
///
/// Every imported profile receives a **fresh UUID** regardless of whether it
/// came with one in the file. This prevents keychain-account collisions with
/// profiles that were already on this machine.
#[tauri::command]
pub fn import_profiles(
    state: State<'_, AppState>,
    file_path: String,
    passphrase: Option<String>,
    conflict_resolutions: Vec<ConflictResolution>,
) -> AppResult<ImportResult> {
    let data = std::fs::read_to_string(&file_path)?;
    let export: ExportFile = serde_json::from_str(&data)?;

    if export.meta.version != 1 {
        return Err(AppError::Transfer(format!(
            "unsupported export format version {}",
            export.meta.version
        )));
    }
    if export.meta.encrypted && passphrase.is_none() {
        return Err(AppError::Transfer(
            "this export file contains encrypted passwords — provide a passphrase".into(),
        ));
    }

    let resolution_map: std::collections::HashMap<String, ConflictAction> = conflict_resolutions
        .into_iter()
        .map(|r| (r.id, r.action))
        .collect();

    let mut result = ImportResult {
        imported: vec![],
        skipped: vec![],
        renamed: vec![],
        needs_password: vec![],
    };

    let mut profiles = state.profiles.write();

    for ep in export.profiles {
        // Determine action for profiles that conflict with an existing id.
        let conflict_action = if profiles.iter().any(|p| p.id == ep.profile.id) {
            resolution_map
                .get(&ep.profile.id)
                .cloned()
                .unwrap_or(ConflictAction::Rename)
        } else {
            ConflictAction::Rename // effectively: just insert as new
        };

        if matches!(conflict_action, ConflictAction::Skip) {
            result.skipped.push(ep.profile.id.clone());
            continue;
        }

        // If overwriting, drop the existing profile's keychain entries and
        // remove it from the list.
        if matches!(conflict_action, ConflictAction::Overwrite) {
            if let Some(pos) = profiles.iter().position(|p| p.id == ep.profile.id) {
                let old = profiles.remove(pos);
                if !matches!(old.driver, Driver::Sqlite) {
                    let _ = keychain::delete_password(&old.keyring_account());
                }
                if let Some(ssh_acct) = old.ssh_keyring_account() {
                    let _ = keychain::delete_password(&ssh_acct);
                }
            }
        }

        // Always assign a fresh UUID to avoid keychain collisions.
        let new_id = Uuid::new_v4().to_string();
        let original_name = ep.profile.name.clone();

        // Ensure the display name is unique; append " (imported)" or " (2)" etc.
        let final_name = {
            let base = ep.profile.name.clone();
            let mut candidate = base.clone();
            let mut suffix = 2u32;
            while profiles.iter().any(|p| p.name == candidate) {
                candidate = if suffix == 2 {
                    format!("{base} (imported)")
                } else {
                    format!("{base} ({suffix})")
                };
                suffix += 1;
            }
            candidate
        };

        let renamed = final_name != original_name;
        if renamed {
            result
                .renamed
                .push((original_name.clone(), final_name.clone()));
        }

        let mut new_profile = ep.profile.clone();
        new_profile.id = new_id.clone();
        new_profile.name = final_name;

        // Decrypt and store secrets if present.
        let has_secrets = if let Some(secrets) = &ep.secrets {
            let pp = passphrase.as_deref().unwrap_or("");
            let mut any = false;
            if let Some(enc_pw) = &secrets.db_password {
                if !matches!(new_profile.driver, Driver::Sqlite) {
                    let pw = crate::transfer::decrypt_secret(enc_pw, pp)?;
                    keychain::set_password(&new_profile.keyring_account(), &pw)?;
                    any = true;
                }
            }
            if let Some(enc_ssh) = &secrets.ssh_secret {
                if let Some(ssh_acct) = new_profile.ssh_keyring_account() {
                    let secret = crate::transfer::decrypt_secret(enc_ssh, pp)?;
                    keychain::set_password(&ssh_acct, &secret)?;
                    any = true;
                }
            }
            any
        } else {
            false
        };

        if !has_secrets && !matches!(new_profile.driver, Driver::Sqlite) {
            result.needs_password.push(new_id.clone());
        }

        profiles.push(new_profile);
        result.imported.push(new_id);
    }

    store::save_profiles(&profiles)?;
    Ok(result)
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

/// Return the command-line arguments that were parsed before the app started.
///
/// Called once by the frontend on boot (after profiles are loaded) to
/// auto-connect when the user launched HuginnDB with `--connect-profile` or
/// ad-hoc `--host` / `--port` / … flags.
#[tauri::command]
pub fn get_startup_args(state: State<'_, AppState>) -> AppResult<StartupArgs> {
    Ok(state.startup_args.clone())
}

/// Drain any connection intent forwarded by a *second* launch.
///
/// The single-instance handler in `lib.rs` buffers the second launch's parsed
/// args here and emits `huginndb://cli-connect`. The frontend calls this once
/// when its event bridge mounts, to recover an intent that may have been
/// emitted before the listener existed (boot race). Returns `None` when there
/// is nothing pending and clears the buffer so it is consumed exactly once.
#[tauri::command]
pub fn take_pending_cli_connect(state: State<'_, AppState>) -> AppResult<Option<StartupArgs>> {
    Ok(state.pending_cli_connect.write().take())
}

// ---------------------------------------------------------------------------
// Multi-window
// ---------------------------------------------------------------------------

/// Open a new, blank HuginnDB window ("New window"). Optionally carries a
/// connection `intent` (e.g. from the CLI second-launch dialog choosing
/// "new window") for the new window's frontend to pick up on boot via
/// [`take_window_startup_intent`].
///
/// Secondary windows are intentionally ephemeral: they never touch
/// `tab_state.json` (see `commands::prefs::get_tab_state`), so nothing about
/// them survives an app restart.
///
/// `WebviewWindowBuilder::new(...).build()` deadlocks on Windows (a WebView2
/// issue) when called from a *synchronous* command or event handler — the
/// new window comes up blank/unresponsive and can't even be closed via its
/// own "×" button. Tauri's own docs call this out and say to use an `async`
/// command instead (an earlier attempt here routed the build through
/// `run_on_main_thread`, which avoided the outright hang but still left the
/// window blank — `async fn` is the actual fix). See
/// <https://github.com/tauri-apps/tauri/issues/13963>.
#[tauri::command]
pub async fn open_new_window(app: AppHandle, intent: Option<StartupArgs>) -> AppResult<String> {
    let label = format!("win-{}", Uuid::new_v4());
    if let Some(args) = intent {
        app.state::<AppState>()
            .window_startup_intents
            .write()
            .insert(label.clone(), args);
    }
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("index.html".into()))
        .title("HuginnDB")
        .inner_size(1400.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .build()?;
    Ok(label)
}

/// Drain the connection intent stashed for `label` by [`open_new_window`].
/// Called once by a secondary window's frontend on boot, alongside the
/// existing `get_startup_args` cold-start call.
#[tauri::command]
pub fn take_window_startup_intent(
    state: State<'_, AppState>,
    label: String,
) -> AppResult<Option<StartupArgs>> {
    Ok(state.window_startup_intents.write().remove(&label))
}
