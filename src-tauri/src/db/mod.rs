//! Database abstraction layer.
//!
//! Huginn currently supports three SQL backends — PostgreSQL, MySQL, and
//! SQLite — all driven by [`sqlx`]. The submodules in this folder hold the
//! shared logic that is independent of which Tauri command is invoking it:
//!
//! * [`pool`]   — open/connect pools, build connection URLs.
//! * [`values`] — extract typed values from `sqlx` rows into `serde_json::Value`
//!                so the frontend can render them generically.
//! * [`sql`]    — driver-aware SQL helpers (identifier quoting, statement
//!                classification).

pub mod pool;
pub mod sql;
pub mod ssh;
pub mod values;
