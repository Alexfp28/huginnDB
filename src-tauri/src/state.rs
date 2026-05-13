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

/// SSH tunnel configuration. Used only by the UI until tunnelling is wired
/// up in the backend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshTunnel {
    pub host: String,
    pub port: u16,
    pub username: String,
}

impl ConnectionProfile {
    /// Key under which the password is stored in the OS keychain.
    ///
    /// We include the profile id so multiple profiles for the same user
    /// don't collide on shared hosts.
    pub fn keyring_account(&self) -> String {
        format!("{}::{}", self.id, self.username)
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

/// Map of profile-id → live pool.
#[derive(Default)]
pub struct ActiveConnections {
    inner: HashMap<String, DbPool>,
}

impl ActiveConnections {
    /// Insert or replace a pool for `id`.
    pub fn insert(&mut self, id: String, pool: DbPool) {
        self.inner.insert(id, pool);
    }

    /// Remove the pool for `id`, if any. The pool will be dropped (and
    /// gracefully closed by `sqlx`) when the last clone goes out of scope.
    pub fn remove(&mut self, id: &str) -> Option<DbPool> {
        self.inner.remove(id)
    }

    /// Cheap, cloning lookup. Pools are themselves cheap to clone.
    pub fn get(&self, id: &str) -> Option<DbPool> {
        self.inner.get(id).cloned()
    }

    /// Ids of every currently active connection.
    pub fn ids(&self) -> Vec<String> {
        self.inner.keys().cloned().collect()
    }
}

/// Top-level state managed by Tauri.
pub struct AppState {
    /// Pools that have been connected this session.
    pub connections: Arc<RwLock<ActiveConnections>>,
    /// Persisted profiles loaded from disk.
    pub profiles: Arc<RwLock<Vec<ConnectionProfile>>>,
}

impl AppState {
    /// Load any existing profiles from disk; failures degrade silently to
    /// an empty list so a corrupted profiles file doesn't prevent the app
    /// from launching.
    pub fn new() -> Self {
        let profiles = crate::store::load_profiles().unwrap_or_default();
        Self {
            connections: Arc::new(RwLock::new(ActiveConnections::default())),
            profiles: Arc::new(RwLock::new(profiles)),
        }
    }
}
