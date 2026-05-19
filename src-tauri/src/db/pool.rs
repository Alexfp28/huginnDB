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

/// Maximum simultaneous connections per pool for server-backed drivers.
///
/// Kept conservative because Huginn is a single-user desktop client; we
/// don't expect more than a couple of in-flight queries at once.
const MAX_CONNECTIONS_SERVER: u32 = 5;

/// SQLite is single-file and benefits from a small pool to avoid lock
/// contention on writes.
const MAX_CONNECTIONS_SQLITE: u32 = 1;

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
            format!(
                "postgres://{user}:{pwd}@{host}:{port}/{db}{ssl}",
                ssl = if profile.ssl { "?sslmode=require" } else { "" },
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
            format!(
                "mysql://{user}:{pwd}@{host}:{port}{path}{ssl}",
                ssl = if profile.ssl {
                    "?ssl-mode=REQUIRED"
                } else {
                    ""
                },
            )
        }
        Driver::Sqlite => format!("sqlite://{}", profile.database),
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
) -> AppResult<(DbPool, Option<SshTunnelHandle>)> {
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
            PgPoolOptions::new()
                .max_connections(MAX_CONNECTIONS_SERVER)
                .connect(&url)
                .await?,
        ),
        Driver::Mysql => DbPool::Mysql(
            MySqlPoolOptions::new()
                .max_connections(MAX_CONNECTIONS_SERVER)
                .connect(&url)
                .await?,
        ),
        Driver::Sqlite => DbPool::Sqlite(
            SqlitePoolOptions::new()
                .max_connections(MAX_CONNECTIONS_SQLITE)
                .connect(&url)
                .await?,
        ),
    };
    Ok((pool, handle))
}

/// Run `SELECT 1` against a freshly opened pool to verify credentials.
///
/// Closes the pool — and tears down any associated SSH tunnel — after the
/// round-trip, so the test does not leave lingering resources behind.
pub async fn smoke_test(
    profile: &ConnectionProfile,
    password: &str,
    ssh_secret: Option<String>,
    known_hosts: SharedKnownHosts,
) -> AppResult<()> {
    let (pool, _handle) = open_pool(profile, password, ssh_secret, known_hosts).await?;
    match &pool {
        DbPool::Postgres(p) => sqlx::query("SELECT 1").execute(p).await.map(|_| ())?,
        DbPool::Mysql(p) => sqlx::query("SELECT 1").execute(p).await.map(|_| ())?,
        DbPool::Sqlite(p) => sqlx::query("SELECT 1").execute(p).await.map(|_| ())?,
    };
    Ok(())
}
