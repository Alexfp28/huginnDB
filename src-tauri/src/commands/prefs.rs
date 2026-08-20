//! Preferences and per-connection tab-state command surface.
//!
//! The frontend hydrates from [`get_preferences`] / [`get_tab_state`] at
//! startup and writes back via the matching setters (debounced on the
//! frontend side to avoid hammering the disk while a user drags a slider).

use crate::commands::connection::{
    apply_profile_imports, ImportProgress, IMPORT_PROGRESS_EVENT, PROFILES_CHANGED_EVENT,
};
use crate::error::{AppError, AppResult};
use crate::prefs::{self, Preferences};
use crate::state::{AppState, ConnectionProfile};
use crate::store;
use crate::tab_state::{self, ConnectionTabState, Environment, LaunchState, Origin};
use crate::transfer::{
    self, ConflictAction, ConflictResolution, EnvironmentExportFile, EnvironmentImportAnalysis,
    EnvironmentImportAnalysisEntry, EnvironmentImportResult, ExportMetadata, ExportedEnvironment,
    ExportedEnvironmentBundle, ExportedOrigin, ImportedEnvironment, KIND_ENVIRONMENT,
};
use tauri::{AppHandle, Emitter, State};

/// Broadcast (unscoped — every window) after a successful `update_preferences`,
/// carrying the full persisted snapshot. Each window's frontend hydrates its
/// own private `Preferences` copy once at boot and otherwise has no way to
/// learn another window changed a setting; without this, two windows racing
/// to save (each sending its *entire* blob, not a diff) silently lose
/// whichever one saved first the moment the other's debounce timer fires —
/// see issue #18. The listener just adopts the payload as its new baseline
/// (no re-save), so this is idempotent for the window that triggered it too.
pub const PREFS_CHANGED_EVENT: &str = "huginndb://prefs-changed";

/// Return the in-memory preferences snapshot.
#[tauri::command]
pub fn get_preferences(state: State<'_, AppState>) -> AppResult<Preferences> {
    Ok(state.prefs.read().clone())
}

/// Replace the entire preferences blob and persist it to disk.
///
/// The frontend always sends a full [`Preferences`] value; partial updates
/// are merged client-side. This keeps the wire shape trivial and lets us
/// keep the on-disk file as a faithful mirror of frontend state.
#[tauri::command]
pub async fn update_preferences(
    app: AppHandle,
    state: State<'_, AppState>,
    prefs: Preferences,
) -> AppResult<()> {
    {
        let mut guard = state.prefs.write();
        *guard = prefs.clone();
    }
    prefs::save_preferences(&prefs)?;
    let _ = app.emit(PREFS_CHANGED_EVENT, prefs);
    // Most preferences take effect just by being readable, but the MCP bridge
    // owns a socket: toggling it has to actually start or stop the listener.
    // `reconcile` is idempotent and cheap when nothing changed, so it runs on
    // every write rather than trying to detect which field moved — the
    // preferences arrive as a whole snapshot, so there is no diff to inspect.
    // `async` for this one reason; the command's IPC shape is unchanged.
    crate::bridge::server::reconcile(&app).await;
    Ok(())
}

/// Look up the persisted tab state for `connection_id` **in the active
/// environment**. Returns `None` when the connection has never been opened
/// there, has been pruned, or its entry was cleared after the profile was
/// deleted.
///
/// Only the main window ever calls this — secondary windows (opened via
/// "New window") never hydrate or save tab state, which is what makes
/// them ephemeral. The active environment is likewise a main-window concept.
#[tauri::command]
pub fn get_tab_state(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Option<ConnectionTabState>> {
    let guard = state.tab_state.read();
    Ok(guard
        .active_environment()
        .and_then(|env| env.connections.get(&connection_id))
        .cloned())
}

/// Replace the persisted tab state for `connection_id` in the active
/// environment and write the full blob to disk. The frontend stamps
/// `last_opened` before sending; we run a final pass to drop oversize query
/// bodies and to LRU-prune each environment's map.
#[tauri::command]
pub fn save_tab_state(
    state: State<'_, AppState>,
    connection_id: String,
    mut tab_state_value: ConnectionTabState,
) -> AppResult<()> {
    tab_state::normalise(&mut tab_state_value);
    let snapshot = {
        let mut guard = state.tab_state.write();
        guard
            .active_environment_mut()
            .connections
            .insert(connection_id, tab_state_value);
        guard.prune();
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}

/// Drop the persisted tab state for `connection_id`. Invoked when a
/// profile is deleted so a removed connection can't keep a dangling tab
/// reference around.
///
/// Sweeps **every** environment, not just the active one: the profile is gone
/// globally, so an entry left behind in another environment would resurface as
/// a tab pointing at a connection that no longer exists the moment the user
/// switched there.
#[tauri::command]
pub fn clear_tab_state(state: State<'_, AppState>, connection_id: String) -> AppResult<()> {
    let snapshot = {
        let mut guard = state.tab_state.write();
        for env in &mut guard.environments {
            env.connections.remove(&connection_id);
            env.launch
                .active_connections
                .retain(|id| id != &connection_id);
            if env.launch.selected_connection_id.as_deref() == Some(connection_id.as_str()) {
                env.launch.selected_connection_id = None;
            }
        }
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}

/// Return the session-level inner-dockview geometry, or `None` for the
/// default tabbed layout. Session-level rather than per-connection: the
/// inner dockview is a single shared instance hosting every connection's
/// tabs, so its geometry belongs to the session (see
/// `tab_state::PersistedTabState::internal_layout`). Main-window-only, same
/// as the per-connection tab-state calls.
#[tauri::command]
pub fn get_workspace_layout(state: State<'_, AppState>) -> AppResult<Option<serde_json::Value>> {
    Ok(state
        .tab_state
        .read()
        .active_environment()
        .and_then(|env| env.internal_layout.clone()))
}

/// Persist the session-level inner-dockview geometry (or `None` to clear it
/// back to the default tabbed layout) and write the full blob to disk.
#[tauri::command]
pub fn save_workspace_layout(
    state: State<'_, AppState>,
    layout: Option<serde_json::Value>,
) -> AppResult<()> {
    let snapshot = {
        let mut guard = state.tab_state.write();
        guard.active_environment_mut().internal_layout = layout;
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}

/// Return the active environment's launch-restore state.
///
/// The DTO used to be declared here; it now lives in `tab_state` next to the
/// rest of the persisted shape, so there is one definition instead of two kept
/// in sync by hand.
#[tauri::command]
pub fn get_launch_state(state: State<'_, AppState>) -> AppResult<LaunchState> {
    let guard = state.tab_state.read();
    Ok(guard
        .active_environment()
        .map(|env| env.launch.clone())
        .unwrap_or_default())
}

/// Record the launch-restore state (live connections, focused connection,
/// active tab) so the next launch — or the next switch back into this
/// environment — can restore it. Written on window close and opportunistically
/// on connect/disconnect; see `src/stores/persistedTabs.ts`.
#[tauri::command]
pub fn save_launch_state(state: State<'_, AppState>, launch_state: LaunchState) -> AppResult<()> {
    let snapshot = {
        let mut guard = state.tab_state.write();
        guard.active_environment_mut().launch = launch_state;
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}

// --- Environments ------------------------------------------------------------
// A named set of connections plus the session state belonging to them. The
// active one scopes every tab-state / layout / launch call above.
//
// All of these are main-window-only in practice, for the same reason tab state
// is (CLAUDE.md gotcha #8): a secondary window writing here would reshape the
// main window's session out from under it.

/// Every environment in display order, plus which one is active.
#[tauri::command]
pub fn list_environments(state: State<'_, AppState>) -> AppResult<EnvironmentList> {
    let guard = state.tab_state.read();
    let mut environments = guard.environments.clone();
    environments.sort_by_key(|e| e.order);
    Ok(EnvironmentList {
        active_environment_id: guard
            .active_environment()
            .map(|e| e.id.clone())
            .unwrap_or_default(),
        environments,
    })
}

/// What [`list_environments`] returns: the list and the active id together, so
/// the frontend can't render a switcher out of step with the backend's notion of
/// which one is current.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentList {
    pub environments: Vec<Environment>,
    pub active_environment_id: String,
}

/// Create a new environment, or update an existing one's presentation fields.
///
/// Deliberately narrow: this never touches `connections`, `internal_layout` or
/// `launch`. Those are owned by the session-state commands above and a
/// round-trip through the frontend's editing form would drop whatever the user
/// had open — the same class of bug as gotcha #14, but caused by an incomplete
/// payload rather than by serde.
#[tauri::command]
pub fn save_environment(
    state: State<'_, AppState>,
    id: Option<String>,
    name: String,
    color: Option<String>,
    icon: Option<String>,
    theme_id: Option<String>,
) -> AppResult<Environment> {
    let (snapshot, saved) = {
        let mut guard = state.tab_state.write();
        let saved = match id {
            Some(id) => {
                let env = guard
                    .environments
                    .iter_mut()
                    .find(|e| e.id == id)
                    .ok_or_else(|| {
                        AppError::InvalidInput(format!("no environment with id {id}"))
                    })?;
                env.name = name;
                env.color = color;
                env.icon = icon;
                env.theme_id = theme_id;
                env.clone()
            }
            None => {
                let order = guard
                    .environments
                    .iter()
                    .map(|e| e.order)
                    .max()
                    .unwrap_or(0)
                    + 1;
                let env = Environment {
                    id: uuid::Uuid::new_v4().to_string(),
                    name,
                    color,
                    icon,
                    order,
                    theme_id,
                    ..Environment::default()
                };
                guard.environments.push(env.clone());
                env
            }
        };
        (guard.clone(), saved)
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(saved)
}

/// Delete an environment and everything it remembered.
///
/// Refuses to delete the last one: the invariant every session-state command
/// relies on is that an active environment always exists, and "delete the only
/// environment" has no sensible outcome — an empty switcher is not a state the
/// user can act from. Deleting the active one moves focus to the first survivor.
///
/// Connection *profiles* are untouched. An environment owns session state, not
/// the connections themselves (they live in `profiles.json`), so removing one
/// discards tabs and layout, never credentials.
#[tauri::command]
pub fn delete_environment(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let snapshot = {
        let mut guard = state.tab_state.write();
        if guard.environments.len() <= 1 {
            return Err(AppError::InvalidInput(
                "cannot delete the last environment".into(),
            ));
        }
        let before = guard.environments.len();
        guard.environments.retain(|e| e.id != id);
        if guard.environments.len() == before {
            return Err(AppError::InvalidInput(format!(
                "no environment with id {id}"
            )));
        }
        if guard.active_environment_id.as_deref() == Some(id.as_str()) {
            guard.active_environment_id = guard.environments.first().map(|e| e.id.clone());
        }
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}

/// Detach an environment from the origin that mirrors it (#108 continuous
/// environment sync's "adopt", the environment-level twin of clearing a
/// connection profile's `origin_id`).
///
/// Clears only `origin_id`/`origin_source_id`. Cosmetics, connections and
/// session state are left exactly as they were at the moment of adoption —
/// the next `sync_origin` run for that origin will no longer touch this
/// environment, and it becomes an ordinary local one.
#[tauri::command]
pub fn adopt_environment(state: State<'_, AppState>, id: String) -> AppResult<Environment> {
    let (snapshot, saved) = {
        let mut guard = state.tab_state.write();
        let saved = {
            let env = guard
                .environments
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or_else(|| AppError::InvalidInput(format!("no environment with id {id}")))?;
            env.origin_id = None;
            env.origin_source_id = None;
            env.clone()
        };
        (guard.clone(), saved)
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(saved)
}

/// Switch the active environment.
///
/// Backend-side this is just a pointer move plus a write; the expensive part is
/// the frontend's job and its order is load-bearing (flush the outgoing
/// session → disconnect → set active → reconnect → restore layout → restore
/// focus). See `src/stores/environments.ts`.
#[tauri::command]
pub fn set_active_environment(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let snapshot = {
        let mut guard = state.tab_state.write();
        if !guard.environments.iter().any(|e| e.id == id) {
            return Err(AppError::InvalidInput(format!(
                "no environment with id {id}"
            )));
        }
        guard.active_environment_id = Some(id);
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}

/// Persist the switcher's display order.
#[tauri::command]
pub fn reorder_environments(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<()> {
    let snapshot = {
        let mut guard = state.tab_state.write();
        for (i, id) in ids.iter().enumerate() {
            if let Some(env) = guard.environments.iter_mut().find(|e| &e.id == id) {
                env.order = i as i32;
            }
        }
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(())
}

// --- Environment export/import ------------------------------------------
//
// An environment's portable identity is its cosmetics + the connections it
// groups + the shared origins it pulls from — never its tabs or dockview
// geometry (see the module doc in `crate::transfer`). Import always creates a
// brand-new environment, so there is nothing for origins (or the environment
// itself) to conflict with; only the connection profiles can, because
// `profiles.json` is global. That reuses `import_profiles`'s exact
// conflict/rename/keychain machinery via `apply_profile_imports`.

/// Every connection id this environment references, anywhere: its remembered
/// tab state, what was live at last close, the focused connection, and the
/// per-connection database-visibility overrides. Deleting a profile already
/// sweeps all of these (gotcha #27), so in practice every id here resolves to
/// a real profile — but the export still filters defensively rather than
/// assuming that.
fn referenced_profile_ids(env: &Environment) -> std::collections::HashSet<String> {
    let mut ids: std::collections::HashSet<String> = env.connections.keys().cloned().collect();
    ids.extend(env.launch.active_connections.iter().cloned());
    if let Some(sel) = &env.launch.selected_connection_id {
        ids.insert(sel.clone());
    }
    if let Some(visible) = &env.launch.visible_connections {
        ids.extend(visible.iter().cloned());
    }
    ids.extend(env.launch.database_visibility.keys().cloned());
    ids
}

/// Export one or more environments into a single bundle: each one's
/// cosmetics and registered shared origins (name + path only — never the
/// passphrase, which stays in this machine's keychain; see
/// `commands::origins`), plus a single deduplicated pool of the connection
/// profiles any of them reference.
///
/// Tabs, dockview geometry and launch state are deliberately left out — they
/// are session artifacts tied to this machine, not part of an environment's
/// portable identity (CLAUDE.md gotcha #10).
#[tauri::command]
pub async fn export_environments(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
    include_passwords: bool,
    passphrase: Option<String>,
    include_json_schemas: Option<bool>,
) -> AppResult<String> {
    if ids.is_empty() {
        return Err(AppError::InvalidInput(
            "select at least one environment to export".into(),
        ));
    }
    if include_passwords && passphrase.is_none() {
        return Err(AppError::InvalidInput(
            "a passphrase is required when include_passwords is true".into(),
        ));
    }

    let envs: Vec<Environment> = {
        let guard = state.tab_state.read();
        ids.iter()
            .map(|id| {
                guard
                    .environments
                    .iter()
                    .find(|e| &e.id == id)
                    .cloned()
                    .ok_or_else(|| AppError::InvalidInput(format!("no environment with id {id}")))
            })
            .collect::<AppResult<Vec<_>>>()?
    };

    // Union of every profile any selected environment references — not one
    // copy per environment (see `EnvironmentExportFile`'s doc).
    let mut profile_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for env in &envs {
        profile_ids.extend(referenced_profile_ids(env));
    }
    let profiles_snapshot: Vec<ConnectionProfile> = {
        let guard = state.profiles.read();
        guard
            .iter()
            .filter(|p| profile_ids.contains(&p.id))
            .cloned()
            .collect()
    };
    let exported_profiles = transfer::build_exported_profiles(
        &profiles_snapshot,
        include_passwords,
        passphrase.as_deref(),
    )?;

    let bundles: Vec<ExportedEnvironmentBundle> = envs
        .iter()
        .map(|env| {
            let mut connection_ids: Vec<String> = referenced_profile_ids(env).into_iter().collect();
            connection_ids.sort();
            ExportedEnvironmentBundle {
                environment: ExportedEnvironment {
                    name: env.name.clone(),
                    color: env.color.clone(),
                    icon: env.icon.clone(),
                    theme_id: env.theme_id.clone(),
                    source_environment_id: env.id.clone(),
                },
                connection_ids,
                origins: env
                    .origins
                    .iter()
                    .map(|o| ExportedOrigin {
                        name: o.name.clone(),
                        path: o.path.clone(),
                    })
                    .collect(),
            }
        })
        .collect();

    // The whole library, not a per-environment slice: schemas are global
    // (`crate::json_schemas`), so there is no subset an environment "owns".
    // Riding along in this file is a convenience for setting up a machine, not
    // a claim that the environment contains them.
    let json_schemas = if include_json_schemas.unwrap_or(false) {
        let guard = state.json_schemas.read();
        let ids: Vec<String> = guard.schemas.iter().map(|s| s.id.clone()).collect();
        crate::json_schemas::import::collect_bundle(&guard, &ids, true)
    } else {
        transfer::JsonSchemaBundle::default()
    };

    let now = chrono::Utc::now().to_rfc3339();
    let file = EnvironmentExportFile {
        meta: ExportMetadata {
            version: 1,
            app: "huginndb".into(),
            exported_at: now.clone(),
            encrypted: include_passwords,
            kind: KIND_ENVIRONMENT.into(),
        },
        environments: bundles,
        profiles: exported_profiles,
        json_schemas,
    };

    let json = serde_json::to_string_pretty(&file)?;

    let date_part = now.get(..10).unwrap_or("export");
    let suggested = if envs.len() == 1 {
        format!("huginndb-environment-{date_part}.json")
    } else {
        format!("huginndb-environments-{date_part}.json")
    };

    use tauri_plugin_dialog::DialogExt;
    let path = app
        .dialog()
        .file()
        .set_title("Export environments")
        .set_file_name(&suggested)
        .add_filter("JSON", &["json"])
        .blocking_save_file()
        .ok_or_else(|| AppError::Transfer("export cancelled".into()))?;

    let dest = path.to_string();
    std::fs::write(&dest, json)?;
    Ok(dest)
}

/// Read and parse an environment export without decrypting anything or
/// touching any state. Mirrors `analyze_import_file`: the frontend calls this
/// first to drive the same conflict-resolution step, before collecting a
/// passphrase (if `encrypted`) and calling `import_environment`.
#[tauri::command]
pub fn analyze_environment_import(
    state: State<'_, AppState>,
    file_path: String,
) -> AppResult<EnvironmentImportAnalysis> {
    let data = std::fs::read_to_string(&file_path)?;
    let export: EnvironmentExportFile = serde_json::from_str(&data)?;

    if export.meta.version != 1 {
        return Err(AppError::Transfer(format!(
            "unsupported export format version {}",
            export.meta.version
        )));
    }
    if export.meta.kind != KIND_ENVIRONMENT {
        return Err(AppError::Transfer(
            "this file is not an environment export".into(),
        ));
    }

    let profiles = state.profiles.read();
    let conflicts = transfer::detect_conflicts(&profiles, &export.profiles);

    let environments = export
        .environments
        .iter()
        .map(|b| EnvironmentImportAnalysisEntry {
            name: b.environment.name.clone(),
            connection_count: b.connection_ids.len(),
            origins: b.origins.clone(),
        })
        .collect();

    Ok(EnvironmentImportAnalysis {
        environments,
        total_profiles: export.profiles.len(),
        encrypted: export.meta.encrypted,
        conflicts,
        total_json_schemas: export.json_schemas.schemas.len(),
        total_json_schema_bindings: export.json_schemas.bindings.len(),
    })
}

/// Import an environment export: every bundle in the file becomes a **new**
/// environment — none is ever merged into or overwritten on top of one that
/// already exists, which is what makes this safe to run repeatedly and what
/// guarantees the origins/cosmetics below never collide with anything already
/// configured. The only real conflict surface is the shared connection-profile
/// pool (`profiles.json` is global), resolved once for the whole file via
/// `apply_profile_imports` — not once per environment.
///
/// Each new environment's connection-tree is scoped to exactly the profiles
/// its bundle referenced via `launch.visible_connections` (the same
/// DataGrip-style filter #107 already added), translated through the
/// import's original-id → new-id map so a skipped or renamed profile is
/// reflected correctly. None are auto-connected (`launch.active_connections`
/// stays empty): importing an environment should not silently open N live
/// database connections.
///
/// Each origin is registered with a fresh id and no stored passphrase. An
/// encrypted one surfaces the same "no passphrase stored" state a freshly
/// `add_origin`-ed one would, on the next sync — there's nothing special to
/// resolve here at import time.
///
/// `async fn` on purpose, with the actual work run via `spawn_blocking`: a
/// synchronous Tauri command executes on the main thread, and
/// `apply_profile_imports` runs one 600 000-iteration PBKDF2 derivation per
/// encrypted secret (`transfer::decrypt_secret`) — deliberately slow, and with
/// a bundle carrying dozens of environments' worth of connection profiles,
/// slow enough in aggregate to freeze the window for the whole import (issue:
/// app reported "not responding" importing 13 environments / 22 conflicting
/// profiles).
#[tauri::command]
pub async fn import_environment(
    app: AppHandle,
    state: State<'_, AppState>,
    file_path: String,
    passphrase: Option<String>,
    conflict_resolutions: Vec<ConflictResolution>,
) -> AppResult<EnvironmentImportResult> {
    let profiles_lock = state.profiles.clone();
    let json_schemas_lock = state.json_schemas.clone();
    let tab_state_lock = state.tab_state.clone();
    let app_for_task = app.clone();

    tauri::async_runtime::spawn_blocking(move || -> AppResult<EnvironmentImportResult> {
        let data = std::fs::read_to_string(&file_path)?;
        let export: EnvironmentExportFile = serde_json::from_str(&data)?;

        if export.meta.version != 1 {
            return Err(AppError::Transfer(format!(
                "unsupported export format version {}",
                export.meta.version
            )));
        }
        if export.meta.kind != KIND_ENVIRONMENT {
            return Err(AppError::Transfer(
                "this file is not an environment export".into(),
            ));
        }
        if export.meta.encrypted && passphrase.is_none() {
            return Err(AppError::Transfer(
                "this export file contains encrypted passwords — provide a passphrase".into(),
            ));
        }

        let resolution_map: std::collections::HashMap<String, ConflictAction> =
            conflict_resolutions
                .into_iter()
                .map(|r| (r.id, r.action))
                .collect();

        let (profile_result, id_map, overwritten_ids) = {
            let mut profiles = profiles_lock.write();
            let (result, id_map, overwritten_ids) = apply_profile_imports(
                &mut profiles,
                export.profiles,
                passphrase.as_deref(),
                &resolution_map,
                |done, total| {
                    let _ =
                        app_for_task.emit(IMPORT_PROGRESS_EVENT, ImportProgress { done, total });
                },
            )?;
            store::save_profiles(&profiles)?;
            (result, id_map, overwritten_ids)
        };
        let _ = app_for_task.emit(PROFILES_CHANGED_EVENT, ());

        // JSON Schemas, when the file carried them. Two passes, in this order:
        // first repoint local bindings whose profile was *overwritten* (a fresh
        // uuid is minted even then, so they would silently stop matching), then
        // merge the file's own schemas, translating their bindings through the same
        // `id_map` that `launch.visible_connections` uses below.
        let schema_result = {
            let bundle = export.json_schemas;
            let has_bundle = !bundle.is_empty();
            if !has_bundle && overwritten_ids.is_empty() {
                None
            } else {
                let now = chrono::Utc::now().to_rfc3339();
                let mut lib = json_schemas_lock.write();
                crate::json_schemas::remap_connection_ids(&mut lib, &overwritten_ids);
                let outcome = if has_bundle {
                    Some(crate::json_schemas::import::apply_imports(
                        &mut lib,
                        bundle,
                        &resolution_map,
                        &crate::json_schemas::import::ConnectionRemap::IdMap(&id_map),
                        &now,
                    ))
                } else {
                    None
                };
                let snapshot = lib.clone();
                drop(lib);
                crate::json_schemas::save_library(&snapshot)?;
                let _ = app_for_task.emit(
                    crate::commands::json_schemas::JSON_SCHEMAS_CHANGED_EVENT,
                    (),
                );
                outcome
            }
        };

        let (snapshot, imported_environments) = {
            let mut guard = tab_state_lock.write();
            let base_order = guard
                .environments
                .iter()
                .map(|e| e.order)
                .max()
                .unwrap_or(0)
                + 1;

            let mut imported_environments = Vec::with_capacity(export.environments.len());
            for (i, bundle) in export.environments.into_iter().enumerate() {
                let ExportedEnvironmentBundle {
                    environment,
                    connection_ids,
                    origins: bundle_origins,
                } = bundle;

                let mut origins = Vec::with_capacity(bundle_origins.len());
                let mut origin_ids = Vec::with_capacity(bundle_origins.len());
                for eo in bundle_origins {
                    let oid = uuid::Uuid::new_v4().to_string();
                    origin_ids.push(oid.clone());
                    origins.push(Origin {
                        id: oid,
                        name: eo.name,
                        path: eo.path,
                        last_synced_at: None,
                    });
                }

                // Translate this bundle's original connection ids into whatever
                // they actually landed as — a skipped profile has no entry here.
                let visible: Vec<String> = connection_ids
                    .iter()
                    .filter_map(|orig| id_map.get(orig).cloned())
                    .collect();
                let visible_connections = if visible.is_empty() {
                    None
                } else {
                    Some(visible)
                };

                let env_id = uuid::Uuid::new_v4().to_string();
                let name = environment.name.clone();
                let env = Environment {
                    id: env_id.clone(),
                    name: environment.name,
                    color: environment.color,
                    icon: environment.icon,
                    order: base_order + i as i32,
                    theme_id: environment.theme_id,
                    origins,
                    launch: LaunchState {
                        visible_connections,
                        ..LaunchState::default()
                    },
                    ..Environment::default()
                };
                imported_environments.push(ImportedEnvironment {
                    environment_id: env_id,
                    name,
                    origin_ids,
                });
                guard.environments.push(env);
            }
            (guard.clone(), imported_environments)
        };
        tab_state::save_tab_state(&snapshot)?;

        Ok(EnvironmentImportResult {
            environments: imported_environments,
            profiles: profile_result,
            json_schemas: schema_result,
        })
    })
    .await
    .map_err(|e| AppError::Transfer(format!("environment import task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn referenced_profile_ids_covers_every_slot_that_can_name_a_connection() {
        let mut env = Environment::default();
        env.connections
            .insert("from-tabs".into(), ConnectionTabState::default());
        env.launch.active_connections = vec!["from-active".into()];
        env.launch.selected_connection_id = Some("from-selected".into());
        env.launch.visible_connections = Some(vec!["from-visible".into()]);
        env.launch
            .database_visibility
            .insert("from-db-visibility".into(), None);

        let ids = referenced_profile_ids(&env);
        for expected in [
            "from-tabs",
            "from-active",
            "from-selected",
            "from-visible",
            "from-db-visibility",
        ] {
            assert!(ids.contains(expected), "missing {expected}");
        }
        assert_eq!(ids.len(), 5);
    }

    #[test]
    fn referenced_profile_ids_is_empty_for_a_fresh_environment() {
        assert!(referenced_profile_ids(&Environment::default()).is_empty());
    }
}
