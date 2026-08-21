//! MongoDB index-manager commands.
//!
//! The Mongo counterpart of what [`crate::commands::structure`] does for the
//! SQL drivers, and split out for the same reason
//! [`crate::commands::aggregation`] is: there is nothing here to diff into DDL.
//! An index is created, hidden, replaced or dropped through a run-command, and
//! `apply_structure_change` rejects MongoDB outright.
//!
//! Two conventions carry over from the aggregation editor and matter:
//!
//! * **Documents cross as source text.** Index keys, partial filters,
//!   collations and text weights arrive exactly as the user typed them and are
//!   parsed in Rust (gotcha #33). The frontend never parses BSON.
//! * **Every command rejects a non-MongoDB connection up front**, so a
//!   mis-routed call fails with a sentence rather than a type error deep in a
//!   driver.
//!
//! These are deliberately **not** exposed over the MCP bridge in this pass:
//! they are writes, and which of them an AI client should reach is its own
//! decision about the per-connection write policy, not a side effect of adding
//! the UI.

use crate::db::mongo::indexes::{self, MongoIndexInfo, NewMongoIndexSpec};
use crate::error::AppResult;
use crate::state::AppState;
use serde::Deserialize;
use tauri::State;

/// Message for the non-MongoDB case of [`AppState::mongo_for`]. Named here
/// rather than templated in the helper because the useful half is the
/// pointer to this feature's SQL equivalent.
const MONGO_ONLY: &str =
    "the index manager is MongoDB-only; SQL indexes are edited in the structure editor";

/// A collection's indexes, with their sizes and usage counters when the
/// connection's role can read them.
#[tauri::command]
pub async fn list_mongo_indexes(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    collection: String,
) -> AppResult<Vec<MongoIndexInfo>> {
    crate::commands::connection::ensure_database_view(
        &app,
        state.inner(),
        Some(window.label()),
        &connection_id,
    )
    .await;
    let conn = state.mongo_for(&connection_id, MONGO_ONLY)?;
    indexes::list_indexes(&conn, &collection).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateIndexArgs {
    pub connection_id: String,
    pub collection: String,
    pub spec: NewMongoIndexSpec,
}

#[tauri::command]
pub async fn create_mongo_index(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    args: CreateIndexArgs,
) -> AppResult<()> {
    crate::commands::connection::ensure_database_view(
        &app,
        state.inner(),
        Some(window.label()),
        &args.connection_id,
    )
    .await;
    let conn = state.mongo_for(&args.connection_id, MONGO_ONLY)?;
    indexes::create_index(&conn, &args.collection, &args.spec).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecreateIndexArgs {
    pub connection_id: String,
    pub collection: String,
    /// The index being replaced. Dropped only after the new spec parses.
    pub original_name: String,
    pub spec: NewMongoIndexSpec,
}

/// Replace an index. MongoDB cannot alter one in place, so this is a drop
/// followed by a create — destructive, and the UI confirms it first.
#[tauri::command]
pub async fn recreate_mongo_index(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    args: RecreateIndexArgs,
) -> AppResult<()> {
    crate::commands::connection::ensure_database_view(
        &app,
        state.inner(),
        Some(window.label()),
        &args.connection_id,
    )
    .await;
    let conn = state.mongo_for(&args.connection_id, MONGO_ONLY)?;
    indexes::recreate_index(&conn, &args.collection, &args.original_name, &args.spec).await
}

#[tauri::command]
pub async fn drop_mongo_index(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    collection: String,
    name: String,
) -> AppResult<()> {
    crate::commands::connection::ensure_database_view(
        &app,
        state.inner(),
        Some(window.label()),
        &connection_id,
    )
    .await;
    let conn = state.mongo_for(&connection_id, MONGO_ONLY)?;
    indexes::drop_index(&conn, &collection, &name).await
}

/// Hide or unhide an index — the reversible rehearsal for dropping it.
#[tauri::command]
pub async fn set_mongo_index_hidden(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    collection: String,
    name: String,
    hidden: bool,
) -> AppResult<()> {
    crate::commands::connection::ensure_database_view(
        &app,
        state.inner(),
        Some(window.label()),
        &connection_id,
    )
    .await;
    let conn = state.mongo_for(&connection_id, MONGO_ONLY)?;
    indexes::set_index_hidden(&conn, &collection, &name, hidden).await
}
