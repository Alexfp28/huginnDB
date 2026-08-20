//! Connection-profile and lifecycle commands.

use crate::db::endpoint::{EndpointExhausted, EndpointGrant, EndpointKey};
use crate::db::pool::{
    close_pool, endpoint_budget, open_pool, smoke_test, top_level_request, PoolLimits,
    PoolOwnership, CLOSE_TIMEOUT, MIN_MAX_CONNECTIONS,
};
use crate::error::{AppError, AppResult};
use crate::keychain;
use crate::log_bus::{self, LogEntry, LogKind};
use crate::ssh_known_hosts;
use crate::state::{ActivePool, AppState, ConnectionProfile, Driver, StartupArgs};
use crate::store;
use crate::transfer::{
    self, ConflictAction, ConflictResolution, ExportFile, ExportMetadata, ImportAnalysis,
    ImportResult, KIND_PROFILES,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

/// Tauri events broadcast (unscoped — every window, not `emit_to` a single
/// one) so that a change made from *any* window's frontend is reflected in
/// every other window's `useConnections` store. Before this, each window's
/// `active`/`profiles` state was a private snapshot taken once at boot with
/// no way to learn about another window's `connect`/`disconnect`/profile
/// edit — see issue #18.
pub const CONNECTION_OPENED_EVENT: &str = "huginndb://connection-opened";
pub const CONNECTION_CLOSED_EVENT: &str = "huginndb://connection-closed";
pub const PROFILES_CHANGED_EVENT: &str = "huginndb://profiles-changed";

/// Payload for [`CONNECTION_OPENED_EVENT`] / [`CONNECTION_CLOSED_EVENT`].
#[derive(Debug, Clone, serde::Serialize)]
pub struct ConnectionSyncPayload {
    pub connection_id: String,
}

/// Emit a `connection` log entry. Used for `connect`, `disconnect`, and
/// `test_connection` so the Console panel can show the actual lifecycle
/// boundary that's currently invisible to the user.
/// `window_label` of `None` broadcasts to every window instead of targeting
/// one — correct for an action with no originating window, such as a connection
/// the MCP bridge opened on a sidecar's behalf. Every Console should see that,
/// the same way they all see the keepalive's connection-lost entries.
fn log_connection(
    app: &AppHandle,
    window_label: Option<&str>,
    connection_id: &str,
    driver: Driver,
    message: &str,
    start: Option<Instant>,
    error: Option<&str>,
) {
    let mut entry = LogEntry::new(LogKind::Connection)
        .connection_id(connection_id)
        .driver(driver.wire_name())
        .message(message);
    if let Some(s) = start {
        entry = entry.duration_ms(s.elapsed().as_millis() as u64);
    }
    if let Some(e) = error {
        entry = entry.error(e);
    }
    match window_label {
        Some(label) => log_bus::emit(app, label, entry),
        None => log_bus::broadcast(app, entry),
    }
}

/// The connection-pool preferences, read once under a single lock so a change
/// can't be observed half-applied.
///
/// Read at *connect* time rather than baked into constants: that is what makes
/// the global preference and the per-profile
/// [`ConnectionProfile::max_connections`] override take effect on the next
/// connection rather than the next release.
struct PoolPolicy {
    /// Total connections allowed against this profile's server.
    budget: u32,
    /// What a per-database view asks for.
    child_request: u32,
    keepalive: Duration,
}

fn pool_policy(state: &AppState, profile: &ConnectionProfile) -> PoolPolicy {
    let prefs = state.prefs.read();
    PoolPolicy {
        budget: endpoint_budget(profile, prefs.connections.max_connections),
        child_request: prefs.connections.child_max_connections,
        keepalive: Duration::from_secs(u64::from(prefs.connections.keepalive_secs)),
    }
}

/// Turn a refused reservation into an error that names the server and our own
/// share of it.
///
/// Distinct from [`annotate_connection_limit`], which decorates a refusal that
/// came back *from* the server: this one never reached the wire. Saying so
/// matters — the remedy is HuginnDB's own setting, not the DBA's.
fn exhausted_to_error(e: EndpointExhausted) -> AppError {
    AppError::TooManyConnections(format!(
        "HuginnDB's own budget for {} is spent ({}/{} connections in use). Raise it in \
         Settings → Connections or on this connection, or close a database view.",
        e.label, e.in_use, e.budget
    ))
}

/// Reserve capacity for a top-level pool against `profile`'s server.
///
/// `Ok(None)` means the profile has no server to ration (SQLite) — not that the
/// reservation failed.
fn reserve_top_level(
    state: &AppState,
    profile: &ConnectionProfile,
    policy: &PoolPolicy,
) -> AppResult<Option<EndpointGrant>> {
    let Some(key) = EndpointKey::for_profile(profile) else {
        return Ok(None);
    };
    state
        .endpoints
        .reserve(
            &key,
            top_level_request(policy.budget, policy.child_request),
            policy.budget,
            MIN_MAX_CONNECTIONS,
        )
        .map(Some)
        .map_err(exhausted_to_error)
}

/// Pool sizing implied by a grant. SQLite (`None`) is fixed at one connection
/// inside `open_pool` regardless of what is passed here.
fn limits_for(grant: &Option<EndpointGrant>) -> PoolLimits {
    match grant {
        Some(g) => PoolLimits::granted(g.amount()),
        None => PoolLimits::default(),
    }
}

/// Add HuginnDB's own pool footprint to a connection-limit refusal.
///
/// A bare "FATAL: sorry, too many connections already" tells the user their
/// server is full and nothing about what to do — least of all that the client
/// showing them the error is holding fourteen pools of its own. Quoting the
/// count turns it into something they can act on, and naming the other usual
/// occupants heads off the wrong conclusion, since HuginnDB is frequently the
/// marginal straw rather than the main consumer.
///
/// Any other error passes through untouched.
fn annotate_connection_limit(state: &AppState, error: AppError) -> AppError {
    if !error.is_too_many_connections() {
        return error;
    }
    let AppError::TooManyConnections(detail) = &error else {
        return error;
    };
    let (connections, views) = state.connections.read().counts();
    AppError::TooManyConnections(format!(
        "{detail} — HuginnDB is currently holding {connections} connection pool(s) and {views} \
         per-database pool(s). Other clients on this machine (IDE data sources, application \
         connection pools, huginndb-mcp sidecars) count against the same server limit."
    ))
}

/// Look up the password for `profile` from the OS keychain.
///
/// SQLite profiles never store a password (the database is a local file),
/// so we short-circuit with the empty string for them.
///
/// `pub(crate)` so `crate::mcp` can share this driver-aware resolution
/// instead of calling `keychain::require_password` directly — see the MCP
/// module's `ensure_connected` for why that divergence was a bug.
pub(crate) fn resolve_password(profile: &ConnectionProfile) -> AppResult<String> {
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
    app: AppHandle,
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
    let _ = app.emit(PROFILES_CHANGED_EVENT, ());
    Ok(profile)
}

/// Delete the profile with `id` and its associated keychain entries.
///
/// Also drops the persisted per-connection tab state (open tabs, schema-tree
/// expansion) so we don't keep dangling entries pointing at a profile that
/// no longer exists.
#[tauri::command]
pub fn delete_profile(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<()> {
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
        // Sweep every environment, not just the active one: the profile is gone
        // globally, so an entry surviving elsewhere would come back as a tab
        // pointing at a connection that no longer exists.
        for env in &mut guard.environments {
            env.connections.remove(&id);
            env.launch.active_connections.retain(|c| c != &id);
            if env.launch.selected_connection_id.as_deref() == Some(id.as_str()) {
                env.launch.selected_connection_id = None;
            }
            // Unlike the id lists above (where a stale entry is inert and left
            // alone on purpose), an override is a keyed payload: leaving it
            // behind would grow the blob with dead keys and, if the id were
            // ever reused, silently apply somebody else's subset.
            env.launch.database_visibility.remove(&id);
        }
        guard.clone()
    };
    crate::tab_state::save_tab_state(&tab_state_snapshot)?;

    // Same reasoning as `database_visibility` above, one step further: a
    // binding pinned to this profile can never match again, because a profile
    // id is a uuid that is never reused. The schema itself — the expensive
    // artefact the user wrote — is deliberately untouched; only the rule goes.
    let swept = {
        let mut lib = state.json_schemas.write();
        let n = crate::json_schemas::sweep_connection(&mut lib, &id);
        if n == 0 {
            None
        } else {
            Some((n, lib.clone()))
        }
    };
    if let Some((n, snapshot)) = swept {
        crate::json_schemas::save_library(&snapshot)?;
        eprintln!("[json_schemas] dropped {n} binding(s) pinned to deleted profile {id}");
        let _ = app.emit(
            crate::commands::json_schemas::JSON_SCHEMAS_CHANGED_EVENT,
            (),
        );
    }

    let _ = app.emit(PROFILES_CHANGED_EVENT, ());
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
    window: tauri::Window,
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> AppResult<String> {
    let window_label = Some(window.label());
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
    // Meter the probe too. It is one connection for a couple of seconds, but
    // "Test" is a button people press repeatedly while fixing a typo — against
    // the very server they are already struggling to get into. Floor of one:
    // nothing interactive runs on this pool, so it cannot deadlock the way an
    // undersized working pool would. The grant lives to the end of the command.
    let _probe_grant = match EndpointKey::for_profile(&profile) {
        Some(key) => {
            let budget = endpoint_budget(&profile, state.prefs.read().connections.max_connections);
            Some(
                state
                    .endpoints
                    .reserve(&key, 1, budget, 1)
                    .map_err(exhausted_to_error)?,
            )
        }
        None => None,
    };
    let start = Instant::now();
    log_connection(
        &app,
        window_label,
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
                window_label,
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
                window_label,
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
    window: tauri::Window,
    state: State<'_, AppState>,
    id: String,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> AppResult<()> {
    connect_inner(
        &app,
        state.inner(),
        Some(window.label()),
        &id,
        password,
        ssh_secret,
    )
    .await
}

/// The body of [`connect`], reusable from a context with no window.
///
/// Extracted for the MCP bridge (`crate::bridge::server`), which opens pools on
/// a sidecar's behalf: it has an `AppHandle` but no originating window, and it
/// must go through *exactly* this path rather than a parallel one — the
/// endpoint reservation, the keepalive, the session-secret cache and the
/// cross-window `connection-opened` event are all things a second
/// implementation would drift on.
pub(crate) async fn connect_inner(
    app: &AppHandle,
    state: &AppState,
    window_label: Option<&str>,
    id: &str,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> AppResult<()> {
    let id = id.to_string();
    let profile = state
        .profiles
        .read()
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("profile {id}")))?;

    // Idempotent: a second `connect` for an already-active id — e.g. a
    // secondary window connecting to the same profile the main window
    // already opened — must NOT fall through to `ActiveConnections::insert`,
    // whose replace semantics would tear down the live pool (and any SSH
    // tunnel) out from under the window that's using it. Reuse it instead.
    if state.connections.read().contains(&id) {
        log_connection(
            app,
            window_label,
            &id,
            profile.driver,
            "connect: already active, reusing existing pool",
            None,
            None,
        );
        return Ok(());
    }

    let pw = match password {
        Some(p) => p,
        None => resolve_password(&profile)?,
    };
    let ssh = match ssh_secret {
        Some(s) => Some(s),
        None => resolve_ssh_secret(&profile)?,
    };

    let known_hosts = state.known_hosts.clone();
    let policy = pool_policy(state, &profile);
    // Reserve the server's capacity *before* dialling. Failing here costs
    // nothing and reports a limit the user controls; failing at the server
    // costs a round trip and reports one they may not.
    let grant = reserve_top_level(state, &profile, &policy)?;
    let limits = limits_for(&grant);
    let start = Instant::now();
    log_connection(
        app,
        window_label,
        &id,
        profile.driver,
        &format!(
            "connect: opening {} pool to {}:{}/{} (max {} connections)",
            profile.driver.wire_name(),
            profile.host,
            profile.port,
            profile.database,
            limits.max_connections
        ),
        None,
        None,
    );
    // Clone the secrets before `open_pool` consumes `ssh`, so we can stash
    // them for child pools (open_database_view) on success.
    let ssh_for_cache = ssh.clone();
    let opened = open_pool(&profile, &pw, ssh, known_hosts, limits).await;
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
                        app,
                        window_label,
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
            let active = ActivePool::bare(pool.clone());
            let keepalive = crate::keepalive::spawn(
                app.clone(),
                id.clone(),
                pool,
                policy.keepalive,
                active.last_used.clone(),
            );
            state.connections.write().insert(
                id.clone(),
                ActivePool {
                    _ssh: ssh_handle,
                    _keepalive: keepalive,
                    _endpoint: grant,
                    ..active
                },
            );
            log_connection(
                app,
                window_label,
                &id,
                profile.driver,
                "connect: ok",
                Some(start),
                None,
            );
            let _ = app.emit(
                CONNECTION_OPENED_EVENT,
                ConnectionSyncPayload {
                    connection_id: id.clone(),
                },
            );
            Ok(())
        }
        Err(e) => {
            let e = annotate_connection_limit(state, e);
            let msg = e.to_string();
            log_connection(
                app,
                window_label,
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

/// Close the active pool for `id`, if any. Also closes every synthetic
/// per-database pool registered as `<id>::db::<db>` so multi-DB browsing
/// sessions don't leak when the parent connection is closed.
///
/// `async` since 1.13.0, and the pools are now closed with an awaited
/// [`close_pool`] rather than left to `Drop`. The old synchronous version could
/// only remove the entries from the map and hope; that is fine on a healthy
/// LAN but not through a pooler or an SSH tunnel, and specifically not in the
/// back-to-back teardown/setup bursts this app produces — a reconnect after a
/// lost connection, or an environment switch closing every pool before
/// restoring the next environment's. There, the outgoing sessions could still
/// be attached to the server when the incoming ones asked for slots, briefly
/// doubling the connection budget at the exact moment it was tightest.
///
/// The frontend needed no change: `invoke` already returned a promise.
#[tauri::command]
pub async fn disconnect(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    // Drop the session-cached secret for this profile (children reuse the
    // parent's entry, so a single remove covers them).
    state.session_secrets.write().remove(&id);
    let removed = state.connections.write().remove(&id);
    // Sweep synthetic children first, so the parent's tunnel (which they ride
    // on) is still up while they close.
    let children = crate::pool_reaper::close_children(state.inner(), &id).await;
    if let Some(active) = &removed {
        close_pool(&active.pool, PoolOwnership::Owned, CLOSE_TIMEOUT).await;
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
        log_connection(
            &app,
            Some(window.label()),
            &id,
            driver,
            "disconnect",
            None,
            None,
        );
        let _ = app.emit(
            CONNECTION_CLOSED_EVENT,
            ConnectionSyncPayload {
                connection_id: id.clone(),
            },
        );
    }
    Ok(())
}

/// Close and forget one synthetic per-database view, logging why.
///
/// Shared by the two reclaim paths in `open_database_view` — the per-connection
/// view cap and the per-server budget — so both release the pool *and* its
/// endpoint grant the same way. The grant rides on the `ActivePool` and
/// releases when this drops it, which is why neither caller has to think about
/// the budget bookkeeping.
async fn close_view(
    app: &AppHandle,
    state: &AppState,
    window_label: Option<&str>,
    driver: Driver,
    id: &str,
    reason: &str,
) {
    let removed = state.connections.write().remove(id);
    if let Some(active) = removed {
        close_pool(&active.pool, PoolOwnership::BorrowedView, CLOSE_TIMEOUT).await;
        log_connection(
            app,
            window_label,
            id,
            driver,
            &format!(
                "open_database_view: closed least-recently-used database pool ({reason} reached)"
            ),
            None,
            None,
        );
    }
}

// The synthetic-id vocabulary lives in `crate::state`, next to the connection
// map it addresses, so the layers *below* `commands` (`db::pool`,
// `pool_reaper`) can use it without depending upward. Re-exported here because
// these two paths are what the rest of `commands` already calls.
pub use crate::state::{database_view_id, parent_connection_id};

/// If `id` names a `<parent>::db::<database>` view the idle reaper
/// (`pool_reaper.rs`) has since closed, transparently reopen it with the same
/// cached credentials `open_database_view` used originally — exactly as if
/// the user had just re-expanded that database in the tree.
///
/// The reaper closing an idle child pool is deliberate policy (see
/// `pool_reaper.rs`'s module docs); the bug this fixes is that its effect used
/// to be invisible until the *next* click on that database failed with
/// `NotConnected`, even though the parent connection the tree shows as
/// "connected" genuinely still is. This makes the reopen part of that click
/// instead of a surprise on it.
///
/// A no-op for an already-open view or a top-level id — including one that
/// was never open in the first place, or a MongoDB/SQLite parent (both of
/// which take a fast, already-idempotent path inside
/// [`open_database_view_inner`]). Never errors: if the reopen fails (bad
/// credentials, server gone), the `pool_for` lookup that runs right after
/// this call is what reports `NotConnected`, unchanged — this only removes
/// the false negative the reaper introduced, it never masks a real one.
pub async fn ensure_database_view(
    app: &AppHandle,
    state: &AppState,
    window_label: Option<&str>,
    id: &str,
) {
    if state.connections.read().get(id).is_some() {
        return;
    }
    if let Some((parent_id, database)) = crate::state::split_database_view(id) {
        let _ = open_database_view_inner(app, state, window_label, parent_id, database).await;
    }
}

/// Resolve (or open) the synthetic per-database Mongo pool for `parent_id`
/// bound to `database` — the Mongo half of [`open_database_view`], pulled out
/// as a free function because it needs neither an `AppHandle`/`Window` nor
/// re-authentication: a single `mongodb::Client` reaches every database in
/// the cluster, so this only clones it and re-tags the target database.
/// Callable from a headless context (the MCP server), unlike the rest of
/// `open_database_view`, which logs to the Console panel and re-resolves
/// credentials for the SQL drivers.
pub async fn resolve_mongo_database_view(
    state: &AppState,
    parent_id: &str,
    database: &str,
) -> AppResult<String> {
    let child_id = database_view_id(parent_id, database);
    if state.connections.read().get(&child_id).is_some() {
        return Ok(child_id);
    }
    let parent_pool = state.connections.read().get(parent_id);
    let Some(crate::state::DbPool::Mongo(conn)) = parent_pool else {
        return Err(AppError::NotConnected(parent_id.to_string()));
    };
    let child_pool = crate::state::DbPool::Mongo(crate::state::MongoConn {
        client: conn.client.clone(),
        database: Some(database.to_string()),
    });
    state
        .connections
        .write()
        .insert(child_id.clone(), ActivePool::bare(child_pool));
    Ok(child_id)
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
    window: tauri::Window,
    state: State<'_, AppState>,
    parent_id: String,
    database: String,
) -> AppResult<String> {
    open_database_view_inner(
        &app,
        state.inner(),
        Some(window.label()),
        &parent_id,
        &database,
    )
    .await
}

/// The reusable body of [`open_database_view`] — no `AppHandle`/`Window`
/// dependency beyond what's threaded in explicitly, so [`ensure_database_view`]
/// and the MCP bridge (`bridge::server::dispatch`) can reopen a child pool the
/// idle reaper (`pool_reaper.rs`) has since closed, exactly as if the user had
/// just re-expanded that database.
async fn open_database_view_inner(
    app: &AppHandle,
    state: &AppState,
    window_label: Option<&str>,
    parent_id: &str,
    database: &str,
) -> AppResult<String> {
    let child_id = database_view_id(parent_id, database);
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
        return Ok(parent_id.to_string());
    }

    // MongoDB: a single client reaches every database in the cluster, so a
    // per-database "view" reuses the parent's client and only re-tags the
    // target database — no new connection, no re-auth, no second tunnel. The
    // child carries no SSH handle of its own; it depends on the parent's tunnel
    // staying alive, and `disconnect` sweeps children before the parent drops.
    // This needs no `AppHandle`/`Window` (unlike the SQL path below), so it's
    // pulled into a free function the headless MCP server can share — the MCP
    // has no equivalent of the desktop's "expand a database in the explorer"
    // gesture otherwise, leaving Mongo tools with no way to target a specific
    // database on a connection with none bound.
    if matches!(parent.driver, Driver::Mongo) {
        return resolve_mongo_database_view(state, parent_id, database).await;
    }

    // Clone the parent profile and substitute the database. The child uses
    // the same credentials and (if configured) SSH tunnel as the parent —
    // resolved from the keychain the same way `connect` does it.
    let mut child = parent.clone();
    child.database = database.to_string();

    // Prefer the session-cached secrets from the parent's `connect` (they may
    // have come from the CLI / dialog and never touched the keychain); only
    // fall back to the keychain when nothing was cached.
    let cached = state.session_secrets.read().get(parent_id).cloned();
    let pw = match cached.as_ref().and_then(|s| s.password.clone()) {
        Some(p) => p,
        None => resolve_password(&parent)?,
    };
    let ssh = match cached.as_ref().and_then(|s| s.ssh_secret.clone()) {
        Some(s) => Some(s),
        None => resolve_ssh_secret(&parent)?,
    };
    let known_hosts = state.known_hosts.clone();
    let policy = pool_policy(state, &parent);
    let max_child_pools = state.prefs.read().connections.max_child_pools;

    // Enforce the per-connection view cap *before* opening, not after: the
    // point is to never exceed the budget, and the case that trips servers is
    // precisely the burst — the schema explorer's cross-database search
    // fanning out across every database at once. Waiting for the reaper's
    // next sweep would let the whole fan-out land first.
    if max_child_pools > 0 {
        let over_cap: Vec<String> = {
            let conns = state.connections.read();
            let existing = conns.children_by_lru(parent_id);
            // `+ 1` accounts for the child we are about to add.
            let excess = (existing.len() + 1).saturating_sub(max_child_pools as usize);
            existing.into_iter().take(excess).collect()
        };
        for victim in over_cap {
            close_view(app, state, window_label, parent.driver, &victim, "cap").await;
        }
    }

    // Reserve this view's share of the *server's* budget, reclaiming from our
    // own idle views on that same server before giving up. This is what makes
    // browsing a twelve-database server work under a budget that can't hold
    // twelve views at once: the view the user hasn't looked at in a while pays
    // for the one they just clicked, instead of the click failing.
    //
    // Only views on the same endpoint are eligible — evicting one on an
    // unrelated server would free capacity nobody is waiting for.
    let grant = match EndpointKey::for_profile(&parent) {
        None => None,
        Some(key) => {
            let request = policy.child_request.max(MIN_MAX_CONNECTIONS);
            let mut reclaimable = state.connections.read().views_on_endpoint_by_lru(&key);
            // Never reclaim the view we are opening (it can't be live yet) nor,
            // more importantly, one that a caller is mid-query against — the
            // LRU ordering already puts those last, so taking from the front is
            // the least disruptive order available.
            reclaimable.retain(|id| id != &child_id);
            loop {
                match state
                    .endpoints
                    .reserve(&key, request, policy.budget, MIN_MAX_CONNECTIONS)
                {
                    Ok(g) => break Some(g),
                    Err(exhausted) => {
                        let Some(victim) = reclaimable.first().cloned() else {
                            return Err(exhausted_to_error(exhausted));
                        };
                        reclaimable.remove(0);
                        close_view(app, state, window_label, parent.driver, &victim, "budget")
                            .await;
                    }
                }
            }
        }
    };
    let limits = limits_for(&grant);

    let start = Instant::now();
    log_connection(
        app,
        window_label,
        &child_id,
        parent.driver,
        &format!(
            "open_database_view: {database} (max {} connections)",
            limits.max_connections
        ),
        None,
        None,
    );
    match open_pool(&child, &pw, ssh, known_hosts, limits).await {
        Ok((pool, ssh_handle)) => {
            state.connections.write().insert(
                child_id.clone(),
                ActivePool {
                    _ssh: ssh_handle,
                    _endpoint: grant,
                    ..ActivePool::bare(pool)
                },
            );
            log_connection(
                app,
                window_label,
                &child_id,
                parent.driver,
                "open_database_view: ok",
                Some(start),
                None,
            );
            Ok(child_id)
        }
        Err(e) => {
            let e = annotate_connection_limit(state, e);
            let msg = e.to_string();
            log_connection(
                app,
                window_label,
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

/// How many pools HuginnDB is holding right now, split by kind.
///
/// Exists because "too many connections" is only an actionable error if the
/// user can see their own contribution to it. Surfaced in Settings →
/// Connections and quoted in the error toast.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolStats {
    /// Pools for connections the user explicitly opened.
    pub connections: usize,
    /// Synthetic `<parent>::db::<name>` pools opened by browsing databases.
    pub database_views: usize,
    /// Per-server reservations. This is the row that actually answers "how
    /// many connections am I holding against *that* box" — the two counts
    /// above are per-pool and a server may back several of them.
    pub endpoints: Vec<EndpointUsage>,
    /// Loopback port the MCP bridge is listening on, or `None` when it is off.
    /// Shown in Settings so a user who gets a firewall prompt, or who is
    /// wondering why an MCP client can't attach, can see the actual state
    /// rather than infer it from a checkbox.
    pub mcp_bridge_port: Option<u16>,
}

/// One server's share of the connection footprint.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointUsage {
    /// `host:port`, plus the SSH tunnel when there is one.
    pub label: String,
    /// Connections reserved against it right now.
    pub in_use: u32,
}

/// Snapshot of the current pool footprint. See [`PoolStats`].
#[tauri::command]
pub fn connection_pool_stats(state: State<'_, AppState>) -> AppResult<PoolStats> {
    let (connections, database_views) = state.connections.read().counts();
    Ok(PoolStats {
        connections,
        database_views,
        endpoints: state
            .endpoints
            .usage()
            .into_iter()
            .map(|(label, in_use)| EndpointUsage { label, in_use })
            .collect(),
        mcp_bridge_port: state.mcp_bridge.lock().as_ref().map(|h| h.port),
    })
}

/// Close every synthetic per-database pool that isn't in use right now,
/// keeping the top-level connections the user opened.
///
/// The manual counterpart to [`crate::pool_reaper`]'s TTL sweep: the recovery
/// action offered when a server refuses a connection because it is full. Each
/// closed view reopens transparently the next time the user touches that
/// database, so this is safe to invoke at any time — the cost is one round
/// trip, not lost state.
///
/// Returns how many pools were closed.
#[tauri::command]
pub async fn release_idle_pools(app: AppHandle, state: State<'_, AppState>) -> AppResult<usize> {
    // `idle_children(0)` is every child, since `last_used` is only stamped on
    // resolution and a pool being *resolved* right now still returns a
    // non-negative age. A query already in flight holds a cloned `DbPool`, so
    // closing the pool here cannot cut it off mid-statement: `close` waits for
    // checked-out connections to be returned.
    let victims = state
        .connections
        .read()
        .idle_children(crate::state::now_millis(), 0);
    let removed: Vec<_> = {
        let mut conns = state.connections.write();
        victims
            .iter()
            .filter_map(|id| conns.remove(id).map(|active| (id.clone(), active)))
            .collect()
    };
    let count = removed.len();
    for (id, active) in removed {
        close_pool(&active.pool, PoolOwnership::BorrowedView, CLOSE_TIMEOUT).await;
        log_bus::broadcast(
            &app,
            LogEntry::new(LogKind::Connection)
                .connection_id(id)
                .message("released per-database pool on request"),
        );
    }
    Ok(count)
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
    if !export.meta.kind.is_empty() && export.meta.kind != KIND_PROFILES {
        return Err(AppError::Transfer(
            "this file is an environment export — use Import Environment instead".into(),
        ));
    }

    let profiles = state.profiles.read();
    let conflicts = transfer::detect_conflicts(&profiles, &export.profiles);

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

    let exported_profiles = transfer::build_exported_profiles(
        &profiles_snapshot,
        include_passwords,
        passphrase.as_deref(),
    )?;

    let now = chrono::Utc::now().to_rfc3339();
    let file = ExportFile {
        meta: ExportMetadata {
            version: 1,
            app: "huginndb".into(),
            exported_at: now.clone(),
            encrypted: include_passwords,
            kind: KIND_PROFILES.into(),
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
///
/// `async fn` on purpose, with the actual work run via `spawn_blocking`: a
/// synchronous Tauri command executes on the main thread (see the identical
/// reasoning on `import_environment` in `commands::prefs`), and
/// `apply_profile_imports` runs one 600 000-iteration PBKDF2 derivation per
/// encrypted secret (`transfer::decrypt_secret`) — deliberately slow, and with
/// enough profiles in one file, slow enough to freeze the window (issue: app
/// reported "not responding" importing a multi-environment bundle with dozens
/// of encrypted secrets).
#[tauri::command]
pub async fn import_profiles(
    app: AppHandle,
    state: State<'_, AppState>,
    file_path: String,
    passphrase: Option<String>,
    conflict_resolutions: Vec<ConflictResolution>,
) -> AppResult<ImportResult> {
    let profiles_lock = state.profiles.clone();
    let json_schemas_lock = state.json_schemas.clone();
    let app_for_task = app.clone();

    let (result, schema_changed) = tauri::async_runtime::spawn_blocking(move || -> AppResult<_> {
        let data = std::fs::read_to_string(&file_path)?;
        let export: ExportFile = serde_json::from_str(&data)?;

        if export.meta.version != 1 {
            return Err(AppError::Transfer(format!(
                "unsupported export format version {}",
                export.meta.version
            )));
        }
        if !export.meta.kind.is_empty() && export.meta.kind != KIND_PROFILES {
            return Err(AppError::Transfer(
                "this file is an environment export — use Import Environment instead".into(),
            ));
        }
        if export.meta.encrypted && passphrase.is_none() {
            return Err(AppError::Transfer(
                "this export file contains encrypted passwords — provide a passphrase".into(),
            ));
        }

        let resolution_map: std::collections::HashMap<String, ConflictAction> =
            conflict_resolutions
                .into_iter()
                .map(|r| (r.id, r.action))
                .collect();

        let (result, overwritten_ids) = {
            let mut profiles = profiles_lock.write();
            let (result, _id_map, overwritten_ids) = apply_profile_imports(
                &mut profiles,
                export.profiles,
                passphrase.as_deref(),
                &resolution_map,
                |done, total| {
                    let _ =
                        app_for_task.emit(IMPORT_PROGRESS_EVENT, ImportProgress { done, total });
                },
            )?;
            store::save_profiles(&profiles)?;
            (result, overwritten_ids)
        };

        // An overwritten profile gets a fresh uuid, so any JSON-Schema binding
        // pinned to the old one would quietly stop matching. See the third
        // return value of `apply_profile_imports`.
        let mut schema_changed = false;
        if !overwritten_ids.is_empty() {
            let mut lib = json_schemas_lock.write();
            let n = crate::json_schemas::remap_connection_ids(&mut lib, &overwritten_ids);
            if n > 0 {
                let snapshot = lib.clone();
                drop(lib);
                crate::json_schemas::save_library(&snapshot)?;
                schema_changed = true;
            }
        }

        Ok((result, schema_changed))
    })
    .await
    .map_err(|e| AppError::Transfer(format!("profile import task failed: {e}")))??;

    if schema_changed {
        let _ = app.emit(
            crate::commands::json_schemas::JSON_SCHEMAS_CHANGED_EVENT,
            (),
        );
    }
    let _ = app.emit(PROFILES_CHANGED_EVENT, ());
    Ok(result)
}

/// What [`apply_profile_imports`] hands back: the user-facing result, the
/// original-to-new id map for *every* imported profile, and the subset of that
/// map for the ones that were overwritten.
pub(crate) type ProfileImportOutcome = (
    ImportResult,
    std::collections::HashMap<String, String>,
    std::collections::HashMap<String, String>,
);

/// Emitted by `import_profiles` and `import_environment` while
/// `apply_profile_imports` works through the exported profile list. Each
/// encrypted secret costs one 600 000-iteration PBKDF2 derivation
/// (`transfer::decrypt_secret`) — deliberately slow — so a file bundling many
/// profiles (an environment export in particular, see CLAUDE.md gotcha #35)
/// can take long enough that a bare spinner isn't enough feedback. Snake_case
/// on the wire, matching `ImportResult` and every other DTO in this module
/// (no `rename_all`).
pub const IMPORT_PROGRESS_EVENT: &str = "huginndb://import-progress";

#[derive(Debug, Clone, serde::Serialize)]
pub struct ImportProgress {
    pub done: usize,
    pub total: usize,
}

/// Apply a set of exported profiles onto `profiles`, honoring
/// `resolution_map` for ids that already exist there. Shared by
/// [`import_profiles`] and `import_environment` (`commands::prefs`) — the
/// conflict/rename/keychain rules are identical either way, only *where* the
/// exported profiles came from (a standalone bundle vs. an environment
/// bundle's shared profile pool) differs.
///
/// Every imported profile receives a **fresh UUID** regardless of whether it
/// came with one in the file, to avoid keychain-account collisions with
/// profiles already on this machine. The second return value maps each
/// *original* profile id to the local id it should now resolve to —
/// `import_profiles` has no use for it, but `import_environment` needs it to
/// translate each environment bundle's `connection_ids` into the ids that
/// actually landed in `profiles.json`. A **skipped** profile maps to *itself*:
/// the conflict was matched by id, so the local profile already answers to it.
/// Every incoming profile therefore has an entry, and an id missing from this
/// map genuinely means "did not land".
///
/// The **third** return value is the subset of that map for profiles that were
/// *overwritten*. Because a fresh UUID is minted even when overwriting, anything
/// keyed on a profile id that lives outside `profiles.json` would silently stop
/// resolving after an overwrite — with no error, just a feature quietly gone.
/// JSON-Schema bindings are exactly that (`crate::json_schemas`), so both
/// callers feed this map to `json_schemas::remap_connection_ids`. It is
/// deliberately *only* the overwrite subset: on `Rename` the local profile keeps
/// its original id and its bindings must stay on it, and on `Skip` nothing was
/// replaced, so there is nothing to repoint (it appears in the *second* map, as
/// an identity entry, but never in this one).
pub(crate) fn apply_profile_imports(
    profiles: &mut Vec<ConnectionProfile>,
    exported: Vec<transfer::ExportedProfile>,
    passphrase: Option<&str>,
    resolution_map: &std::collections::HashMap<String, ConflictAction>,
    mut on_progress: impl FnMut(usize, usize),
) -> AppResult<ProfileImportOutcome> {
    let mut result = ImportResult {
        imported: vec![],
        skipped: vec![],
        renamed: vec![],
        needs_password: vec![],
    };
    let mut id_map = std::collections::HashMap::new();
    let mut overwritten_ids = std::collections::HashMap::new();

    let total = exported.len();
    for (processed, ep) in exported.into_iter().enumerate() {
        // Fired unconditionally at the top of the loop body (rather than once
        // per exit path) so it can't be missed by the early `continue` below
        // or by a future one — the item being *started* is a fine proxy for
        // "N of total processed" on a progress bar.
        on_progress(processed + 1, total);

        // Determine action for profiles that conflict with an existing id.
        // Conflicts are matched by id (`detect_conflicts`), so a conflict here
        // is never a coincidence — it is definitionally the same connection
        // already present. The fallback for one the caller left unresolved is
        // therefore `Skip`, not `Rename`: renaming would silently create a
        // second, independent copy of a profile that already exists, which is
        // almost never what "I didn't touch that row" was meant to request.
        let conflict_action = if profiles.iter().any(|p| p.id == ep.profile.id) {
            resolution_map
                .get(&ep.profile.id)
                .cloned()
                .unwrap_or(ConflictAction::Skip)
        } else {
            ConflictAction::Rename // effectively: just insert as new
        };

        if matches!(conflict_action, ConflictAction::Skip) {
            // Map the skipped id to *itself*. A conflict is matched by id, so
            // "skip" means "a profile with this exact id is already here" — the
            // incoming reference resolves perfectly well, it just resolves to
            // the local profile instead of a freshly minted one. Leaving the
            // entry out made `id_map` say "this connection did not land",
            // which is false, and both consumers acted on it:
            //
            //   * `import_environment` builds the new environment's
            //     `launch.visible_connections` by translating the bundle's
            //     `connection_ids` through this map, so a skipped connection
            //     was dropped from the filter — the environment came up hiding
            //     the very connections it was exported to describe.
            //   * JSON-Schema bindings are repointed through the same map, and
            //     an id absent from it is taken to name a connection unknown
            //     locally, so the binding is *disabled* (gotcha #39). It was
            //     disabling bindings for profiles that were sitting right
            //     there under the same id.
            //
            // `overwritten_ids` (the third return value) deliberately gets no
            // entry: nothing was overwritten, so there is nothing to repoint.
            result.skipped.push(ep.profile.id.clone());
            id_map.insert(ep.profile.id.clone(), ep.profile.id.clone());
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
        id_map.insert(ep.profile.id.clone(), new_id.clone());
        if matches!(conflict_action, ConflictAction::Overwrite) {
            overwritten_ids.insert(ep.profile.id.clone(), new_id.clone());
        }
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

        // Decrypt and store secrets if present. `Strict` because the user is
        // sitting in the import dialog: a wrong passphrase has to surface here
        // rather than yielding a pile of connections that cannot authenticate.
        let has_secrets = match &ep.secrets {
            Some(secrets) => crate::transfer::land_secrets(
                &new_profile,
                secrets,
                passphrase,
                crate::transfer::LandMode::Strict,
            )?,
            None => false,
        };

        if !has_secrets && !matches!(new_profile.driver, Driver::Sqlite) {
            result.needs_password.push(new_id.clone());
        }

        profiles.push(new_profile);
        result.imported.push(new_id);
    }

    Ok((result, id_map, overwritten_ids))
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
        // Mirror the main window's `dragDropEnabled: false` (tauri.conf.json).
        // The main window is declared statically with that flag; a window built
        // here would otherwise default to Tauri 2's OS-level drag-drop handler
        // being ENABLED, which swallows the HTML5 drag events dockview relies on
        // — so panels can't be rearranged and dragging shows the "not-allowed"
        // cursor. Disabling the native handler lets dockview's own DnD through,
        // matching the main window exactly.
        .disable_drag_drop_handler()
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

/// Pop a single workspace tab out into its own bare OS window (the "sacar
/// como ventana flotante" action) — a real, independently movable/resizable
/// native window rather than dockview's `addFloatingGroup`, which stays
/// confined to the inner workspace's own bounds. `tab` is the serialized
/// `AppTab` the frontend was displaying; it's carried opaquely (see
/// `AppState::detached_tab_intents`) and handed back verbatim to the new
/// window's frontend, which renders just that one panel — no sidebar, no
/// tab strip, no menus. The connection pool it needs is already open in the
/// shared backend `AppState`, so no reconnect happens here.
///
/// Like `open_new_window`, this window is ephemeral: closing it does not
/// hand anything back to the caller. The caller removes the tab from its own
/// `useTabs` immediately after this call returns, so "close the OS window"
/// and "close the tab" are simply the same moment from two different
/// windows' point of view — no cross-window signal is needed.
#[tauri::command]
pub async fn open_tab_window(
    app: AppHandle,
    tab: serde_json::Value,
    title: String,
) -> AppResult<String> {
    let label = format!("tabwin-{}", Uuid::new_v4());
    app.state::<AppState>()
        .detached_tab_intents
        .write()
        .insert(label.clone(), tab);
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(1000.0, 700.0)
        .min_inner_size(480.0, 320.0)
        // See `open_new_window` above for why this matters even for a window
        // with no dockview instance of its own — the data grid's own drag
        // interactions rely on the same native HTML5 DnD path.
        .disable_drag_drop_handler()
        .build()?;
    Ok(label)
}

/// Drain the tab payload stashed for `label` by [`open_tab_window`]. Called
/// once by the detached window's frontend on boot.
#[tauri::command]
pub fn take_detached_tab_intent(
    state: State<'_, AppState>,
    label: String,
) -> AppResult<Option<serde_json::Value>> {
    Ok(state.detached_tab_intents.write().remove(&label))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::MongoConn;

    async fn mongo_client() -> mongodb::Client {
        // `ClientOptions::parse` + `Client::with_options` only parse/validate
        // and spawn the driver's background monitor tasks — no reachable
        // server is required, so this is safe to construct in a unit test
        // (mirrors `db/mongo/mod.rs`'s real connection setup).
        let options = mongodb::options::ClientOptions::parse("mongodb://127.0.0.1:1")
            .await
            .expect("valid connection string");
        mongodb::Client::with_options(options).expect("client construction is lazy")
    }

    #[tokio::test]
    async fn resolve_mongo_database_view_creates_and_reuses_child_pool() {
        let state = AppState::new();
        let client = mongo_client().await;
        state.connections.write().insert(
            "parent".to_string(),
            ActivePool::bare(crate::state::DbPool::Mongo(MongoConn {
                client: client.clone(),
                database: None,
            })),
        );

        let child_id = resolve_mongo_database_view(&state, "parent", "mydb")
            .await
            .unwrap();
        assert_eq!(child_id, "parent::db::mydb");
        match state.connections.read().get(&child_id) {
            Some(crate::state::DbPool::Mongo(conn)) => {
                assert_eq!(conn.database.as_deref(), Some("mydb"));
            }
            _ => panic!("expected a Mongo child pool"),
        }

        // Idempotent: calling again for the same database returns the same
        // id without erroring (and without needing the parent pool again).
        state.connections.write().remove("parent");
        let again = resolve_mongo_database_view(&state, "parent", "mydb")
            .await
            .unwrap();
        assert_eq!(again, child_id);
    }

    #[tokio::test]
    async fn resolve_mongo_database_view_errors_without_a_parent_pool() {
        let state = AppState::new();
        let err = resolve_mongo_database_view(&state, "missing", "mydb")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotConnected(_)));
    }

    fn profile(id: &str, name: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: id.into(),
            name: name.into(),
            driver: crate::state::Driver::Postgres,
            host: "localhost".into(),
            port: 5432,
            database: String::new(),
            username: "u".into(),
            ssl: false,
            ssh_tunnel: None,
            connection_string: None,
            auth_source: None,
            mssql: None,
            ephemeral: false,
            group: None,
            visible_databases: None,
            mcp_write: Default::default(),
            max_connections: None,
            origin_id: None,
        }
    }

    fn exported(id: &str, name: &str) -> transfer::ExportedProfile {
        transfer::ExportedProfile {
            profile: profile(id, name),
            secrets: None,
        }
    }

    #[test]
    fn apply_profile_imports_maps_original_ids_to_fresh_ones() {
        // `import_environment` needs this map to translate a bundle's
        // `connection_ids` (the original, pre-import ids) into whatever
        // actually landed in `profiles.json` — every imported profile gets a
        // fresh UUID, never its original id (to avoid keychain collisions).
        let mut profiles = Vec::new();
        let (result, id_map, _overwritten) = apply_profile_imports(
            &mut profiles,
            vec![exported("orig-a", "A"), exported("orig-b", "B")],
            None,
            &std::collections::HashMap::new(),
            |_, _| {},
        )
        .unwrap();

        assert_eq!(result.imported.len(), 2);
        assert_eq!(id_map.len(), 2);
        let new_a = id_map.get("orig-a").expect("orig-a mapped");
        let new_b = id_map.get("orig-b").expect("orig-b mapped");
        assert_ne!(new_a, "orig-a", "must not reuse the original id");
        assert!(result.imported.contains(new_a));
        assert!(result.imported.contains(new_b));
        assert!(profiles.iter().any(|p| &p.id == new_a && p.name == "A"));
    }

    #[test]
    fn apply_profile_imports_maps_a_skipped_profile_to_itself() {
        let mut profiles = Vec::new();
        let mut resolutions = std::collections::HashMap::new();
        resolutions.insert("orig-a".to_string(), ConflictAction::Skip);
        // Pre-seed a profile with the same id so it registers as a conflict.
        profiles.push(profile("orig-a", "Existing"));

        let (result, id_map, overwritten) = apply_profile_imports(
            &mut profiles,
            vec![exported("orig-a", "A")],
            None,
            &resolutions,
            |_, _| {},
        )
        .unwrap();

        assert_eq!(result.skipped, vec!["orig-a".to_string()]);
        // The conflict was matched by id, so the local profile already answers
        // to it: the reference resolves, it just resolves to what is already
        // here. Callers translate ids through this map to decide what an
        // imported environment can see and where a JSON-Schema binding points,
        // and both read a missing entry as "this connection did not land".
        assert_eq!(
            id_map.get("orig-a").map(String::as_str),
            Some("orig-a"),
            "a skipped profile must map to the local profile it collided with"
        );
        // Nothing was replaced, so nothing needs repointing.
        assert!(overwritten.is_empty());
    }

    #[test]
    fn an_unresolved_conflict_defaults_to_skip_not_rename() {
        // A conflict is matched by id, so it is never a coincidence — it is
        // definitionally the same connection already present (the exact case
        // hit by exporting one's own profiles and reimporting them
        // unchanged). Leaving it unresolved must not silently duplicate it
        // under a fresh id with a " (imported)" suffix.
        let mut profiles = vec![profile("orig-a", "A")];

        let (result, id_map, overwritten) = apply_profile_imports(
            &mut profiles,
            vec![exported("orig-a", "A")],
            None,
            &std::collections::HashMap::new(),
            |_, _| {},
        )
        .unwrap();

        assert_eq!(result.skipped, vec!["orig-a".to_string()]);
        assert!(result.imported.is_empty());
        assert!(result.renamed.is_empty());
        assert_eq!(id_map.get("orig-a").map(String::as_str), Some("orig-a"));
        assert_eq!(profiles.len(), 1, "no duplicate profile must be created");
        // Nothing was overwritten, so no JSON-Schema binding should be
        // repointed either (see the third return value).
        assert!(overwritten.is_empty());
    }
}
