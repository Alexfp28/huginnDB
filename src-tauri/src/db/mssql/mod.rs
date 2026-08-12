//! Microsoft SQL Server backend (TDS, via the `tiberius` crate).
//!
//! Structured like [`crate::db::mongo`]: everything driver-specific lives in
//! this module and the command layer keeps thin `DbPool::MsSql(_)` arms that
//! delegate here. The reason it needs its own module at all is that `sqlx`
//! dropped MSSQL after 0.6, so unlike Postgres/MySQL/SQLite there is no shared
//! `sqlx::Pool` / `sqlx::query` machinery to reuse.
//!
//! Two consequences shape the code below:
//!
//! 1. **`tiberius` has no connection pool.** Its [`tiberius::Client`] owns a
//!    single TDS session and every query takes `&mut self`. [`MsSqlPool`] is
//!    therefore a small pool of our own: a semaphore bounding concurrency, a
//!    stack of idle clients, lazy creation on demand, and a guard
//!    ([`PooledClient`]) that returns its client on drop — unless the query
//!    failed at the transport level, in which case the session is discarded
//!    rather than handed to the next caller in an undefined state.
//! 2. **The command layer never sees a `tiberius::Client`.** [`PooledClient`]
//!    exposes only the handful of shapes the callers actually need
//!    (`query_rows`, `execute`, `simple_query_sets`, `scalar_i64`), each of
//!    which classifies its own errors for the pool. That keeps the
//!    poison-on-transport-error decision in one place instead of at every call
//!    site, and keeps `tiberius` types out of `commands/`.
//!
//! Every value is bound as a nullable string, matching gotcha #5: the cell
//! editor only ever produces text and the server coerces it to the column
//! type. That coercion is right for numbers, dates, `bit` and even
//! `uniqueidentifier`, but wrong for the binary family — see
//! [`binary_convert`].

pub mod schema;
pub mod values;

use crate::db::ssh::{self, SshTunnelHandle};
use crate::error::{AppError, AppResult};
use crate::ssh_known_hosts::SharedKnownHosts;
use crate::state::{ConnectionProfile, DbPool, MsSqlAuth, MsSqlOptions};
use std::sync::Arc;
use std::time::Instant;
use tiberius::{AuthMethod, Client, Config, EncryptionLevel, Row};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

/// A live TDS session. `tiberius` speaks the `futures-io` traits, so the tokio
/// socket goes through `tokio_util`'s compatibility wrapper.
type MsSqlClient = Client<Compat<TcpStream>>;

/// Fallback bound on concurrent TDS sessions, used only when a caller opens a
/// pool without stating its limits.
///
/// The real number normally comes from [`crate::db::pool::PoolLimits`], i.e.
/// from what the server's endpoint budget granted this connection — a TDS
/// session is a real server-side connection and has to be counted like every
/// other driver's.
const DEFAULT_MAX_SESSIONS: usize = 4;

/// The `DbPool::MsSql` payload: a cheaply clonable handle onto the shared pool.
#[derive(Clone)]
pub struct MsSqlPool {
    inner: Arc<Inner>,
}

struct Inner {
    /// Everything needed to open a *new* session, so the pool can grow lazily
    /// and replace sessions the server dropped.
    cfg: Config,
    /// Whether the target is a named instance, which has to be reached through
    /// the SQL Browser rather than a fixed port.
    named_instance: bool,
    /// Concurrency bound. A permit is held for as long as a caller holds a
    /// [`PooledClient`], so `max_sessions` callers can work at once and the
    /// rest queue.
    permits: Arc<Semaphore>,
    /// Sessions that are open but not in use, each stamped with the moment it
    /// was returned. Never longer than the permit count, because a permit is
    /// required to take one out.
    ///
    /// The stamp is what lets [`MsSqlPool::reap_idle`] apply the same
    /// [`crate::db::pool::IDLE_TIMEOUT`] the `sqlx` pools enforce for
    /// themselves: without it a connection the user opened once and forgot
    /// would hold TDS sessions against the server until the app closed, which
    /// is precisely the footprint this release set out to bound.
    idle: Mutex<Vec<(MsSqlClient, Instant)>>,
}

impl MsSqlPool {
    /// Check out a session, opening a new one if none is idle.
    ///
    /// Waits for a permit when `MAX_SESSIONS` are already busy. The returned
    /// guard must be dropped (or awaited to completion) promptly — holding one
    /// across a long user interaction would starve the keepalive ping.
    pub async fn acquire(&self) -> AppResult<PooledClient> {
        let permit = self
            .inner
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| AppError::NotConnected("SQL Server pool is closed".into()))?;

        let existing = {
            let mut idle = self.inner.idle.lock().await;
            drop_expired(&mut idle);
            idle.pop().map(|(client, _)| client)
        };
        let client = match existing {
            Some(c) => c,
            None => connect(&self.inner.cfg, self.inner.named_instance).await?,
        };
        Ok(PooledClient {
            inner: self.inner.clone(),
            client: Some(client),
            _permit: permit,
        })
    }

    /// Cheap liveness probe used by [`crate::keepalive`] and the connection
    /// smoke test.
    pub async fn ping(&self) -> AppResult<()> {
        let mut c = self.acquire().await?;
        let result = c.simple_query_sets("SELECT 1").await.map(|_| ());
        drop(c);
        // The keepalive is the only thing that reliably touches an idle
        // connection, so it doubles as the sweep that gives sessions the user
        // has stopped using back to the server. `acquire` reaps too, but a
        // pool nobody queries would never call it.
        self.reap_idle().await;
        result
    }

    /// Close sessions that have sat unused past
    /// [`crate::db::pool::IDLE_TIMEOUT`].
    pub async fn reap_idle(&self) {
        drop_expired(&mut *self.inner.idle.lock().await);
    }

    /// Close the pool: refuse new checkouts and drop every idle session.
    ///
    /// The `sqlx` drivers get this from `Pool::close`, and it is not
    /// cosmetic — `crate::db::pool::close_pool` is what makes a disconnect or
    /// an environment switch give its sockets back to the server *before* the
    /// replacement session is opened, instead of leaving that to `Drop` at an
    /// unspecified later point. Closing the semaphore also unblocks anything
    /// queued on `acquire`, which then reports `NotConnected` rather than
    /// waiting on a pool that will never serve it.
    ///
    /// Sessions currently checked out are not interrupted; each is dropped
    /// (not returned to `idle`) when its holder finishes, because
    /// `Semaphore::close` makes the return path unreachable for new callers
    /// and the idle stack is drained here.
    pub async fn close(&self) {
        self.inner.permits.close();
        self.inner.idle.lock().await.clear();
    }

    // --- one-shot conveniences -------------------------------------------
    //
    // Acquire, run, release. The command layer's `match &pool` arms are
    // expressions, so a two-step `acquire()?` + call would either need a `?`
    // that skips the surrounding Console logging or a nested match at every
    // site. These keep each arm a single expression, which is what the other
    // drivers' `sqlx` one-liners look like.

    /// Parameterised read.
    pub async fn query_all(&self, sql: &str, params: &[Option<String>]) -> AppResult<Vec<Row>> {
        self.acquire().await?.query_rows(sql, params).await
    }

    /// Parameterised write, returning rows affected.
    pub async fn execute_params(&self, sql: &str, params: &[Option<String>]) -> AppResult<u64> {
        self.acquire().await?.execute(sql, params).await
    }

    /// Unparameterised write (ad-hoc SQL from the editor), returning rows
    /// affected.
    pub async fn execute_simple(&self, sql: &str) -> AppResult<u64> {
        self.acquire().await?.simple_execute(sql).await
    }

    /// Unparameterised read returning every result set the batch produced.
    pub async fn query_sets(&self, sql: &str) -> AppResult<Vec<Vec<Row>>> {
        self.acquire().await?.simple_query_sets(sql).await
    }

    /// Parameterised single-value read (the `COUNT(*)` shape).
    pub async fn scalar(&self, sql: &str, params: &[Option<String>]) -> AppResult<Option<i64>> {
        self.acquire().await?.scalar_i64(sql, params).await
    }
}

/// Drop every idle session older than [`crate::db::pool::IDLE_TIMEOUT`].
///
/// Dropping a `tiberius::Client` closes its socket, so this is the whole
/// mechanism — there is no `close()` to await, and nothing else holds the
/// session once it leaves the vector.
fn drop_expired(idle: &mut Vec<(MsSqlClient, Instant)>) {
    idle.retain(|(_, since)| since.elapsed() < crate::db::pool::IDLE_TIMEOUT);
}

/// A checked-out session. Derefs to nothing on purpose: callers go through the
/// methods below so every error is classified for the pool exactly once.
pub struct PooledClient {
    inner: Arc<Inner>,
    /// `None` only after [`Self::classify`] has decided this session is unusable.
    client: Option<MsSqlClient>,
    _permit: OwnedSemaphorePermit,
}

impl PooledClient {
    /// Run a parameterised statement and collect the first result set.
    ///
    /// Parameters are bound as nullable strings (see the module docs). `sql`
    /// must use `@P1..@Pn` placeholders, which is what
    /// [`crate::db::sql::Dialect::placeholder`] emits for this dialect.
    pub async fn query_rows(
        &mut self,
        sql: &str,
        params: &[Option<String>],
    ) -> AppResult<Vec<Row>> {
        let borrowed: Vec<Option<&str>> = params.iter().map(|p| p.as_deref()).collect();
        let bound: Vec<&dyn tiberius::ToSql> =
            borrowed.iter().map(|p| p as &dyn tiberius::ToSql).collect();
        let client = self.client_mut()?;
        let result = async {
            let stream = client.query(sql, &bound).await?;
            stream.into_first_result().await
        }
        .await;
        self.classify(result)
    }

    /// Run a parameterised statement for its side effect, returning the total
    /// number of rows affected across every statement in the batch.
    pub async fn execute(&mut self, sql: &str, params: &[Option<String>]) -> AppResult<u64> {
        let borrowed: Vec<Option<&str>> = params.iter().map(|p| p.as_deref()).collect();
        let bound: Vec<&dyn tiberius::ToSql> =
            borrowed.iter().map(|p| p as &dyn tiberius::ToSql).collect();
        let client = self.client_mut()?;
        let result = client
            .execute(sql, &bound)
            .await
            .map(|r| r.rows_affected().iter().sum());
        self.classify(result)
    }

    /// Run SQL with no parameters and return *every* result set it produced.
    ///
    /// Used for the query editor, where the text is whatever the user typed and
    /// a single batch can legitimately return several result sets.
    pub async fn simple_query_sets(&mut self, sql: &str) -> AppResult<Vec<Vec<Row>>> {
        let client = self.client_mut()?;
        let result = async {
            let stream = client.simple_query(sql).await?;
            stream.into_results().await
        }
        .await;
        self.classify(result)
    }

    /// Run SQL with no parameters for its side effect (row count only).
    pub async fn simple_execute(&mut self, sql: &str) -> AppResult<u64> {
        let client = self.client_mut()?;
        let result = client
            .execute(sql, &[])
            .await
            .map(|r| r.rows_affected().iter().sum());
        self.classify(result)
    }

    /// First column of the first row as an `i64` — the `COUNT(*)` shape.
    /// `None` when the query returned no rows or a NULL.
    pub async fn scalar_i64(
        &mut self,
        sql: &str,
        params: &[Option<String>],
    ) -> AppResult<Option<i64>> {
        let rows = self.query_rows(sql, params).await?;
        Ok(rows.first().and_then(values::first_i64))
    }

    fn client_mut(&mut self) -> AppResult<&mut MsSqlClient> {
        self.client.as_mut().ok_or_else(|| {
            AppError::NotConnected(
                "the SQL Server session was dropped after a transport error".into(),
            )
        })
    }

    /// Turn a `tiberius` result into an [`AppResult`], discarding the session
    /// when the failure means the TDS stream is no longer usable.
    ///
    /// A [`tiberius::error::Error::Server`] is the server rejecting a
    /// statement — syntax error, permission denied, constraint violation — and
    /// leaves the session perfectly healthy. Anything else (I/O, protocol,
    /// TLS, encoding) means we no longer know where we are in the stream, so
    /// reusing it would corrupt the *next* caller's query rather than this one.
    fn classify<T>(&mut self, result: tiberius::Result<T>) -> AppResult<T> {
        match result {
            Ok(v) => Ok(v),
            Err(e) => {
                if !matches!(e, tiberius::error::Error::Server(_)) {
                    self.client = None;
                }
                Err(AppError::MsSql(e))
            }
        }
    }
}

impl Drop for PooledClient {
    fn drop(&mut self) {
        if let Some(client) = self.client.take() {
            // `try_lock` cannot fail in practice (the lock is only ever held
            // for a push/pop), and dropping the session on contention is
            // strictly better than blocking in `Drop`.
            if let Ok(mut idle) = self.inner.idle.try_lock() {
                idle.push((client, Instant::now()));
            }
        }
    }
}

/// Wrap `placeholder` so a textual value lands correctly in a binary column,
/// or return it unchanged.
///
/// This is the SQL Server twin of the MySQL `BIT` problem (gotcha #15). Values
/// travel as text, and T-SQL's implicit nvarchar → `varbinary` conversion
/// reinterprets the *characters* of the string as bytes — so saving the
/// `0x4A2B` that [`values::mssql_value`] renders for a binary cell would store
/// the ASCII of `"0x4A2B"` rather than the two bytes it names. `CONVERT` with
/// style `1` is the form that parses a `0x`-prefixed hex string, which makes
/// the round-trip exact. `CONVERT(varbinary(max), NULL, 1)` is still NULL, so
/// the set-to-NULL path is unaffected.
///
/// `column_type` is the frontend's type hint (see `RowValue.columnType`). When
/// it is absent — a stale schema cache — the value is bound as plain text, the
/// same degradation the other drivers accept for their type-specific casts.
pub fn binary_convert(column_type: Option<&str>, placeholder: &str) -> String {
    let is_binary = column_type
        .map(|t| {
            let t = t.trim().to_ascii_lowercase();
            t.starts_with("varbinary")
                || t.starts_with("binary")
                || t == "image"
                || t == "timestamp"
                || t == "rowversion"
        })
        .unwrap_or(false);
    if is_binary {
        format!("CONVERT(varbinary(max), {placeholder}, 1)")
    } else {
        placeholder.to_string()
    }
}

/// Whether `e` is the server refusing an `OUTPUT` clause because the target
/// table has triggers (error 334).
///
/// `INSERT ... OUTPUT INSERTED.<pk>` is how [`crate::commands::query::insert_row`]
/// recovers a generated key, and it is the only form that works for
/// non-identity keys — but SQL Server rejects it outright on a table with any
/// enabled trigger, with no way to detect that up front short of querying
/// `sys.triggers` before every insert. Matching the specific error code lets
/// the caller fall back to `SCOPE_IDENTITY()` for exactly that case, without
/// swallowing genuine failures like a constraint violation.
pub fn is_output_clause_conflict(e: &AppError) -> bool {
    matches!(e, AppError::MsSql(tiberius::error::Error::Server(t)) if t.code() == 334)
}

/// Open one TDS session against `cfg`.
async fn connect(cfg: &Config, named_instance: bool) -> AppResult<MsSqlClient> {
    let tcp = if named_instance {
        // Resolves the instance's dynamic port through the SQL Browser
        // (UDP 1434) and connects to it.
        use tiberius::SqlBrowser;
        TcpStream::connect_named(cfg)
            .await
            .map_err(AppError::MsSql)?
    } else {
        TcpStream::connect(cfg.get_addr())
            .await
            .map_err(AppError::Io)?
    };
    tcp.set_nodelay(true)?;
    Ok(Client::connect(cfg.clone(), tcp.compat_write()).await?)
}

/// Build the `tiberius` [`Config`] for `profile`.
///
/// `host`/`port` are passed explicitly so an SSH tunnel can substitute
/// `127.0.0.1:<local-port>` without mutating the profile — same contract as
/// [`crate::db::pool::build_url`]. Returns the config plus whether a named
/// instance has to be resolved through the SQL Browser.
fn build_config(
    profile: &ConnectionProfile,
    password: &str,
    host: &str,
    port: u16,
) -> AppResult<(Config, bool)> {
    let opts = profile.mssql.clone().unwrap_or_default();
    let mut cfg = Config::new();
    cfg.host(host);
    cfg.port(port);
    // A blank database is a legitimate choice ("connect to the server, then let
    // me pick from the tree"); SQL Server falls back to the login's default
    // database, and the explorer opens per-database child pools from there.
    if !profile.database.is_empty() {
        cfg.database(&profile.database);
    }
    cfg.application_name("HuginnDB");

    let named_instance = match opts.instance.as_deref().map(str::trim) {
        Some(inst) if !inst.is_empty() => {
            cfg.instance_name(inst);
            true
        }
        _ => false,
    };

    // Be explicit rather than relying on tiberius's default (`Required` when
    // built with TLS): an unchecked SSL box has to mean "no TLS", the same
    // rationale as the `sslmode`/`ssl-mode` handling for Postgres/MySQL.
    cfg.encryption(if profile.ssl {
        EncryptionLevel::Required
    } else {
        EncryptionLevel::NotSupported
    });
    // Most on-prem instances present a self-signed certificate, so without this
    // toggle an encrypted connection simply cannot be established.
    if opts.trust_server_certificate {
        cfg.trust_cert();
    }

    cfg.authentication(auth_method(&opts, &profile.username, password)?);
    Ok((cfg, named_instance))
}

/// Translate the profile's auth mode into a `tiberius` [`AuthMethod`].
///
/// `AuthMethod::Windows` (NTLM with an explicit `DOMAIN\user` and password) is
/// `cfg(windows)`-gated inside tiberius, so on other platforms the mode is
/// refused with an actionable message instead of failing to compile. Integrated
/// / SSPI (log in as the current Windows user, no credentials typed) and Entra
/// ID tokens are deliberately not offered yet.
fn auth_method(opts: &MsSqlOptions, username: &str, password: &str) -> AppResult<AuthMethod> {
    match opts.auth {
        MsSqlAuth::Sql => Ok(AuthMethod::sql_server(username, password)),
        MsSqlAuth::Windows => {
            #[cfg(windows)]
            {
                Ok(AuthMethod::windows(username, password))
            }
            #[cfg(not(windows))]
            {
                let _ = (username, password);
                Err(AppError::UnsupportedDriver(
                    "Windows authentication for SQL Server is only available on Windows builds"
                        .into(),
                ))
            }
        }
    }
}

/// Open a pool for `profile`, bringing up its SSH tunnel first when configured.
///
/// Mirrors [`crate::db::mongo::open_pool`]'s signature so the connection
/// lifecycle in `commands::connection` stays uniform across drivers: the
/// returned [`SshTunnelHandle`] must outlive the pool.
pub async fn open_pool(
    profile: &ConnectionProfile,
    password: &str,
    ssh_secret: Option<String>,
    known_hosts: SharedKnownHosts,
    limits: crate::db::pool::PoolLimits,
) -> AppResult<(DbPool, Option<SshTunnelHandle>)> {
    let (host, port, handle) = match profile.ssh_tunnel.as_ref() {
        Some(tunnel) => {
            let h = ssh::open_tunnel(tunnel, ssh_secret, &profile.host, profile.port, known_hosts)
                .await?;
            ("127.0.0.1".to_string(), h.local_port, Some(h))
        }
        None => (profile.host.clone(), profile.port, None),
    };

    let (cfg, named_instance) = build_config(profile, password, &host, port)?;
    // A named instance is resolved through the SQL Browser, which the tunnel
    // does not forward (it is a separate UDP service on 1434). Fail loudly
    // rather than silently connecting to the wrong port.
    if named_instance && handle.is_some() {
        return Err(AppError::InvalidInput(
            "a named SQL Server instance cannot be reached through an SSH tunnel — \
             tunnel the instance's own TCP port and leave the instance name empty"
                .into(),
        ));
    }

    // Honour the grant the endpoint registry made for this server rather than
    // a constant of our own: a TDS session costs the server exactly what a
    // Postgres backend does, and a driver that sized itself was how the
    // footprint became unbounded in the first place (see `crate::db::pool`).
    let max_sessions = usize::try_from(limits.max_connections)
        .unwrap_or(DEFAULT_MAX_SESSIONS)
        .max(1);
    let pool = MsSqlPool {
        inner: Arc::new(Inner {
            cfg,
            named_instance,
            permits: Arc::new(Semaphore::new(max_sessions)),
            idle: Mutex::new(Vec::new()),
        }),
    };
    // Fail fast on bad credentials / unreachable host, like the `sqlx` pools'
    // eager `connect()` does, instead of surfacing the error on first query.
    pool.ping().await?;
    Ok((DbPool::MsSql(pool), handle))
}

// A per-database child pool for the multi-DB explorer needs no code here:
// `commands::connection::open_database_view` already clones the parent profile
// with `database` substituted and calls `crate::db::pool::open_pool` again,
// which lands back in this module. That path also reuses the parent's cached
// credentials and opens its own tunnel, exactly like the Postgres/MySQL case.

#[cfg(test)]
mod tests {
    use super::binary_convert;

    #[test]
    fn wraps_only_binary_columns_in_a_hex_convert() {
        // The `0x…` text `mssql_value` produces for a binary cell has to be
        // parsed back as hex, not stored as the characters of the string.
        assert_eq!(
            binary_convert(Some("varbinary(max)"), "@P1"),
            "CONVERT(varbinary(max), @P1, 1)"
        );
        assert_eq!(
            binary_convert(Some("BINARY(16)"), "@P1"),
            "CONVERT(varbinary(max), @P1, 1)"
        );
        assert_eq!(
            binary_convert(Some("image"), "@P1"),
            "CONVERT(varbinary(max), @P1, 1)"
        );
    }

    #[test]
    fn leaves_every_other_type_to_the_implicit_conversion() {
        for t in [
            "int",
            "nvarchar(50)",
            "bit",
            "datetime2",
            "uniqueidentifier",
        ] {
            assert_eq!(binary_convert(Some(t), "@P1"), "@P1", "type {t}");
        }
        // No type hint (stale schema cache): bind as plain text rather than
        // guessing, matching the other drivers' degradation.
        assert_eq!(binary_convert(None, "@P1"), "@P1");
    }
}
