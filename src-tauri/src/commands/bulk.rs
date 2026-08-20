//! Bulk row/document update — apply a `$set`-shaped change to every row or
//! document matching a filter, in one round trip.
//!
//! The write path mirrors [`crate::commands::query::delete_rows`]'s dispatch
//! shape (Mongo handled first with an early return, the three SQL drivers
//! sharing one code path below) and the preview/apply split
//! [`crate::commands::structure::preview_structure_change`] /
//! `apply_structure_change` already established for DDL: both the count
//! shown before confirming and the write that actually runs are built by the
//! same statement-construction code ([`build_update_statement`] for SQL,
//! [`crate::db::mongo::query::describe_bulk_update`] for Mongo), so the two
//! can never diverge.
//!
//! Unlike `delete_rows` (always addressed by known primary keys), this
//! operates on an arbitrary filter the caller builds in the UI — the same
//! [`ColumnFilter`] shape [`crate::commands::query::fetch_table_data`]
//! already uses for the grid's advanced filter. An empty filter would
//! silently mean "every row", so `confirm_unfiltered` is a deliberate second
//! gate: the command refuses to run unless the caller supplied at least one
//! filter or explicitly acknowledged the unfiltered case.

use crate::commands::query::{
    build_filter_clause_at, count_table_rows_inner, ColumnFilter, RowValue,
};
use crate::db::sql::Dialect;
use crate::error::{AppError, AppResult};
use crate::log_bus::{self, LogEntry, LogKind, LogSink};
use crate::state::{AppState, DbPool};
use serde::{Deserialize, Serialize};
use std::time::Instant;
use tauri::{AppHandle, State};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkUpdateArgs {
    pub connection_id: String,
    #[serde(default)]
    pub schema: Option<String>,
    pub table: String,
    /// AND-composed match condition. Empty means "every row/document" and is
    /// rejected unless `confirm_unfiltered` is set.
    #[serde(default)]
    pub filters: Vec<ColumnFilter>,
    /// Columns/fields to set, reusing the same shape `insert_row` takes.
    pub set_values: Vec<RowValue>,
    /// Deliberate override for running with `filters` empty (update every
    /// row/document). Defaults to `false` so a blank filter can't silently
    /// become a full-table update.
    #[serde(default)]
    pub confirm_unfiltered: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkUpdatePreview {
    /// Human-readable statement shown in the confirmation dialog — the
    /// `UPDATE ...` text for SQL, a `db.<collection>.updateMany(...)`-style
    /// line for Mongo. Informational only; never re-parsed.
    pub statement: String,
    /// Rows/documents matching the filter right now. May differ from what
    /// `apply_bulk_update` reports afterwards if the data changes between
    /// the two calls (a concurrent write) — the dialog labels this an
    /// estimate for that reason.
    pub affected_estimate: u64,
}

fn validate_args(args: &BulkUpdateArgs) -> AppResult<()> {
    if args.filters.is_empty() && !args.confirm_unfiltered {
        return Err(AppError::InvalidInput(
            "bulk update requires at least one filter, or confirm_unfiltered".into(),
        ));
    }
    if args.set_values.is_empty() {
        return Err(AppError::InvalidInput(
            "bulk update: no columns to set".into(),
        ));
    }
    Ok(())
}

/// Build the `UPDATE <qt> SET ... WHERE ...` statement + its binds for one
/// bulk update. Shared by [`preview_bulk_update`] (which only displays the
/// text) and [`apply_bulk_update`] (which executes it) via this single
/// function, so the two can never diverge.
fn build_update_statement(
    dialect: Dialect,
    qt: &str,
    filters: &[ColumnFilter],
    set_values: &[RowValue],
) -> (String, Vec<Option<String>>) {
    let mut next = 1usize;
    let mut binds: Vec<Option<String>> = Vec::with_capacity(set_values.len());
    let set_parts: Vec<String> = set_values
        .iter()
        .map(|rv| {
            let col = dialect.quote_ident(&rv.column);
            let ph = dialect.placeholder(next);
            next += 1;
            binds.push(rv.value.clone());
            format!("{col} = {ph}")
        })
        .collect();
    let (where_clause, where_binds, _) = build_filter_clause_at(next, dialect, filters, None, &[]);
    binds.extend(where_binds);
    (
        format!("UPDATE {qt} SET {}{where_clause}", set_parts.join(", ")),
        binds,
    )
}

/// Preview a bulk update: how many rows/documents currently match
/// `args.filters`, plus the statement [`apply_bulk_update`] would run. Runs a
/// read-only count; never modifies data.
#[tauri::command]
pub async fn preview_bulk_update(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    args: BulkUpdateArgs,
) -> AppResult<BulkUpdatePreview> {
    validate_args(&args)?;
    crate::commands::connection::ensure_database_view(
        &app,
        state.inner(),
        Some(window.label()),
        &args.connection_id,
    )
    .await;
    let pool = state.pool_for(&args.connection_id)?;

    let statement = if matches!(&pool, DbPool::Mongo(_)) {
        crate::db::mongo::query::describe_bulk_update(&args.table, &args.filters, &args.set_values)
    } else {
        let dialect = Dialect::try_of(&pool)?;
        let qt = dialect.qualify_defaulted(args.schema.as_deref(), &args.table);
        build_update_statement(dialect, &qt, &args.filters, &args.set_values).0
    };

    let sink = log_bus::TauriSink::new(&app, window.label());
    let affected_estimate = count_table_rows_inner(
        &sink,
        state.inner(),
        args.connection_id.clone(),
        args.schema.clone(),
        args.table.clone(),
        Some(args.filters.clone()),
        None,
        None,
    )
    .await?
    .total;

    Ok(BulkUpdatePreview {
        statement,
        affected_estimate,
    })
}

/// Apply a bulk update: `UPDATE ... SET ... WHERE ...` for the three SQL
/// drivers, `update_many` with a `$set` for MongoDB. Returns the number of
/// rows/documents actually modified.
#[tauri::command]
pub async fn apply_bulk_update(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    args: BulkUpdateArgs,
) -> AppResult<u64> {
    let sink = log_bus::TauriSink::new(&app, window.label());
    crate::commands::connection::ensure_database_view(
        &app,
        state.inner(),
        Some(window.label()),
        &args.connection_id,
    )
    .await;
    apply_bulk_update_inner(&sink, state.inner(), args).await
}

/// Tauri-independent core of [`apply_bulk_update`].
pub(crate) async fn apply_bulk_update_inner(
    sink: &dyn LogSink,
    state: &AppState,
    args: BulkUpdateArgs,
) -> AppResult<u64> {
    validate_args(&args)?;
    let pool = state.pool_for(&args.connection_id)?;
    let driver = pool.driver_name();

    // MongoDB: update_many over the same filter shape fetch_collection_data
    // already understands, with a $set built from set_values.
    if let DbPool::Mongo(conn) = &pool {
        let start = Instant::now();
        let res = crate::db::mongo::query::bulk_update(
            conn,
            &args.table,
            &args.filters,
            &args.set_values,
        )
        .await;
        match &res {
            Ok(n) => sink.log(
                LogEntry::new(LogKind::Sql)
                    .connection_id(&args.connection_id)
                    .driver(driver)
                    .sql("(mongo bulk update)")
                    .duration_ms(start.elapsed().as_millis() as u64)
                    .rows_affected(*n),
            ),
            Err(e) => sink.log(
                LogEntry::new(LogKind::Sql)
                    .connection_id(&args.connection_id)
                    .driver(driver)
                    .sql("(mongo bulk update)")
                    .duration_ms(start.elapsed().as_millis() as u64)
                    .error(e.to_string()),
            ),
        }
        return res;
    }

    let dialect = Dialect::try_of(&pool)?;
    let qt = dialect.qualify_defaulted(args.schema.as_deref(), &args.table);
    let (sql, binds) = build_update_statement(dialect, &qt, &args.filters, &args.set_values);

    let start = Instant::now();
    let outcome: AppResult<u64> = match &pool {
        DbPool::Postgres(p) => {
            let mut q = sqlx::query(&sql);
            for b in &binds {
                q = q.bind(b);
            }
            q.execute(p)
                .await
                .map(|r| r.rows_affected())
                .map_err(AppError::from)
        }
        DbPool::Mysql(p) => {
            let mut q = sqlx::query(&sql);
            for b in &binds {
                q = q.bind(b);
            }
            q.execute(p)
                .await
                .map(|r| r.rows_affected())
                .map_err(AppError::from)
        }
        DbPool::Sqlite(p) => {
            let mut q = sqlx::query(&sql);
            for b in &binds {
                q = q.bind(b);
            }
            q.execute(p)
                .await
                .map(|r| r.rows_affected())
                .map_err(AppError::from)
        }
        DbPool::MsSql(p) => p.execute_params(&sql, &binds).await,
        DbPool::Mongo(_) => unreachable!("mongo dispatched above"),
    };

    match &outcome {
        Ok(n) => sink.log(
            LogEntry::new(LogKind::Sql)
                .connection_id(&args.connection_id)
                .driver(driver)
                .sql(&sql)
                .duration_ms(start.elapsed().as_millis() as u64)
                .rows_affected(*n),
        ),
        Err(e) => sink.log(
            LogEntry::new(LogKind::Sql)
                .connection_id(&args.connection_id)
                .driver(driver)
                .sql(&sql)
                .duration_ms(start.elapsed().as_millis() as u64)
                .error(e.to_string()),
        ),
    }
    outcome
}
