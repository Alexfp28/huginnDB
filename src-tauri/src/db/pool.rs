//! Pool construction and connection URL assembly.
//!
//! These helpers are kept driver-agnostic: callers describe what they want
//! via a [`ConnectionProfile`] + password and receive back a typed
//! [`DbPool`].

use crate::error::AppResult;
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
/// For SQLite the `database` field is interpreted as a file path; for the
/// server-backed drivers it is the catalog/schema name plus host info.
pub fn build_url(profile: &ConnectionProfile, password: &str) -> String {
    let user = url_encode(&profile.username);
    let pwd = url_encode(password);

    match profile.driver {
        Driver::Postgres => format!(
            "postgres://{user}:{pwd}@{host}:{port}/{db}{ssl}",
            host = profile.host,
            port = profile.port,
            db = profile.database,
            ssl = if profile.ssl { "?sslmode=require" } else { "" },
        ),
        Driver::Mysql => format!(
            "mysql://{user}:{pwd}@{host}:{port}/{db}{ssl}",
            host = profile.host,
            port = profile.port,
            db = profile.database,
            ssl = if profile.ssl { "?ssl-mode=REQUIRED" } else { "" },
        ),
        Driver::Sqlite => format!("sqlite://{}", profile.database),
    }
}

/// Open a fresh pool for `profile`, using `password` for authentication.
///
/// The returned [`DbPool`] wraps the underlying driver-specific pool. The
/// caller is responsible for storing it inside [`crate::state::ActiveConnections`]
/// if it intends to keep the connection alive.
pub async fn open_pool(profile: &ConnectionProfile, password: &str) -> AppResult<DbPool> {
    let url = build_url(profile, password);
    match profile.driver {
        Driver::Postgres => Ok(DbPool::Postgres(
            PgPoolOptions::new()
                .max_connections(MAX_CONNECTIONS_SERVER)
                .connect(&url)
                .await?,
        )),
        Driver::Mysql => Ok(DbPool::Mysql(
            MySqlPoolOptions::new()
                .max_connections(MAX_CONNECTIONS_SERVER)
                .connect(&url)
                .await?,
        )),
        Driver::Sqlite => Ok(DbPool::Sqlite(
            SqlitePoolOptions::new()
                .max_connections(MAX_CONNECTIONS_SQLITE)
                .connect(&url)
                .await?,
        )),
    }
}

/// Run `SELECT 1` against a freshly opened pool to verify credentials.
///
/// Closes the pool after the round-trip so the test does not leave a
/// lingering connection.
pub async fn smoke_test(profile: &ConnectionProfile, password: &str) -> AppResult<()> {
    let pool = open_pool(profile, password).await?;
    match &pool {
        DbPool::Postgres(p) => sqlx::query("SELECT 1").execute(p).await.map(|_| ())?,
        DbPool::Mysql(p) => sqlx::query("SELECT 1").execute(p).await.map(|_| ())?,
        DbPool::Sqlite(p) => sqlx::query("SELECT 1").execute(p).await.map(|_| ())?,
    };
    Ok(())
}
