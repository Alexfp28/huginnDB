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

use mongodb::Client as MongoClient;
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
    /// MongoDB. The document model diverges sharply from the SQL drivers
    /// above: all of its logic is concentrated in [`crate::db::mongo`] and
    /// dispatched through thin `DbPool::Mongo` arms in the command layer.
    /// Serialised as `"mongodb"` (not `"mongo"`) to match the frontend
    /// `Driver` union and the conventional driver name.
    #[serde(rename = "mongodb")]
    Mongo,
}

/// How far the headless MCP connector (`huginndb-mcp`) may go when writing to
/// this connection. Per-connection policy — the sidecar reads it fresh from
/// `profiles.json` on every write attempt, so changing it in the app takes
/// effect without restarting the MCP client.
///
/// * `ReadOnly` (default) — reads only; every write tool and any non-read-only
///   `run_query` is refused.
/// * `Data` — row-level DML: `INSERT`/`UPDATE`/`DELETE` (and their Mongo
///   equivalents), plus the structured write tools. No schema changes.
/// * `Full` — adds DDL (`CREATE`/`DROP`/`ALTER`/`TRUNCATE`/…) and the
///   structure-editor tool.
///
/// This is metadata-only from the backend's perspective (like
/// [`ConnectionProfile::visible_databases`]); the desktop app never acts on
/// it — only the sidecar's enforcement path does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpWritePolicy {
    ReadOnly,
    Data,
    Full,
}

impl Default for McpWritePolicy {
    fn default() -> Self {
        Self::ReadOnly
    }
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
    /// Raw connection URI, used by MongoDB as the primary connection input.
    /// When set (`mongodb://…` / `mongodb+srv://…`) it is passed verbatim to
    /// the driver and takes precedence over the discrete host/port/database
    /// fields, which Mongo only keeps as best-effort parsed conveniences.
    /// `None` for the SQL drivers, which assemble their URL from the discrete
    /// fields in [`crate::db::pool::build_url`].
    #[serde(default)]
    pub connection_string: Option<String>,
    /// MongoDB `authSource` (the auth database, e.g. `admin`). The form-built
    /// `connection_string` already carries it as a query option; it is stored
    /// separately so the URI-less fallback in [`crate::db::mongo::open_pool`]
    /// (CLI `--auth-source`) and form repopulation have it explicitly. `None`
    /// for the SQL drivers.
    #[serde(default)]
    pub auth_source: Option<String>,
    /// Session-only profile that must never be persisted to `profiles.json`.
    /// Set for ad-hoc connections opened from the CLI (`--host …`): they live
    /// in `state.profiles` in memory so the explorer / tabs / `pool_for` treat
    /// them like any other connection, but [`crate::store::save_profiles`]
    /// filters them out, so they vanish on the next launch. The matching
    /// password is already in-memory only (handed straight to `connect`), so
    /// nothing about an ephemeral profile ever touches disk or the keychain.
    #[serde(default)]
    pub ephemeral: bool,
    /// Free-text group/folder label for organizing the connection list (e.g.
    /// several drivers/environments for the same client). `None`/empty means
    /// ungrouped. Grouping is purely a display concern — no separate group
    /// registry, just equality-matched on this string in the frontend.
    #[serde(default)]
    pub group: Option<String>,
    /// DataGrip-style subset of databases to show for a multi-DB connection
    /// (#64). `None` (or absent) means "show all" — the historical behaviour;
    /// `Some(names)` restricts the multi-DB explorer to those databases and
    /// scopes the background warm to them. Purely a frontend display/perf
    /// concern; the backend stores it opaquely and never acts on it.
    #[serde(default)]
    pub visible_databases: Option<Vec<String>>,
    /// How far the MCP connector may write to this connection (#1.9.0). Absent
    /// / `None` on older profiles is treated as [`McpWritePolicy::ReadOnly`] —
    /// the safe default, so an upgrade never silently grants write access.
    /// Only the headless sidecar's enforcement path reads this; the desktop
    /// app stores it opaquely. See [`McpWritePolicy`].
    #[serde(default)]
    pub mcp_write: McpWritePolicy,
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
    /// A MongoDB client bound to a target database. Unlike the `sqlx` pools
    /// this is not a SQL connection pool — the driver manages its own internal
    /// connection pooling — but it is `Clone` (cheap, `Arc`-backed) so it slots
    /// into the same [`ActiveConnections`] map and `pool_for` lookup pattern.
    Mongo(MongoConn),
}

/// A live MongoDB client plus the database a given connection handle targets.
///
/// A single [`mongodb::Client`] can reach every database in the cluster, so
/// the per-database "views" the explorer opens (mirroring the SQL
/// `<id>::db::<name>` synthetic connections) reuse the parent's client and
/// only re-tag `database`. The parent connection's `database` is the URI's
/// default database (often `None` → "let me pick a database from the tree").
#[derive(Clone)]
pub struct MongoConn {
    pub client: MongoClient,
    pub database: Option<String>,
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
    /// Background keepalive ping (see [`crate::keepalive`]). `None` for the
    /// synthetic per-database pools opened by `open_database_view`, which
    /// deliberately don't get their own heartbeat.
    pub _keepalive: Option<crate::keepalive::KeepaliveHandle>,
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

    /// Whether `id` already has a live pool. Used by `connect` to make
    /// re-connecting to an already-active profile from a second window a
    /// no-op instead of tearing down the first window's pool (and any SSH
    /// tunnel) via [`Self::insert`]'s replace semantics.
    pub fn contains(&self, id: &str) -> bool {
        self.inner.contains_key(id)
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
    pub adhoc_host: Option<String>,
    pub adhoc_port: Option<u16>,
    pub adhoc_database: Option<String>,
    pub adhoc_username: Option<String>,
    /// One of "postgres", "mysql", "sqlite", "mongodb".
    pub adhoc_driver: Option<String>,
    /// Raw connection URI for an ad-hoc connection (`--uri` /
    /// `--connection-string`). The primary way to reach MongoDB — especially
    /// Atlas `mongodb+srv://` — from the CLI, where the discrete host/port
    /// fields can't express an SRV seed list or URI options. When present and
    /// no `--driver` is given, the driver defaults to `mongodb`.
    pub adhoc_connection_string: Option<String>,
    /// MongoDB `authSource` supplied via `--auth-source`. Folded into the
    /// assembled URI when no `--uri` is given (the URI-less ad-hoc path).
    pub adhoc_auth_source: Option<String>,
    /// Display name for the ad-hoc connection.
    pub adhoc_name: Option<String>,
    /// Optional password supplied via `--password`/`--pass`. Opt-in and kept
    /// only in memory for this launch: it is handed straight to `connect` and
    /// never persisted to the OS keychain. When absent, the password is
    /// resolved from the keychain (saved profile) or requested via the
    /// `ConnectPasswordDialog` flow once the app is open.
    pub adhoc_password: Option<String>,
}

/// In-memory, session-only secrets captured when a connection is opened,
/// keyed by profile id. Lets child pools (`open_database_view`) reuse a
/// password / SSH secret that was supplied via the CLI or the connect dialog
/// and deliberately never written to the OS keychain. Cleared on disconnect.
#[derive(Clone, Default)]
pub struct SessionSecret {
    pub password: Option<String>,
    pub ssh_secret: Option<String>,
}

/// Top-level state managed by Tauri.
pub struct AppState {
    /// Pools that have been connected this session.
    pub connections: Arc<RwLock<ActiveConnections>>,
    /// Session-only secrets keyed by profile id (see [`SessionSecret`]).
    pub session_secrets: Arc<RwLock<HashMap<String, SessionSecret>>>,
    /// Persisted profiles loaded from disk.
    pub profiles: Arc<RwLock<Vec<ConnectionProfile>>>,
    /// User-tunable preferences loaded from `prefs.json`.
    pub prefs: Arc<RwLock<crate::prefs::Preferences>>,
    /// Per-connection tab state loaded from `tab_state.json`.
    pub tab_state: Arc<RwLock<crate::tab_state::PersistedTabState>>,
    /// Trusted SSH host-key fingerprints loaded from `known_hosts.json`.
    /// Shared with every SSH tunnel opened during the session.
    pub known_hosts: crate::ssh_known_hosts::SharedKnownHosts,
    /// CLI arguments parsed before the Tauri builder ran.
    pub startup_args: StartupArgs,
    /// Connection intent forwarded by a *second* launch (see the
    /// single-instance handler in `lib.rs`). Buffered here because Tauri
    /// events are not replayed: if the second launch lands while the window
    /// is still booting, a listener attached afterwards would miss the
    /// `huginndb://cli-connect` event. The frontend drains this via
    /// `take_pending_cli_connect` once its bridge is mounted, then relies on
    /// the live event for every subsequent launch.
    pub pending_cli_connect: Arc<RwLock<Option<StartupArgs>>>,
    /// Connection intent stashed for a freshly-opened secondary window,
    /// keyed by its Tauri window label. Populated by `open_new_window` and
    /// drained exactly once by `take_window_startup_intent` when that
    /// window's frontend boots.
    pub window_startup_intents: Arc<RwLock<HashMap<String, StartupArgs>>>,
}

impl AppState {
    /// Load any existing profiles, preferences, and tab state from disk;
    /// failures degrade silently to defaults so a corrupted file doesn't
    /// prevent the app from launching.
    ///
    /// The desktop app always goes through [`Self::new_with_args`]; this
    /// argument-less constructor is the headless MCP binary's entry point.
    #[cfg_attr(not(feature = "mcp"), allow(dead_code))]
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
            session_secrets: Arc::new(RwLock::new(HashMap::new())),
            profiles: Arc::new(RwLock::new(profiles)),
            prefs: Arc::new(RwLock::new(prefs)),
            tab_state: Arc::new(RwLock::new(tab_state)),
            known_hosts: crate::ssh_known_hosts::load_shared(),
            startup_args,
            pending_cli_connect: Arc::new(RwLock::new(None)),
            window_startup_intents: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}
