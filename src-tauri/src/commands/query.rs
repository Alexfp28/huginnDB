//! Query execution and table-data commands.
//!
//! Three entry points are exposed:
//!
//! * [`execute_query`]   — run an arbitrary SQL statement provided by the
//!   user. Branches between fetch and execute depending on whether the
//!   statement looks read-only.
//! * [`fetch_table_data`] — paginated SELECT over a known table, with
//!   optional sort. Backs the table-data browser tab.
//! * [`update_cell`]     — UPDATE one column of one row by primary key.
//!   Drives inline / cell-editor edits in the grid.

use crate::db::sql::{is_read_only, quote_ident};
use crate::db::values::{
    mysql_columns, mysql_value, pg_columns, pg_value, sqlite_columns, sqlite_value,
};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, DbPool};
use serde::Serialize;
use serde_json::Value;
use std::time::Instant;
use tauri::State;

/// Result set returned to the frontend.
#[derive(Debug, Serialize)]
pub struct QueryResult {
    /// Columns of the result set, in order.
    pub columns: Vec<ColumnMeta>,
    /// One inner `Vec` per row, with values aligned to `columns`.
    pub rows: Vec<Vec<Value>>,
    /// Number of rows affected (`UPDATE`/`DELETE`/`INSERT`) or returned
    /// (`SELECT`).
    pub rows_affected: u64,
    /// Wall-clock time of the round-trip in milliseconds.
    pub elapsed_ms: u64,
    /// For [`fetch_table_data`] only: the total row count of the table
    /// (so the UI can show "1–100 of 12,345").
    pub total: Option<u64>,
}

/// Column descriptor in a [`QueryResult`].
#[derive(Debug, Serialize)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
}

/// Resolve the active pool for `id`, or fail with [`AppError::NotConnected`].
fn pool_for(state: &AppState, id: &str) -> AppResult<DbPool> {
    state
        .connections
        .read()
        .get(id)
        .ok_or_else(|| AppError::NotConnected(id.to_string()))
}

/// Execute an arbitrary SQL statement on the connection identified by
/// `connection_id`.
#[tauri::command]
pub async fn execute_query(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
) -> AppResult<QueryResult> {
    execute_with_state(state.inner(), &connection_id, &sql).await
}

/// Shared implementation used by both [`execute_query`] and
/// [`fetch_table_data`]. Takes a borrowed `AppState` so it can be called
/// from other command handlers without re-acquiring the Tauri `State`
/// guard.
async fn execute_with_state(
    state: &AppState,
    connection_id: &str,
    sql: &str,
) -> AppResult<QueryResult> {
    let pool = pool_for(state, connection_id)?;
    let start = Instant::now();

    if !is_read_only(sql) {
        let rows_affected = match &pool {
            DbPool::Postgres(p) => sqlx::query(sql).execute(p).await?.rows_affected(),
            DbPool::Mysql(p) => sqlx::query(sql).execute(p).await?.rows_affected(),
            DbPool::Sqlite(p) => sqlx::query(sql).execute(p).await?.rows_affected(),
        };
        return Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            rows_affected,
            elapsed_ms: start.elapsed().as_millis() as u64,
            total: None,
        });
    }

    let result = match pool {
        DbPool::Postgres(p) => {
            let rows = sqlx::query(sql).fetch_all(&p).await?;
            let columns = rows
                .first()
                .map(|r| {
                    pg_columns(r)
                        .into_iter()
                        .map(|(name, data_type)| ColumnMeta { name, data_type })
                        .collect()
                })
                .unwrap_or_default();
            let data: Vec<Vec<Value>> = rows
                .iter()
                .map(|r| {
                    use sqlx::Row;
                    (0..r.columns().len()).map(|i| pg_value(r, i)).collect()
                })
                .collect();
            QueryResult {
                rows_affected: data.len() as u64,
                rows: data,
                columns,
                elapsed_ms: start.elapsed().as_millis() as u64,
                total: None,
            }
        }
        DbPool::Mysql(p) => {
            let rows = sqlx::query(sql).fetch_all(&p).await?;
            let columns = rows
                .first()
                .map(|r| {
                    mysql_columns(r)
                        .into_iter()
                        .map(|(name, data_type)| ColumnMeta { name, data_type })
                        .collect()
                })
                .unwrap_or_default();
            let data: Vec<Vec<Value>> = rows
                .iter()
                .map(|r| {
                    use sqlx::Row;
                    (0..r.columns().len())
                        .map(|i| mysql_value(r, i))
                        .collect()
                })
                .collect();
            QueryResult {
                rows_affected: data.len() as u64,
                rows: data,
                columns,
                elapsed_ms: start.elapsed().as_millis() as u64,
                total: None,
            }
        }
        DbPool::Sqlite(p) => {
            let rows = sqlx::query(sql).fetch_all(&p).await?;
            let columns = rows
                .first()
                .map(|r| {
                    sqlite_columns(r)
                        .into_iter()
                        .map(|(name, data_type)| ColumnMeta { name, data_type })
                        .collect()
                })
                .unwrap_or_default();
            let data: Vec<Vec<Value>> = rows
                .iter()
                .map(|r| {
                    use sqlx::Row;
                    (0..r.columns().len())
                        .map(|i| sqlite_value(r, i))
                        .collect()
                })
                .collect();
            QueryResult {
                rows_affected: data.len() as u64,
                rows: data,
                columns,
                elapsed_ms: start.elapsed().as_millis() as u64,
                total: None,
            }
        }
    };
    Ok(result)
}

/// Fetch one page of rows from `schema.table`.
///
/// Generates `SELECT * FROM <table> [ORDER BY ...] LIMIT ? OFFSET ?` plus
/// a companion `SELECT COUNT(*)` so the UI can render an exact pagination
/// footer. Identifiers are quoted with the driver-appropriate helper.
#[tauri::command]
pub async fn fetch_table_data(
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
    limit: i64,
    offset: i64,
    order_by: Option<String>,
    order_desc: Option<bool>,
) -> AppResult<QueryResult> {
    let pool = pool_for(state.inner(), &connection_id)?;
    let pg_or_sqlite = matches!(&pool, DbPool::Postgres(_) | DbPool::Sqlite(_));

    let order_clause = match order_by {
        Some(col) => {
            let dir = if order_desc.unwrap_or(false) { "DESC" } else { "ASC" };
            format!(" ORDER BY {} {}", quote_ident(pg_or_sqlite, &col), dir)
        }
        None => String::new(),
    };

    let (data_sql, count_sql) = match &pool {
        DbPool::Postgres(_) => {
            let schema = schema.clone().unwrap_or_else(|| "public".into());
            let qt = format!(
                "{}.{}",
                quote_ident(true, &schema),
                quote_ident(true, &table)
            );
            (
                format!(
                    "SELECT * FROM {qt}{order_clause} LIMIT {limit} OFFSET {offset}"
                ),
                format!("SELECT COUNT(*) FROM {qt}"),
            )
        }
        DbPool::Mysql(_) => {
            let qt = if let Some(s) = &schema {
                format!("{}.{}", quote_ident(false, s), quote_ident(false, &table))
            } else {
                quote_ident(false, &table)
            };
            (
                format!(
                    "SELECT * FROM {qt}{order_clause} LIMIT {limit} OFFSET {offset}"
                ),
                format!("SELECT COUNT(*) FROM {qt}"),
            )
        }
        DbPool::Sqlite(_) => {
            let qt = quote_ident(true, &table);
            (
                format!(
                    "SELECT * FROM {qt}{order_clause} LIMIT {limit} OFFSET {offset}"
                ),
                format!("SELECT COUNT(*) FROM {qt}"),
            )
        }
    };

    let mut result = execute_with_state(state.inner(), &connection_id, &data_sql).await?;

    let total: Option<u64> = match &pool {
        DbPool::Postgres(p) => sqlx::query_scalar::<_, i64>(&count_sql)
            .fetch_optional(p)
            .await?
            .map(|v| v as u64),
        DbPool::Mysql(p) => sqlx::query_scalar::<_, i64>(&count_sql)
            .fetch_optional(p)
            .await?
            .map(|v| v as u64),
        DbPool::Sqlite(p) => sqlx::query_scalar::<_, i64>(&count_sql)
            .fetch_optional(p)
            .await?
            .map(|v| v as u64),
    };
    result.total = total;
    Ok(result)
}

/// Update one column of one row in `schema.table`, addressed by primary key.
///
/// The new value is always sent as `Option<String>` because the cell
/// editor produces text. Drivers cast textual literals to the column type
/// automatically. NULLs are conveyed by passing `None`.
#[tauri::command]
pub async fn update_cell(
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
    pk_column: String,
    pk_value: Value,
    column: String,
    value: Option<String>,
) -> AppResult<u64> {
    let pool = pool_for(state.inner(), &connection_id)?;
    let pg_or_sqlite = matches!(&pool, DbPool::Postgres(_) | DbPool::Sqlite(_));

    let qt = if let Some(s) = schema {
        format!(
            "{}.{}",
            quote_ident(pg_or_sqlite, &s),
            quote_ident(pg_or_sqlite, &table)
        )
    } else {
        quote_ident(pg_or_sqlite, &table)
    };
    let col_id = quote_ident(pg_or_sqlite, &column);
    let pk_id = quote_ident(pg_or_sqlite, &pk_column);
    let pk_str = json_to_string(&pk_value);

    let affected = match pool {
        DbPool::Postgres(p) => {
            let sql = format!("UPDATE {qt} SET {col_id} = $1 WHERE {pk_id} = $2");
            sqlx::query(&sql)
                .bind(&value)
                .bind(&pk_str)
                .execute(&p)
                .await?
                .rows_affected()
        }
        DbPool::Mysql(p) => {
            let sql = format!("UPDATE {qt} SET {col_id} = ? WHERE {pk_id} = ?");
            sqlx::query(&sql)
                .bind(&value)
                .bind(&pk_str)
                .execute(&p)
                .await?
                .rows_affected()
        }
        DbPool::Sqlite(p) => {
            let sql = format!("UPDATE {qt} SET {col_id} = ?1 WHERE {pk_id} = ?2");
            sqlx::query(&sql)
                .bind(&value)
                .bind(&pk_str)
                .execute(&p)
                .await?
                .rows_affected()
        }
    };
    Ok(affected)
}

/// Coerce a JSON scalar to its textual SQL bind form. `null` becomes `None`
/// so the driver writes a SQL `NULL` rather than the four-byte string
/// `"null"`.
fn json_to_string(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}
