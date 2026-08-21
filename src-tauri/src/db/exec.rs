//! Running SQL on a [`DbPool`], whatever driver is behind it.
//!
//! [`crate::db::sql::Dialect`] owns every per-engine difference in the SQL
//! *text*. This module is its counterpart for *running* it — the piece that was
//! missing, which is why twelve call sites in `commands/` each wrote out the
//! same five-arm `match pool`, two of them byte-identical to each other.
//!
//! The arms are near-identical by construction, so there was never much to
//! choose between them: `sqlx`'s three pools share an API, and [`MsSqlPool`] was
//! deliberately built to expose the same surface (`query_all` /
//! `execute_params` / `execute_simple` / `scalar`), so its arm here is one line
//! in every function. What the duplication actually cost was the guarantee: a
//! new engine had to be threaded through twelve bodies, and a `_ =>` in any one
//! of them would have silently given it Postgres's behaviour (gotcha #30).
//!
//! **MongoDB never reaches these functions.** It is not a SQL dialect; every
//! command dispatches it to [`crate::db::mongo`] before any SQL is built. A
//! `DbPool::Mongo` here is a programming error, and the `unreachable!` arms say
//! so rather than inventing a fallback — matching what the individual call sites
//! already did.
//!
//! Values cross as `Option<String>` end-to-end (gotcha #5): the cell editor only
//! ever emits text and the drivers cast textual literals server-side. Anything
//! needing a per-driver cast around the placeholder (a MySQL `BIT`, a SQL Server
//! `varbinary`) builds that into the SQL *before* getting here.

use crate::error::{AppError, AppResult};
use crate::state::DbPool;

/// Bind `binds` positionally and run `sql`, on whichever pool this is.
///
/// Expands to the same `sqlx::query(...).bind(...).execute(...)` chain per pool
/// type. A macro rather than a generic function because `sqlx::query` returns a
/// different `Query<'_, DB, _>` for each database, and the three are not related
/// by a trait we can name here.
macro_rules! bind_all {
    ($sql:expr, $binds:expr, $pool:expr) => {{
        let mut q = sqlx::query($sql);
        for b in $binds {
            q = q.bind(b);
        }
        q
    }};
}

/// [`bind_all`] for the `query_scalar` flavour. A macro for the same reason, and
/// not a generic function: `query_scalar`'s bounds have to be discharged against
/// a concrete `Database`, and naming them all at a generic signature is more
/// code than the three lines it would save.
macro_rules! bind_all_scalar {
    ($sql:expr, $binds:expr) => {{
        let mut q = sqlx::query_scalar::<_, i64>($sql);
        for b in $binds {
            q = q.bind(b);
        }
        q
    }};
}

/// Run a parameterless statement, returning rows affected.
///
/// For DDL and other statements with no user values to bind — `TRUNCATE`,
/// `DROP TABLE`, `CREATE DATABASE`, a `sp_rename`. Identifiers in `sql` must
/// already be quoted through [`crate::db::sql::Dialect::quote_ident`] (and any
/// user-entered name validated first — see [`crate::db::ddl::validate_ident`]),
/// because DDL cannot bind an identifier as a parameter.
pub async fn execute(pool: &DbPool, sql: &str) -> AppResult<u64> {
    match pool {
        DbPool::Postgres(p) => sqlx::query(sql)
            .execute(p)
            .await
            .map(|r| r.rows_affected())
            .map_err(AppError::from),
        DbPool::Mysql(p) => sqlx::query(sql)
            .execute(p)
            .await
            .map(|r| r.rows_affected())
            .map_err(AppError::from),
        DbPool::Sqlite(p) => sqlx::query(sql)
            .execute(p)
            .await
            .map(|r| r.rows_affected())
            .map_err(AppError::from),
        DbPool::MsSql(p) => p.execute_simple(sql).await,
        DbPool::Mongo(_) => unreachable!("MongoDB is dispatched to db::mongo before any SQL"),
    }
}

/// Run a parameterised write, returning rows affected.
pub async fn execute_params(pool: &DbPool, sql: &str, binds: &[Option<String>]) -> AppResult<u64> {
    match pool {
        DbPool::Postgres(p) => bind_all!(sql, binds, p)
            .execute(p)
            .await
            .map(|r| r.rows_affected())
            .map_err(AppError::from),
        DbPool::Mysql(p) => bind_all!(sql, binds, p)
            .execute(p)
            .await
            .map(|r| r.rows_affected())
            .map_err(AppError::from),
        DbPool::Sqlite(p) => bind_all!(sql, binds, p)
            .execute(p)
            .await
            .map(|r| r.rows_affected())
            .map_err(AppError::from),
        DbPool::MsSql(p) => p.execute_params(sql, binds).await,
        DbPool::Mongo(_) => unreachable!("MongoDB is dispatched to db::mongo before any SQL"),
    }
}

/// Run a parameterised read, returning `(columns, rows)`.
///
/// Columns come back as untyped `(name, type_name)` pairs rather than a
/// `ColumnMeta`: that DTO lives in `commands::query`, and `db/` must not depend
/// upward on `commands/`. `db::mssql::schema::decode_rows` already returned this
/// shape for the same reason, so one signature covers all four drivers and the
/// caller maps into whatever it serialises.
pub async fn query_rows(
    pool: &DbPool,
    sql: &str,
    binds: &[Option<String>],
) -> AppResult<(Vec<(String, String)>, Vec<Vec<serde_json::Value>>)> {
    use crate::db::values;
    match pool {
        DbPool::Postgres(p) => bind_all!(sql, binds, p)
            .fetch_all(p)
            .await
            .map(|rows| values::pg_result(&rows))
            .map_err(AppError::from),
        DbPool::Mysql(p) => bind_all!(sql, binds, p)
            .fetch_all(p)
            .await
            .map(|rows| values::mysql_result(&rows))
            .map_err(AppError::from),
        DbPool::Sqlite(p) => bind_all!(sql, binds, p)
            .fetch_all(p)
            .await
            .map(|rows| values::sqlite_result(&rows))
            .map_err(AppError::from),
        DbPool::MsSql(p) => p
            .query_all(sql, binds)
            .await
            .map(|rows| crate::db::mssql::schema::decode_rows(&rows)),
        DbPool::Mongo(_) => unreachable!("MongoDB is dispatched to db::mongo before any SQL"),
    }
}

/// Run a parameterised query expected to yield a single `i64` — a `COUNT(*)`,
/// a `last_insert_id`, an estimated row count.
///
/// `None` when the query returned no row at all, which callers treat as "no
/// answer available" rather than zero: an estimate that is missing and an
/// estimate of nothing are different facts.
pub async fn scalar_i64(
    pool: &DbPool,
    sql: &str,
    binds: &[Option<String>],
) -> AppResult<Option<i64>> {
    match pool {
        DbPool::Postgres(p) => bind_all_scalar!(sql, binds)
            .fetch_optional(p)
            .await
            .map_err(AppError::from),
        DbPool::Mysql(p) => bind_all_scalar!(sql, binds)
            .fetch_optional(p)
            .await
            .map_err(AppError::from),
        DbPool::Sqlite(p) => bind_all_scalar!(sql, binds)
            .fetch_optional(p)
            .await
            .map_err(AppError::from),
        DbPool::MsSql(p) => p.scalar(sql, binds).await,
        DbPool::Mongo(_) => unreachable!("MongoDB is dispatched to db::mongo before any SQL"),
    }
}
