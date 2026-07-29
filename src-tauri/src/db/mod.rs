//! Database abstraction layer.
//!
//! Four backends: PostgreSQL, MySQL and SQLite through [`sqlx`], plus MongoDB
//! through the `mongodb` crate (since 1.1.0). The submodules here hold the
//! logic that is independent of which Tauri command is invoking it:
//!
//! * [`pool`] — open/close pools and build connection options per driver.
//! * [`values`] — decode `sqlx` rows into `serde_json::Value`. The
//!   driver-specific type quirks documented here are load-bearing; read the
//!   comments before touching a decode branch.
//! * [`sql`] — driver-aware SQL helpers: identifier quoting and the statement
//!   classifier that drives the MCP connector's write policy.
//! * [`ddl`] — pure builder that diffs two table structures into ordered DDL,
//!   shared by structure-editor preview and apply so they cannot drift.
//! * [`view_ddl`] — the same idea for views.
//! * [`dump`] — render rows back into `INSERT` statements for SQL export.
//! * [`ssh`] — SSH tunnel: host-key verification and local port forwarding.
//! * [`mongo`] — shell-syntax parsing, query execution and BSON conversion.

pub mod ddl;
pub mod dump;
pub mod mongo;
pub mod pool;
pub mod sql;
pub mod ssh;
pub mod values;
pub mod view_ddl;
