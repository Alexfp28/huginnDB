//! Pulse commands — server health, and later the per-view reads behind it.
//!
//! Same shape as [`crate::commands::schema`]: a thin `#[tauri::command]`
//! wrapper that resolves the database view and applies the standard timeout,
//! over an `_inner` core that dispatches on the pool. The core is separate so
//! the MCP bridge can call it without a `Window` (see [`crate::bridge::exec`]).

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::pulse::PulseHealth;
use crate::state::{AppState, DbPool};

/// A driver Pulse does not read yet.
///
/// Returned rather than an empty snapshot on purpose: an empty snapshot is
/// indistinguishable from a server answering zero to everything, and the panel
/// would render a wall of `0`s for a connection it simply cannot measure. The
/// frontend turns this into an explicit "not supported yet" state, the same
/// call the Security panel makes for SQLite's absent user model.
fn unsupported(driver: &str) -> AppError {
    AppError::UnsupportedDriver(format!(
        "Pulse does not read {driver} statistics yet — MySQL and MongoDB only"
    ))
}

pub async fn pulse_health_inner(state: &AppState, connection_id: &str) -> AppResult<PulseHealth> {
    match state.pool_for(connection_id)? {
        DbPool::Mysql(p) => crate::db::mysql::pulse::health(&p).await,
        DbPool::Postgres(_) => Err(unsupported("PostgreSQL")),
        DbPool::Sqlite(_) => Err(unsupported("SQLite")),
        DbPool::Mongo(_) => Err(unsupported("MongoDB")),
        DbPool::MsSql(_) => Err(unsupported("SQL Server")),
    }
}

/// One read of a connection's vital signs. See [`crate::pulse`].
#[tauri::command]
pub async fn pulse_health(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<PulseHealth> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::error::with_timeout(
        "pulse_health",
        pulse_health_inner(state.inner(), &connection_id),
    )
    .await
}
