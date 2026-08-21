//! PostgreSQL-specific logic.
//!
//! The sqlx drivers historically had no module of their own: their catalog
//! queries lived inline in `commands/schema.rs` while MongoDB's and SQL
//! Server's were already factored out into `db/mongo` and `db/mssql`. This is
//! the missing half of that split — see [`schema`].

pub mod schema;
