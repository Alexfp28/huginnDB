//! Background keepalive pings for active connection pools.
//!
//! An idle server-backed connection (Postgres, MySQL) can be silently
//! dropped by a NAT gateway, cloud load balancer, or corporate firewall
//! well before the user notices — the pool object survives in memory, but
//! the next query fails with an opaque driver error. A periodic
//! lightweight ping keeps the underlying socket (and, for tunnelled
//! connections, the SSH channel) exercised often enough to avoid most
//! idle-timeout drops, and doubles as the detector for the ones it can't
//! prevent: a failed ping is reported to the frontend via
//! [`CONNECTION_LOST_EVENT`] so the connection list can offer a one-click
//! reconnect instead of the user discovering it mid-query.
//!
//! Scope: only top-level profile connections (`connect` / `disconnect` in
//! `commands::connection`) get a heartbeat — the synthetic per-database
//! pools opened by `open_database_view` share the same underlying
//! TCP/tunnel liveness as their parent and are cheap to reopen on demand,
//! so a second heartbeat per open database would be redundant background
//! load for no real benefit.
//!
//! Lifecycle mirrors [`crate::db::ssh::SshTunnelHandle`]: the returned
//! [`KeepaliveHandle`] owns a [`CancellationToken`], cancelled on `Drop`.
//! Stashing it in [`crate::state::ActivePool`] alongside the SSH handle
//! means the loop stops automatically whenever that pool is removed or
//! replaced — no separate bookkeeping needed in `AppState`.

use crate::error::AppResult;
use crate::log_bus::{self, LogEntry, LogKind};
use crate::state::DbPool;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

/// Default ping interval. Short enough to stay well under common
/// NAT/load-balancer idle timeouts (typically 5+ minutes), long enough that
/// the ping traffic is negligible.
///
/// User-overridable via `connections.keepaliveSecs` (`0` disables the
/// heartbeat). Note the deliberate relationship with
/// [`crate::db::pool::IDLE_TIMEOUT`]: pinging more often than the pool reaps
/// means one connection per active pool never goes idle long enough to be
/// closed. That is the point — the next click is instant and a dead connection
/// is found before a query hits it — but it is a real, permanent socket per
/// open connection, which is why it can be turned off.
pub const DEFAULT_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(180);

/// Tauri event name the frontend subscribes to.
pub const CONNECTION_LOST_EVENT: &str = "huginndb://connection-lost";

/// Payload for [`CONNECTION_LOST_EVENT`].
#[derive(Debug, Clone, Serialize)]
pub struct ConnectionLostPayload {
    pub connection_id: String,
    pub error: String,
}

/// Owns the background keepalive task for one connection pool. Dropping it
/// (pool removed on `disconnect`, or replaced by a fresh `connect` /
/// reconnect) cancels the loop.
pub struct KeepaliveHandle {
    cancel: CancellationToken,
}

impl Drop for KeepaliveHandle {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// Spawn a background task that pings `pool` every `interval`.
///
/// A failed ping is reported once via [`CONNECTION_LOST_EVENT`] and ends
/// the loop — the pool is left in place (still broken) until the user
/// reconnects, which opens a fresh pool and starts a new heartbeat.
///
/// `last_used` is the [`crate::state::ActivePool`]'s usage stamp; a tick whose
/// interval the user's own queries already spanned is skipped, since traffic
/// that just succeeded is better proof of liveness than a `SELECT 1` and there
/// is no reason to pay for both.
///
/// Returns `None` when `interval` is zero — the user has turned the heartbeat
/// off — so no task is spawned at all.
pub fn spawn(
    app: AppHandle,
    connection_id: String,
    pool: DbPool,
    interval: Duration,
    last_used: Arc<AtomicU64>,
) -> Option<KeepaliveHandle> {
    if interval.is_zero() {
        return None;
    }
    let cancel = CancellationToken::new();
    let cancel_loop = cancel.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_loop.cancelled() => return,
                _ = tokio::time::sleep(interval) => {}
            }
            let idle = crate::state::now_millis().saturating_sub(last_used.load(Ordering::Relaxed));
            if idle < interval.as_millis() as u64 {
                continue;
            }
            if let Err(e) = ping(&pool).await {
                let msg = e.to_string();
                log_bus::broadcast(
                    &app,
                    LogEntry::new(LogKind::Connection)
                        .connection_id(connection_id.clone())
                        .message("keepalive: ping failed, flagging connection as lost")
                        .error(&msg),
                );
                let _ = app.emit(
                    CONNECTION_LOST_EVENT,
                    ConnectionLostPayload {
                        connection_id: connection_id.clone(),
                        error: msg,
                    },
                );
                return;
            }
        }
    });
    Some(KeepaliveHandle { cancel })
}

/// One lightweight round-trip per driver — cheap enough to run every tick
/// without measurable load on the server.
async fn ping(pool: &DbPool) -> AppResult<()> {
    match pool {
        DbPool::Postgres(p) => sqlx::query("SELECT 1").execute(p).await.map(|_| ())?,
        DbPool::Mysql(p) => sqlx::query("SELECT 1").execute(p).await.map(|_| ())?,
        DbPool::Sqlite(p) => sqlx::query("SELECT 1").execute(p).await.map(|_| ())?,
        DbPool::Mongo(conn) => crate::db::mongo::schema::ping(conn).await?,
        // Runs `SELECT 1` on a pooled session; a dead session is discarded by
        // the pool rather than handed to the next caller (see `db::mssql`).
        DbPool::MsSql(p) => p.ping().await?,
    };
    Ok(())
}
