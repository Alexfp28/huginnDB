//! Application-wide runtime state.
//!
//! Stores two pieces of cross-command state behind interior-mutable locks:
//!
//! * `profiles` — the user's saved connection profiles. Loaded from disk
//!   at startup, written back whenever the user adds, edits, or removes
//!   one.
//! * `connections` — the pools that are currently open. Lives only in
//!   memory; reconnecting after a restart is an explicit user action.
//!
//! Passwords are **not** part of this state. They are read on-demand from
//! the OS keychain via [`crate::keychain`].

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use sqlx::{MySqlPool, PgPool, SqlitePool};
use std::collections::HashMap;
use std::sync::Arc;

/// Database backend selected for a [`ConnectionProfile`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Driver {
    Postgres,
    Mysql,
    Sqlite,
}

/// User-defined connection profile stored on disk.
///
/// Only contains non-sensitive metadata; the matching password is kept in
/// the OS keychain under the account returned by [`Self::keyring_account`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionProfile {
    /// Stable identifier. Generated server-side on first save.
    pub id: String,
    /// User-facing display name.
    pub name: String,
    /// Backend driver.
    pub driver: Driver,
    /// Host or, for SQLite, the empty string.
    pub host: String,
    /// TCP port for server-backed drivers. Ignored for SQLite.
    pub port: u16,
    /// Database / catalog name. For SQLite this is the filesystem path.
    pub database: String,
    /// Username used at connect-time.
    pub username: String,
    /// Whether the driver should negotiate TLS.
    #[serde(default)]
    pub ssl: bool,
    /// Optional SSH tunnel configuration. Not yet wired up; reserved for
    /// the next alpha release.
    #[serde(default)]
    pub ssh_tunnel: Option<SshTunnel>,
}

/// How the client decides whether to trust the SSH server's host key.
///
/// `AcceptNew` mirrors `ssh -o StrictHostKeyChecking=accept-new`: trust on
/// first use, then strict afterwards. `Strict` requires a pre-existing
/// fingerprint in `known_hosts.json`. `AcceptAny` skips verification.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum HostKeyPolicy {
    Strict,
    AcceptNew,
    AcceptAny,
}

impl Default for HostKeyPolicy {
    fn default() -> Self {
        Self::AcceptNew
    }
}

/// Authentication method used to log into the SSH server.
///
/// The matching secret (password or private-key passphrase) is **not**
/// stored here — it lives in the OS keychain under the account returned by
/// [`ConnectionProfile::ssh_keyring_account`]. Storing only metadata keeps
/// the on-disk profile free of plaintext credentials.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SshAuth {
    /// Authenticate with a password. Secret is the SSH password.
    Password,
    /// Authenticate with a private-key file. Secret is the (optional)
    /// passphrase for the key; an empty string means no passphrase.
    Key { path: String },
}

/// SSH tunnel configuration attached to a [`ConnectionProfile`].
///
/// When present, [`crate::db::pool::open_pool`] opens a local TCP listener
/// that proxies into the remote `(profile.host, profile.port)` over an
/// SSH `direct-tcpip` channel before pointing `sqlx` at `127.0.0.1`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshTunnel {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    /// Local port to bind for the tunnel listener. `0` asks the OS to pick
    /// a free ephemeral port; the actual port is returned on the
    /// [`crate::db::ssh::SshTunnelHandle`].
    #[serde(default)]
    pub local_port: u16,
    /// Host-key trust policy. Older profiles without this field default to
    /// [`HostKeyPolicy::AcceptNew`] for ergonomic backwards compatibility.
    #[serde(default)]
    pub host_key_policy: HostKeyPolicy,
}

impl ConnectionProfile {
    /// Key under which the password is stored in the OS keychain.
    ///
    /// We include the profile id so multiple profiles for the same user
    /// don't collide on shared hosts.
    pub fn keyring_account(&self) -> String {
        format!("{}::{}", self.id, self.username)
    }

    /// Key under which the SSH secret (password or key passphrase) is
    /// stored in the OS keychain, namespaced so it cannot collide with the
    /// database password account.
    pub fn ssh_keyring_account(&self) -> Option<String> {
        self.ssh_tunnel
            .as_ref()
            .map(|t| format!("{}::ssh::{}", self.id, t.username))
    }
}

/// Live, driver-typed pool for an active connection.
///
/// `Clone` here is cheap because the inner `sqlx` pools share their state
/// behind an `Arc`.
#[derive(Clone)]
pub enum DbPool {
    Postgres(PgPool),
    Mysql(MySqlPool),
    Sqlite(SqlitePool),
}

/// A live database pool plus, optionally, the SSH tunnel that fronts it.
///
/// Kept together so the tunnel is dropped (and its local listener freed)
/// exactly when the pool itself is removed from [`ActiveConnections`]. The
/// `_ssh` handle is owned uniquely by this struct; the pool may still be
/// cloned out for query workers via [`ActiveConnections::get`].
pub struct ActivePool {
    pub pool: DbPool,
    pub _ssh: Option<crate::db::ssh::SshTunnelHandle>,
}

/// Map of profile-id → live pool.
#[derive(Default)]
pub struct ActiveConnections {
    inner: HashMap<String, ActivePool>,
}

impl ActiveConnections {
    /// Insert or replace a pool for `id`. Any previous pool is dropped,
    /// which tears down its SSH tunnel (if any) before this one starts.
    pub fn insert(&mut self, id: String, pool: ActivePool) {
        self.inner.insert(id, pool);
    }

    /// Remove the pool for `id`, if any. The pool and any associated SSH
    /// tunnel will be dropped (and gracefully closed) when the last clone
    /// goes out of scope.
    pub fn remove(&mut self, id: &str) -> Option<ActivePool> {
        self.inner.remove(id)
    }

    /// Cheap, cloning lookup. Pools are themselves cheap to clone; the
    /// tunnel handle stays owned by the [`ActivePool`] so query workers
    /// don't need to know it exists.
    pub fn get(&self, id: &str) -> Option<DbPool> {
        self.inner.get(id).map(|a| a.pool.clone())
    }

    /// Ids of every currently active connection.
    pub fn ids(&self) -> Vec<String> {
        self.inner.keys().cloned().collect()
    }
}

/// Arguments parsed from the command line at startup.
///
/// Passed to [`AppState::new_with_args`] and stored so the frontend can
/// retrieve them via the `get_startup_args` command after hydration. Fields
/// are all `Option` / `bool` so the struct is self-describing and the
/// frontend knows which flags were actually supplied.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct StartupArgs {
    /// Name or UUID of an existing saved profile to connect to automatically.
    pub connect_profile: Option<String>,
    /// When `true`, `connect_profile` is a UUID rather than a display name.
    pub connect_by_id: bool,
    // Ad-hoc connection parameters (no saved profile required).
    // The password is intentionally absent — it will be requested via the
    // normal `ConnectPasswordDialog` flow once the app is open.
    pub adhoc_host: Option<String>,
    pub adhoc_port: Option<u16>,
    pub adhoc_database: Option<String>,
    pub adhoc_username: Option<String>,
    /// One of "postgres", "mysql", "sqlite".
    pub adhoc_driver: Option<String>,
    /// Display name for the ad-hoc connection.
    pub adhoc_name: Option<String>,
}

/// Top-level state managed by Tauri.
pub struct AppState {
    /// Pools that have been connected this session.
    pub connections: Arc<RwLock<ActiveConnections>>,
    /// Persisted profiles loaded from disk.
    pub profiles: Arc<RwLock<Vec<ConnectionProfile>>>,
    /// User-tunable preferences loaded from `prefs.json`.
    pub prefs: Arc<RwLock<crate::prefs::Preferences>>,
    /// Per-connection workspace state loaded from `tab_state.json`.
    pub tab_state: Arc<RwLock<crate::tab_state::PersistedTabState>>,
    /// Trusted SSH host-key fingerprints loaded from `known_hosts.json`.
    /// Shared with every SSH tunnel opened during the session.
    pub known_hosts: crate::ssh_known_hosts::SharedKnownHosts,
    /// CLI arguments parsed before the Tauri builder ran.
    pub startup_args: StartupArgs,
}

impl AppState {
    /// Load any existing profiles, preferences, and tab state from disk;
    /// failures degrade silently to defaults so a corrupted file doesn't
    /// prevent the app from launching.
    pub fn new() -> Self {
        Self::new_with_args(StartupArgs::default())
    }

    /// Same as [`Self::new`] but attaches pre-parsed CLI arguments so the
    /// frontend can retrieve them via `get_startup_args`.
    pub fn new_with_args(startup_args: StartupArgs) -> Self {
        let profiles = crate::store::load_profiles().unwrap_or_default();
        let prefs = crate::prefs::load_preferences();
        let tab_state = crate::tab_state::load_tab_state();
        Self {
            connections: Arc::new(RwLock::new(ActiveConnections::default())),
            profiles: Arc::new(RwLock::new(profiles)),
            prefs: Arc::new(RwLock::new(prefs)),
            tab_state: Arc::new(RwLock::new(tab_state)),
            known_hosts: crate::ssh_known_hosts::load_shared(),
            startup_args,
        }
    }
}
