//! Settings → Policy: the read-only view of this machine's managed policy —
//! where it was read from, who this is, which role that makes them, and what
//! each connection allows. See `crate::policy`.
//!
//! Read-only on purpose. The policy is written by an administrator, in a
//! place a standard user cannot write; nothing in the app edits it.

use crate::state::AppState;
use tauri::State;

/// The policy as it applies to this user on this machine, right now.
///
/// Synchronous: it reads two locks and no file — the policy was loaded by
/// `policy::install`'s thread, and the profiles are in memory.
#[tauri::command]
pub fn policy_status(state: State<'_, AppState>) -> crate::policy::PolicyStatus {
    crate::policy::status(state.inner())
}

/// What the app may offer the person using it on each connection — locked
/// controls read this. `connection_ids` may be profile ids or
/// `<parent>::db::<name>` view ids, since a rule can be about one database.
///
/// Advisory for the interface only: every command refuses on its own
/// (`commands::guard`), so a stale answer here can show a control that then
/// fails, never let one through.
#[tauri::command]
pub fn policy_access(
    state: State<'_, AppState>,
    connection_ids: Vec<String>,
) -> crate::policy::PolicyAccess {
    crate::policy::access(state.inner(), &connection_ids)
}

/// A relation, as `policy_relation_access` is asked about it.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationRef {
    pub schema: Option<String>,
    pub name: String,
}

/// What the person may do on each of `relations`, in one call per listing or
/// tab rather than one per row. The globs, the deny-wins rule and the
/// MySQL/MongoDB schema-is-the-database rule all live in Rust, so the
/// frontend cannot answer this on its own.
#[tauri::command]
pub fn policy_relation_access(
    state: State<'_, AppState>,
    connection_id: String,
    relations: Vec<RelationRef>,
) -> Vec<crate::policy::RelationAccess> {
    let pairs: Vec<(Option<String>, String)> =
        relations.into_iter().map(|r| (r.schema, r.name)).collect();
    crate::policy::relation_access(state.inner(), &connection_id, &pairs)
}

/// The permission script for policy `role` on `connection_id`'s server:
/// `GRANT`s (or MongoDB's `createRole`) that make the database agree with
/// what the role allows, for an administrator to review and run. HuginnDB
/// never runs it.
///
/// Reads the catalog through the `_inner` cores, unfiltered on purpose: the
/// grants must cover every relation the rules name, and the connection is the
/// administrator's own. Guarded by `monitor`, the permission that already lets
/// a person read users and privileges on the server.
#[tauri::command]
pub async fn policy_generate_grants(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    role: String,
) -> crate::error::AppResult<crate::policy::grants::GrantScript> {
    use crate::error::AppError;
    use crate::policy::grants::{self, Engine, GrantInput, Relation};
    use crate::state::Driver;

    crate::commands::guard::monitor(state.inner(), &connection_id)?;
    let parent = crate::state::parent_connection_id(&connection_id).to_string();
    let (doc, source) = match &*state.policy.read() {
        crate::policy::PolicyState::Active { doc, source, .. } => (doc.clone(), source.clone()),
        _ => {
            return Err(AppError::InvalidInput(
                "no managed policy is in force on this machine, so there is nothing to grant"
                    .into(),
            ))
        }
    };
    let profile = state
        .profiles
        .read()
        .iter()
        .find(|p| p.id == parent)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("profile {parent}")))?;
    let engine = match profile.driver {
        Driver::Postgres => Engine::Postgres,
        Driver::Mysql => Engine::Mysql,
        Driver::MsSql => Engine::MsSql,
        Driver::Mongo => Engine::Mongo,
        Driver::Sqlite => {
            return Err(AppError::InvalidInput(
                "SQLite has no users to grant to; only the file's permissions protect it".into(),
            ))
        }
    };
    let rules = grants::rules_for(&doc, &role, &profile)
        .ok_or_else(|| AppError::InvalidInput(format!("the policy has no role {role:?}")))?;

    let mut databases = Vec::new();
    let mut relations = Vec::new();
    if !rules.is_empty() {
        for db in crate::commands::schema::list_databases_inner(state.inner(), &parent).await? {
            if !grants::wants_database(&rules, &db.name) {
                continue;
            }
            // Postgres, MySQL and SQL Server list the tables of the database
            // a pool is bound to, so each one is read through its own view.
            let child = crate::state::database_view_id(&parent, &db.name);
            crate::commands::ensure_view(&app, &window, state.inner(), &child).await;
            for t in crate::commands::schema::list_tables_inner(state.inner(), &child).await? {
                relations.push(Relation {
                    database: db.name.clone(),
                    schema: t.schema,
                    name: t.name,
                });
            }
            databases.push(db.name);
        }
    }

    let members = grants::members(&doc, &role, &rules);
    Ok(grants::build(&GrantInput {
        engine,
        role: &role,
        rules,
        databases,
        relations,
        members,
        server: format!("{}:{}", profile.host, profile.effective_port()),
        source,
        generated_at: chrono::Utc::now().to_rfc3339(),
    }))
}
