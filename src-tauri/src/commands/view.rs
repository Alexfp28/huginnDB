//! View editor commands: read a view's definition, and preview / apply the
//! `CREATE VIEW` / `CREATE OR REPLACE VIEW` / rename / drop DDL built by
//! [`crate::db::view_ddl`]. Mirrors [`crate::commands::structure`]'s
//! introspect → preview → apply shape, but for views instead of tables.
//!
//! The per-driver catalog SQL that reads a stored definition lives with its
//! driver (`db::<driver>::schema::view_definition`), per CLAUDE.md gotcha #43;
//! this module only dispatches to it.
//!
//! MongoDB has no `CREATE VIEW` equivalent (its "views" are read-only
//! aggregation-pipeline collections, edited via `collMod`/`createView` — a
//! fundamentally different model), so every command here rejects it up
//! front, matching [`crate::commands::structure`]'s existing Mongo guard.

use crate::db::sql::{Dialect, Relation};
use crate::db::view_ddl::{build_view_ddl, ViewDefinition};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, DbPool};
use serde::{Deserialize, Serialize};
use tauri::State;

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_view_definition(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    view: String,
) -> AppResult<ViewDefinition> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    let pool = state.pool_for(&connection_id)?;
    // No SQL Server refusal here, unlike `preview`/`apply` below: reading a
    // definition is a plain catalog query, and the T-SQL DDL *builder* is the
    // only thing that isn't written yet (`db::view_ddl::build_view_ddl` still
    // refuses it). `Dialect::try_of` is what rejects MongoDB, whose views are
    // stored pipelines and belong to the aggregation editor.
    Dialect::try_of(&pool)?;
    crate::error::with_timeout("get_view_definition", async move {
        // The `schema` each driver reports back is the one it actually queried,
        // not the argument: Postgres resolves an omitted schema to `public`,
        // MySQL echoes what it was given (an empty one means "the session's
        // current database", which has no name to report), and SQLite has only
        // `main`. `ViewEditorTab` builds its `desired` from the tab's own schema
        // prop rather than from this field, so the two agree.
        let (schema, query) = match &pool {
            DbPool::Postgres(p) => {
                let schema = schema.unwrap_or_else(|| "public".into());
                let query =
                    crate::db::postgres::schema::view_definition(p, Some(&schema), &view).await?;
                (Some(schema), query)
            }
            DbPool::Mysql(p) => {
                let query =
                    crate::db::mysql::schema::view_definition(p, schema.as_deref(), &view).await?;
                (schema, query)
            }
            DbPool::Sqlite(p) => {
                let query = crate::db::sqlite::schema::view_definition(p, None, &view).await?;
                (None, query)
            }
            DbPool::MsSql(p) => {
                let query =
                    crate::db::mssql::schema::view_definition(p, schema.as_deref(), &view).await?;
                (schema, query)
            }
            DbPool::Mongo(_) => unreachable!("mongo rejected by Dialect::try_of above"),
        };
        let query = query.ok_or_else(|| match &schema {
            Some(s) => AppError::NotFound(format!("view {s}.{view}")),
            None => AppError::NotFound(format!("view {view}")),
        })?;
        Ok(ViewDefinition {
            schema,
            name: view,
            query,
        })
    })
    .await
}

// ---------------------------------------------------------------------------
// Preview / apply
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewPreview {
    pub statements: Vec<String>,
    pub drop_and_recreate: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewChangeArgs {
    pub connection_id: String,
    #[serde(default)]
    pub original: Option<ViewDefinition>,
    pub desired: ViewDefinition,
}

#[tauri::command]
pub async fn preview_view_change(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    args: ViewChangeArgs,
) -> AppResult<ViewPreview> {
    crate::commands::ensure_view(&app, &window, state.inner(), &args.connection_id).await;
    let pool = state.pool_for(&args.connection_id)?;
    let dialect = Dialect::try_of(&pool)?;
    let (statements, drop_and_recreate) =
        build_view_ddl(dialect, args.original.as_ref(), &args.desired)?;
    Ok(ViewPreview {
        statements,
        drop_and_recreate,
    })
}

#[tauri::command]
pub async fn apply_view_change(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    args: ViewChangeArgs,
) -> AppResult<()> {
    crate::commands::ensure_view(&app, &window, state.inner(), &args.connection_id).await;
    let pool = state.pool_for(&args.connection_id)?;
    let dialect = Dialect::try_of(&pool)?;
    let (statements, _) = build_view_ddl(dialect, args.original.as_ref(), &args.desired)?;

    // Wrapped on Postgres so a rename plus a body change cannot half-apply; see
    // `db::exec::execute_all` for the per-engine policy.
    crate::db::exec::execute_all(&pool, &statements).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Rename / drop
// ---------------------------------------------------------------------------

/// Rename a view. Postgres uses `ALTER VIEW ... RENAME TO`; MySQL treats
/// views and tables as the same namespace so `RENAME TABLE` works; SQLite
/// likewise accepts `ALTER TABLE ... RENAME TO` for a view.
#[tauri::command]
pub async fn rename_view(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    view: String,
    new_name: String,
) -> AppResult<()> {
    if new_name.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "rename_view: new_name must not be empty".into(),
        ));
    }
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    let pool = state.pool_for(&connection_id)?;
    let dialect = Dialect::try_of(&pool)?;
    let sql = dialect.rename_stmt(schema.as_deref(), &view, new_name.trim(), Relation::View)?;
    crate::db::exec::execute(&pool, &sql).await?;
    Ok(())
}

#[tauri::command]
pub async fn drop_view(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    view: String,
) -> AppResult<()> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    let pool = state.pool_for(&connection_id)?;
    // MongoDB is the one driver whose views this module can otherwise not
    // touch — but *dropping* one needs no DDL at all (a view lives in the same
    // namespace as a collection), so it is handled here rather than forcing
    // the explorer to pick a different command per driver. Editing a Mongo
    // view still belongs to the aggregation editor, which has a pipeline to
    // work with instead of a `SELECT` body.
    if let DbPool::Mongo(conn) = &pool {
        return crate::db::mongo::aggregation::drop_view(conn, &view).await;
    }
    let dialect = Dialect::try_of(&pool)?;
    let qt = dialect.qualify_defaulted(schema.as_deref(), &view);
    let sql = format!("DROP VIEW {qt}");
    // Dropping a view is plain, portable DDL — supported on every SQL driver
    // even though *editing* one isn't yet (see `build_view_ddl`). MongoDB took
    // the branch above.
    crate::db::exec::execute(&pool, &sql).await?;
    Ok(())
}
