//! Tauri command handlers — the public surface the frontend invokes via
//! `invoke("name", { args })`.
//!
//! Modules here are organised by feature area and intentionally kept thin:
//! they validate arguments, look up state, and delegate the heavy lifting
//! to the [`crate::db`] / [`crate::keychain`] helpers.

pub mod connection;
pub mod credentials;
pub mod query;
pub mod schema;
