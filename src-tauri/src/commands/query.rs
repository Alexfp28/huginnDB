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
use crate::db::sql::{is_read_only, Dialect};
use crate::db::values::{
    mysql_columns, mysql_value, pg_columns, pg_value, sqlite_columns, sqlite_value,
};
use crate::error::{AppError, AppResult};
use crate::log_bus::{self, LogEntry, LogKind, LogSink};
use crate::state::{AppState, DbPool};
use serde::{Deserialize, Serialize};
use serde_json::Value;
// Brought into scope for `<&Pool>::execute(&str)` / `<&mut Conn>::execute(&str)`
// in the ad-hoc DML paths. Passing a `&str` (no bound arguments) runs through
// sqlx's text/simple-query protocol — the unprepared path — whereas
// `sqlx::query(sql)` always prepares. Inherent `Query::execute` calls elsewhere
// are unaffected (inherent methods win over the trait).
use sqlx::Executor as _;
use std::collections::HashSet;
use std::time::Instant;
use tauri::{AppHandle, State};

/// Build the SQL [`LogEntry`] shared by the window- and sink-targeted
/// emitters below, so the field population lives in exactly one place.
#[allow(clippy::too_many_arguments)]
fn build_sql_entry(
    connection_id: &str,
    driver: &str,
    sql: &str,
    start: Instant,
    rows_affected: Option<u64>,
    error: Option<&str>,
) -> LogEntry {
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
    entry
}

/// Emit a SQL log entry through a [`LogSink`] after a statement finished.
///
/// This is the single logging path for every DB command: the GUI's
/// `#[tauri::command]` wrappers build a [`log_bus::TauriSink`] (window-scoped
/// Console emission) and the headless `huginndb-mcp` binary passes its own
/// sink, so the shared `_inner` cores ([`execute_with_state`],
/// [`fetch_table_data_inner`], [`update_cell_inner`], …) stay
/// Tauri-independent.
fn log_sql_sink(
    sink: &dyn LogSink,
    connection_id: &str,
    driver: &str,
    sql: &str,
    start: Instant,
    rows_affected: Option<u64>,
    error: Option<&str>,
) {
    let entry = build_sql_entry(connection_id, driver, sql, start, rows_affected, error);
    sink.log(entry);
}

/// Unwrap a `Result<_, sqlx::Error>` produced by a SQL call and, on failure,
/// emit a SQL log entry through the [`LogSink`] plus early-return the error
/// from the enclosing command — analogous to `?` with an extra side-effect.
///
/// We use a macro (rather than an `async fn` helper) for two reasons:
///
/// 1. The success branch needs to stay in the caller's control flow so
///    each driver arm can keep using its own bespoke row-decoding logic
///    (`pg_value` vs `mysql_value` vs `sqlite_value`).
/// 2. `return Err(...)` from inside an async closure would not exit the
///    outer function; a macro expands inline and does.
macro_rules! try_sql_sink {
    ($sink:expr, $cid:expr, $driver:expr, $sql:expr, $start:expr, $res:expr) => {
        match $res {
            Ok(v) => v,
            Err(e) => {
                let msg = e.to_string();
                log_sql_sink($sink, $cid, $driver, $sql, $start, None, Some(&msg));
                return Err(e.into());
            }
        }
    };
}

/// Comparison operator accepted by [`ColumnFilter`].
///
/// The set is intentionally closed so we can map each variant to a fixed
/// SQL fragment without going through user-supplied strings. All variants
/// except `IsNull` / `IsNotNull` consume the filter's bound `value`; the
/// frontend advanced-filter builder (#66) only *offers* the type-appropriate
/// subset per column, but the backend accepts any op on any column and lets
/// the driver coerce the textual literal.
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    Ne,
    /// `LIKE %v%` (case-insensitive via `ILIKE` on Postgres).
    Contains,
    /// `NOT LIKE %v%`.
    NotContains,
    /// `LIKE v%`.
    StartsWith,
    /// `LIKE %v`.
    EndsWith,
    /// `>` / `>=` / `<` / `<=` — numeric/date comparisons; the value is bound
    /// and the driver casts it to the column type.
    Gt,
    Gte,
    Lt,
    Lte,
    /// `BETWEEN v1 AND v2` (inclusive). Consumes both `value` and `value2`.
    Between,
    /// `IN (v1, v2, …)` / `NOT IN (…)`. The only ops that read the filter's
    /// `values` list instead of `value`/`value2`; driven by the data grid's
    /// "filter by the selected rows" action (#114).
    In,
    NotIn,
    IsNull,
    IsNotNull,
}

/// One column-level predicate applied by [`fetch_table_data`].
///
/// Multiple filters are AND-composed. Identifiers are always quoted via
/// [`Dialect::quote_ident`]; values are sent as binds, never interpolated into the
/// SQL string.
#[derive(Debug, Deserialize, Clone)]
pub struct ColumnFilter {
    pub column: String,
    pub op: FilterOp,
    /// Bound value. Always `None` for `IsNull` / `IsNotNull`; coerced
    /// through [`json_to_string`] for `Eq` / `Ne`.
    #[serde(default)]
    pub value: Value,
    /// Second bound value, only consumed by `Between` (the range's upper
    /// bound). Ignored by every other op.
    #[serde(default)]
    pub value2: Value,
    /// Value list, only consumed by `In` / `NotIn`. Ignored by every other op.
    /// Capped at [`MAX_IN_VALUES`] by [`validate_filters`] before any SQL is
    /// built.
    #[serde(default)]
    pub values: Vec<Value>,
}

/// One level of an `ORDER BY` clause built by [`fetch_table_data`].
///
/// The frontend sends an ordered list (`order[0]` is the primary sort key,
/// `order[1]` the tie-breaker, …) so the data browser can sort by several
/// columns at once. Identifiers are quoted via [`Dialect::quote_ident`]; only the
/// `ASC`/`DESC` keyword is interpolated, derived from the boolean.
#[derive(Debug, Deserialize, Clone)]
pub struct SortSpec {
    pub column: String,
    #[serde(default)]
    pub desc: bool,
}

/// One column/value pair used to build an INSERT statement.
///
/// We use parallel positional encoding (`Vec<RowValue>`) instead of a
/// `HashMap` so column order is preserved verbatim from the frontend —
/// otherwise we cannot pair columns with their placeholders deterministically.
/// `Serialize` as well, for the same reason as [`QueryResult`]: the bridge
/// carries these to whichever process owns the pool.
#[derive(Debug, Serialize, Deserialize)]
pub struct RowValue {
    pub column: String,
    /// Always a string or `null`. The cell editor and `RowEditor` dialog
    /// produce text only; drivers cast textual literals to the target type.
    pub value: Option<String>,
    /// Raw `data_type` string from `ColumnMeta` (e.g. `"BIT"` for MySQL BIT
    /// columns). Used to detect columns that need special binding (see
    /// `insert_row`'s MySQL BIT handling). `None` when the frontend has no
    /// type information (safe default: no special handling).
    #[serde(default)]
    pub column_type: Option<String>,
}

/// Result set returned to the frontend.
///
/// `Deserialize` as well as `Serialize` since the MCP bridge sends this back
/// across a process boundary: the sidecar re-reads it to apply its `--max-rows`
/// cap before handing it to the model.
#[derive(Debug, Serialize, Deserialize)]
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
    /// `true` when the driver returned more rows than [`MAX_ADHOC_QUERY_ROWS`]
    /// and the excess was discarded rather than sent to the frontend. Only
    /// ever set on a hand-typed SELECT with no `LIMIT`/`TOP`/`.limit()` of its
    /// own — [`fetch_table_data`] always paginates server-side and never
    /// truncates.
    #[serde(default)]
    pub truncated: bool,
    /// MongoDB only: the per-cell BSON *type* structure mirroring `rows`, one
    /// inner `Vec` per row aligned to `columns` (see
    /// [`crate::db::mongo::values::bson_type_tree`]).
    ///
    /// The SQL drivers leave this `None`: their column types are uniform per
    /// column and already carried by [`ColumnMeta::data_type`]. MongoDB's are
    /// not — a field's type is a property of the individual document, and
    /// nested fields have no `ColumnMeta` at all — so the document list view
    /// would otherwise have to guess a type from the (deliberately lossy)
    /// display JSON and would rewrite a `Long` as an `Int` on the first edit.
    ///
    /// Skipped when absent so a SQL result's payload is byte-identical to what
    /// it was before this field existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_types: Option<Vec<Vec<Value>>>,
}

/// Column descriptor in a [`QueryResult`]. `Deserialize` for the same reason
/// as its parent — it crosses the MCP bridge.
#[derive(Debug, Serialize, Deserialize)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
}

/// Result of [`count_table_rows`]: the row total for the current predicate
/// plus whether it is an engine-provided *estimate* (fast, approximate)
/// rather than an exact `COUNT(*)`.
///
/// The count is served separately from the data page (see
/// [`fetch_table_data`], which the GUI now always calls with
/// `with_count = false`) so the grid can paint its first rows immediately —
/// on a multi-million-row table the exact `COUNT(*)` used to gate that first
/// paint. When the whole table is browsed (no filters, no search) we skip the
/// count entirely and return the planner/catalog estimate, which is O(1);
/// any predicate forces an exact count (still off the render's critical path).
#[derive(Debug, Serialize)]
pub struct CountResult {
    pub total: u64,
    /// `true` when `total` came from a statistics estimate (`reltuples` on
    /// Postgres, `information_schema.TABLE_ROWS` on MySQL,
    /// `estimatedDocumentCount` on MongoDB) instead of an exact count. The
    /// frontend renders an estimate as `~N`.
    pub estimated: bool,
}

/// Per-statement outcome inside a [`BatchResult`].
///
/// `preview` is a single-line, length-capped echo of the statement (so the
/// UI can label each row of the summary without re-sending the SQL). On a
/// failing statement `error` carries the driver message and the batch stops
/// there — later statements never run, mirroring how a paste of `;`-delimited
/// queries would abort at the first failure in a `psql`/`mysql` session.
#[derive(Debug, Serialize)]
pub struct StmtOutcome {
    pub index: usize,
    pub preview: String,
    pub rows_affected: u64,
    pub is_select: bool,
    pub error: Option<String>,
}

/// Result of running a batch of statements via [`execute_batch`].
///
/// `last_result` holds the full result set of the *last* SELECT in the batch
/// (the grid shows it); write statements only contribute their affected-row
/// count to `total_affected` and an entry in `statements`.
#[derive(Debug, Serialize)]
pub struct BatchResult {
    pub statements: Vec<StmtOutcome>,
    pub last_result: Option<QueryResult>,
    pub total_affected: u64,
}

/// Resolve the active pool for `id`, or fail with [`AppError::NotConnected`].
fn pool_for(state: &AppState, id: &str) -> AppResult<DbPool> {
    state
        .connections
        .read()
        .get(id)
        .ok_or_else(|| AppError::NotConnected(id.to_string()))
}

/// One-line, length-capped echo of a statement for the batch summary.
fn stmt_preview(sql: &str) -> String {
    let one_line = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > 120 {
        let head: String = one_line.chars().take(117).collect();
        format!("{head}…")
    } else {
        one_line
    }
}

/// Decode a Postgres result set into `(columns, rows)`. Shared by
/// [`execute_with_state`] and [`execute_batch`] so the two paths can never
/// drift in how they map driver rows to JSON values.
fn pg_result(rows: &[sqlx::postgres::PgRow]) -> (Vec<ColumnMeta>, Vec<Vec<Value>>) {
    use sqlx::Row;
    let columns = rows
        .first()
        .map(|r| {
            pg_columns(r)
                .into_iter()
                .map(|(name, data_type)| ColumnMeta { name, data_type })
                .collect()
        })
        .unwrap_or_default();
    let data = rows
        .iter()
        .map(|r| (0..r.columns().len()).map(|i| pg_value(r, i)).collect())
        .collect();
    (columns, data)
}

/// Decode a MySQL result set into `(columns, rows)`. See [`pg_result`].
fn mysql_result(rows: &[sqlx::mysql::MySqlRow]) -> (Vec<ColumnMeta>, Vec<Vec<Value>>) {
    use sqlx::Row;
    let columns = rows
        .first()
        .map(|r| {
            mysql_columns(r)
                .into_iter()
                .map(|(name, data_type)| ColumnMeta { name, data_type })
                .collect()
        })
        .unwrap_or_default();
    let data = rows
        .iter()
        .map(|r| (0..r.columns().len()).map(|i| mysql_value(r, i)).collect())
        .collect();
    (columns, data)
}

/// Decode a SQLite result set into `(columns, rows)`. See [`pg_result`].
fn sqlite_result(rows: &[sqlx::sqlite::SqliteRow]) -> (Vec<ColumnMeta>, Vec<Vec<Value>>) {
    use sqlx::Row;
    let columns = rows
        .first()
        .map(|r| {
            sqlite_columns(r)
                .into_iter()
                .map(|(name, data_type)| ColumnMeta { name, data_type })
                .collect()
        })
        .unwrap_or_default();
    let data = rows
        .iter()
        .map(|r| (0..r.columns().len()).map(|i| sqlite_value(r, i)).collect())
        .collect();
    (columns, data)
}

/// Execute an arbitrary SQL statement on the connection identified by
/// `connection_id`.
#[tauri::command]
pub async fn execute_query(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
) -> AppResult<QueryResult> {
    let sink = log_bus::TauriSink::new(&app, window.label());
    crate::commands::connection::ensure_database_view(
        &app,
        state.inner(),
        Some(window.label()),
        &connection_id,
    )
    .await;
    execute_with_state(&sink, state.inner(), &connection_id, &sql).await
}

/// Shared implementation used by [`execute_query`] and the headless MCP
/// `run_query` tool. Takes a borrowed [`AppState`] and a [`LogSink`] so it
/// can run without a Tauri `State` guard or `AppHandle` — the GUI passes a
/// `TauriSink`, the MCP binary a `NoopSink`.
///
/// Emits a SQL [`LogEntry`] after every execution path (write, read, and
/// error) so the Console panel sees the same statement the engine ran.
pub(crate) async fn execute_with_state(
    sink: &dyn LogSink,
    state: &AppState,
    connection_id: &str,
    sql: &str,
) -> AppResult<QueryResult> {
    let pool = pool_for(state, connection_id)?;
    let driver = pool.driver_name();
    let start = Instant::now();

    // MongoDB: parse + run the mongosh-style statement in the mongo module,
    // which classifies read vs write itself and shapes the result.
    if let DbPool::Mongo(conn) = &pool {
        let result = crate::db::mongo::query::execute(conn, sql).await;
        match &result {
            Ok(r) => log_sql_sink(
                sink,
                connection_id,
                driver,
                sql,
                start,
                Some(r.rows_affected),
                None,
            ),
            Err(e) => log_sql_sink(
                sink,
                connection_id,
                driver,
                sql,
                start,
                None,
                Some(&e.to_string()),
            ),
        }
        return result;
    }

    if !is_read_only(sql) {
        // Ad-hoc, hand-typed DML/DDL runs through the **unprepared** simple-query
        // protocol (`raw_sql`), not the prepared/binary protocol that
        // `sqlx::query(...)` uses. The editor never binds parameters, so there's
        // nothing to prepare — and MySQL's prepared protocol rejects or
        // mishandles a whole family of statements a CLI client runs without
        // complaint (the recurring BIT / integer-literal and "command not
        // supported in the prepared statement protocol" errors). The simple
        // protocol parses the statement exactly like the server's CLI would, so
        // what the user types is what executes. We only need `rows_affected`
        // here, so there's no result-set decoding to worry about. SELECTs keep
        // the prepared path below (their typed decoding is unaffected).
        //
        // Passing the bare `&str` to `Executor::execute` is what selects the
        // unprepared protocol: a `&str` carries no bound arguments, and sqlx
        // sends argument-less queries via the simple-query (text) protocol.
        let rows_affected = try_sql_sink!(
            sink,
            connection_id,
            driver,
            sql,
            start,
            match &pool {
                DbPool::Postgres(p) => p
                    .execute(sql)
                    .await
                    .map(|r| r.rows_affected())
                    .map_err(AppError::from),
                DbPool::Mysql(p) => p
                    .execute(sql)
                    .await
                    .map(|r| r.rows_affected())
                    .map_err(AppError::from),
                DbPool::Sqlite(p) => p
                    .execute(sql)
                    .await
                    .map(|r| r.rows_affected())
                    .map_err(AppError::from),
                // `tiberius` has only the unprepared path for parameterless
                // SQL, which is exactly what the editor needs here.
                DbPool::MsSql(p) => p.execute_simple(sql).await,
                DbPool::Mongo(_) => unreachable!("mongo dispatched above"),
            }
        );
        log_sql_sink(
            sink,
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
            truncated: false,
            row_types: None,
        });
    }

    let ((columns, data), truncated) = match pool {
        DbPool::Postgres(p) => {
            let (rows, truncated) = try_sql_sink!(
                sink,
                connection_id,
                driver,
                sql,
                start,
                fetch_capped(&p, sql, MAX_ADHOC_QUERY_ROWS).await
            );
            (pg_result(&rows), truncated)
        }
        DbPool::Mysql(p) => {
            let (rows, truncated) = try_sql_sink!(
                sink,
                connection_id,
                driver,
                sql,
                start,
                fetch_capped(&p, sql, MAX_ADHOC_QUERY_ROWS).await
            );
            (mysql_result(&rows), truncated)
        }
        DbPool::Sqlite(p) => {
            let (rows, truncated) = try_sql_sink!(
                sink,
                connection_id,
                driver,
                sql,
                start,
                fetch_capped(&p, sql, MAX_ADHOC_QUERY_ROWS).await
            );
            (sqlite_result(&rows), truncated)
        }
        DbPool::MsSql(p) => {
            // A T-SQL batch can return several result sets; the grid shows one,
            // so take the first non-empty one (a `SELECT` preceded by e.g. a
            // `SET NOCOUNT ON` would otherwise look empty).
            let (sets, truncated) = try_sql_sink!(
                sink,
                connection_id,
                driver,
                sql,
                start,
                p.query_sets_capped(sql, MAX_ADHOC_QUERY_ROWS).await
            );
            let rows = sets.into_iter().find(|s| !s.is_empty()).unwrap_or_default();
            let (cols, data) = crate::db::mssql::schema::decode_rows(&rows);
            (
                (
                    cols.into_iter()
                        .map(|(name, data_type)| ColumnMeta { name, data_type })
                        .collect::<Vec<_>>(),
                    data,
                ),
                truncated,
            )
        }
        DbPool::Mongo(_) => unreachable!("mongo dispatched above"),
    };
    let result = QueryResult {
        rows_affected: data.len() as u64,
        rows: data,
        columns,
        elapsed_ms: start.elapsed().as_millis() as u64,
        total: None,
        truncated,
        row_types: None,
    };
    log_sql_sink(
        sink,
        connection_id,
        driver,
        sql,
        start,
        Some(result.rows_affected),
        None,
    );
    Ok(result)
}

/// Run a batch of statements sequentially on a single pooled connection.
///
/// The frontend splits the editor buffer into individual statements (reusing
/// its `splitSql` lexer) and sends them here as a list. We run them **on one
/// acquired connection**, in order, so that session-scoped state carries
/// across the batch: an explicit `BEGIN`/`COMMIT`, a MySQL `USE db`, temp
/// tables, `SET`s, etc. Acquiring a fresh connection per statement (what
/// `execute_query` does) would scatter them across the pool and silently break
/// the user's own transaction control.
///
/// We deliberately do **not** open an implicit transaction around the batch:
/// atomicity stays in the user's hands (and now works, because it's one
/// connection). Execution stops at the first failing statement — its error is
/// recorded in the corresponding [`StmtOutcome`] and later statements are
/// skipped, matching how a `;`-delimited paste aborts in a CLI client. The
/// last SELECT's full result set is returned in `last_result` for the grid.
///
/// This is also the path that fixes multi-statement Ctrl+Enter: a single
/// `sqlx::query` over a `;`-joined buffer goes through the *prepared* protocol,
/// which rejects multiple commands; running them one at a time does not.
#[tauri::command]
pub async fn execute_batch(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    statements: Vec<String>,
) -> AppResult<BatchResult> {
    let sink = log_bus::TauriSink::new(&app, window.label());
    crate::commands::connection::ensure_database_view(
        &app,
        state.inner(),
        Some(window.label()),
        &connection_id,
    )
    .await;
    execute_batch_inner(&sink, state.inner(), connection_id, statements).await
}

/// Tauri-independent core of [`execute_batch`], shared with the headless MCP
/// write path. Takes a borrowed [`AppState`] and a [`LogSink`] instead of a
/// Tauri `State`/`AppHandle`.
pub(crate) async fn execute_batch_inner(
    sink: &dyn LogSink,
    state: &AppState,
    connection_id: String,
    statements: Vec<String>,
) -> AppResult<BatchResult> {
    let pool = pool_for(state, &connection_id)?;
    let driver = pool.driver_name();

    if let DbPool::Mongo(conn) = &pool {
        return crate::db::mongo::query::execute_batch(conn, &statements, sink, &connection_id)
            .await;
    }

    let mut outcomes: Vec<StmtOutcome> = Vec::with_capacity(statements.len());
    let mut last_result: Option<QueryResult> = None;
    let mut total_affected: u64 = 0;

    // Drive every statement over a single borrowed connection `$conn`,
    // decoding SELECT result sets with the driver-specific `$decode`. Pushes
    // one `StmtOutcome` per statement and breaks on the first error.
    macro_rules! drive {
        ($conn:expr, $decode:path) => {{
            for (index, raw) in statements.iter().enumerate() {
                let sql = raw.trim();
                if sql.is_empty() {
                    continue;
                }
                let is_select = is_read_only(sql);
                let start = Instant::now();
                if is_select {
                    match fetch_capped(&mut *$conn, sql, MAX_ADHOC_QUERY_ROWS).await {
                        Ok((rows, truncated)) => {
                            let (columns, data) = $decode(&rows);
                            let ra = data.len() as u64;
                            total_affected += ra;
                            log_sql_sink(sink, &connection_id, driver, sql, start, Some(ra), None);
                            last_result = Some(QueryResult {
                                columns,
                                rows: data,
                                rows_affected: ra,
                                elapsed_ms: start.elapsed().as_millis() as u64,
                                total: None,
                                truncated,
                                row_types: None,
                            });
                            outcomes.push(StmtOutcome {
                                index,
                                preview: stmt_preview(sql),
                                rows_affected: ra,
                                is_select: true,
                                error: None,
                            });
                        }
                        Err(e) => {
                            let msg = e.to_string();
                            log_sql_sink(
                                sink,
                                &connection_id,
                                driver,
                                sql,
                                start,
                                None,
                                Some(&msg),
                            );
                            outcomes.push(StmtOutcome {
                                index,
                                preview: stmt_preview(sql),
                                rows_affected: 0,
                                is_select: true,
                                error: Some(msg),
                            });
                            break;
                        }
                    }
                } else {
                    // Non-SELECT statements run through the unprepared simple-query
                    // protocol — see the rationale in `execute_with_state`. The
                    // prepared/binary protocol rejects or mishandles statements a
                    // CLI client accepts (notably MySQL BIT / integer-literal DML),
                    // and an ad-hoc editor binds no parameters, so there's nothing
                    // to prepare. Passing the bare `&str` to `Executor::execute`
                    // (no bound arguments) is what selects the text protocol. Only
                    // `rows_affected` is consumed here.
                    match (&mut *$conn).execute(sql).await {
                        Ok(r) => {
                            let ra = r.rows_affected();
                            total_affected += ra;
                            log_sql_sink(sink, &connection_id, driver, sql, start, Some(ra), None);
                            outcomes.push(StmtOutcome {
                                index,
                                preview: stmt_preview(sql),
                                rows_affected: ra,
                                is_select: false,
                                error: None,
                            });
                        }
                        Err(e) => {
                            let msg = e.to_string();
                            log_sql_sink(
                                sink,
                                &connection_id,
                                driver,
                                sql,
                                start,
                                None,
                                Some(&msg),
                            );
                            outcomes.push(StmtOutcome {
                                index,
                                preview: stmt_preview(sql),
                                rows_affected: 0,
                                is_select: false,
                                error: Some(msg),
                            });
                            break;
                        }
                    }
                }
            }
        }};
    }

    // Same loop for SQL Server, over one pooled TDS session. It cannot share
    // `drive!` because that macro is written against `sqlx::query` and an
    // `Executor`; everything else about the shape (per-statement outcome, break
    // on first error, remember the last SELECT) is identical.
    macro_rules! drive_mssql {
        ($client:expr) => {{
            for (index, raw) in statements.iter().enumerate() {
                let sql = raw.trim();
                if sql.is_empty() {
                    continue;
                }
                let is_select = is_read_only(sql);
                let start = Instant::now();
                let outcome: AppResult<(u64, Option<QueryResult>)> = if is_select {
                    $client
                        .simple_query_sets_capped(sql, MAX_ADHOC_QUERY_ROWS)
                        .await
                        .map(|(sets, truncated)| {
                            let rows = sets.into_iter().find(|s| !s.is_empty()).unwrap_or_default();
                            let (cols, data) = crate::db::mssql::schema::decode_rows(&rows);
                            let ra = data.len() as u64;
                            (
                                ra,
                                Some(QueryResult {
                                    columns: cols
                                        .into_iter()
                                        .map(|(name, data_type)| ColumnMeta { name, data_type })
                                        .collect(),
                                    rows: data,
                                    rows_affected: ra,
                                    elapsed_ms: start.elapsed().as_millis() as u64,
                                    total: None,
                                    truncated,
                                    // SQL, so the catalog column type is the hint
                                    // the editor needs; per-cell BSON type trees
                                    // are MongoDB's alone (gotcha #29).
                                    row_types: None,
                                }),
                            )
                        })
                } else {
                    $client.simple_execute(sql).await.map(|ra| (ra, None))
                };
                match outcome {
                    Ok((ra, result)) => {
                        total_affected += ra;
                        if result.is_some() {
                            last_result = result;
                        }
                        log_sql_sink(sink, &connection_id, driver, sql, start, Some(ra), None);
                        outcomes.push(StmtOutcome {
                            index,
                            preview: stmt_preview(sql),
                            rows_affected: ra,
                            is_select,
                            error: None,
                        });
                    }
                    Err(e) => {
                        let msg = e.to_string();
                        log_sql_sink(sink, &connection_id, driver, sql, start, None, Some(&msg));
                        outcomes.push(StmtOutcome {
                            index,
                            preview: stmt_preview(sql),
                            rows_affected: 0,
                            is_select,
                            error: Some(msg),
                        });
                        break;
                    }
                }
            }
        }};
    }

    let acquire_start = Instant::now();
    match &pool {
        DbPool::Postgres(p) => {
            let mut conn = try_sql_sink!(
                sink,
                &connection_id,
                driver,
                "(batch)",
                acquire_start,
                p.acquire().await
            );
            drive!(conn, pg_result);
        }
        DbPool::Mysql(p) => {
            let mut conn = try_sql_sink!(
                sink,
                &connection_id,
                driver,
                "(batch)",
                acquire_start,
                p.acquire().await
            );
            drive!(conn, mysql_result);
        }
        DbPool::Sqlite(p) => {
            let mut conn = try_sql_sink!(
                sink,
                &connection_id,
                driver,
                "(batch)",
                acquire_start,
                p.acquire().await
            );
            drive!(conn, sqlite_result);
        }
        DbPool::MsSql(p) => {
            let mut client = try_sql_sink!(
                sink,
                &connection_id,
                driver,
                "(batch)",
                acquire_start,
                p.acquire().await
            );
            drive_mssql!(client);
        }
        DbPool::Mongo(_) => unreachable!("mongo dispatched above"),
    }

    Ok(BatchResult {
        statements: outcomes,
        last_result,
        total_affected,
    })
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

/// Upper bound on how many values a single `In` / `NotIn` filter may carry.
///
/// Every value becomes one bind, so an unbounded list turns into an unbounded
/// statement: engines have their own placeholder ceilings (Postgres tops out at
/// 65535 binds per statement, SQLite's `SQLITE_MAX_VARIABLE_NUMBER` defaults far
/// lower) and the failure mode is an opaque driver error rather than anything the
/// user can act on. 1000 is comfortably above any plausible manual selection in
/// the grid and far below every engine limit.
pub const MAX_IN_VALUES: usize = 1000;

/// Upper bound on how many rows an ad-hoc query (the editor's `execute_query`/
/// `execute_batch`, and MongoDB's `find`/`aggregate` shell statements) keeps
/// from a SELECT/find result.
///
/// Unlike [`fetch_table_data`], which always appends its own `LIMIT`/`OFFSET`,
/// text the user typed carries no such bound — a `SELECT * FROM big_table
/// WHERE rarely_true` returns however many rows the table has. Every SQL
/// driver here used to hand that straight to `fetch_all`/`tiberius::
/// into_results`, which buffer the *entire* result set in memory before
/// returning, and `DataGrid` then rendered every one of those rows into the
/// DOM — a non-selective query over a large table reliably took down the
/// whole app with an out-of-memory crash (no timeout ever ran, because the
/// "Run" button's clock is cosmetic and never cancels the driver call). Rows
/// past the cap are still drained off the wire (SQL: to leave the pooled
/// session/connection at a clean protocol boundary instead of mid-response;
/// Mongo: the cursor is simply dropped early, which is a supported operation)
/// — they're discarded, not merely deferred, so backend memory stays bounded
/// regardless of how many rows the query actually matches.
pub const MAX_ADHOC_QUERY_ROWS: usize = 50_000;

/// Stream `sql` and keep only the first `cap` rows, still draining (and
/// discarding) anything past that so the connection is left at a clean
/// protocol boundary rather than mid-response — see [`MAX_ADHOC_QUERY_ROWS`].
/// Returns `(rows, truncated)`.
async fn fetch_capped<'q, 'c, DB, E>(
    executor: E,
    sql: &'q str,
    cap: usize,
) -> Result<(Vec<DB::Row>, bool), sqlx::Error>
where
    DB: sqlx::Database,
    E: sqlx::Executor<'c, Database = DB>,
    for<'a> <DB as sqlx::Database>::Arguments<'a>: sqlx::IntoArguments<'a, DB>,
{
    use futures_util::TryStreamExt;
    let mut stream = sqlx::query(sql).fetch(executor);
    let mut rows = Vec::new();
    let mut truncated = false;
    while let Some(row) = stream.try_next().await? {
        if rows.len() < cap {
            rows.push(row);
        } else {
            truncated = true;
        }
    }
    Ok((rows, truncated))
}

/// Reject filter payloads that would build pathological or invalid SQL.
///
/// Called from [`fetch_table_data_inner`] rather than from the `#[tauri::command]`
/// wrapper, so it guards every caller of the shared core — today that's the GUI
/// command (the only one that sends filters; the MCP `browse_table` tool passes
/// `None`), and tomorrow anything else built on it.
fn validate_filters(filters: &[ColumnFilter]) -> AppResult<()> {
    for f in filters {
        if matches!(f.op, FilterOp::In | FilterOp::NotIn) && f.values.len() > MAX_IN_VALUES {
            return Err(AppError::InvalidInput(format!(
                "filter on {:?}: {} values exceeds the {MAX_IN_VALUES}-value limit for IN/NOT IN",
                f.column,
                f.values.len()
            )));
        }
    }
    Ok(())
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
    dialect: Dialect,
    filters: &[ColumnFilter],
    search: Option<&str>,
    search_columns: &[String],
) -> (String, Vec<Option<String>>) {
    let (clause, binds, _) = build_filter_clause_at(1, dialect, filters, search, search_columns);
    (clause, binds)
}

/// Same as [`build_filter_clause`], but starting the positional placeholder
/// counter at `start_at` instead of always at 1, and returning the counter's
/// final value alongside the usual `(clause, binds)`.
///
/// Needed when a `WHERE` built from this function is appended after a `SET`
/// clause that already consumed some placeholders (bulk update, see
/// `crate::commands::bulk`): Postgres numbers placeholders globally per
/// statement, so the `WHERE` must continue the `SET`'s counter rather than
/// restart at `$1`. MySQL/SQLite's `?` doesn't care about the number, so the
/// threading is harmless there too.
pub(crate) fn build_filter_clause_at(
    start_at: usize,
    dialect: Dialect,
    filters: &[ColumnFilter],
    search: Option<&str>,
    search_columns: &[String],
) -> (String, Vec<Option<String>>, usize) {
    let mut binds: Vec<Option<String>> = Vec::new();
    let mut parts: Vec<String> = Vec::new();
    let mut next_placeholder: usize = start_at;

    // Next positional placeholder for this dialect, advancing the counter.
    let placeholder = |next: &mut usize| -> String {
        let ph = dialect.placeholder(*next);
        *next += 1;
        ph
    };
    let like_kw = dialect.like_kw();
    let cast_to = dialect.cast_to_text();
    let escape = dialect.like_escape_clause();

    for f in filters {
        let col = dialect.quote_ident(&f.column);
        match f.op {
            FilterOp::IsNull => parts.push(format!("{col} IS NULL")),
            FilterOp::IsNotNull => parts.push(format!("{col} IS NOT NULL")),
            FilterOp::Eq
            | FilterOp::Ne
            | FilterOp::Gt
            | FilterOp::Gte
            | FilterOp::Lt
            | FilterOp::Lte => {
                let sym = match f.op {
                    FilterOp::Eq => "=",
                    FilterOp::Ne => "<>",
                    FilterOp::Gt => ">",
                    FilterOp::Gte => ">=",
                    FilterOp::Lt => "<",
                    FilterOp::Lte => "<=",
                    // Unreachable: the arm above admits only those six. Listed
                    // by name rather than `_` so that adding a `FilterOp` is a
                    // compile error here instead of silently inheriting `<=`.
                    FilterOp::Contains
                    | FilterOp::NotContains
                    | FilterOp::StartsWith
                    | FilterOp::EndsWith
                    | FilterOp::Between
                    | FilterOp::In
                    | FilterOp::NotIn
                    | FilterOp::IsNull
                    | FilterOp::IsNotNull => {
                        unreachable!("non-comparison op in the comparison arm")
                    }
                };
                let ph = placeholder(&mut next_placeholder);
                parts.push(format!("{col} {sym} {ph}"));
                binds.push(json_to_string(&f.value));
            }
            FilterOp::Between => {
                let ph1 = placeholder(&mut next_placeholder);
                let ph2 = placeholder(&mut next_placeholder);
                parts.push(format!("{col} BETWEEN {ph1} AND {ph2}"));
                binds.push(json_to_string(&f.value));
                binds.push(json_to_string(&f.value2));
            }
            FilterOp::In | FilterOp::NotIn => {
                let negated = matches!(f.op, FilterOp::NotIn);
                // Deduplicate on the *bound* representation while preserving the
                // order the values arrived in: selecting 40 rows that share a
                // value must produce one placeholder, not 40. NULL is pulled out
                // separately — no `IN` list can ever match it.
                let mut seen: HashSet<String> = HashSet::new();
                let mut bound: Vec<Option<String>> = Vec::new();
                let mut has_null = false;
                for v in &f.values {
                    match json_to_string(v) {
                        None => has_null = true,
                        Some(s) => {
                            if seen.insert(s.clone()) {
                                bound.push(Some(s));
                            }
                        }
                    }
                }

                if bound.is_empty() {
                    // `IN ()` is a syntax error on every engine. A list that is
                    // empty (or NULL-only) can only arrive from a hand-built
                    // payload, since the UI always sends the selected values —
                    // but emit a valid degenerate predicate rather than dropping
                    // the filter, because dropping it would silently widen the
                    // result set to the whole table, the opposite of the ask.
                    if has_null {
                        let kw = if negated { "IS NOT NULL" } else { "IS NULL" };
                        parts.push(format!("{col} {kw}"));
                    } else {
                        parts.push(if negated { "1 = 1" } else { "1 = 0" }.to_string());
                    }
                } else {
                    let list = bound
                        .iter()
                        .map(|_| placeholder(&mut next_placeholder))
                        .collect::<Vec<_>>()
                        .join(", ");
                    // SQL's three-valued logic makes NULL the whole subtlety
                    // here, and it cuts in opposite directions per op:
                    //
                    // * `IN` + NULL selected → `col IN (…)` is never true for a
                    //   NULL column, so the NULL rows the user explicitly picked
                    //   would vanish. Add `OR col IS NULL`.
                    // * `NOT IN` + NULL selected → nothing to add: NULL was kept
                    //   out of the list, and `NULL NOT IN (…)` evaluates to NULL
                    //   (not true), so NULL rows are already excluded — which is
                    //   exactly what "exclude these" asked for.
                    // * `NOT IN` without NULL selected → the classic trap. NULL
                    //   rows would be dropped by 3VL even though the user never
                    //   asked to exclude them. Add `OR col IS NULL` to keep them.
                    if negated {
                        if has_null {
                            parts.push(format!("{col} NOT IN ({list})"));
                        } else {
                            parts.push(format!("({col} NOT IN ({list}) OR {col} IS NULL)"));
                        }
                    } else if has_null {
                        parts.push(format!("({col} IN ({list}) OR {col} IS NULL)"));
                    } else {
                        parts.push(format!("{col} IN ({list})"));
                    }
                    binds.extend(bound);
                }
            }
            FilterOp::Contains
            | FilterOp::NotContains
            | FilterOp::StartsWith
            | FilterOp::EndsWith => {
                // Substring / prefix / suffix match. Cast the column to text so
                // the pattern match works on non-text columns too, and escape
                // the user value's LIKE metacharacters before wrapping it in
                // the position wildcards.
                let raw = json_to_string(&f.value).unwrap_or_default();
                let escaped = escape_like(&raw);
                let (pattern, kw) = match f.op {
                    FilterOp::Contains => (format!("%{escaped}%"), like_kw),
                    FilterOp::NotContains => (format!("%{escaped}%"), "NOT LIKE"),
                    FilterOp::StartsWith => (format!("{escaped}%"), like_kw),
                    FilterOp::EndsWith => (format!("%{escaped}"), like_kw),
                    // Unreachable, and spelled out for the same reason as the
                    // comparison arm above: a new `FilterOp` must not quietly
                    // become a suffix match.
                    FilterOp::Eq
                    | FilterOp::Ne
                    | FilterOp::Gt
                    | FilterOp::Gte
                    | FilterOp::Lt
                    | FilterOp::Lte
                    | FilterOp::Between
                    | FilterOp::In
                    | FilterOp::NotIn
                    | FilterOp::IsNull
                    | FilterOp::IsNotNull => {
                        unreachable!("non-pattern op in the pattern arm")
                    }
                };
                // `NOT LIKE` has no case-insensitive keyword form; on Postgres
                // fold both sides to lower() so "not contains" stays
                // case-insensitive like the positive matches.
                let ph = placeholder(&mut next_placeholder);
                if dialect.not_like_needs_lower() && matches!(f.op, FilterOp::NotContains) {
                    parts.push(format!(
                        "lower(CAST({col} AS {cast_to})) NOT LIKE lower({ph}){escape}"
                    ));
                } else {
                    parts.push(format!("CAST({col} AS {cast_to}) {kw} {ph}{escape}"));
                }
                binds.push(Some(pattern));
            }
        }
    }

    if let Some(q) = search {
        if !q.is_empty() && !search_columns.is_empty() {
            // Reuses the `like_kw` / `cast_to` / `escape` bindings hoisted above.
            let pattern = format!("%{}%", escape_like(q));
            let mut or_parts: Vec<String> = Vec::new();
            for col in search_columns {
                let qcol = dialect.quote_ident(col);
                let ph = placeholder(&mut next_placeholder);
                or_parts.push(format!("CAST({qcol} AS {cast_to}) {like_kw} {ph}{escape}"));
                binds.push(Some(pattern.clone()));
            }
            if !or_parts.is_empty() {
                parts.push(format!("({})", or_parts.join(" OR ")));
            }
        }
    }

    if parts.is_empty() {
        return (String::new(), binds, next_placeholder);
    }
    (
        format!(" WHERE {}", parts.join(" AND ")),
        binds,
        next_placeholder,
    )
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
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
    limit: i64,
    offset: i64,
    order: Option<Vec<SortSpec>>,
    filters: Option<Vec<ColumnFilter>>,
    search: Option<String>,
    search_columns: Option<Vec<String>>,
    // Whether to run the companion `SELECT COUNT(*)`. The frontend passes
    // `false` when only the sort/offset/page changed (the total can't have
    // changed) and reuses its cached total, saving a round trip per
    // interaction. Defaults to `true` (count) when omitted.
    with_count: Option<bool>,
) -> AppResult<QueryResult> {
    let sink = log_bus::TauriSink::new(&app, window.label());
    crate::commands::connection::ensure_database_view(
        &app,
        state.inner(),
        Some(window.label()),
        &connection_id,
    )
    .await;
    fetch_table_data_inner(
        &sink,
        state.inner(),
        connection_id,
        schema,
        table,
        limit,
        offset,
        order,
        filters,
        search,
        search_columns,
        with_count,
    )
    .await
}

/// Tauri-independent core of [`fetch_table_data`], reused by the headless MCP
/// `browse_table` tool. Takes a borrowed [`AppState`] and a [`LogSink`] (a
/// `TauriSink` in the GUI, a `NoopSink` under MCP) instead of the Tauri
/// `State` guard + `AppHandle`.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn fetch_table_data_inner(
    sink: &dyn LogSink,
    state: &AppState,
    connection_id: String,
    schema: Option<String>,
    table: String,
    limit: i64,
    offset: i64,
    order: Option<Vec<SortSpec>>,
    filters: Option<Vec<ColumnFilter>>,
    search: Option<String>,
    search_columns: Option<Vec<String>>,
    with_count: Option<bool>,
) -> AppResult<QueryResult> {
    if let Some(f) = filters.as_deref() {
        validate_filters(f)?;
    }
    let pool = pool_for(state, &connection_id)?;

    // MongoDB browse: delegate to the mongo module (find + count). Clone the
    // option args so the SQL path below — though unreachable for mongo — still
    // type-checks without a use-after-move.
    let order = order.unwrap_or_default();
    let want_count = with_count.unwrap_or(true);

    if let DbPool::Mongo(conn) = &pool {
        let f = filters.clone().unwrap_or_default();
        let sc = search_columns.clone().unwrap_or_default();
        let search_ref = search.as_deref().filter(|s| !s.is_empty());
        let start = Instant::now();
        let result = crate::db::mongo::query::fetch_collection_data(
            conn, &table, limit, offset, &order, &f, search_ref, &sc, want_count,
        )
        .await;
        let sql_text = crate::db::mongo::query::describe_find(
            &table, &f, search_ref, &sc, &order, limit, offset,
        );
        match &result {
            Ok(r) => log_sql_sink(
                sink,
                &connection_id,
                "mongodb",
                &sql_text,
                start,
                Some(r.rows.len() as u64),
                None,
            ),
            Err(e) => log_sql_sink(
                sink,
                &connection_id,
                "mongodb",
                &sql_text,
                start,
                None,
                Some(&e.to_string()),
            ),
        }
        return result;
    }

    let driver = pool.driver_name();
    let dialect = Dialect::try_of(&pool)?;

    // Build a multi-level `ORDER BY c1 ASC, c2 DESC, …`. Identifiers are
    // quoted; only the ASC/DESC keyword is interpolated (from the bool).
    let order_clause = if order.is_empty() {
        String::new()
    } else {
        let parts: Vec<String> = order
            .iter()
            .map(|s| {
                let dir = if s.desc { "DESC" } else { "ASC" };
                format!("{} {}", dialect.quote_ident(&s.column), dir)
            })
            .collect();
        format!(" ORDER BY {}", parts.join(", "))
    };

    let filters = filters.unwrap_or_default();
    let search_columns = search_columns.unwrap_or_default();
    let search_ref = search.as_deref().filter(|s| !s.is_empty());
    let (where_clause, where_binds) =
        build_filter_clause(dialect, &filters, search_ref, &search_columns);

    let qt = dialect.qualify_defaulted(schema.as_deref(), &table);

    // LIMIT/OFFSET stay inline (they are integers we already parsed),
    // so the filter binds are the only binds in the statement. The clause
    // itself is dialect-specific: T-SQL has no LIMIT and its OFFSET/FETCH
    // form requires an ORDER BY, which `paginate` supplies when the user
    // hasn't sorted.
    let page = dialect.paginate(limit, offset, !order_clause.is_empty());
    let data_sql = format!("SELECT * FROM {qt}{where_clause}{order_clause}{page}");
    let count_sql = format!("SELECT COUNT(*) FROM {qt}{where_clause}");

    let start = Instant::now();
    let (columns, data) = match &pool {
        DbPool::Postgres(p) => {
            let mut q = sqlx::query(&data_sql);
            for b in &where_binds {
                q = q.bind(b);
            }
            let rows = try_sql_sink!(
                sink,
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
            let rows = try_sql_sink!(
                sink,
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
            let rows = try_sql_sink!(
                sink,
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
        DbPool::MsSql(p) => {
            let rows = try_sql_sink!(
                sink,
                &connection_id,
                driver,
                &data_sql,
                start,
                p.query_all(&data_sql, &where_binds).await
            );
            let (cols, data) = crate::db::mssql::schema::decode_rows(&rows);
            (
                cols.into_iter()
                    .map(|(name, data_type)| ColumnMeta { name, data_type })
                    .collect::<Vec<_>>(),
                data,
            )
        }
        DbPool::Mongo(_) => unreachable!("mongo dispatched above"),
    };
    let elapsed_ms = start.elapsed().as_millis() as u64;
    log_sql_sink(
        sink,
        &connection_id,
        driver,
        &data_sql,
        start,
        Some(data.len() as u64),
        None,
    );

    // The COUNT companion is skipped when the caller already knows the total
    // (only sort/offset/page changed). This halves the round trips for the
    // common case of paging through or re-sorting a large result set.
    let total: Option<u64> = if want_count {
        let count_start = Instant::now();
        let raw_count: Option<i64> = try_sql_sink!(
            sink,
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
                    q.fetch_optional(p).await.map_err(AppError::from)
                }
                DbPool::Mysql(p) => {
                    let mut q = sqlx::query_scalar::<_, i64>(&count_sql);
                    for b in &where_binds {
                        q = q.bind(b);
                    }
                    q.fetch_optional(p).await.map_err(AppError::from)
                }
                DbPool::Sqlite(p) => {
                    let mut q = sqlx::query_scalar::<_, i64>(&count_sql);
                    for b in &where_binds {
                        q = q.bind(b);
                    }
                    q.fetch_optional(p).await.map_err(AppError::from)
                }
                DbPool::MsSql(p) => p.scalar(&count_sql, &where_binds).await,
                DbPool::Mongo(_) => unreachable!("mongo dispatched above"),
            }
        );
        let total = raw_count.map(|n| n as u64);
        log_sql_sink(
            sink,
            &connection_id,
            driver,
            &count_sql,
            count_start,
            total,
            None,
        );
        total
    } else {
        None
    };

    // An empty page carries no rows for the per-driver decode to read column
    // metadata from, so `columns` came back empty above — which left the grid
    // with no headers and no way to begin an insert on an empty table (issue
    // #27). Fall back to the catalog definition so an empty table still shows
    // its full structure. Only pays the extra introspection query when the
    // page is genuinely empty; a failed lookup degrades to the old empty list.
    let columns = if columns.is_empty() {
        list_columns_inner(state, &connection_id, schema, table)
            .await
            .map(|cols| {
                cols.into_iter()
                    .map(|c| ColumnMeta {
                        name: c.name,
                        data_type: c.data_type,
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    } else {
        columns
    };

    Ok(QueryResult {
        rows_affected: data.len() as u64,
        rows: data,
        columns,
        elapsed_ms,
        total,
        truncated: false,
        row_types: None,
    })
}

/// Count the rows of `schema.table` for the current predicate.
///
/// Split out of [`fetch_table_data`] so the count never gates the data
/// page's first paint (see [`CountResult`]). When the whole table is browsed
/// (no filters, no search) it returns the engine's O(1) statistics estimate;
/// with any predicate it runs an exact `COUNT(*)` — still off the render's
/// critical path because the frontend fires it as a separate request.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn count_table_rows(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
    filters: Option<Vec<ColumnFilter>>,
    search: Option<String>,
    search_columns: Option<Vec<String>>,
) -> AppResult<CountResult> {
    let sink = log_bus::TauriSink::new(&app, window.label());
    crate::commands::connection::ensure_database_view(
        &app,
        state.inner(),
        Some(window.label()),
        &connection_id,
    )
    .await;
    count_table_rows_inner(
        &sink,
        state.inner(),
        connection_id,
        schema,
        table,
        filters,
        search,
        search_columns,
    )
    .await
}

/// Tauri-independent core of [`count_table_rows`].
#[allow(clippy::too_many_arguments)]
pub(crate) async fn count_table_rows_inner(
    sink: &dyn LogSink,
    state: &AppState,
    connection_id: String,
    schema: Option<String>,
    table: String,
    filters: Option<Vec<ColumnFilter>>,
    search: Option<String>,
    search_columns: Option<Vec<String>>,
) -> AppResult<CountResult> {
    let pool = pool_for(state, &connection_id)?;
    let driver = pool.driver_name();

    let filters = filters.unwrap_or_default();
    let search_columns = search_columns.unwrap_or_default();
    let search_ref = search.as_deref().filter(|s| !s.is_empty());
    // "Unfiltered" == the whole relation: no column filters AND no committed
    // search. Only then may we serve the fast catalog estimate; any predicate
    // forces an exact count of the matching subset.
    let unfiltered = filters.is_empty() && search_ref.is_none();

    // MongoDB: estimatedDocumentCount (O(1) metadata read) when unfiltered,
    // exact countDocuments over the filter otherwise.
    if let DbPool::Mongo(conn) = &pool {
        let start = Instant::now();
        let res = crate::db::mongo::query::count_collection(
            conn,
            &table,
            &filters,
            search_ref,
            &search_columns,
            unfiltered,
        )
        .await;
        let label = if unfiltered {
            "(mongo estimatedDocumentCount)"
        } else {
            "(mongo countDocuments)"
        };
        match &res {
            Ok(c) => log_sql_sink(
                sink,
                &connection_id,
                driver,
                label,
                start,
                Some(c.total),
                None,
            ),
            Err(e) => log_sql_sink(
                sink,
                &connection_id,
                driver,
                label,
                start,
                None,
                Some(&e.to_string()),
            ),
        }
        return res;
    }

    let dialect = Dialect::try_of(&pool)?;

    // Whole-table browse: try the engine estimate first. `try_estimate`
    // returns `None` when no usable estimate exists (SQLite always; a
    // never-analyzed Postgres/MySQL table) so we fall through to an exact
    // count rather than reporting a bogus `~0`.
    if unfiltered {
        if let Some(total) = try_estimate(
            sink,
            &pool,
            driver,
            &connection_id,
            schema.as_deref(),
            &table,
        )
        .await
        {
            return Ok(CountResult {
                total,
                estimated: true,
            });
        }
    }

    // Exact count: predicate present, or no estimate available.
    let (where_clause, where_binds) =
        build_filter_clause(dialect, &filters, search_ref, &search_columns);
    let qt = dialect.qualify_defaulted(schema.as_deref(), &table);
    let count_sql = format!("SELECT COUNT(*) FROM {qt}{where_clause}");

    let start = Instant::now();
    let raw_count: Option<i64> = try_sql_sink!(
        sink,
        &connection_id,
        driver,
        &count_sql,
        start,
        match &pool {
            DbPool::Postgres(p) => {
                let mut q = sqlx::query_scalar::<_, i64>(&count_sql);
                for b in &where_binds {
                    q = q.bind(b);
                }
                q.fetch_optional(p).await.map_err(AppError::from)
            }
            DbPool::Mysql(p) => {
                let mut q = sqlx::query_scalar::<_, i64>(&count_sql);
                for b in &where_binds {
                    q = q.bind(b);
                }
                q.fetch_optional(p).await.map_err(AppError::from)
            }
            DbPool::Sqlite(p) => {
                let mut q = sqlx::query_scalar::<_, i64>(&count_sql);
                for b in &where_binds {
                    q = q.bind(b);
                }
                q.fetch_optional(p).await.map_err(AppError::from)
            }
            DbPool::MsSql(p) => p.scalar(&count_sql, &where_binds).await,
            DbPool::Mongo(_) => unreachable!("mongo dispatched above"),
        }
    );
    let total = raw_count.unwrap_or(0).max(0) as u64;
    log_sql_sink(
        sink,
        &connection_id,
        driver,
        &count_sql,
        start,
        Some(total),
        None,
    );
    Ok(CountResult {
        total,
        estimated: false,
    })
}

/// Fast, approximate whole-table row count read from engine statistics.
///
/// Returns `None` when no usable estimate exists so the caller falls back to
/// an exact `COUNT(*)`:
///
/// * **Postgres** — `pg_class.reltuples` (the planner's row estimate).
///   `-1` means "never analyzed" on PG 14+, and older PG reports `0` for the
///   same state, so we treat any non-positive value as "no estimate".
/// * **MySQL** — `information_schema.TABLES.TABLE_ROWS`, cast to signed so
///   sqlx decodes the `BIGINT UNSIGNED` column as `i64`. This is InnoDB's
///   estimate (exact for MyISAM); `NULL`/`0` (views, or stale stats on a
///   freshly-created table) is treated as "no estimate".
/// * **SQLite** — always `None`: there is no cheap, reliable row estimate,
///   and the file is local so an exact `COUNT(*)` is acceptable.
///
/// A driver error (or a missing relation) also degrades to `None` rather than
/// failing the whole request; the exact-count fallback surfaces any real
/// error to the user with the actual failing SQL.
async fn try_estimate(
    sink: &dyn LogSink,
    pool: &DbPool,
    driver: &str,
    connection_id: &str,
    schema: Option<&str>,
    table: &str,
) -> Option<u64> {
    match pool {
        DbPool::Postgres(p) => {
            // `::regclass` resolves the (optionally schema-qualified) quoted
            // name to the relation's OID, so the estimate is bound to the same
            // table the data query reads.
            let schema = schema.unwrap_or("public");
            let regclass = format!(
                "{}.{}",
                Dialect::Postgres.quote_ident(schema),
                Dialect::Postgres.quote_ident(table)
            );
            let sql = "SELECT reltuples::bigint FROM pg_class WHERE oid = $1::regclass";
            let start = Instant::now();
            let est: Option<i64> = sqlx::query_scalar::<_, i64>(sql)
                .bind(&regclass)
                .fetch_optional(p)
                .await
                .unwrap_or(None);
            log_sql_sink(
                sink,
                connection_id,
                driver,
                sql,
                start,
                est.map(|v| v.max(0) as u64),
                None,
            );
            est.filter(|&v| v > 0).map(|v| v as u64)
        }
        DbPool::Mysql(p) => {
            let sql = "SELECT CAST(TABLE_ROWS AS SIGNED) FROM information_schema.TABLES \
                       WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?";
            let start = Instant::now();
            let est: Option<i64> = sqlx::query_scalar::<_, Option<i64>>(sql)
                .bind(schema)
                .bind(table)
                .fetch_optional(p)
                .await
                .unwrap_or(None)
                .flatten();
            log_sql_sink(
                sink,
                connection_id,
                driver,
                sql,
                start,
                est.map(|v| v.max(0) as u64),
                None,
            );
            // 0 is ambiguous (genuinely empty vs stale stats on a new InnoDB
            // table) — confirm it with an exact count rather than showing ~0.
            est.filter(|&v| v > 0).map(|v| v as u64)
        }
        DbPool::MsSql(p) => {
            // `sys.dm_db_partition_stats` is the SQL Server equivalent of
            // `reltuples`: maintained by the engine, no scan. It needs VIEW
            // DATABASE STATE, and the helper returns `None` when that is
            // missing — same "fall through to an exact count" contract.
            crate::db::mssql::schema::estimate_rows(p, schema, table).await
        }
        // No cheap estimate; caller does an exact COUNT(*).
        DbPool::Sqlite(_) => None,
        DbPool::Mongo(_) => None,
    }
}

/// Update one column of one row in `schema.table`, addressed by the
/// full primary key.
///
/// The new value is always sent as `Option<String>` because the cell
/// editor produces text. Drivers cast textual literals to the column type
/// automatically. NULLs are conveyed by passing `None`.
///
/// Composite primary keys are supported: `pk_columns` is the ordered list
/// of column names that participate in the PK, and `pk_values` is the
/// parallel list of values for the row being updated. The WHERE clause is
/// `c1 = ? AND c2 = ? AND …` so the UPDATE can only ever match the single
/// row identified by the full key. If the resulting `rows_affected` is
/// greater than 1 the call returns an error: that would mean the supplied
/// columns are not actually unique together (caller bug) and quietly
/// touching multiple rows is exactly the corruption this signature was
/// designed to prevent.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_cell(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
    pk_columns: Vec<String>,
    pk_values: Vec<Value>,
    column: String,
    value: Option<String>,
    column_type: Option<String>,
) -> AppResult<u64> {
    let sink = log_bus::TauriSink::new(&app, window.label());
    crate::commands::connection::ensure_database_view(
        &app,
        state.inner(),
        Some(window.label()),
        &connection_id,
    )
    .await;
    update_cell_inner(
        &sink,
        state.inner(),
        connection_id,
        schema,
        table,
        pk_columns,
        pk_values,
        column,
        value,
        column_type,
    )
    .await
}

/// Tauri-independent core of [`update_cell`], shared with the headless MCP
/// `update_cell` write tool. Takes a borrowed [`AppState`] and a [`LogSink`]
/// (a `TauriSink` in the GUI) instead of a Tauri `State`/`AppHandle`.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn update_cell_inner(
    sink: &dyn LogSink,
    state: &AppState,
    connection_id: String,
    schema: Option<String>,
    table: String,
    pk_columns: Vec<String>,
    pk_values: Vec<Value>,
    column: String,
    value: Option<String>,
    column_type: Option<String>,
) -> AppResult<u64> {
    if pk_columns.is_empty() {
        return Err(AppError::InvalidInput(
            "update_cell: no primary-key columns supplied".into(),
        ));
    }
    if pk_columns.len() != pk_values.len() {
        return Err(AppError::InvalidInput(format!(
            "update_cell: pk_columns/pk_values arity mismatch ({} vs {})",
            pk_columns.len(),
            pk_values.len()
        )));
    }

    let pool = pool_for(state, &connection_id)?;
    let driver = pool.driver_name();

    // MongoDB: update one field of the document addressed by `_id` ($set). The
    // PK is always `_id`, so the first pk value is the id; `column_type` is the
    // field's inferred BSON type used to coerce the textual cell value.
    if let DbPool::Mongo(conn) = &pool {
        let start = Instant::now();
        let id = pk_values.first().cloned().unwrap_or(Value::Null);
        let res = crate::db::mongo::query::update_cell(
            conn,
            &table,
            &id,
            &column,
            value.as_deref(),
            column_type.as_deref(),
        )
        .await;
        match &res {
            Ok(n) => log_sql_sink(
                sink,
                &connection_id,
                driver,
                "(mongo update)",
                start,
                Some(*n),
                None,
            ),
            Err(e) => log_sql_sink(
                sink,
                &connection_id,
                driver,
                "(mongo update)",
                start,
                None,
                Some(&e.to_string()),
            ),
        }
        return res;
    }

    let dialect = Dialect::try_of(&pool)?;
    // `schema` is consumed below to build `qt`; keep a copy for the catalog
    // fallback further down (only actually read when `column_type` is absent).
    let schema_for_catalog = schema.clone();

    let qt = dialect.qualify(schema.as_deref(), &table);
    let col_id = dialect.quote_ident(&column);

    // SET uses placeholder #1; the PK predicate consumes #2..=#N+1 on the
    // dialects that number their placeholders.
    let where_clause = pk_columns
        .iter()
        .enumerate()
        .map(|(i, c)| {
            format!(
                "{} = {}",
                dialect.quote_ident(c),
                dialect.placeholder(i + 2)
            )
        })
        .collect::<Vec<_>>()
        .join(" AND ");
    // The cell value travels as a textual literal (gotcha #5) and drivers
    // coerce it to the column type server-side. That coercion is wrong for
    // MySQL `BIT`: binding the string "1" makes MySQL store the ASCII byte
    // 0x31 (the character '1') rather than the integer 1, so editing a BIT
    // cell silently wrote garbage. Wrapping the placeholder in
    // `CAST(? AS UNSIGNED)` forces numeric interpretation of the literal,
    // and `CAST(NULL AS UNSIGNED)` is still NULL so the set-NULL path is
    // unaffected. Only MySQL needs this; PG/SQLite cast textual literals to
    // their bit/blob types correctly on their own.
    let is_mysql = dialect == Dialect::Mysql;
    // Same fallback as `insert_row`: if the frontend's `column_type` hint is
    // missing (stale/unloaded schema cache), fall back to a catalog lookup
    // rather than silently binding a MySQL BIT column as plain text (issue #15).
    let catalog_bit_cast = is_mysql
        && column_type.is_none()
        && list_columns_inner(state, &connection_id, schema_for_catalog, table.clone())
            .await
            .map(|cols| {
                cols.iter().any(|c| {
                    c.name == column && c.data_type.trim().to_ascii_uppercase().starts_with("BIT")
                })
            })
            .unwrap_or(false);
    let bit_cast = is_mysql
        && (column_type
            .as_deref()
            .map(|t| t.trim().to_ascii_uppercase().starts_with("BIT"))
            .unwrap_or(false)
            || catalog_bit_cast);
    let set_placeholder = if bit_cast {
        format!("CAST({} AS UNSIGNED)", dialect.placeholder(1))
    } else if dialect == Dialect::MsSql {
        // The same "text literal, wrong coercion" problem MySQL BIT has, for
        // SQL Server's binary family — see `db::mssql::binary_convert`.
        crate::db::mssql::binary_convert(column_type.as_deref(), &dialect.placeholder(1))
    } else {
        dialect.placeholder(1)
    };
    let sql = format!("UPDATE {qt} SET {col_id} = {set_placeholder} WHERE {where_clause}");
    // Normalize the cell value for BIT columns: "true"/"false" must become
    // "1"/"0" before being handed to CAST(? AS UNSIGNED) — MySQL evaluates
    // CAST('true' AS UNSIGNED) as 0, silently clobbering any 1-valued cell
    // the user saves after the cell editor formats it as "true".
    let effective_value: Option<String> = if bit_cast {
        value.as_deref().map(normalize_bit_value)
    } else {
        value
    };
    let pk_strs: Vec<Option<String>> = pk_values.iter().map(json_to_string).collect();

    // Wrap the UPDATE in a transaction so a stray multi-row hit can be
    // rolled back atomically. With a correctly-introspected PRIMARY KEY
    // constraint `rows_affected > 1` is impossible, but the cell-save
    // path used to corrupt data silently when only the first PK column
    // was sent on composite-PK tables — this is the belt-and-braces
    // assertion that catches any future regression of that family.
    let start = Instant::now();
    let res: AppResult<u64> = async {
        match &pool {
            DbPool::Postgres(p) => {
                let mut tx = p.begin().await?;
                let mut q = sqlx::query(&sql).bind(&effective_value);
                for s in &pk_strs {
                    q = q.bind(s);
                }
                let affected = q.execute(&mut *tx).await?.rows_affected();
                if affected > 1 {
                    tx.rollback().await?;
                    return Err(AppError::InvalidInput(format!(
                        "update_cell refused: {affected} rows matched the supplied \
                         primary key (composite PK incomplete?) — transaction rolled back"
                    )));
                }
                tx.commit().await?;
                Ok(affected)
            }
            DbPool::Mysql(p) => {
                let mut tx = p.begin().await?;
                let mut q = sqlx::query(&sql).bind(&effective_value);
                for s in &pk_strs {
                    q = q.bind(s);
                }
                let affected = q.execute(&mut *tx).await?.rows_affected();
                if affected > 1 {
                    tx.rollback().await?;
                    return Err(AppError::InvalidInput(format!(
                        "update_cell refused: {affected} rows matched the supplied \
                         primary key (composite PK incomplete?) — transaction rolled back"
                    )));
                }
                tx.commit().await?;
                Ok(affected)
            }
            DbPool::Sqlite(p) => {
                let mut tx = p.begin().await?;
                let mut q = sqlx::query(&sql).bind(&effective_value);
                for s in &pk_strs {
                    q = q.bind(s);
                }
                let affected = q.execute(&mut *tx).await?.rows_affected();
                if affected > 1 {
                    tx.rollback().await?;
                    return Err(AppError::InvalidInput(format!(
                        "update_cell refused: {affected} rows matched the supplied \
                         primary key (composite PK incomplete?) — transaction rolled back"
                    )));
                }
                tx.commit().await?;
                Ok(affected)
            }
            DbPool::MsSql(p) => {
                // `tiberius` has no transaction handle: `BEGIN`/`COMMIT`/
                // `ROLLBACK` are statements on the session, which is why this
                // arm holds one `PooledClient` for the whole sequence instead
                // of using the pool's one-shot helpers.
                let mut binds = Vec::with_capacity(pk_strs.len() + 1);
                binds.push(effective_value.clone());
                binds.extend(pk_strs.iter().cloned());
                let mut c = p.acquire().await?;
                c.simple_execute("BEGIN TRANSACTION").await?;
                let affected = match c.execute(&sql, &binds).await {
                    Ok(n) => n,
                    Err(e) => {
                        // Best-effort unwind: if the rollback also fails the
                        // session is already poisoned and never reused.
                        let _ = c.simple_execute("ROLLBACK TRANSACTION").await;
                        return Err(e);
                    }
                };
                if affected > 1 {
                    c.simple_execute("ROLLBACK TRANSACTION").await?;
                    return Err(AppError::InvalidInput(format!(
                        "update_cell refused: {affected} rows matched the supplied \
                         primary key (composite PK incomplete?) — transaction rolled back"
                    )));
                }
                c.simple_execute("COMMIT TRANSACTION").await?;
                Ok(affected)
            }
            DbPool::Mongo(_) => unreachable!("mongo dispatched above"),
        }
    }
    .await;
    let affected = try_sql_sink!(sink, &connection_id, driver, &sql, start, res);
    log_sql_sink(
        sink,
        &connection_id,
        driver,
        &sql,
        start,
        Some(affected),
        None,
    );
    Ok(affected)
}

/// Remove a field from one MongoDB document (`$unset`), addressed by `_id`.
///
/// The document list view's "delete field" action. MongoDB only: a SQL row has
/// a fixed column set, so removing a *field* from a single row has no meaning
/// there (setting it to NULL does, and that already goes through
/// [`update_cell`]) — the other drivers are rejected rather than silently
/// mapped onto something else.
///
/// `field` is a path (`"customData.format"`, `"tags.2"`), matching the way the
/// same list view addresses a nested field on the write side of
/// [`update_cell`].
#[tauri::command]
pub async fn unset_field(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    collection: String,
    id_value: Value,
    field: String,
) -> AppResult<u64> {
    let sink = log_bus::TauriSink::new(&app, window.label());
    crate::commands::connection::ensure_database_view(
        &app,
        state.inner(),
        Some(window.label()),
        &connection_id,
    )
    .await;
    let pool = pool_for(state.inner(), &connection_id)?;
    let driver = pool.driver_name();
    let DbPool::Mongo(conn) = &pool else {
        return Err(AppError::InvalidInput(
            "unset_field is only supported for MongoDB".into(),
        ));
    };
    let start = Instant::now();
    let res = crate::db::mongo::query::unset_field(conn, &collection, &id_value, &field).await;
    match &res {
        Ok(n) => log_sql_sink(
            &sink,
            &connection_id,
            driver,
            "(mongo unset)",
            start,
            Some(*n),
            None,
        ),
        Err(e) => log_sql_sink(
            &sink,
            &connection_id,
            driver,
            "(mongo unset)",
            start,
            None,
            Some(&e.to_string()),
        ),
    }
    res
}

/// Normalize a cell value string for a MySQL BIT column write.
///
/// `"true"`/`"false"` (case-insensitive) map to `"1"`/`"0"` so that
/// `CAST(? AS UNSIGNED)` receives a digit string rather than an alphabetic
/// one — MySQL converts `CAST('true' AS UNSIGNED)` to 0 regardless of what
/// the intended bit value is. Any other string is returned unchanged so
/// numeric strings like `"1"`, `"0"`, or `"255"` pass through unaltered.
fn normalize_bit_value(s: &str) -> String {
    match s.trim().to_lowercase().as_str() {
        "true" => "1".to_string(),
        "false" => "0".to_string(),
        other => other.to_string(),
    }
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

/// Delete one or more rows from `schema.table` identified by their
/// (possibly composite) primary key.
///
/// `pk_columns` lists the columns that make up the PK in the order the
/// frontend captured them; `pk_value_rows` carries one tuple of values per
/// row to delete, parallel to `pk_columns`. The WHERE clause is built as
/// `(c1, c2, …) IN ((?, ?, …), …)` so the DELETE only ever touches rows
/// whose *full* key matches a supplied tuple — sending only the leading
/// PK column used to fan the DELETE out across every row sharing that
/// value (the same family of bug as the cell-save corruption that
/// motivated this signature change).
///
/// Returns the number of rows actually deleted; that should equal
/// `pk_value_rows.len()` when every key existed, and less if any did not.
// The argument list is the IPC surface, not a design choice: a `#[tauri::command]`
// receives flat named arguments from `invoke`, and `app`/`window`/`state` are
// injected by Tauri rather than passed by the caller. Collapsing these into a
// struct would change the shape the frontend calls with for no gain here. (The
// same allow on the `_inner` helpers below is a different matter — those are
// plain Rust functions and genuinely want a request struct.)
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn delete_rows(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
    pk_columns: Vec<String>,
    pk_value_rows: Vec<Vec<Value>>,
) -> AppResult<u64> {
    let sink = log_bus::TauriSink::new(&app, window.label());
    crate::commands::connection::ensure_database_view(
        &app,
        state.inner(),
        Some(window.label()),
        &connection_id,
    )
    .await;
    delete_rows_inner(
        &sink,
        state.inner(),
        connection_id,
        schema,
        table,
        pk_columns,
        pk_value_rows,
    )
    .await
}

/// Tauri-independent core of [`delete_rows`], shared with the headless MCP
/// `delete_rows` write tool.
pub(crate) async fn delete_rows_inner(
    sink: &dyn LogSink,
    state: &AppState,
    connection_id: String,
    schema: Option<String>,
    table: String,
    pk_columns: Vec<String>,
    pk_value_rows: Vec<Vec<Value>>,
) -> AppResult<u64> {
    if pk_columns.is_empty() {
        return Err(AppError::InvalidInput(
            "delete_rows: no primary-key columns supplied".into(),
        ));
    }
    if pk_value_rows.is_empty() {
        return Ok(0);
    }
    let arity = pk_columns.len();
    for (i, row) in pk_value_rows.iter().enumerate() {
        if row.len() != arity {
            return Err(AppError::InvalidInput(format!(
                "delete_rows: row #{i} has {} values, expected {arity}",
                row.len()
            )));
        }
    }

    let pool = pool_for(state, &connection_id)?;
    let driver = pool.driver_name();

    // MongoDB: delete by `_id` ({_id: {$in: [...]}}). Each pk tuple is a single
    // `_id` value.
    if let DbPool::Mongo(conn) = &pool {
        let start = Instant::now();
        let ids: Vec<Value> = pk_value_rows
            .iter()
            .map(|r| r.first().cloned().unwrap_or(Value::Null))
            .collect();
        let res = crate::db::mongo::query::delete_rows(conn, &table, &ids).await;
        match &res {
            Ok(n) => log_sql_sink(
                sink,
                &connection_id,
                driver,
                "(mongo delete)",
                start,
                Some(*n),
                None,
            ),
            Err(e) => log_sql_sink(
                sink,
                &connection_id,
                driver,
                "(mongo delete)",
                start,
                None,
                Some(&e.to_string()),
            ),
        }
        return res;
    }

    let dialect = Dialect::try_of(&pool)?;

    let qt = dialect.qualify_defaulted(schema.as_deref(), &table);
    let lhs = pk_columns
        .iter()
        .map(|c| dialect.quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let mut counter = 0usize;
    let tuples = pk_value_rows
        .iter()
        .map(|row| {
            let placeholders = row
                .iter()
                .map(|_| {
                    counter += 1;
                    dialect.placeholder(counter)
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("({placeholders})")
        })
        .collect::<Vec<_>>()
        .join(", ");
    // For arity==1 wrap the LHS in parentheses too — `(c) IN ((?), (?))`
    // is valid across all three drivers and keeps a single code path.
    let sql = format!("DELETE FROM {qt} WHERE ({lhs}) IN ({tuples})");
    let binds: Vec<Option<String>> = pk_value_rows
        .iter()
        .flat_map(|row| row.iter().map(json_to_string))
        .collect();

    let start = Instant::now();
    let affected = try_sql_sink!(
        sink,
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
                q.execute(&p)
                    .await
                    .map(|r| r.rows_affected())
                    .map_err(AppError::from)
            }
            DbPool::Mysql(p) => {
                let mut q = sqlx::query(&sql);
                for b in &binds {
                    q = q.bind(b);
                }
                q.execute(&p)
                    .await
                    .map(|r| r.rows_affected())
                    .map_err(AppError::from)
            }
            DbPool::Sqlite(p) => {
                let mut q = sqlx::query(&sql);
                for b in &binds {
                    q = q.bind(b);
                }
                q.execute(&p)
                    .await
                    .map(|r| r.rows_affected())
                    .map_err(AppError::from)
            }
            DbPool::MsSql(p) => p.execute_params(&sql, &binds).await,
            DbPool::Mongo(_) => unreachable!("mongo dispatched above"),
        }
    );
    log_sql_sink(
        sink,
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
// Flat argument list is the IPC surface — see the note on `delete_rows`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn insert_row(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
    pk_column: Option<String>,
    values: Vec<RowValue>,
) -> AppResult<Value> {
    let sink = log_bus::TauriSink::new(&app, window.label());
    crate::commands::connection::ensure_database_view(
        &app,
        state.inner(),
        Some(window.label()),
        &connection_id,
    )
    .await;
    insert_row_inner(
        &sink,
        state.inner(),
        connection_id,
        schema,
        table,
        pk_column,
        values,
    )
    .await
}

/// Tauri-independent core of [`insert_row`], shared with the headless MCP
/// `insert_row` write tool.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn insert_row_inner(
    sink: &dyn LogSink,
    state: &AppState,
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
    let pool = pool_for(state, &connection_id)?;
    let driver = pool.driver_name();

    // MongoDB: insert one document built from the column/value pairs; returns
    // the generated `_id`.
    if let DbPool::Mongo(conn) = &pool {
        let start = Instant::now();
        let res = crate::db::mongo::query::insert_row(conn, &table, &values).await;
        match &res {
            Ok(_) => log_sql_sink(
                sink,
                &connection_id,
                driver,
                "(mongo insert)",
                start,
                Some(1),
                None,
            ),
            Err(e) => log_sql_sink(
                sink,
                &connection_id,
                driver,
                "(mongo insert)",
                start,
                None,
                Some(&e.to_string()),
            ),
        }
        return res;
    }

    let dialect = Dialect::try_of(&pool)?;
    let is_mysql = dialect == Dialect::Mysql;

    let qt = dialect.qualify_defaulted(schema.as_deref(), &table);
    let cols: Vec<String> = values
        .iter()
        .map(|v| dialect.quote_ident(&v.column))
        .collect();
    let placeholders: Vec<String> = values
        .iter()
        .enumerate()
        .map(|(i, rv)| {
            let ph = dialect.placeholder(i + 1);
            if dialect == Dialect::MsSql {
                // Binary columns need the hex-string conversion; every other
                // type coerces correctly from text (see `db::mssql`).
                crate::db::mssql::binary_convert(rv.column_type.as_deref(), &ph)
            } else {
                ph
            }
        })
        .collect();
    let binds: Vec<Option<String>> = values.iter().map(|v| v.value.clone()).collect();

    // The frontend supplies `column_type` from whatever schema-cache/query-result
    // metadata it has on hand at commit time; if that's stale or hasn't loaded
    // yet, a MySQL BIT column can arrive with `column_type: None`, in which case
    // the branch below would silently bind it as plain text and MySQL rejects
    // the literal with "Data too long for column" (issue #15). Only pay for a
    // catalog round-trip when at least one value actually lacks a type hint —
    // the common case (frontend metadata present) skips this entirely.
    let catalog_bit_columns: std::collections::HashSet<String> =
        if is_mysql && values.iter().any(|v| v.column_type.is_none()) {
            list_columns_inner(state, &connection_id, schema.clone(), table.clone())
                .await
                .map(|cols| {
                    cols.into_iter()
                        .filter(|c| c.data_type.trim().to_ascii_uppercase().starts_with("BIT"))
                        .map(|c| c.name)
                        .collect()
                })
                .unwrap_or_default()
        } else {
            std::collections::HashSet::new()
        };

    // MySQL BIT columns require CAST(? AS UNSIGNED) — binding a plain string
    // stores the ASCII bytes of the literal rather than its numeric value (e.g.
    // "1" stores byte 0x31 = 49, not integer 1). Build BIT-aware placeholders
    // and normalize "true"/"false" to "1"/"0" so `CAST` gets a digit string.
    let (mysql_placeholders, mysql_binds): (Vec<String>, Vec<Option<String>>) = if is_mysql {
        values
            .iter()
            .map(|rv| {
                let is_bit = rv
                    .column_type
                    .as_deref()
                    .map(|t| t.trim().to_ascii_uppercase().starts_with("BIT"))
                    .unwrap_or(false)
                    || catalog_bit_columns.contains(&rv.column);
                if is_bit {
                    let normalized = rv.value.as_deref().map(normalize_bit_value);
                    ("CAST(? AS UNSIGNED)".to_string(), normalized)
                } else {
                    ("?".to_string(), rv.value.clone())
                }
            })
            .unzip()
    } else {
        (placeholders.clone(), binds.clone())
    };

    let base_sql = format!(
        "INSERT INTO {qt} ({}) VALUES ({})",
        cols.join(", "),
        placeholders.join(", ")
    );

    // Each driver arm yields (final SQL string, Result<(rows_affected, returned_pk), _>).
    // Postgres optionally tacks on RETURNING to recover the generated PK;
    // MySQL/SQLite use `last_insert_*` instead.
    let start = Instant::now();
    let (sql_used, outcome): (String, AppResult<(Option<u64>, Value)>) = match pool {
        DbPool::Postgres(p) => {
            let sql = match &pk_column {
                Some(pk) => format!("{base_sql} RETURNING {}", Dialect::Postgres.quote_ident(pk)),
                None => base_sql,
            };
            let mut q = sqlx::query(&sql);
            for b in &binds {
                q = q.bind(b);
            }
            let outcome = if pk_column.is_some() {
                q.fetch_all(&p)
                    .await
                    .map(|rows| {
                        let returned = rows.first().map(|r| pg_value(r, 0)).unwrap_or(Value::Null);
                        (Some(rows.len() as u64), returned)
                    })
                    .map_err(AppError::from)
            } else {
                q.execute(&p)
                    .await
                    .map(|r| (Some(r.rows_affected()), Value::Null))
                    .map_err(AppError::from)
            };
            (sql, outcome)
        }
        DbPool::Mysql(p) => {
            let mysql_sql = format!(
                "INSERT INTO {qt} ({}) VALUES ({})",
                cols.join(", "),
                mysql_placeholders.join(", ")
            );
            let mut q = sqlx::query(&mysql_sql);
            for b in &mysql_binds {
                q = q.bind(b);
            }
            let outcome = q
                .execute(&p)
                .await
                .map(|r| {
                    let id = r.last_insert_id();
                    let returned = if id == 0 {
                        Value::Null
                    } else {
                        Value::from(id)
                    };
                    (Some(r.rows_affected()), returned)
                })
                .map_err(AppError::from);
            (mysql_sql, outcome)
        }
        DbPool::Sqlite(p) => {
            let mut q = sqlx::query(&base_sql);
            for b in &binds {
                q = q.bind(b);
            }
            let outcome = q
                .execute(&p)
                .await
                .map(|r| (Some(r.rows_affected()), Value::from(r.last_insert_rowid())))
                .map_err(AppError::from);
            (base_sql, outcome)
        }
        DbPool::MsSql(p) if pk_column.is_none() => {
            let outcome = p
                .execute_params(&base_sql, &binds)
                .await
                .map(|n| (Some(n), Value::Null));
            (base_sql, outcome)
        }
        DbPool::MsSql(p) => {
            // Guarded by the arm above, so the PK is present here.
            let pk = pk_column.as_deref().unwrap_or_default();
            // `OUTPUT INSERTED.<pk>` is the closest thing T-SQL has to
            // `RETURNING`, and unlike `SCOPE_IDENTITY()` it also recovers a
            // non-identity generated key (a `uniqueidentifier` defaulting to
            // `newid()`, a sequence default). It is rejected outright on a
            // table carrying triggers (error 334), so that one case falls back
            // to `SCOPE_IDENTITY()` — which only knows about IDENTITY columns,
            // but a trigger-bearing table is exactly where that is the
            // conventional answer anyway.
            let output_sql = format!(
                "INSERT INTO {qt} ({}) OUTPUT INSERTED.{} VALUES ({})",
                cols.join(", "),
                Dialect::MsSql.quote_ident(pk),
                placeholders.join(", ")
            );
            match p.query_all(&output_sql, &binds).await {
                Ok(rows) => {
                    let returned = rows
                        .first()
                        .map(|r| crate::db::mssql::values::mssql_value(r, 0))
                        .unwrap_or(Value::Null);
                    (output_sql, Ok((Some(rows.len() as u64), returned)))
                }
                Err(e) if crate::db::mssql::is_output_clause_conflict(&e) => {
                    let fallback_sql =
                        format!("{base_sql}; SELECT CAST(SCOPE_IDENTITY() AS bigint) AS [id]");
                    let outcome = p.query_all(&fallback_sql, &binds).await.map(|rows| {
                        let returned = rows
                            .first()
                            .map(|r| crate::db::mssql::values::mssql_value(r, 0))
                            .unwrap_or(Value::Null);
                        (Some(1), returned)
                    });
                    (fallback_sql, outcome)
                }
                Err(e) => (output_sql, Err(e)),
            }
        }
        DbPool::Mongo(_) => unreachable!("mongo dispatched above"),
    };

    let (rows, returned) = try_sql_sink!(sink, &connection_id, driver, &sql_used, start, outcome);
    log_sql_sink(sink, &connection_id, driver, &sql_used, start, rows, None);
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
/// [`list_columns_inner`] before they reach [`Dialect::quote_ident`] — keeps us
/// aligned with the rule in `SECURITY.md` that `quote_ident` is only ever
/// applied to catalog-sourced names. The optional `search` is passed as a
/// bound LIKE/ILIKE pattern with escape handling.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn fetch_fk_options(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
    key_column: String,
    label_column: Option<String>,
    search: Option<String>,
    limit: i64,
) -> AppResult<FkOptionsPage> {
    // Reopen a reaped child pool *before* the catalog lookup below — it goes
    // through `list_columns_inner`, which resolves the pool itself and would
    // otherwise fail with `NotConnected` before this function ever reaches
    // its own `pool_for` call further down.
    crate::commands::connection::ensure_database_view(
        &app,
        state.inner(),
        Some(window.label()),
        &connection_id,
    )
    .await;

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
    // MongoDB has no foreign keys; the FK combobox is not offered for it.
    if matches!(&pool, DbPool::Mongo(_)) {
        return Err(AppError::InvalidInput(
            "foreign-key lookups are not supported on MongoDB".into(),
        ));
    }
    let dialect = Dialect::try_of(&pool)?;

    let qt = dialect.qualify_defaulted(schema.as_deref(), &table);
    let key_id = dialect.quote_ident(&key_column);
    let label_id = label_col.as_ref().map(|c| dialect.quote_ident(c));

    // Projection: key first, label second (when present).
    let projection = match &label_id {
        Some(l) => format!("{key_id} AS k, {l} AS lbl"),
        None => format!("{key_id} AS k"),
    };

    let search_term = search.as_deref().filter(|s| !s.is_empty());
    let mut binds: Vec<Option<String>> = Vec::new();
    let where_clause = if let Some(term) = search_term {
        let pattern = format!("%{}%", escape_like(term));
        let like_kw = dialect.like_kw();
        let cast_to = dialect.cast_to_text();
        let escape = dialect.like_escape_clause();
        let ph1 = dialect.placeholder(1);
        let ph2 = dialect.placeholder(2);
        let mut parts = vec![format!(
            "CAST({key_id} AS {cast_to}) {like_kw} {ph1}{escape}"
        )];
        binds.push(Some(pattern.clone()));
        if let Some(l) = &label_id {
            parts.push(format!("CAST({l} AS {cast_to}) {like_kw} {ph2}{escape}"));
            binds.push(Some(pattern));
        }
        format!(" WHERE {}", parts.join(" OR "))
    } else {
        String::new()
    };

    // Request limit+1 so we can detect has_more without a second COUNT(*).
    let fetch_limit = limit.max(0).saturating_add(1);
    // There is always an `ORDER BY`, so T-SQL's OFFSET/FETCH needs no filler.
    let page = dialect.paginate(fetch_limit, 0, true);
    let sql = format!("SELECT {projection} FROM {qt}{where_clause} ORDER BY {key_id}{page}");

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
        DbPool::MsSql(p) => {
            let rows = p.query_all(&sql, &binds).await?;
            rows.iter()
                .map(|r| {
                    let v = value_to_dropdown_string(&crate::db::mssql::values::mssql_value(r, 0));
                    let lbl = if label_id.is_some() {
                        match crate::db::mssql::values::mssql_value(r, 1) {
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
        DbPool::Mongo(_) => unreachable!("mongo rejected above"),
    };

    let has_more = options.len() as i64 > limit;
    if has_more {
        options.truncate(limit.max(0) as usize);
    }
    Ok(FkOptionsPage { options, has_more })
}

#[cfg(test)]
mod filter_tests {
    use super::*;
    use serde_json::json;

    fn f(column: &str, op: FilterOp, value: serde_json::Value) -> ColumnFilter {
        ColumnFilter {
            column: column.into(),
            op,
            value,
            value2: json!(null),
            values: Vec::new(),
        }
    }

    fn between(column: &str, value: serde_json::Value, value2: serde_json::Value) -> ColumnFilter {
        ColumnFilter {
            column: column.into(),
            op: FilterOp::Between,
            value,
            value2,
            values: Vec::new(),
        }
    }

    /// `In` / `NotIn` filter over an explicit value list.
    fn in_list(column: &str, op: FilterOp, values: Vec<serde_json::Value>) -> ColumnFilter {
        ColumnFilter {
            column: column.into(),
            op,
            value: json!(null),
            value2: json!(null),
            values,
        }
    }

    #[test]
    fn advanced_ops_build_expected_postgres_sql() {
        let filters = vec![
            f("name", FilterOp::Contains, json!("ab")),
            f("age", FilterOp::Gt, json!(5)),
            f("code", FilterOp::StartsWith, json!("x")),
        ];
        let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        // Postgres: ILIKE for contains/starts_with, TEXT cast, $N placeholders.
        assert!(
            clause.contains(r#"CAST("name" AS TEXT) ILIKE $1 ESCAPE"#),
            "{clause}"
        );
        assert!(clause.contains(r#""age" > $2"#), "{clause}");
        assert!(
            clause.contains(r#"CAST("code" AS TEXT) ILIKE $3 ESCAPE"#),
            "{clause}"
        );
        assert_eq!(
            binds,
            vec![
                Some("%ab%".to_string()),
                Some("5".to_string()),
                Some("x%".to_string()),
            ]
        );
    }

    #[test]
    fn advanced_ops_build_expected_mysql_sql() {
        let filters = vec![
            f("name", FilterOp::EndsWith, json!("z")),
            f("qty", FilterOp::Lte, json!(10)),
            f("note", FilterOp::NotContains, json!("skip")),
        ];
        let (clause, binds) = build_filter_clause(Dialect::Mysql, &filters, None, &[]);
        // MySQL: LIKE / NOT LIKE, CHAR cast, `?` placeholders, doubled escape.
        assert!(clause.contains("CAST(`name` AS CHAR) LIKE ?"), "{clause}");
        assert!(clause.contains("`qty` <= ?"), "{clause}");
        assert!(
            clause.contains("CAST(`note` AS CHAR) NOT LIKE ?"),
            "{clause}"
        );
        assert_eq!(
            binds,
            vec![
                Some("%z".to_string()),
                Some("10".to_string()),
                Some("%skip%".to_string()),
            ]
        );
    }

    #[test]
    fn between_builds_expected_postgres_sql() {
        let filters = vec![between("age", json!(18), json!(65))];
        let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        assert!(clause.contains(r#""age" BETWEEN $1 AND $2"#), "{clause}");
        assert_eq!(binds, vec![Some("18".to_string()), Some("65".to_string())]);
    }

    #[test]
    fn between_builds_expected_mysql_and_sqlite_sql() {
        let filters = vec![between("age", json!(18), json!(65))];
        let (clause, binds) = build_filter_clause(Dialect::Mysql, &filters, None, &[]);
        assert!(clause.contains("`age` BETWEEN ? AND ?"), "{clause}");
        assert_eq!(binds, vec![Some("18".to_string()), Some("65".to_string())]);
    }

    #[test]
    fn null_ops_take_no_bind() {
        let filters = vec![
            f("a", FilterOp::IsNull, json!(null)),
            f("b", FilterOp::IsNotNull, json!(null)),
        ];
        let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        assert!(clause.contains(r#""a" IS NULL"#), "{clause}");
        assert!(clause.contains(r#""b" IS NOT NULL"#), "{clause}");
        assert!(binds.is_empty());
    }

    #[test]
    fn in_builds_one_placeholder_per_value() {
        let filters = vec![in_list(
            "id",
            FilterOp::In,
            vec![json!(1), json!(2), json!(3)],
        )];
        let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        assert!(clause.contains(r#""id" IN ($1, $2, $3)"#), "{clause}");
        assert_eq!(
            binds,
            vec![
                Some("1".to_string()),
                Some("2".to_string()),
                Some("3".to_string())
            ]
        );
    }

    #[test]
    fn in_uses_question_marks_on_mysql() {
        let filters = vec![in_list("id", FilterOp::In, vec![json!(1), json!(2)])];
        let (clause, binds) = build_filter_clause(Dialect::Mysql, &filters, None, &[]);
        assert!(clause.contains("`id` IN (?, ?)"), "{clause}");
        assert_eq!(binds.len(), 2);
    }

    #[test]
    fn in_deduplicates_repeated_values() {
        // Selecting many rows that share a value must not fan out into one
        // placeholder per row.
        let filters = vec![in_list(
            "status",
            FilterOp::In,
            vec![json!("a"), json!("b"), json!("a"), json!("a")],
        )];
        let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        assert!(clause.contains(r#""status" IN ($1, $2)"#), "{clause}");
        assert_eq!(
            binds,
            vec![Some("a".to_string()), Some("b".to_string())],
            "order of first appearance must be preserved"
        );
    }

    #[test]
    fn in_with_a_null_value_adds_an_is_null_branch() {
        // `col IN (…)` is never true for a NULL column, so a selected NULL row
        // would silently disappear from its own filter without this.
        let filters = vec![in_list("x", FilterOp::In, vec![json!(1), json!(null)])];
        let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        assert!(
            clause.contains(r#"("x" IN ($1) OR "x" IS NULL)"#),
            "{clause}"
        );
        assert_eq!(binds, vec![Some("1".to_string())]);
    }

    #[test]
    fn not_in_without_null_keeps_null_rows_visible() {
        // The classic NOT IN trap: 3VL would drop NULL rows the user never asked
        // to exclude.
        let filters = vec![in_list("x", FilterOp::NotIn, vec![json!(1)])];
        let (clause, _) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        assert!(
            clause.contains(r#"("x" NOT IN ($1) OR "x" IS NULL)"#),
            "{clause}"
        );
    }

    #[test]
    fn not_in_with_null_excludes_null_rows() {
        // Here the user *did* pick NULL, so 3VL's own exclusion is the wanted
        // behaviour and no extra branch is emitted.
        let filters = vec![in_list("x", FilterOp::NotIn, vec![json!(1), json!(null)])];
        let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        assert!(clause.contains(r#""x" NOT IN ($1)"#), "{clause}");
        assert!(!clause.contains("IS NULL"), "{clause}");
        assert_eq!(binds, vec![Some("1".to_string())]);
    }

    #[test]
    fn empty_in_list_matches_nothing_instead_of_emitting_invalid_sql() {
        // `IN ()` is a syntax error everywhere. Dropping the filter would be
        // worse than a never-true predicate: it would widen the result set to
        // the whole table.
        let filters = vec![in_list("x", FilterOp::In, vec![])];
        let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        assert!(clause.contains("1 = 0"), "{clause}");
        assert!(!clause.contains("IN ()"), "{clause}");
        assert!(binds.is_empty());
    }

    #[test]
    fn null_only_in_list_degrades_to_is_null() {
        let filters = vec![in_list("x", FilterOp::In, vec![json!(null)])];
        let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        assert!(clause.contains(r#""x" IS NULL"#), "{clause}");
        assert!(binds.is_empty());

        let filters = vec![in_list("x", FilterOp::NotIn, vec![json!(null)])];
        let (clause, _) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        assert!(clause.contains(r#""x" IS NOT NULL"#), "{clause}");
    }

    #[test]
    fn in_placeholders_stay_in_step_with_other_filters() {
        // The `$N` counter is shared across every filter; an `IN` list consuming
        // several numbers must not desync the ones that follow it.
        let filters = vec![
            f("a", FilterOp::Eq, json!("x")),
            in_list("b", FilterOp::In, vec![json!(1), json!(2)]),
            f("c", FilterOp::Gt, json!(9)),
        ];
        let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        assert!(clause.contains(r#""a" = $1"#), "{clause}");
        assert!(clause.contains(r#""b" IN ($2, $3)"#), "{clause}");
        assert!(clause.contains(r#""c" > $4"#), "{clause}");
        assert_eq!(binds.len(), 4);
    }

    #[test]
    fn oversize_in_list_is_rejected() {
        let values: Vec<serde_json::Value> = (0..=MAX_IN_VALUES).map(|i| json!(i)).collect();
        let filters = vec![in_list("id", FilterOp::In, values)];
        assert!(validate_filters(&filters).is_err());

        let values: Vec<serde_json::Value> = (0..MAX_IN_VALUES).map(|i| json!(i)).collect();
        let filters = vec![in_list("id", FilterOp::In, values)];
        assert!(validate_filters(&filters).is_ok());
    }
}
