//! The data-path executor both sides of the MCP bridge run.
//!
//! One [`BridgeRequest`] in, one JSON value out, against whichever `AppState`
//! owns the pools. The desktop app calls this to serve a sidecar; the sidecar
//! calls it directly when there is no app to serve it.
//!
//! Sharing it is the point. The alternative — the server dispatching one way
//! and the sidecar's local fallback another — is two transcriptions of the same
//! fifteen calls that would drift the moment either side gained an argument,
//! and the drift would only show up when the app happened not to be running.

use crate::bridge::protocol::BridgeRequest;
use crate::error::{AppError, AppResult};
use crate::log_bus::LogSink;
use crate::state::AppState;
use serde_json::Value;

/// Execute one request against `state`.
///
/// `EnsureConnected` is **not** handled here — see the arm's comment. Every
/// caller must intercept it first.
pub async fn execute(
    state: &AppState,
    sink: &dyn LogSink,
    request: &BridgeRequest,
) -> AppResult<Value> {
    use BridgeRequest::*;
    let value = match request {
        EnsureConnected { .. } => {
            // Opening a pool differs per side — the app goes through
            // `connect_inner` (endpoint reservation, keepalive, cross-window
            // event), the sidecar through its own `ensure_connected`. Both
            // callers handle this variant before delegating here, so reaching
            // it means a new call site forgot to. An error rather than a panic:
            // this function is driven by network input.
            return Err(AppError::InvalidInput(
                "ensure_connected must be handled by the caller".into(),
            ));
        }
        ResolveMongoTarget {
            connection_id,
            database,
        } => {
            let id = crate::commands::connection::resolve_mongo_database_view(
                state,
                connection_id,
                database,
            )
            .await?;
            Value::String(id)
        }
        IsMongo { connection_id } => Value::Bool(matches!(
            state.connections.read().get(connection_id),
            Some(crate::state::DbPool::Mongo(_))
        )),
        // Metadata reads get the same `with_timeout` ceiling their GUI command
        // counterparts do (`commands::schema`/`structure`) — this is the *other*
        // caller of these `_inner` functions (see the module docs), so without
        // its own wrap here a half-dead socket would hang an MCP tool call
        // indefinitely even though the desktop command for the same operation
        // fails fast.
        ListDatabases { connection_id } => serde_json::to_value(
            crate::error::with_timeout(
                "list_databases",
                crate::commands::schema::list_databases_inner(state, connection_id),
            )
            .await?,
        )?,
        ListTables { connection_id } => serde_json::to_value(
            crate::error::with_timeout(
                "list_tables",
                crate::commands::schema::list_tables_inner(state, connection_id),
            )
            .await?,
        )?,
        GetTableStructure {
            connection_id,
            schema,
            table,
        } => serde_json::to_value(
            crate::error::with_timeout(
                "get_table_structure",
                crate::commands::structure::get_table_structure_inner(
                    state,
                    connection_id,
                    schema.clone(),
                    table.clone(),
                ),
            )
            .await?,
        )?,
        ListIndexes {
            connection_id,
            schema,
            table,
        } => serde_json::to_value(
            crate::error::with_timeout(
                "list_indexes",
                crate::commands::schema::list_indexes_inner(
                    state,
                    connection_id,
                    schema.clone(),
                    table.clone(),
                ),
            )
            .await?,
        )?,
        ServerVersion { connection_id } => Value::String(
            crate::error::with_timeout(
                "server_version",
                crate::commands::schema::server_version_inner(state, connection_id),
            )
            .await?,
        ),
        ListUsers { connection_id } => serde_json::to_value(
            crate::error::with_timeout(
                "list_users",
                crate::commands::schema::list_users_inner(state, connection_id),
            )
            .await?,
        )?,
        ListPrivileges {
            connection_id,
            user,
        } => serde_json::to_value(
            crate::error::with_timeout(
                "list_privileges",
                crate::commands::schema::list_privileges_inner(state, connection_id, user.clone()),
            )
            .await?,
        )?,
        RunStatement {
            connection_id, sql, ..
        } => serde_json::to_value(
            crate::commands::query::execute_with_state(sink, state, connection_id, sql).await?,
        )?,
        FetchTableData {
            connection_id,
            schema,
            table,
            limit,
            offset,
            with_count,
            ..
        } => serde_json::to_value(
            crate::commands::query::fetch_table_data_inner(
                sink,
                state,
                crate::commands::query::TableQuery {
                    connection_id: connection_id.clone(),
                    schema: schema.clone(),
                    table: table.clone(),
                    limit: *limit,
                    offset: *offset,
                    order: Vec::new(),
                    filter: Default::default(),
                    // The bridge's own `with_count` is an `Option<bool>` on
                    // the wire; `None` kept the pre-struct default of "count".
                    with_count: with_count.unwrap_or(true),
                },
            )
            .await?,
        )?,
        InsertRow {
            connection_id,
            schema,
            table,
            pk_column,
            values,
            ..
        } => {
            crate::commands::query::insert_row_inner(
                sink,
                state,
                connection_id.clone(),
                schema.clone(),
                table.clone(),
                pk_column.clone(),
                serde_json::from_value(values.clone())?,
            )
            .await?
        }
        UpdateCell {
            connection_id,
            schema,
            table,
            pk_columns,
            pk_values,
            column,
            value,
            column_type,
            ..
        } => Value::from(
            crate::commands::query::update_cell_inner(
                sink,
                state,
                connection_id.clone(),
                schema.clone(),
                table.clone(),
                pk_columns.clone(),
                pk_values.clone(),
                column.clone(),
                value.clone(),
                column_type.clone(),
            )
            .await?,
        ),
        DeleteRows {
            connection_id,
            schema,
            table,
            pk_columns,
            pk_value_rows,
            ..
        } => Value::from(
            crate::commands::query::delete_rows_inner(
                sink,
                state,
                connection_id.clone(),
                schema.clone(),
                table.clone(),
                pk_columns.clone(),
                pk_value_rows.clone(),
            )
            .await?,
        ),
    };
    Ok(value)
}
