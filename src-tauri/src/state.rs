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

use crate::error::{AppError, AppResult};

/// Database backend selected for a [`ConnectionProfile`].
///
/// `PartialEq`/`Eq`/`Hash` so it can take part in
/// [`crate::db::endpoint::EndpointKey`], which keys the per-server budget map.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
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
    /// Microsoft SQL Server, over TDS via `tiberius` (see [`crate::db::mssql`]).
    /// `sqlx` has no MSSQL driver, so this one carries its own client and
    /// session pool, but unlike MongoDB it speaks SQL and therefore shares the
    /// whole SQL command path via [`crate::db::sql::Dialect::MsSql`].
    /// Serialised as `"sqlserver"` to match the frontend `Driver` union.
    #[serde(rename = "sqlserver")]
    MsSql,
}

impl Driver {
    /// The driver's wire name — the same string `serde` writes to
    /// `profiles.json` and the frontend's `Driver` union uses.
    ///
    /// Every user-visible driver label goes through here: the Console panel's
    /// per-entry tag and the MCP `list_connections` tool. Before this existed
    /// the Console built the string with three duplicated `match` helpers and
    /// the MCP tool used `format!("{:?}")`, which reported `"mongo"` where the
    /// profile said `"mongodb"` — a Debug repr is not a wire format.
    pub fn wire_name(self) -> &'static str {
        match self {
            Self::Postgres => "postgres",
            Self::Mysql => "mysql",
            Self::Sqlite => "sqlite",
            Self::Mongo => "mongodb",
            Self::MsSql => "sqlserver",
        }
    }
}

/// How a SQL Server connection authenticates.
///
/// `Sql` is a SQL Server login (username + password stored in the OS keychain
/// like every other driver). `Windows` is NTLM with an explicit
/// `DOMAIN\user` + password — supported only by Windows builds, because
/// `tiberius`'s `AuthMethod::Windows` is `cfg(windows)`-gated. Integrated /
/// SSPI (authenticate as the logged-in Windows user with no credentials typed)
/// and Entra ID tokens are deliberately not offered yet.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MsSqlAuth {
    #[default]
    Sql,
    Windows,
}

/// SQL Server-specific connection settings.
///
/// Nested (like [`SshTunnel`]) rather than flattened into
/// [`ConnectionProfile`], so the other four drivers' profiles don't carry three
/// fields that mean nothing to them.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MsSqlOptions {
    /// Named instance (`SQLEXPRESS` in `HOST\SQLEXPRESS`). The combined
    /// `HOST\INSTANCE` form is accepted here and in [`ConnectionProfile::host`]
    /// — see `db::mssql::split_instance`. When set, the port is discovered
    /// through the SQL Browser instead of being used as given, except as the
    /// fallback tried when the Browser doesn't answer.
    #[serde(default)]
    pub instance: Option<String>,
    /// Accept the server's TLS certificate without validating it. Most on-prem
    /// instances present a self-signed certificate, so an encrypted connection
    /// to them cannot be established without this.
    #[serde(default)]
    pub trust_server_certificate: bool,
    #[serde(default)]
    pub auth: MsSqlAuth,
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
/// * `Full` — adds DDL (`CREATE`/`DROP`/`ALTER`/`TRUNCATE`/…) through
///   `run_query`, plus the `save_view` / `drop_view` tools. There is no
///   structure-editor tool on any tier; table DDL goes through `run_query`.
///
/// This is metadata-only from the backend's perspective (like
/// [`ConnectionProfile::visible_databases`]); the desktop app never acts on
/// it — only the sidecar's enforcement path does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum McpWritePolicy {
    /// The default for any profile that has never opted in: an MCP client may
    /// read but never mutate. Deliberately the `Default` so a profile
    /// deserialised from an older `profiles.json` (which has no such field)
    /// can never come back as writable.
    #[default]
    ReadOnly,
    Data,
    Full,
}

// Consumed by the headless connector's enforcement path (`crate::mcp`) and,
// since the MCP bridge landed, by `crate::bridge::server` — which re-checks the
// policy inside the *desktop app*, built without the `mcp` feature. That second
// caller is why these are no longer gated behind it.
impl McpWritePolicy {
    /// Whether a statement of the given tier is permitted under this policy.
    /// `ReadOnly` admits only reads; `Data` adds row-level DML; `Full` adds
    /// DDL. The ordering is strict — a lower tier never admits a higher one.
    pub fn allows(self, class: crate::db::sql::StmtClass) -> bool {
        use crate::db::sql::StmtClass;
        match self {
            McpWritePolicy::ReadOnly => class == StmtClass::Read,
            McpWritePolicy::Data => matches!(class, StmtClass::Read | StmtClass::DataWrite),
            McpWritePolicy::Full => true,
        }
    }

    /// Lowercased wire label (`read-only` / `data` / `full`) for error
    /// messages and logs.
    pub fn label(self) -> &'static str {
        match self {
            McpWritePolicy::ReadOnly => "read-only",
            McpWritePolicy::Data => "data",
            McpWritePolicy::Full => "full",
        }
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
    /// Optional SSH tunnel configuration. When set,
    /// [`crate::db::pool::open_pool`] brings the tunnel up first and points the
    /// driver at `127.0.0.1:<local-port>` — see [`SshTunnel`] and
    /// [`crate::db::ssh`]. Ignored for SQLite (a local file has nothing to
    /// tunnel to).
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
    /// SQL Server-specific settings (named instance, certificate trust, auth
    /// mode). `None` for every other driver, and for a SQL Server profile that
    /// predates the field — [`MsSqlOptions::default`] is the plain
    /// SQL-login-over-an-explicit-port case.
    #[serde(default)]
    pub mssql: Option<MsSqlOptions>,
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
    /// Ceiling on how many simultaneous connections HuginnDB may hold against
    /// this server, overriding the global `connections.maxConnections`
    /// preference. `None` (the default, and every profile written before this
    /// field existed) means "use the preference".
    ///
    /// Connection capacity is a fact about a *server*, not about a session,
    /// which is why it lives on the profile rather than in `prefs.json`:
    /// a shared staging box that tolerates three sessions needs that recorded
    /// next to its host and port. Two things fall out of that placement for
    /// free — it exports/imports with the profile ([`crate::transfer`]) and
    /// syncs through shared origins, and the headless MCP sidecar honours it
    /// without any extra plumbing, because it reads the same `profiles.json`.
    ///
    /// Clamped at use time by [`crate::db::pool::PoolLimits`]; a value below
    /// the floor there is raised rather than rejected, so a hand-edited `0`
    /// can't produce a pool that deadlocks.
    #[serde(default)]
    pub max_connections: Option<u32>,
    /// Id of the shared origin this profile was imported from (#108), or `None`
    /// for a profile the user created locally.
    ///
    /// A profile carrying this is **read-only in the UI**: it is a copy of an
    /// entry in a file somebody else curates, so editing it locally would be
    /// silently undone by the next sync. To vary one, duplicate it — the copy
    /// has no `origin_id` and is an ordinary local profile.
    ///
    /// The backend stores it opaquely and never acts on it beyond the sync
    /// itself; enforcement of the read-only rule is a frontend concern, the
    /// same split as `visible_databases`.
    #[serde(default)]
    pub origin_id: Option<String>,
}

/// How the client decides whether to trust the SSH server's host key.
///
/// `AcceptNew` mirrors `ssh -o StrictHostKeyChecking=accept-new`: trust on
/// first use, then strict afterwards. `Strict` requires a pre-existing
/// fingerprint in `known_hosts.json`. `AcceptAny` skips verification.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum HostKeyPolicy {
    Strict,
    /// Trust-on-first-use: an unknown host is recorded, a *changed* key is
    /// refused. The `Default` because it is the only setting that is both
    /// usable without a manual known-hosts step and still detects a MITM on
    /// every subsequent connect.
    #[default]
    AcceptNew,
    AcceptAny,
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
    /// A SQL Server session pool (see [`crate::db::mssql::MsSqlPool`]). Not a
    /// `sqlx` pool — `tiberius` has none of its own, so this is ours — but
    /// `Clone` and `Arc`-backed like the rest, so it slots into
    /// [`ActiveConnections`] unchanged.
    MsSql(crate::db::mssql::MsSqlPool),
}

impl DbPool {
    /// The wire name of the driver behind this pool — see
    /// [`Driver::wire_name`], which this mirrors for the runtime side.
    pub fn driver_name(&self) -> &'static str {
        match self {
            Self::Postgres(_) => Driver::Postgres.wire_name(),
            Self::Mysql(_) => Driver::Mysql.wire_name(),
            Self::Sqlite(_) => Driver::Sqlite.wire_name(),
            Self::Mongo(_) => Driver::Mongo.wire_name(),
            Self::MsSql(_) => Driver::MsSql.wire_name(),
        }
    }
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

// ---------------------------------------------------------------------------
// Synthetic per-database connection ids
// ---------------------------------------------------------------------------

/// Separator between a profile id and a database name in the synthetic
/// connection id `commands::connection::open_database_view` registers for a
/// per-database browse session on a server-wide connection.
///
/// One spelling, here. The helpers below are the *only* things that should know
/// this string: it used to be written out at eight sites across four layers
/// (`state`, `db::pool`, `pool_reaper`, `bridge::server`), each re-deriving
/// "is this a view?" or "what is the parent?" by hand. This lives in `state`
/// rather than beside `open_database_view` because `db::pool` and `pool_reaper`
/// are *below* `commands` and must not depend upward; `commands::connection`
/// re-exports the two it had so its public paths keep working.
pub const DB_VIEW_SEP: &str = "::db::";

/// Synthetic connection id for a per-database browse session under `parent_id`.
///
/// Format is stable so callers can derive the id without a round-trip when they
/// only need to address an already-open child.
pub fn database_view_id(parent_id: &str, database: &str) -> String {
    format!("{parent_id}{DB_VIEW_SEP}{database}")
}

/// The id prefix shared by every per-database view under `parent_id`, for
/// `starts_with` scans over the live connection map.
pub fn database_view_prefix(parent_id: &str) -> String {
    format!("{parent_id}{DB_VIEW_SEP}")
}

/// Split a synthetic id into `(parent profile id, database name)`, or `None`
/// for a plain top-level id.
///
/// Splits at the *first* separator: a database whose own name contains the
/// separator would otherwise re-parent the id (see `PoolOwnership::for_id`'s
/// test, which pins this).
pub fn split_database_view(id: &str) -> Option<(&str, &str)> {
    id.split_once(DB_VIEW_SEP)
}

/// Whether `id` names a synthetic per-database view rather than a profile.
pub fn is_database_view(id: &str) -> bool {
    id.contains(DB_VIEW_SEP)
}

/// The *profile* id behind a connection id: `id` itself for a plain one, the
/// parent for a synthetic `<parent>::db::<database>` child.
///
/// Rust twin of `lib/connectionLabel.ts`'s `parentConnectionId` (gotcha #36).
pub fn parent_connection_id(id: &str) -> &str {
    match split_database_view(id) {
        Some((parent, _)) => parent,
        None => id,
    }
}

/// Monotonic milliseconds since the first call, used to timestamp pool usage.
///
/// Deliberately not wall-clock: the reaper compares ages, and a system clock
/// that jumps (NTP correction, suspend/resume, a user changing the timezone)
/// would make a `SystemTime` delta either negative or enormous, and reap live
/// pools out from under an active session either way.
pub fn now_millis() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis() as u64
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
    /// This pool's reservation against its server's connection budget (see
    /// [`crate::db::endpoint`]). `None` for the pools that spend no budget: a
    /// SQLite file, and a Mongo per-database view that reuses its parent's
    /// client.
    ///
    /// Held here purely so it lives exactly as long as the pool does — the
    /// grant releases on `Drop`, which is what keeps the four different
    /// removal paths from having to remember to give the budget back.
    pub _endpoint: Option<crate::db::endpoint::EndpointGrant>,
    /// [`now_millis`] at the last [`ActiveConnections::get`] — i.e. the last
    /// time any command resolved this pool in order to use it.
    ///
    /// `Arc<AtomicU64>` rather than a plain field for two reasons: `get` takes
    /// `&self` (every command path goes through a read lock, and taking a
    /// write lock just to stamp a timestamp would serialise all query
    /// dispatch), and the keepalive task holds a clone so it can skip a tick
    /// whose liveness the user's own traffic already proved.
    ///
    /// Fed by `get`, which is the single choke point every one of the
    /// per-module `pool_for` helpers funnels through — so this stays accurate
    /// without touching any of them.
    pub last_used: Arc<std::sync::atomic::AtomicU64>,
}

impl ActivePool {
    /// A pool with no tunnel and no heartbeat, stamped as used right now — the
    /// shape every synthetic per-database child and every headless (MCP) pool
    /// takes.
    pub fn bare(pool: DbPool) -> Self {
        Self {
            pool,
            _ssh: None,
            _keepalive: None,
            _endpoint: None,
            last_used: Arc::new(std::sync::atomic::AtomicU64::new(now_millis())),
        }
    }

    /// The server budget this pool draws on, if it draws on one.
    pub fn endpoint_key(&self) -> Option<&crate::db::endpoint::EndpointKey> {
        self._endpoint.as_ref().map(|g| g.key())
    }

    /// [`now_millis`] value at the last use.
    pub fn last_used_millis(&self) -> u64 {
        self.last_used.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// How long this pool has been idle, as of `now`.
    ///
    /// `now` is passed in rather than read here so the eviction policy is a
    /// pure function of its inputs: [`now_millis`] is anchored to the first
    /// call in the process, which for a unit test is the test itself, leaving
    /// no room to express "this pool was last used ten seconds ago".
    pub fn idle_millis_at(&self, now: u64) -> u64 {
        now.saturating_sub(self.last_used_millis())
    }
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
    ///
    /// Prefer routing removals through [`crate::db::pool::close_pool`] so the
    /// driver gets an awaited, graceful shutdown instead of a bare `Drop` —
    /// see that function's docs for why the difference is load-bearing.
    pub fn remove(&mut self, id: &str) -> Option<ActivePool> {
        self.inner.remove(id)
    }

    /// Cheap, cloning lookup. Pools are themselves cheap to clone; the
    /// tunnel handle stays owned by the [`ActivePool`] so query workers
    /// don't need to know it exists.
    ///
    /// **Also stamps `last_used`.** Every command that touches a database goes
    /// through here (via its module's `pool_for`), which makes this the one
    /// place that can keep the idle reaper honest. A lookup that must *not*
    /// count as use — the reaper's own bookkeeping — reads `inner` directly
    /// through the accessors below instead.
    pub fn get(&self, id: &str) -> Option<DbPool> {
        self.inner.get(id).map(|a| {
            a.last_used
                .store(now_millis(), std::sync::atomic::Ordering::Relaxed);
            a.pool.clone()
        })
    }

    /// Synthetic per-database children of `parent_id`, oldest use first.
    ///
    /// The ordering is what makes the per-parent cap an LRU rather than an
    /// arbitrary eviction: callers take from the front.
    pub fn children_by_lru(&self, parent_id: &str) -> Vec<String> {
        let prefix = database_view_prefix(parent_id);
        let mut children: Vec<(&String, u64)> = self
            .inner
            .iter()
            .filter(|(id, _)| id.starts_with(&prefix))
            .map(|(id, active)| (id, active.last_used_millis()))
            .collect();
        // Oldest use first == longest idle first. Ties broken by id so the
        // order is deterministic; a `HashMap` iteration order is not, and an
        // eviction that picks a different victim on each run is untestable and
        // unexplainable to the user.
        children.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(b.0)));
        children.into_iter().map(|(id, _)| id.clone()).collect()
    }

    /// Every synthetic per-database child pool (any parent) idle for at least
    /// `ttl_millis` as of `now`. Top-level pools are never returned: they
    /// represent a connection the user explicitly opened and are only closed by
    /// an explicit disconnect.
    pub fn idle_children(&self, now: u64, ttl_millis: u64) -> Vec<String> {
        self.inner
            .iter()
            .filter(|(id, active)| is_database_view(id) && active.idle_millis_at(now) >= ttl_millis)
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Synthetic per-database views drawing on `key`, longest-unused first.
    ///
    /// Feeds the reclaim step in `open_database_view`: when a server's budget
    /// is spent, closing the view the user looked at least recently is a far
    /// better answer than refusing to open the one they just clicked. Scoped to
    /// a single endpoint on purpose — evicting a view on an unrelated server
    /// would free nothing that the caller is waiting for.
    pub fn views_on_endpoint_by_lru(&self, key: &crate::db::endpoint::EndpointKey) -> Vec<String> {
        let mut views: Vec<(&String, u64)> = self
            .inner
            .iter()
            .filter(|(id, active)| is_database_view(id) && active.endpoint_key() == Some(key))
            .map(|(id, active)| (id, active.last_used_millis()))
            .collect();
        views.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(b.0)));
        views.into_iter().map(|(id, _)| id.clone()).collect()
    }

    /// Every pool — top-level included — idle for at least `ttl_millis`.
    ///
    /// Only the headless MCP sidecar uses this: it has no user watching a
    /// connection indicator, so an untouched pool there is pure cost. The
    /// desktop app deliberately keeps top-level pools until disconnect — hence
    /// the dead-code allowance in a normal `pnpm tauri:build`, matching the
    /// `McpWritePolicy` helpers above.
    #[cfg_attr(not(feature = "mcp"), allow(dead_code))]
    pub fn idle_pools(&self, now: u64, ttl_millis: u64) -> Vec<String> {
        self.inner
            .iter()
            .filter(|(_, active)| active.idle_millis_at(now) >= ttl_millis)
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// How many pools are live right now, split into top-level and synthetic
    /// per-database children. Feeds the connection-limit error message, which
    /// is only actionable if it can tell the user what HuginnDB itself holds.
    pub fn counts(&self) -> (usize, usize) {
        let children = self.inner.keys().filter(|id| is_database_view(id)).count();
        (self.inner.len() - children, children)
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
    /// Per-server connection budgets. See [`crate::db::endpoint`] — this is
    /// what stops two profiles pointing at the same host from getting two
    /// independent allowances.
    pub endpoints: Arc<crate::db::endpoint::EndpointRegistry>,
    /// The running MCP bridge listener, when enabled. `None` means the bridge
    /// is off and any sidecar falls back to its own pools.
    ///
    /// A `parking_lot::Mutex` rather than an `RwLock` because it is only ever
    /// swapped, never read concurrently under load; dropping the handle is what
    /// stops the listener and removes the discovery file.
    pub mcp_bridge: parking_lot::Mutex<Option<crate::bridge::server::BridgeHandle>>,
    /// Persisted profiles loaded from disk.
    pub profiles: Arc<RwLock<Vec<ConnectionProfile>>>,
    /// User-tunable preferences loaded from `prefs.json`.
    pub prefs: Arc<RwLock<crate::prefs::Preferences>>,
    /// Per-connection tab state loaded from `tab_state.json`.
    pub tab_state: Arc<RwLock<crate::tab_state::PersistedTabState>>,
    /// User-defined JSON Schema library loaded from `json_schemas.json`.
    ///
    /// Global rather than per environment, and in a file of its own rather than
    /// in `prefs.json` — see [`crate::json_schemas`] for both arguments.
    pub json_schemas: Arc<RwLock<crate::json_schemas::JsonSchemaLibrary>>,
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
    /// Serialized `AppTab` payload for a freshly-opened detached-tab window
    /// (the "pop out to a real OS window" action), keyed by its Tauri window
    /// label. Kept as an opaque `serde_json::Value` — the shape is owned by
    /// the frontend's `AppTab` type and this state never inspects it (see
    /// CLAUDE.md gotcha #14 on why a typed intermediate would silently drop
    /// fields). Populated by `open_tab_window` and drained exactly once by
    /// `take_detached_tab_intent` when that window's frontend boots.
    pub detached_tab_intents: Arc<RwLock<HashMap<String, serde_json::Value>>>,
    /// Connection id a freshly-opened Pulse window should measure, keyed by its
    /// Tauri window label. A plain `String` rather than a serialized tab
    /// because Pulse is deliberately *not* a `TabKind` — it never appears in
    /// the workspace, so there is no tab to carry. Populated by
    /// `open_pulse_window` and drained exactly once by
    /// `take_pulse_window_intent` when that window's frontend boots.
    pub pulse_window_intents: Arc<RwLock<HashMap<String, String>>>,
}

impl AppState {
    /// The live pool for `id`, or [`AppError::NotConnected`].
    ///
    /// Every command module had a byte-identical private `pool_for` (seven of
    /// them) before this existed. Cloning the `DbPool` out under the read lock
    /// rather than handing back a guard is what keeps the lock off the `await`
    /// points that follow in the caller — the pools are `Arc`-backed, so the
    /// clone is cheap.
    pub fn pool_for(&self, id: &str) -> AppResult<DbPool> {
        self.connections
            .read()
            .get(id)
            .ok_or_else(|| AppError::NotConnected(id.to_string()))
    }

    /// The live MongoDB handle for `id`, for a surface that only exists on
    /// MongoDB (the aggregation editor, the index manager).
    ///
    /// `unsupported` is the whole message for the non-Mongo case, not a
    /// fragment: each caller points the user at the SQL equivalent of its own
    /// feature, and a templated "X is MongoDB-only" would lose that half.
    pub fn mongo_for(&self, id: &str, unsupported: &str) -> AppResult<MongoConn> {
        match self.pool_for(id)? {
            DbPool::Mongo(conn) => Ok(conn),
            _ => Err(AppError::UnsupportedDriver(unsupported.into())),
        }
    }

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
        // Tab state loads first: a v4→v5 migration (origins moving to a
        // global registry, `tab_state`'s module doc) can dedupe two
        // environments' origins that shared a `path`, and the returned remap
        // (old id → surviving id) has to be applied to `profiles.json` — a
        // separate file `tab_state` knows nothing about — before it's read.
        // Without this, a profile synced from the deduped-away id would be
        // left with a dangling `origin_id` pointing at nothing.
        let (tab_state, origin_id_remap) = crate::tab_state::load_tab_state();
        let mut profiles = crate::store::load_profiles().unwrap_or_default();
        if !origin_id_remap.is_empty() {
            let mut changed = false;
            for p in &mut profiles {
                if let Some(old_id) = p.origin_id.clone() {
                    if let Some(new_id) = origin_id_remap.get(&old_id) {
                        p.origin_id = Some(new_id.clone());
                        changed = true;
                    }
                }
            }
            // Best-effort, same philosophy as the rest of this function: a
            // failed save here just means the remap recomputes identically
            // (and re-applies harmlessly) on the next launch, since it's a
            // pure function of the still-unmigrated tab_state.json blob.
            if changed {
                let _ = crate::store::save_profiles(&profiles);
            }
            let _ = crate::tab_state::save_tab_state(&tab_state);
        }
        let prefs = crate::prefs::load_preferences();
        let json_schemas = crate::json_schemas::load_library();
        Self {
            connections: Arc::new(RwLock::new(ActiveConnections::default())),
            session_secrets: Arc::new(RwLock::new(HashMap::new())),
            endpoints: Arc::new(crate::db::endpoint::EndpointRegistry::default()),
            mcp_bridge: parking_lot::Mutex::new(None),
            profiles: Arc::new(RwLock::new(profiles)),
            prefs: Arc::new(RwLock::new(prefs)),
            tab_state: Arc::new(RwLock::new(tab_state)),
            json_schemas: Arc::new(RwLock::new(json_schemas)),
            known_hosts: crate::ssh_known_hosts::load_shared(),
            startup_args,
            pending_cli_connect: Arc::new(RwLock::new(None)),
            window_startup_intents: Arc::new(RwLock::new(HashMap::new())),
            detached_tab_intents: Arc::new(RwLock::new(HashMap::new())),
            pulse_window_intents: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}
