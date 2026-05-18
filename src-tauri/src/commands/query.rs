//! Query execution and table-data commands.
//!
//! Entry points:
//!
//! * [`execute_query`]   — run an arbitrary SQL statement provided by the
//!   user. Branches between fetch and execute depending on whether the
//!   statement looks read-only.
//! * [`fetch_table_data`] — paginated SELECT over a known table, with
//!   optional sort + column filters. Backs the table-data browser tab.
//! * [`update_cell`]     — UPDATE one column of one row by primary key.
//!   Drives inline / cell-editor edits in the grid.
//! * [`delete_rows`]     — DELETE one or more rows addressed by primary key.
//! * [`insert_row`]      — INSERT one row from a list of column/value pairs.
//!   Used by both the "insert" and "duplicate" flows in the grid.

use crate::commands::schema::list_columns_inner;
use crate::db::sql::{is_read_only, quote_ident};
use crate::db::values::{
    mysql_columns, mysql_value, pg_columns, pg_value, sqlite_columns, sqlite_value,
};
use crate::error::{AppError, AppResult};
use crate::log_bus::{self, LogEntry, LogKind};
use crate::state::{AppState, DbPool};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Instant;
use tauri::{AppHandle, State};

/// Driver label used by the Console panel. Kept local so we don't leak
/// the `DbPool` enum's `Debug` formatting into a user-facing string.
fn driver_str(pool: &DbPool) -> &'static str {
    match pool {
        DbPool::Postgres(_) => "postgres",
        DbPool::Mysql(_) => "mysql",
        DbPool::Sqlite(_) => "sqlite",
    }
}

/// Emit a SQL log entry after a statement has finished (successfully or
/// otherwise). Pulled out so every call site stays a single line.
fn log_sql(
    app: &AppHandle,
    connection_id: &str,
    driver: &str,
    sql: &str,
    start: Instant,
    rows_affected: Option<u64>,
    error: Option<&str>,
) {
    let mut entry = LogEntry::new(LogKind::Sql)
        .connection_id(connection_id)
        .driver(driver)
        .sql(sql)
        .duration_ms(start.elapsed().as_millis() as u64);
    if let Some(r) = rows_affected {
        entry = entry.rows_affected(r);
    }
    if let Some(e) = error {
        entry = entry.error(e);
    }
    log_bus::emit(app, entry);
}

/// Unwrap a `Result<_, sqlx::Error>` produced by a SQL call and, on
/// failure, emit a SQL log entry plus early-return the error from the
/// enclosing command — analogous to `?` with an extra side-effect.
///
/// We use a macro (rather than an `async fn` helper) for two reasons:
///
/// 1. The success branch needs to stay in the caller's control flow so
///    each driver arm can keep using its own bespoke row-decoding logic
///    (`pg_value` vs `mysql_value` vs `sqlite_value`).
/// 2. `return Err(...)` from inside an async closure would not exit the
///    outer function; a macro expands inline and does.
macro_rules! try_sql {
    ($app:expr, $cid:expr, $driver:expr, $sql:expr, $start:expr, $res:expr) => {
        match $res {
            Ok(v) => v,
            Err(e) => {
                let msg = e.to_string();
                log_sql($app, $cid, $driver, $sql, $start, None, Some(&msg));
                return Err(e.into());
            }
        }
    };
}

/// Comparison operator accepted by [`ColumnFilter`].
///
/// The set is intentionally closed so we can map each variant to a fixed
/// SQL fragment without going through user-supplied strings. `Eq` / `Ne`
/// take a bound value; `IsNull` / `IsNotNull` do not.
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    Ne,
    IsNull,
    IsNotNull,
}

/// One column-level predicate applied by [`fetch_table_data`].
///
/// Multiple filters are AND-composed. Identifiers are always quoted via
/// [`quote_ident`]; values are sent as binds, never interpolated into the
/// SQL string.
#[derive(Debug, Deserialize, Clone)]
pub struct ColumnFilter {
    pub column: String,
    pub op: FilterOp,
    /// Bound value. Always `None` for `IsNull` / `IsNotNull`; coerced
    /// through [`json_to_string`] for `Eq` / `Ne`.
    #[serde(default)]
    pub value: Value,
}

/// One column/value pair used to build an INSERT statement.
///
/// We use parallel positional encoding (`Vec<RowValue>`) instead of a
/// `HashMap` so column order is preserved verbatim from the frontend —
/// otherwise we cannot pair columns with their placeholders deterministically.
#[derive(Debug, Deserialize)]
pub struct RowValue {
    pub column: String,
    /// Always a string or `null`. The cell editor and `RowEditor` dialog
    /// produce text only; drivers cast textual literals to the target type.
    pub value: Option<String>,
}

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
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
) -> AppResult<QueryResult> {
    execute_with_state(&app, state.inner(), &connection_id, &sql).await
}

/// Shared implementation used by both [`execute_query`] and
/// [`fetch_table_data`]. Takes a borrowed `AppState` so it can be called
/// from other command handlers without re-acquiring the Tauri `State`
/// guard.
///
/// Emits a SQL [`LogEntry`] after every execution path (write, read, and
/// error) so the Console panel sees the same statement the engine ran.
async fn execute_with_state(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    sql: &str,
) -> AppResult<QueryResult> {
    let pool = pool_for(state, connection_id)?;
    let driver = driver_str(&pool);
    let start = Instant::now();

    if !is_read_only(sql) {
        let rows_affected = try_sql!(
            app,
            connection_id,
            driver,
            sql,
            start,
            match &pool {
                DbPool::Postgres(p) => sqlx::query(sql).execute(p).await.map(|r| r.rows_affected()),
                DbPool::Mysql(p) => sqlx::query(sql).execute(p).await.map(|r| r.rows_affected()),
                DbPool::Sqlite(p) => sqlx::query(sql).execute(p).await.map(|r| r.rows_affected()),
            }
        );
        log_sql(
            app,
            connection_id,
            driver,
            sql,
            start,
            Some(rows_affected),
            None,
        );
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
            let rows = try_sql!(
                app,
                connection_id,
                driver,
                sql,
                start,
                sqlx::query(sql).fetch_all(&p).await
            );
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
            let rows = try_sql!(
                app,
                connection_id,
                driver,
                sql,
                start,
                sqlx::query(sql).fetch_all(&p).await
            );
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
                    (0..r.columns().len()).map(|i| mysql_value(r, i)).collect()
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
            let rows = try_sql!(
                app,
                connection_id,
                driver,
                sql,
                start,
                sqlx::query(sql).fetch_all(&p).await
            );
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
                    (0..r.columns().len()).map(|i| sqlite_value(r, i)).collect()
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
    log_sql(
        app,
        connection_id,
        driver,
        sql,
        start,
        Some(result.rows_affected),
        None,
    );
    Ok(result)
}

/// Escape a user-supplied LIKE pattern so `%` and `_` lose their special
/// meaning. The resulting fragment is intended to be used with
/// `LIKE/ILIKE ... ESCAPE '\'`.
fn escape_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 4);
    for ch in input.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            other => out.push(other),
        }
    }
    out
}

/// Build the `WHERE` fragment + bind list for a set of column filters
/// plus an optional free-text `search` applied across `search_columns`.
///
/// Returns `(clause, binds)`. `clause` is either `""` or starts with a
/// leading space `" WHERE ..."`. The search predicate is appended as a
/// single OR group AND-composed with the column filters. Search values
/// are escaped against LIKE metacharacters and case-folded by the SQL
/// engine (`ILIKE` on Postgres, default `LIKE` on MySQL/SQLite).
fn build_filter_clause(
    pg: bool,
    pg_or_sqlite: bool,
    filters: &[ColumnFilter],
    search: Option<&str>,
    search_columns: &[String],
) -> (String, Vec<Option<String>>) {
    let mut binds: Vec<Option<String>> = Vec::new();
    let mut parts: Vec<String> = Vec::new();
    let mut next_placeholder: usize = 1;

    for f in filters {
        let col = quote_ident(pg_or_sqlite, &f.column);
        match f.op {
            FilterOp::IsNull => parts.push(format!("{col} IS NULL")),
            FilterOp::IsNotNull => parts.push(format!("{col} IS NOT NULL")),
            FilterOp::Eq | FilterOp::Ne => {
                let sym = if f.op == FilterOp::Eq { "=" } else { "<>" };
                let ph = if pg {
                    format!("${next_placeholder}")
                } else {
                    "?".to_string()
                };
                next_placeholder += 1;
                parts.push(format!("{col} {sym} {ph}"));
                binds.push(json_to_string(&f.value));
            }
        }
    }

    if let Some(q) = search {
        if !q.is_empty() && !search_columns.is_empty() {
            let pattern = format!("%{}%", escape_like(q));
            let like_kw = if pg { "ILIKE" } else { "LIKE" };
            let cast_to = if pg_or_sqlite { "TEXT" } else { "CHAR" };
            let mut or_parts: Vec<String> = Vec::new();
            for col in search_columns {
                let qcol = quote_ident(pg_or_sqlite, col);
                let ph = if pg {
                    format!("${next_placeholder}")
                } else {
                    "?".to_string()
                };
                next_placeholder += 1;
                or_parts.push(format!(
                    "CAST({qcol} AS {cast_to}) {like_kw} {ph} ESCAPE '\\'"
                ));
                binds.push(Some(pattern.clone()));
            }
            if !or_parts.is_empty() {
                parts.push(format!("({})", or_parts.join(" OR ")));
            }
        }
    }

    if parts.is_empty() {
        return (String::new(), binds);
    }
    (format!(" WHERE {}", parts.join(" AND ")), binds)
}

/// Fetch one page of rows from `schema.table`.
///
/// Generates `SELECT * FROM <table> [WHERE ...] [ORDER BY ...] LIMIT ?
/// OFFSET ?` plus a companion `SELECT COUNT(*)` so the UI can render an
/// exact pagination footer. Identifiers are quoted with the
/// driver-appropriate helper; filter values are always bound, never
/// interpolated.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn fetch_table_data(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
    limit: i64,
    offset: i64,
    order_by: Option<String>,
    order_desc: Option<bool>,
    filters: Option<Vec<ColumnFilter>>,
    search: Option<String>,
    search_columns: Option<Vec<String>>,
) -> AppResult<QueryResult> {
    let pool = pool_for(state.inner(), &connection_id)?;
    let driver = driver_str(&pool);
    let pg_or_sqlite = matches!(&pool, DbPool::Postgres(_) | DbPool::Sqlite(_));
    let pg = matches!(&pool, DbPool::Postgres(_));

    let order_clause = match order_by {
        Some(col) => {
            let dir = if order_desc.unwrap_or(false) {
                "DESC"
            } else {
                "ASC"
            };
            format!(" ORDER BY {} {}", quote_ident(pg_or_sqlite, &col), dir)
        }
        None => String::new(),
    };

    let filters = filters.unwrap_or_default();
    let search_columns = search_columns.unwrap_or_default();
    let search_ref = search.as_deref().filter(|s| !s.is_empty());
    let (where_clause, where_binds) =
        build_filter_clause(pg, pg_or_sqlite, &filters, search_ref, &search_columns);

    let qt = match &pool {
        DbPool::Postgres(_) => {
            let schema = schema.clone().unwrap_or_else(|| "public".into());
            format!(
                "{}.{}",
                quote_ident(true, &schema),
                quote_ident(true, &table)
            )
        }
        DbPool::Mysql(_) => {
            if let Some(s) = &schema {
                format!("{}.{}", quote_ident(false, s), quote_ident(false, &table))
            } else {
                quote_ident(false, &table)
            }
        }
        DbPool::Sqlite(_) => quote_ident(true, &table),
    };

    // LIMIT/OFFSET stay inline (they are integers we already parsed),
    // so the filter binds are the only binds in the statement.
    let data_sql =
        format!("SELECT * FROM {qt}{where_clause}{order_clause} LIMIT {limit} OFFSET {offset}");
    let count_sql = format!("SELECT COUNT(*) FROM {qt}{where_clause}");

    let start = Instant::now();
    let (columns, data) = match &pool {
        DbPool::Postgres(p) => {
            let mut q = sqlx::query(&data_sql);
            for b in &where_binds {
                q = q.bind(b);
            }
            let rows = try_sql!(
                &app,
                &connection_id,
                driver,
                &data_sql,
                start,
                q.fetch_all(p).await
            );
            let columns = rows
                .first()
                .map(|r| {
                    pg_columns(r)
                        .into_iter()
                        .map(|(name, data_type)| ColumnMeta { name, data_type })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let data: Vec<Vec<Value>> = rows
                .iter()
                .map(|r| {
                    use sqlx::Row;
                    (0..r.columns().len()).map(|i| pg_value(r, i)).collect()
                })
                .collect();
            (columns, data)
        }
        DbPool::Mysql(p) => {
            let mut q = sqlx::query(&data_sql);
            for b in &where_binds {
                q = q.bind(b);
            }
            let rows = try_sql!(
                &app,
                &connection_id,
                driver,
                &data_sql,
                start,
                q.fetch_all(p).await
            );
            let columns = rows
                .first()
                .map(|r| {
                    mysql_columns(r)
                        .into_iter()
                        .map(|(name, data_type)| ColumnMeta { name, data_type })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let data: Vec<Vec<Value>> = rows
                .iter()
                .map(|r| {
                    use sqlx::Row;
                    (0..r.columns().len()).map(|i| mysql_value(r, i)).collect()
                })
                .collect();
            (columns, data)
        }
        DbPool::Sqlite(p) => {
            let mut q = sqlx::query(&data_sql);
            for b in &where_binds {
                q = q.bind(b);
            }
            let rows = try_sql!(
                &app,
                &connection_id,
                driver,
                &data_sql,
                start,
                q.fetch_all(p).await
            );
            let columns = rows
                .first()
                .map(|r| {
                    sqlite_columns(r)
                        .into_iter()
                        .map(|(name, data_type)| ColumnMeta { name, data_type })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let data: Vec<Vec<Value>> = rows
                .iter()
                .map(|r| {
                    use sqlx::Row;
                    (0..r.columns().len()).map(|i| sqlite_value(r, i)).collect()
                })
                .collect();
            (columns, data)
        }
    };
    let elapsed_ms = start.elapsed().as_millis() as u64;
    log_sql(
        &app,
        &connection_id,
        driver,
        &data_sql,
        start,
        Some(data.len() as u64),
        None,
    );

    let count_start = Instant::now();
    let raw_count: Option<i64> = try_sql!(
        &app,
        &connection_id,
        driver,
        &count_sql,
        count_start,
        match &pool {
            DbPool::Postgres(p) => {
                let mut q = sqlx::query_scalar::<_, i64>(&count_sql);
                for b in &where_binds {
                    q = q.bind(b);
                }
                q.fetch_optional(p).await
            }
            DbPool::Mysql(p) => {
                let mut q = sqlx::query_scalar::<_, i64>(&count_sql);
                for b in &where_binds {
                    q = q.bind(b);
                }
                q.fetch_optional(p).await
            }
            DbPool::Sqlite(p) => {
                let mut q = sqlx::query_scalar::<_, i64>(&count_sql);
                for b in &where_binds {
                    q = q.bind(b);
                }
                q.fetch_optional(p).await
            }
        }
    );
    let total: Option<u64> = raw_count.map(|n| n as u64);
    log_sql(
        &app,
        &connection_id,
        driver,
        &count_sql,
        count_start,
        total,
        None,
    );

    Ok(QueryResult {
        rows_affected: data.len() as u64,
        rows: data,
        columns,
        elapsed_ms,
        total,
    })
}

/// Update one column of one row in `schema.table`, addressed by primary key.
///
/// The new value is always sent as `Option<String>` because the cell
/// editor produces text. Drivers cast textual literals to the column type
/// automatically. NULLs are conveyed by passing `None`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_cell(
    app: AppHandle,
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
    let driver = driver_str(&pool);
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

    let start = Instant::now();
    let (sql, res) = match pool {
        DbPool::Postgres(p) => {
            let sql = format!("UPDATE {qt} SET {col_id} = $1 WHERE {pk_id} = $2");
            let res = sqlx::query(&sql)
                .bind(&value)
                .bind(&pk_str)
                .execute(&p)
                .await
                .map(|r| r.rows_affected());
            (sql, res)
        }
        DbPool::Mysql(p) => {
            let sql = format!("UPDATE {qt} SET {col_id} = ? WHERE {pk_id} = ?");
            let res = sqlx::query(&sql)
                .bind(&value)
                .bind(&pk_str)
                .execute(&p)
                .await
                .map(|r| r.rows_affected());
            (sql, res)
        }
        DbPool::Sqlite(p) => {
            let sql = format!("UPDATE {qt} SET {col_id} = ?1 WHERE {pk_id} = ?2");
            let res = sqlx::query(&sql)
                .bind(&value)
                .bind(&pk_str)
                .execute(&p)
                .await
                .map(|r| r.rows_affected());
            (sql, res)
        }
    };
    let affected = try_sql!(&app, &connection_id, driver, &sql, start, res);
    log_sql(
        &app,
        &connection_id,
        driver,
        &sql,
        start,
        Some(affected),
        None,
    );
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

/// Delete one or more rows from `schema.table` identified by primary key.
///
/// The PK is expected to be a single column. `pk_values` is a JSON array
/// so multi-row deletion can be wired from the UI in a future PR without
/// changing the command signature.
#[tauri::command]
pub async fn delete_rows(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
    pk_column: String,
    pk_values: Vec<Value>,
) -> AppResult<u64> {
    if pk_values.is_empty() {
        return Ok(0);
    }
    let pool = pool_for(state.inner(), &connection_id)?;
    let driver = driver_str(&pool);
    let pg_or_sqlite = matches!(&pool, DbPool::Postgres(_) | DbPool::Sqlite(_));
    let pg = matches!(&pool, DbPool::Postgres(_));

    let qt = qualified_table(&pool, schema.as_deref(), &table);
    let pk_id = quote_ident(pg_or_sqlite, &pk_column);
    let placeholders: Vec<String> = (1..=pk_values.len())
        .map(|i| if pg { format!("${i}") } else { "?".into() })
        .collect();
    let sql = format!(
        "DELETE FROM {qt} WHERE {pk_id} IN ({})",
        placeholders.join(", ")
    );
    let binds: Vec<Option<String>> = pk_values.iter().map(json_to_string).collect();

    let start = Instant::now();
    let affected = try_sql!(
        &app,
        &connection_id,
        driver,
        &sql,
        start,
        match pool {
            DbPool::Postgres(p) => {
                let mut q = sqlx::query(&sql);
                for b in &binds {
                    q = q.bind(b);
                }
                q.execute(&p).await.map(|r| r.rows_affected())
            }
            DbPool::Mysql(p) => {
                let mut q = sqlx::query(&sql);
                for b in &binds {
                    q = q.bind(b);
                }
                q.execute(&p).await.map(|r| r.rows_affected())
            }
            DbPool::Sqlite(p) => {
                let mut q = sqlx::query(&sql);
                for b in &binds {
                    q = q.bind(b);
                }
                q.execute(&p).await.map(|r| r.rows_affected())
            }
        }
    );
    log_sql(
        &app,
        &connection_id,
        driver,
        &sql,
        start,
        Some(affected),
        None,
    );
    Ok(affected)
}

/// Insert one row into `schema.table`.
///
/// `values` carries the columns the caller wants to populate; any column
/// omitted will fall back to the database default. Bound values are sent
/// as text and cast by the driver, matching [`update_cell`]'s semantics.
///
/// When `pk_column` is provided on Postgres, the statement is suffixed
/// with `RETURNING <pk>` and the generated value is returned to the
/// frontend. MySQL/SQLite return the last insert id when available; if
/// neither path applies the response is `null`.
#[tauri::command]
pub async fn insert_row(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
    pk_column: Option<String>,
    values: Vec<RowValue>,
) -> AppResult<Value> {
    if values.is_empty() {
        return Err(AppError::InvalidInput(
            "insert_row: no columns supplied".into(),
        ));
    }
    let pool = pool_for(state.inner(), &connection_id)?;
    let driver = driver_str(&pool);
    let pg_or_sqlite = matches!(&pool, DbPool::Postgres(_) | DbPool::Sqlite(_));
    let pg = matches!(&pool, DbPool::Postgres(_));

    let qt = qualified_table(&pool, schema.as_deref(), &table);
    let cols: Vec<String> = values
        .iter()
        .map(|v| quote_ident(pg_or_sqlite, &v.column))
        .collect();
    let placeholders: Vec<String> = (1..=values.len())
        .map(|i| if pg { format!("${i}") } else { "?".into() })
        .collect();
    let binds: Vec<Option<String>> = values.iter().map(|v| v.value.clone()).collect();

    let base_sql = format!(
        "INSERT INTO {qt} ({}) VALUES ({})",
        cols.join(", "),
        placeholders.join(", ")
    );

    // Each driver arm yields (final SQL string, Result<(rows_affected, returned_pk), _>).
    // Postgres optionally tacks on RETURNING to recover the generated PK;
    // MySQL/SQLite use `last_insert_*` instead.
    let start = Instant::now();
    let (sql_used, outcome): (String, Result<(Option<u64>, Value), sqlx::Error>) = match pool {
        DbPool::Postgres(p) => {
            let sql = match &pk_column {
                Some(pk) => format!("{base_sql} RETURNING {}", quote_ident(true, pk)),
                None => base_sql,
            };
            let mut q = sqlx::query(&sql);
            for b in &binds {
                q = q.bind(b);
            }
            let outcome = if pk_column.is_some() {
                q.fetch_all(&p).await.map(|rows| {
                    let returned = rows.first().map(|r| pg_value(r, 0)).unwrap_or(Value::Null);
                    (Some(rows.len() as u64), returned)
                })
            } else {
                q.execute(&p)
                    .await
                    .map(|r| (Some(r.rows_affected()), Value::Null))
            };
            (sql, outcome)
        }
        DbPool::Mysql(p) => {
            let mut q = sqlx::query(&base_sql);
            for b in &binds {
                q = q.bind(b);
            }
            let outcome = q.execute(&p).await.map(|r| {
                let id = r.last_insert_id();
                let returned = if id == 0 {
                    Value::Null
                } else {
                    Value::from(id)
                };
                (Some(r.rows_affected()), returned)
            });
            (base_sql, outcome)
        }
        DbPool::Sqlite(p) => {
            let mut q = sqlx::query(&base_sql);
            for b in &binds {
                q = q.bind(b);
            }
            let outcome = q
                .execute(&p)
                .await
                .map(|r| (Some(r.rows_affected()), Value::from(r.last_insert_rowid())));
            (base_sql, outcome)
        }
    };

    let (rows, returned) = try_sql!(&app, &connection_id, driver, &sql_used, start, outcome);
    log_sql(&app, &connection_id, driver, &sql_used, start, rows, None);
    Ok(returned)
}

/// One row in an FK dropdown payload.
#[derive(Debug, Serialize)]
pub struct FkOption {
    pub value: String,
    pub label: Option<String>,
}

/// Page of FK options. `has_more` is true when more matching rows exist
/// beyond `limit`; the caller can switch from client-side filtering to a
/// server-side search request when this is set.
#[derive(Debug, Serialize)]
pub struct FkOptionsPage {
    pub options: Vec<FkOption>,
    pub has_more: bool,
}

/// Render a `serde_json::Value` as the stringified form the cell editor
/// uses for `update_cell` and `insert_row`. Numbers, bools and strings go
/// through as-is; nulls become an empty string (callers should drop the
/// row entirely before reaching here, but we guard for safety).
fn value_to_dropdown_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Auto-pick the first non-PK column whose `data_type` looks like a text
/// type (text / varchar / char / citext / name / clob). Case-insensitive.
fn pick_label_column(cols: &[crate::commands::schema::ColumnInfo]) -> Option<String> {
    const TEXT_HINTS: &[&str] = &["text", "varchar", "char", "citext", "name", "clob"];
    cols.iter()
        .filter(|c| !c.is_primary_key)
        .find(|c| {
            let t = c.data_type.to_lowercase();
            TEXT_HINTS.iter().any(|h| t.contains(h))
        })
        .map(|c| c.name.clone())
}

/// Fetch a page of distinct primary-key values (with an optional human
/// label) from a foreign-key target table. Powers the inline FK combobox
/// in the data grid.
///
/// Identifiers are validated against the live catalog via
/// [`list_columns_inner`] before they reach [`quote_ident`] — keeps us
/// aligned with the rule in `SECURITY.md` that `quote_ident` is only ever
/// applied to catalog-sourced names. The optional `search` is passed as a
/// bound LIKE/ILIKE pattern with escape handling.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn fetch_fk_options(
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
    key_column: String,
    label_column: Option<String>,
    search: Option<String>,
    limit: i64,
) -> AppResult<FkOptionsPage> {
    // Catalog validation. Failing here means the target was dropped or
    // moved out from under us; the frontend treats this as "fall back to
    // plain input".
    let cols =
        list_columns_inner(state.inner(), &connection_id, schema.clone(), table.clone()).await?;
    if cols.is_empty() {
        return Err(AppError::InvalidInput(format!(
            "fetch_fk_options: target table {table} has no columns or is inaccessible",
        )));
    }
    if !cols.iter().any(|c| c.name == key_column) {
        return Err(AppError::InvalidInput(format!(
            "fetch_fk_options: key column {key_column} not found on {table}",
        )));
    }

    let label_col: Option<String> = match label_column {
        Some(name) if cols.iter().any(|c| c.name == name) => Some(name),
        Some(_) => None, // caller-specified but missing; ignore
        None => pick_label_column(&cols),
    };

    let pool = pool_for(state.inner(), &connection_id)?;
    let pg = matches!(&pool, DbPool::Postgres(_));
    let pg_or_sqlite = matches!(&pool, DbPool::Postgres(_) | DbPool::Sqlite(_));

    let qt = qualified_table(&pool, schema.as_deref(), &table);
    let key_id = quote_ident(pg_or_sqlite, &key_column);
    let label_id = label_col.as_ref().map(|c| quote_ident(pg_or_sqlite, c));

    // Projection: key first, label second (when present).
    let projection = match &label_id {
        Some(l) => format!("{key_id} AS k, {l} AS lbl"),
        None => format!("{key_id} AS k"),
    };

    let search_term = search.as_deref().filter(|s| !s.is_empty());
    let mut binds: Vec<Option<String>> = Vec::new();
    let where_clause = if let Some(term) = search_term {
        let pattern = format!("%{}%", escape_like(term));
        let like_kw = if pg { "ILIKE" } else { "LIKE" };
        let cast_to = if pg_or_sqlite { "TEXT" } else { "CHAR" };
        let ph1 = if pg { "$1".to_string() } else { "?".into() };
        let ph2 = if pg { "$2".to_string() } else { "?".into() };
        let mut parts = vec![format!(
            "CAST({key_id} AS {cast_to}) {like_kw} {ph1} ESCAPE '\\'"
        )];
        binds.push(Some(pattern.clone()));
        if let Some(l) = &label_id {
            parts.push(format!(
                "CAST({l} AS {cast_to}) {like_kw} {ph2} ESCAPE '\\'"
            ));
            binds.push(Some(pattern));
        }
        format!(" WHERE {}", parts.join(" OR "))
    } else {
        String::new()
    };

    // Request limit+1 so we can detect has_more without a second COUNT(*).
    let fetch_limit = limit.max(0).saturating_add(1);
    let sql = format!(
        "SELECT {projection} FROM {qt}{where_clause} ORDER BY {key_id} LIMIT {fetch_limit}"
    );

    let mut options: Vec<FkOption> = match pool {
        DbPool::Postgres(p) => {
            let mut q = sqlx::query(&sql);
            for b in &binds {
                q = q.bind(b);
            }
            let rows = q.fetch_all(&p).await?;
            rows.iter()
                .map(|r| {
                    let v = value_to_dropdown_string(&pg_value(r, 0));
                    let lbl = if label_id.is_some() {
                        match pg_value(r, 1) {
                            Value::Null => None,
                            other => Some(value_to_dropdown_string(&other)),
                        }
                    } else {
                        None
                    };
                    FkOption {
                        value: v,
                        label: lbl,
                    }
                })
                .collect()
        }
        DbPool::Mysql(p) => {
            let mut q = sqlx::query(&sql);
            for b in &binds {
                q = q.bind(b);
            }
            let rows = q.fetch_all(&p).await?;
            rows.iter()
                .map(|r| {
                    let v = value_to_dropdown_string(&mysql_value(r, 0));
                    let lbl = if label_id.is_some() {
                        match mysql_value(r, 1) {
                            Value::Null => None,
                            other => Some(value_to_dropdown_string(&other)),
                        }
                    } else {
                        None
                    };
                    FkOption {
                        value: v,
                        label: lbl,
                    }
                })
                .collect()
        }
        DbPool::Sqlite(p) => {
            let mut q = sqlx::query(&sql);
            for b in &binds {
                q = q.bind(b);
            }
            let rows = q.fetch_all(&p).await?;
            rows.iter()
                .map(|r| {
                    let v = value_to_dropdown_string(&sqlite_value(r, 0));
                    let lbl = if label_id.is_some() {
                        match sqlite_value(r, 1) {
                            Value::Null => None,
                            other => Some(value_to_dropdown_string(&other)),
                        }
                    } else {
                        None
                    };
                    FkOption {
                        value: v,
                        label: lbl,
                    }
                })
                .collect()
        }
    };

    let has_more = options.len() as i64 > limit;
    if has_more {
        options.truncate(limit.max(0) as usize);
    }
    Ok(FkOptionsPage { options, has_more })
}

/// Build the driver-specific `schema.table` (or just `table`) string.
fn qualified_table(pool: &DbPool, schema: Option<&str>, table: &str) -> String {
    match pool {
        DbPool::Postgres(_) => {
            let schema = schema.unwrap_or("public");
            format!("{}.{}", quote_ident(true, schema), quote_ident(true, table))
        }
        DbPool::Mysql(_) => match schema {
            Some(s) => format!("{}.{}", quote_ident(false, s), quote_ident(false, table)),
            None => quote_ident(false, table),
        },
        DbPool::Sqlite(_) => quote_ident(true, table),
    }
}
