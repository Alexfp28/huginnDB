//! Pool construction and connection URL assembly.
//!
//! These helpers are kept driver-agnostic: callers describe what they want
//! via a [`ConnectionProfile`] + password and receive back a typed
//! [`DbPool`].
//!
//! When the profile carries an [`SshTunnel`] config, [`open_pool`] first
//! brings up the tunnel via [`crate::db::ssh::open_tunnel`] and points the
//! resulting `sqlx` URL at the local listener instead of the remote host.
//! The returned [`SshTunnelHandle`] must be kept alive for as long as the
//! pool — callers normally store it in [`crate::state::ActivePool`]
//! alongside the pool itself.

use crate::db::ssh::{self, SshTunnelHandle};
use crate::error::AppResult;
use crate::ssh_known_hosts::SharedKnownHosts;
use crate::state::{ConnectionProfile, DbPool, Driver};
use sqlx::mysql::MySqlPoolOptions;
use sqlx::postgres::PgPoolOptions;
use sqlx::sqlite::SqlitePoolOptions;
use std::time::Duration;

/// Default ceiling for a **top-level** pool against a server-backed driver.
///
/// Kept conservative because HuginnDB is a single-user desktop client; we
/// don't expect more than a couple of in-flight queries at once. Overridable
/// globally (`connections.maxConnections`) and per profile
/// ([`ConnectionProfile::max_connections`]).
pub const DEFAULT_MAX_CONNECTIONS: u32 = 5;

/// Default ceiling for a **synthetic per-database child** pool
/// (`<parent>::db::<name>`, see `commands::connection::open_database_view`).
///
/// Deliberately much smaller than [`DEFAULT_MAX_CONNECTIONS`], because these
/// are the pools that *multiply*: one per database the user browses, against
/// the same server. Five apiece is how a twelve-database server turned into a
/// ceiling of sixty-five backends from a single window. A child pool serves
/// schema introspection and one grid at a time; two is enough for that, and
/// still above [`MIN_MAX_CONNECTIONS`].
pub const DEFAULT_CHILD_MAX_CONNECTIONS: u32 = 2;

/// Floor for any server-backed pool.
///
/// Not cosmetic: `commands::query::run_batch` holds one connection checked out
/// for the whole of a multi-statement batch (so `BEGIN`/`SET`/`COMMIT` share a
/// session), and a background schema refresh that lands during a long batch
/// would deadlock against a single-connection pool waiting on
/// [`ACQUIRE_TIMEOUT`]. Two is the smallest pool that stays usable
/// interactively, so a hand-edited `0` or `1` is raised to it rather than
/// honoured.
pub const MIN_MAX_CONNECTIONS: u32 = 2;

/// Sanity ceiling on a user-supplied override. Past this the user wants a
/// server-side pooler, not a bigger desktop client.
pub const MAX_MAX_CONNECTIONS: u32 = 64;

/// SQLite is single-file and benefits from a small pool to avoid lock
/// contention on writes.
const MAX_CONNECTIONS_SQLITE: u32 = 1;

/// How long an idle connection may sit in a pool before it is closed.
///
/// Was implicit (`sqlx`'s 10-minute default) until connection pressure became
/// a reported problem; stated here so the value is reviewable, and shortened
/// so a pool the user has stopped touching gives its sockets back to the
/// server within a coffee break rather than twice that.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

/// Hard cap on a single connection's age, regardless of activity. Bounds the
/// damage from a server-side session that has quietly gone bad (a stale
/// prepared-statement cache, a rotated credential, a failed-over replica) and
/// gives load balancers a chance to rebalance.
pub const MAX_LIFETIME: Duration = Duration::from_secs(1800);

/// How long a caller waits for a free slot before failing.
///
/// The failure is classified into [`crate::error::AppError::TooManyConnections`]
/// (see `sqlx_connection_limit_detail`), so exhausting our *own* pool reports
/// the same actionable error as the server refusing us.
pub const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(30);

/// Resolved sizing for one pool.
///
/// Threaded through [`open_pool`] instead of read from a constant so that the
/// three kinds of pool HuginnDB opens — a top-level connection, a synthetic
/// per-database child, and a throwaway credentials probe — can differ, and so
/// that the per-profile and global overrides apply at exactly one place.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoolLimits {
    pub max_connections: u32,
}

impl PoolLimits {
    /// Clamp an arbitrary requested ceiling into the supported range.
    fn clamped(requested: u32) -> Self {
        Self {
            max_connections: requested.clamp(MIN_MAX_CONNECTIONS, MAX_MAX_CONNECTIONS),
        }
    }

    /// Limits for a top-level connection: the profile's own override if it has
    /// one, else the global preference.
    pub fn top_level(profile: &ConnectionProfile, preference: u32) -> Self {
        Self::clamped(profile.max_connections.unwrap_or(preference))
    }

    /// Limits for a synthetic per-database child.
    ///
    /// Takes the *smaller* of the child default and whatever the parent
    /// connection resolved to, so lowering a profile's ceiling lowers its
    /// children too — but raising it never inflates them past the child
    /// default. Children are the multiplying kind of pool; the override exists
    /// to let a user open a bigger *connection*, not twelve bigger ones.
    pub fn child(profile: &ConnectionProfile, preference: u32, child_preference: u32) -> Self {
        let parent = Self::top_level(profile, preference).max_connections;
        Self::clamped(child_preference.min(parent))
    }

    /// Limits for a short-lived pool that only has to prove the credentials
    /// work ("Test connection"). One connection, one `SELECT 1`, then closed.
    /// Not clamped — the floor exists to keep *interactive* pools usable, and
    /// nothing interactive ever runs against this one.
    pub fn probe() -> Self {
        Self { max_connections: 1 }
    }
}

impl Default for PoolLimits {
    fn default() -> Self {
        Self::clamped(DEFAULT_MAX_CONNECTIONS)
    }
}

/// URL-encode arbitrary bytes so they are safe inside a connection URL.
fn url_encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// Build the `sqlx`-compatible connection URL for `profile`.
///
/// `host`/`port` are passed explicitly so callers using an SSH tunnel can
/// substitute `127.0.0.1:<local-port>` without mutating the profile.
/// For SQLite the `database` field is interpreted as a file path; for the
/// server-backed drivers it is the catalog/schema name plus host info.
pub fn build_url(profile: &ConnectionProfile, password: &str, host: &str, port: u16) -> String {
    let user = url_encode(&profile.username);
    let pwd = url_encode(password);

    match profile.driver {
        Driver::Postgres => {
            // A blank `database` is a legitimate user choice: "connect to the
            // server, then let me pick a database from the schema tree".
            // Postgres requires SOME database at connect time though, so we
            // fall back to the always-present `postgres` maintenance DB. The
            // schema tree later spawns per-DB synthetic pools (see
            // `open_database_view`) once the user expands a specific
            // database node.
            let db = if profile.database.is_empty() {
                "postgres"
            } else {
                profile.database.as_str()
            };
            // Make the SSL toggle explicit. With no `sslmode`, sqlx defaults
            // to `prefer`, which still sends a Postgres SSLRequest and
            // negotiates TLS — and that negotiation blows up against servers
            // (or poolers) that don't speak it ("unexpected response from
            // SSLRequest"). `disable` skips the SSLRequest entirely and goes
            // straight to a plaintext startup, which is what an unchecked SSL
            // box should mean.
            format!(
                "postgres://{user}:{pwd}@{host}:{port}/{db}{ssl}",
                ssl = if profile.ssl {
                    "?sslmode=require"
                } else {
                    "?sslmode=disable"
                },
            )
        }
        Driver::Mysql => {
            // MySQL accepts a URL with no database path. Leaving it blank
            // means the session starts without a default `DATABASE()` set;
            // listing/querying is then driven by per-DB synthetic pools.
            let path = if profile.database.is_empty() {
                String::new()
            } else {
                format!("/{}", profile.database)
            };
            // Same rationale as Postgres above: be explicit so an unchecked
            // SSL box means "no TLS" instead of sqlx's `PREFERRED` default
            // (which negotiates TLS and can trip the same way).
            format!(
                "mysql://{user}:{pwd}@{host}:{port}{path}{ssl}",
                ssl = if profile.ssl {
                    "?ssl-mode=REQUIRED"
                } else {
                    "?ssl-mode=DISABLED"
                },
            )
        }
        Driver::Sqlite => format!("sqlite://{}", profile.database),
        // MongoDB does not use this SQL-URL builder; its client is constructed
        // in `crate::db::mongo::open_pool`, which `open_pool` delegates to before
        // ever reaching here. Returning the raw connection string keeps the
        // match total without inventing a meaningless SQL URL.
        Driver::Mongo => profile.connection_string.clone().unwrap_or_default(),
    }
}

/// Open a fresh pool for `profile`, using `password` for authentication.
///
/// If the profile carries an SSH tunnel configuration, the tunnel is
/// opened first and the `sqlx` URL is pointed at the local listener.
/// `ssh_secret` is forwarded to the SSH layer (password or key passphrase).
///
/// The returned [`DbPool`] wraps the underlying driver-specific pool; the
/// optional [`SshTunnelHandle`] is the owner of the tunnel and must be kept
/// alive for the pool's lifetime. The caller normally stashes both in
/// [`crate::state::ActivePool`].
pub async fn open_pool(
    profile: &ConnectionProfile,
    password: &str,
    ssh_secret: Option<String>,
    known_hosts: SharedKnownHosts,
    limits: PoolLimits,
) -> AppResult<(DbPool, Option<SshTunnelHandle>)> {
    // MongoDB has its own connection model (URI / SRV / tunnel rules) and is
    // built entirely in the mongo module.
    if matches!(profile.driver, Driver::Mongo) {
        return crate::db::mongo::open_pool(profile, password, ssh_secret, known_hosts, limits)
            .await;
    }

    // SQLite is a local file; tunnels don't apply. For network drivers,
    // bring the tunnel up first so we know which local port to target.
    let (host, port, handle): (String, u16, Option<SshTunnelHandle>) =
        if let (Some(tunnel), false) = (
            profile.ssh_tunnel.as_ref(),
            matches!(profile.driver, Driver::Sqlite),
        ) {
            let h = ssh::open_tunnel(tunnel, ssh_secret, &profile.host, profile.port, known_hosts)
                .await?;
            ("127.0.0.1".to_string(), h.local_port, Some(h))
        } else {
            (profile.host.clone(), profile.port, None)
        };

    let url = build_url(profile, password, &host, port);
    let pool = match profile.driver {
        Driver::Postgres => DbPool::Postgres(
            tuned(PgPoolOptions::new(), limits.max_connections)
                .connect(&url)
                .await?,
        ),
        Driver::Mysql => DbPool::Mysql(
            tuned(MySqlPoolOptions::new(), limits.max_connections)
                .connect(&url)
                .await?,
        ),
        // MongoDB is handled by the early return at the top of this function.
        Driver::Mongo => unreachable!("mongo handled by db::mongo::open_pool"),
        // SQLite is a local file: no server to run out of connections, and a
        // second writer only buys lock contention. Fixed at one, tuned the
        // same way so an abandoned tab doesn't hold the file handle open.
        Driver::Sqlite => DbPool::Sqlite(
            tuned(SqlitePoolOptions::new(), MAX_CONNECTIONS_SQLITE)
                .connect(&url)
                .await?,
        ),
    };
    Ok((pool, handle))
}

/// Apply the shared sizing/lifetime policy to any driver's `PoolOptions`.
///
/// Generic over the driver so the four call sites above cannot drift apart —
/// which they previously had room to, since each set `max_connections` and
/// nothing else and inherited four separate implicit `sqlx` defaults.
///
/// `min_connections(0)` is stated rather than inherited because it is the
/// single most important value here: it is what lets an untouched pool decay
/// to zero sockets instead of holding a floor open against a server other
/// tools are competing for.
fn tuned<DB>(
    options: sqlx::pool::PoolOptions<DB>,
    max_connections: u32,
) -> sqlx::pool::PoolOptions<DB>
where
    DB: sqlx::Database,
{
    options
        .max_connections(max_connections)
        .min_connections(0)
        .idle_timeout(Some(IDLE_TIMEOUT))
        .max_lifetime(Some(MAX_LIFETIME))
        .acquire_timeout(ACQUIRE_TIMEOUT)
}

/// Whether a pool owns the driver resources behind it, or borrows them from
/// another pool.
///
/// Only MongoDB makes the distinction observable, and it is load-bearing there:
/// a synthetic per-database view (`resolve_mongo_database_view`) reuses the
/// *parent's* `mongodb::Client` and only re-tags the target database. Shutting
/// that client down to "close the view" would tear down the parent connection
/// the user is still using — and the idle-pool reaper sweeps views by age
/// without knowing which driver they belong to, so it would do exactly that,
/// silently, five minutes after the user last touched a Mongo database.
///
/// The SQL drivers own their pools outright (a view has its own pool, and
/// possibly its own SSH tunnel), so both variants close them the same way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PoolOwnership {
    /// A top-level connection, or a standalone throwaway pool. Closing it
    /// releases everything underneath.
    Owned,
    /// A synthetic `<parent>::db::<name>` view. Closing it must not touch
    /// resources shared with the parent.
    BorrowedView,
}

impl PoolOwnership {
    /// Classify by connection id: anything carrying the synthetic `::db::`
    /// infix is a per-database view. Used by the sweep paths, which work from
    /// ids rather than from how a pool was created.
    pub fn for_id(id: &str) -> Self {
        if id.contains("::db::") {
            Self::BorrowedView
        } else {
            Self::Owned
        }
    }
}

/// Close `pool` gracefully, waiting for its connections to actually go away.
///
/// Dropping a `sqlx::Pool` is *not* equivalent: `Drop` cannot await, so it can
/// only signal the pool closed and let the sockets be torn down whenever the
/// runtime gets to them. The difference is invisible on a healthy LAN — the
/// server sees the FIN and reaps the backend — and very visible everywhere the
/// user is actually complaining: behind a connection pooler, through an SSH
/// tunnel, or during a burst where HuginnDB closes and reopens pools back to
/// back (`disconnect` → `connect` on a reconnect, or an environment switch
/// tearing down every pool before restoring the next environment's). There,
/// the old sessions can still be attached when the new ones ask for slots, and
/// the user's connection budget is transiently doubled at the worst moment.
///
/// `drop_database` already reached this conclusion in isolation and did the
/// awaited close by hand; this is that reasoning applied everywhere.
///
/// Bounded by `timeout`, because a pool whose server has gone away can take
/// the full TCP timeout to close and no teardown path should block on that.
/// A timed-out close falls back to the drop behaviour, which is what we had
/// before — never worse.
pub async fn close_pool(pool: &DbPool, ownership: PoolOwnership, timeout: Duration) {
    let closing = async {
        match pool {
            DbPool::Postgres(p) => p.close().await,
            DbPool::Mysql(p) => p.close().await,
            DbPool::Sqlite(p) => p.close().await,
            // The Mongo driver owns its own pooling; `shutdown` drains the
            // in-flight operations and closes the sockets. `clone` because it
            // consumes the client, and clones are cheap `Arc` handles — which
            // is precisely the hazard: a per-database view holds a clone of the
            // *parent's* client, so shutting it down here would close the
            // connection the user still has open. See [`PoolOwnership`].
            DbPool::Mongo(conn) => {
                if ownership == PoolOwnership::Owned {
                    conn.client.clone().shutdown().await
                }
            }
        }
    };
    let _ = tokio::time::timeout(timeout, closing).await;
}

/// Default budget for [`close_pool`]. Long enough for a healthy server to
/// acknowledge, short enough that a dead one doesn't stall a disconnect.
pub const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

/// Run `SELECT 1` against a freshly opened pool to verify credentials.
///
/// Opened with [`PoolLimits::probe`] — a credentials check needs exactly one
/// connection, and "Test" is a button users press repeatedly while fixing a
/// typo, so it must not cost five slots a go on the server they're already
/// struggling to get into.
///
/// The pool is closed explicitly (rather than left to `Drop`) and any
/// associated SSH tunnel torn down, so the test leaves nothing behind — see
/// [`close_pool`].
pub async fn smoke_test(
    profile: &ConnectionProfile,
    password: &str,
    ssh_secret: Option<String>,
    known_hosts: SharedKnownHosts,
) -> AppResult<()> {
    let (pool, _handle) = open_pool(
        profile,
        password,
        ssh_secret,
        known_hosts,
        PoolLimits::probe(),
    )
    .await?;
    let result = match &pool {
        DbPool::Postgres(p) => sqlx::query("SELECT 1").execute(p).await.map(|_| ()),
        DbPool::Mysql(p) => sqlx::query("SELECT 1").execute(p).await.map(|_| ()),
        DbPool::Sqlite(p) => sqlx::query("SELECT 1").execute(p).await.map(|_| ()),
        DbPool::Mongo(conn) => {
            return {
                let ping = crate::db::mongo::schema::ping(conn).await;
                close_pool(&pool, PoolOwnership::Owned, CLOSE_TIMEOUT).await;
                ping
            }
        }
    };
    close_pool(&pool, PoolOwnership::Owned, CLOSE_TIMEOUT).await;
    result?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The routing that keeps a Mongo per-database view from shutting down its
    /// parent's shared client. The consequence itself isn't unit-testable
    /// without a live deployment — `Client::shutdown` only becomes observable
    /// on the next operation — so this pins the classification every sweep path
    /// depends on instead.
    #[test]
    fn ownership_is_derived_from_the_synthetic_view_infix() {
        assert_eq!(
            PoolOwnership::for_id("6f1a-…-profile"),
            PoolOwnership::Owned
        );
        assert_eq!(
            PoolOwnership::for_id("6f1a-…-profile::db::analytics"),
            PoolOwnership::BorrowedView
        );
        // A database whose *name* contains the infix still resolves correctly:
        // the id is `<parent>::db::<name>`, so any match at all means a view.
        assert_eq!(
            PoolOwnership::for_id("p::db::weird::db::name"),
            PoolOwnership::BorrowedView
        );
    }

    fn profile(max_connections: Option<u32>) -> ConnectionProfile {
        ConnectionProfile {
            id: "p".into(),
            name: "p".into(),
            driver: Driver::Postgres,
            host: "localhost".into(),
            port: 5432,
            database: String::new(),
            username: "u".into(),
            ssl: false,
            ssh_tunnel: None,
            connection_string: None,
            auth_source: None,
            ephemeral: false,
            group: None,
            visible_databases: None,
            mcp_write: Default::default(),
            max_connections,
            origin_id: None,
        }
    }

    #[test]
    fn the_profile_override_beats_the_global_preference() {
        assert_eq!(
            PoolLimits::top_level(&profile(Some(3)), 10).max_connections,
            3
        );
        assert_eq!(
            PoolLimits::top_level(&profile(None), 10).max_connections,
            10
        );
    }

    #[test]
    fn limits_are_clamped_into_a_usable_range() {
        // Below the floor a batch holding a connection would deadlock the next
        // acquire, so a hand-edited 0/1 is raised rather than honoured.
        assert_eq!(
            PoolLimits::top_level(&profile(Some(0)), 5).max_connections,
            MIN_MAX_CONNECTIONS
        );
        assert_eq!(
            PoolLimits::top_level(&profile(Some(9_000)), 5).max_connections,
            MAX_MAX_CONNECTIONS
        );
    }

    #[test]
    fn a_child_never_exceeds_its_parent_but_is_not_inflated_by_it() {
        // Raising a profile's ceiling must not multiply across every database
        // the user browses: the child default still caps it.
        assert_eq!(
            PoolLimits::child(&profile(Some(20)), 5, DEFAULT_CHILD_MAX_CONNECTIONS).max_connections,
            DEFAULT_CHILD_MAX_CONNECTIONS
        );
        // Lowering it, on the other hand, must lower the children too.
        assert_eq!(
            PoolLimits::child(&profile(Some(2)), 5, 4).max_connections,
            MIN_MAX_CONNECTIONS
        );
    }
}
