//! Background eviction of idle per-database connection pools.
//!
//! Browsing a multi-database server opens one whole extra pool per database
//! (`<parent>::db::<name>`, see `commands::connection::open_database_view`).
//! Until 1.13.0 nothing ever closed them: the only removal paths were the
//! *parent*'s `disconnect` and `drop_database`, so a database expanded once at
//! 09:00 — or, worse, a dozen of them opened at once by a single keystroke in
//! the schema explorer's cross-database search — still held a pool at 18:00.
//!
//! That is the difference between a footprint that tracks *what the user is
//! doing* and one that tracks *everything the user has ever done in this
//! session*, and it is a large part of why HuginnDB was tipping shared servers
//! over their connection limit alongside the rest of a developer's toolchain.
//!
//! This module closes the gap with the smallest policy that fixes it:
//!
//! * **TTL** — a child pool untouched for `connections.childIdleTtlSecs` is
//!   closed. Reopening costs one round trip and the frontend's schema cache is
//!   untouched, so the user cannot tell the difference.
//! * **LRU cap** — a connection may hold at most `connections.maxChildPools`
//!   children; past that the longest-unused are closed regardless of age. The
//!   TTL alone doesn't bound the *burst* (twelve databases opened in one
//!   second are all equally fresh), and the burst is what trips the server.
//!
//! Top-level pools are deliberately never reaped here: they represent a
//! connection the user explicitly opened and the UI shows as connected, so
//! closing one behind their back would be a lie. The MCP sidecar, which has no
//! such UI and no user watching, *does* reap its top-level pools — see
//! `crate::mcp::spawn_idle_pool_reaper`.

use crate::db::pool::{close_pool, PoolOwnership, CLOSE_TIMEOUT};
use crate::log_bus::{self, LogEntry, LogKind};
use crate::state::AppState;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// How often the reaper wakes up. Coarse on purpose: the TTL is measured in
/// minutes, so a sweep granularity of a minute costs nothing and keeps the
/// idle-process wakeup count low.
const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

/// Start the reaper. Called once from the Tauri `setup` hook.
///
/// Uses `tauri::async_runtime::spawn` rather than `tokio::spawn` because
/// `setup` does not run inside a tokio reactor context — unlike
/// [`crate::keepalive::spawn`], which is only ever called from an `async`
/// command and so already has one.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(SWEEP_INTERVAL).await;
            sweep(&app).await;
        }
    });
}

/// One eviction pass. Split out from the loop so it is directly testable and
/// so a future "Close idle pools" button can call it on demand.
async fn sweep(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (ttl_secs, max_children) = {
        let prefs = state.prefs.read();
        (
            prefs.connections.child_idle_ttl_secs,
            prefs.connections.max_child_pools,
        )
    };

    let victims = select_victims(
        state.inner(),
        crate::state::now_millis(),
        ttl_secs,
        max_children,
    );
    if victims.is_empty() {
        return;
    }

    // Take the pools out under the write lock, then close them *after* it is
    // released: `close_pool` awaits, and holding a `parking_lot` guard across
    // an await point would block every command that needs the map — including
    // the ones whose queries we're waiting on.
    let removed: Vec<_> = {
        let mut conns = state.connections.write();
        victims
            .iter()
            .filter_map(|id| conns.remove(id).map(|active| (id.clone(), active)))
            .collect()
    };

    for (id, active) in removed {
        close_pool(&active.pool, PoolOwnership::for_id(&id), CLOSE_TIMEOUT).await;
        log_bus::broadcast(
            app,
            LogEntry::new(LogKind::Connection)
                .connection_id(id)
                .message("closed idle per-database pool"),
        );
    }
}

/// Decide which child pools to close, without touching them.
///
/// Kept pure (no locks held on return, no I/O) so the policy — the part worth
/// getting right — is separable from the teardown mechanics.
///
/// Note the read lock is taken through the accessors that do **not** stamp
/// `last_used`; going through `ActiveConnections::get` here would refresh the
/// very timestamps the decision is based on and the reaper would never fire.
fn select_victims(state: &AppState, now: u64, ttl_secs: u32, max_children: u32) -> Vec<String> {
    let conns = state.connections.read();
    let mut victims: Vec<String> = if ttl_secs == 0 {
        Vec::new()
    } else {
        conns.idle_children(now, u64::from(ttl_secs) * 1_000)
    };

    if max_children > 0 {
        // Apply the cap per parent. A global cap would let a connection the
        // user is actively browsing evict another one's children, which is
        // both surprising and useless — the servers may be different, so the
        // budget being defended isn't shared.
        for parent in conns.ids() {
            if parent.contains("::db::") {
                continue;
            }
            let children = conns.children_by_lru(&parent);
            let excess = children.len().saturating_sub(max_children as usize);
            // `children_by_lru` is longest-idle first, so the excess is the
            // front of the list.
            victims.extend(children.into_iter().take(excess));
        }
    }

    victims.sort();
    victims.dedup();
    victims
}

/// Close every synthetic per-database child pool of `parent_id`, gracefully.
///
/// Shared by `disconnect` and by the environment-switch teardown so both get
/// the awaited close described on [`close_pool`] instead of a bare `Drop`.
/// Returns the ids that were actually closed.
pub async fn close_children(state: &AppState, parent_id: &str) -> Vec<String> {
    let prefix = format!("{parent_id}::db::");
    let removed: Vec<_> = {
        let mut conns = state.connections.write();
        let ids: Vec<String> = conns
            .ids()
            .into_iter()
            .filter(|id| id.starts_with(&prefix))
            .collect();
        ids.into_iter()
            .filter_map(|id| conns.remove(&id).map(|active| (id, active)))
            .collect()
    };
    let mut closed = Vec::with_capacity(removed.len());
    for (id, active) in removed {
        // Always `BorrowedView` — these are `<parent>::db::…` by construction,
        // and the parent (closed by the caller right after) owns any shared
        // driver client.
        close_pool(&active.pool, PoolOwnership::BorrowedView, CLOSE_TIMEOUT).await;
        closed.push(id);
    }
    closed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{ActivePool, DbPool};
    use std::sync::atomic::Ordering;

    /// A pool object that is never actually used for I/O — `select_victims`
    /// only reads ids and timestamps, so a lazily-constructed SQLite pool
    /// against a path that is never opened is enough.
    ///
    /// Still needs a tokio reactor: `connect_lazy` spawns the pool's own
    /// maintenance task up front, which is why every test here is a
    /// `#[tokio::test]` despite exercising purely synchronous logic.
    fn dummy_pool() -> DbPool {
        DbPool::Sqlite(
            sqlx::sqlite::SqlitePoolOptions::new()
                .connect_lazy("sqlite::memory:")
                .expect("lazy pool construction does not touch the filesystem"),
        )
    }

    /// Simulated "current time" for the tests. Any value comfortably past the
    /// largest age below; `now_millis()` itself starts near zero in a unit
    /// test (its epoch is the first call, which *is* the test), so ages have
    /// to be expressed against a stated `now` rather than subtracted from the
    /// real clock.
    const NOW: u64 = 10_000_000;

    fn insert(state: &AppState, id: &str, idle_millis: u64) {
        let active = ActivePool::bare(dummy_pool());
        active
            .last_used
            .store(NOW.saturating_sub(idle_millis), Ordering::Relaxed);
        state.connections.write().insert(id.to_string(), active);
    }

    #[tokio::test]
    async fn ttl_evicts_only_stale_children() {
        let state = AppState::new();
        insert(&state, "parent", 999_999);
        insert(&state, "parent::db::cold", 10_000);
        insert(&state, "parent::db::warm", 500);

        let victims = select_victims(&state, NOW, 5, 0);
        // The parent is stale by any measure and must still survive: only an
        // explicit disconnect closes a connection the user can see.
        assert_eq!(victims, vec!["parent::db::cold".to_string()]);
    }

    #[tokio::test]
    async fn ttl_zero_disables_reaping() {
        let state = AppState::new();
        insert(&state, "parent::db::ancient", 60 * 60 * 1000);
        assert!(select_victims(&state, NOW, 0, 0).is_empty());
    }

    #[tokio::test]
    async fn cap_evicts_longest_unused_regardless_of_age() {
        let state = AppState::new();
        insert(&state, "parent", 0);
        // All four are far younger than the TTL — this is the burst case the
        // cap exists for (one keystroke fanning out across every database).
        insert(&state, "parent::db::a", 400);
        insert(&state, "parent::db::b", 300);
        insert(&state, "parent::db::c", 200);
        insert(&state, "parent::db::d", 100);

        let victims = select_victims(&state, NOW, 600, 2);
        assert_eq!(
            victims,
            vec!["parent::db::a".to_string(), "parent::db::b".to_string()]
        );
    }

    #[tokio::test]
    async fn cap_is_per_parent_not_global() {
        let state = AppState::new();
        insert(&state, "one", 0);
        insert(&state, "two", 0);
        insert(&state, "one::db::a", 400);
        insert(&state, "one::db::b", 300);
        insert(&state, "two::db::a", 400);
        insert(&state, "two::db::b", 300);

        // Two children each, cap of two: a global cap would have evicted half
        // of them.
        assert!(select_victims(&state, NOW, 600, 2).is_empty());
    }
}
