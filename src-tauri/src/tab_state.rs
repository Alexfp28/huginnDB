//! Persisted workspace + per-connection session state.
//!
//! HuginnDB groups the user's work into **workspaces**: each workspace
//! owns its own bag of per-connection tab state (open tabs, active tab,
//! schema-tree expansion). One workspace is active at a time; switching
//! to another workspace swaps the visible tabs without closing pools.
//!
//! The on-disk blob (`tab_state.json`) carries every workspace plus the
//! id of the active one, alongside a `version` field to drive forward
//! migrations.
//!
//! ## Why one file?
//!
//! The tabs of every workspace ultimately need to live together on disk
//! anyway — there's no per-workspace lifecycle that benefits from a
//! separate file. Keeping the blob single makes "create workspace",
//! "rename", "reorder", and "set active" all atomic without juggling
//! multiple writes.
//!
//! ## v1 → v2 migration
//!
//! Pre-workspaces blobs (`version == 1`) had a top-level
//! `connections: HashMap<id, ConnectionTabState>`. On load we wrap that
//! map inside a single auto-created "Default" workspace and bump
//! `version` to 2. The migrated shape is what every subsequent save
//! emits — we never write the old format again.
//!
//! Each workspace's `connections` map is LRU-pruned to
//! [`MAX_REMEMBERED_CONNECTIONS`]. Query bodies inside tabs are capped
//! at [`MAX_QUERY_BYTES`]; oversized bodies are saved empty.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

const TAB_STATE_FILE: &str = "tab_state.json";
const APP_DIR: &str = "HuginnDB";

/// Soft cap on how many connections each workspace remembers. Older
/// entries (by `last_opened`) get pruned at save time.
pub const MAX_REMEMBERED_CONNECTIONS: usize = 20;

/// Soft cap on a single tab's query body. Anything larger is truncated
/// to `None` at save time — restoring a 2 MB query body for a tab the
/// user forgot they had open is not worth the startup cost.
pub const MAX_QUERY_BYTES: usize = 64 * 1024;

/// Top-level on-disk shape, v2.
///
/// We keep `#[serde(default)]` on every field so partial blobs (from a
/// hand-edit or an interrupted write) deserialise without errors — bad
/// JSON falls back to `Default::default()` upstream.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PersistedTabState {
    pub version: u32,
    pub workspaces: Vec<Workspace>,
    /// Id of the workspace currently in focus. `None` is valid before
    /// any workspace has been visited; the frontend falls back to the
    /// first entry in `workspaces`.
    pub active_workspace_id: Option<String>,
}

/// One workspace: name, presentation chrome, and the per-connection
/// session state for every connection the user touched while it was
/// active.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    /// Optional accent color (hex, e.g. `"#7c3aed"`). Drives the
    /// workspace-switcher color dot.
    pub color: Option<String>,
    /// Optional lucide icon name (e.g. `"briefcase"`). Validation is
    /// purely cosmetic — unknown names render as the fallback.
    pub icon: Option<String>,
    /// Position in the workspace list. Reordering rewrites every entry
    /// rather than diffing — the list is small and the operation is rare.
    pub order: u32,
    pub connections: HashMap<String, ConnectionTabState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ConnectionTabState {
    pub tabs: Vec<PersistedTab>,
    pub active_tab_id: Option<String>,
    pub expanded_schema_nodes: Vec<String>,
    /// Unix timestamp (seconds) of the last save. Drives LRU pruning.
    pub last_opened: i64,
    /// Opaque dockview `toJSON()` blob describing the workspace's inner
    /// split/float geometry. The backend never interprets it — it round-trips
    /// as a raw JSON value so the frontend can restore the exact pane layout.
    ///
    /// This MUST be a declared field: `save_tab_state` deserializes the IPC
    /// payload into this strongly-typed struct, and `#[serde(default)]` with
    /// no catch-all silently drops any undeclared key, so a "frontend-only"
    /// field would never reach disk.
    pub internal_layout: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PersistedTab {
    pub id: String,
    /// One of "table" | "query". The backend does not interpret this; it
    /// stays a free-form string so the frontend can introduce new tab kinds
    /// without a backend release.
    pub kind: String,
    pub schema: Option<String>,
    pub table: Option<String>,
    pub query: Option<String>,
    pub title: Option<String>,
}

/// Light-weight workspace summary for the UI list. We deliberately
/// omit `connections` so the frontend doesn't drag every cached tab
/// blob across the IPC bridge on every render.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMeta {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub order: u32,
}

impl From<&Workspace> for WorkspaceMeta {
    fn from(w: &Workspace) -> Self {
        Self {
            id: w.id.clone(),
            name: w.name.clone(),
            color: w.color.clone(),
            icon: w.icon.clone(),
            order: w.order,
        }
    }
}

impl Default for PersistedTabState {
    fn default() -> Self {
        // We seed an empty Default workspace so the rest of the code
        // can always assume `workspaces` is non-empty after `load_tab_state`
        // returns. A workspace-less state is conceptually a degenerate
        // case and not worth threading through every accessor.
        let default_ws = Workspace::new_default();
        let id = default_ws.id.clone();
        Self {
            version: CURRENT_VERSION,
            workspaces: vec![default_ws],
            active_workspace_id: Some(id),
        }
    }
}

impl Default for ConnectionTabState {
    fn default() -> Self {
        Self {
            tabs: Vec::new(),
            active_tab_id: None,
            expanded_schema_nodes: Vec::new(),
            last_opened: 0,
            internal_layout: None,
        }
    }
}

impl Default for PersistedTab {
    fn default() -> Self {
        Self {
            id: String::new(),
            kind: "query".into(),
            schema: None,
            table: None,
            query: None,
            title: None,
        }
    }
}

impl Default for Workspace {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            color: None,
            icon: None,
            order: 0,
            connections: HashMap::new(),
        }
    }
}

impl Workspace {
    /// Build a fresh workspace with a UUID-v4 id, the "Default" name
    /// and no tabs. Used both by [`PersistedTabState::default`] and by
    /// the v1→v2 migration to wrap pre-existing connections.
    pub fn new_default() -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Default".into(),
            color: None,
            icon: None,
            order: 0,
            connections: HashMap::new(),
        }
    }

    /// Build a user-created workspace. The id is auto-assigned;
    /// `order` is set by the caller (typically `last + 1` so the new
    /// workspace lands at the end of the list).
    pub fn new(name: String, color: Option<String>, icon: Option<String>, order: u32) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            color,
            icon,
            order,
            connections: HashMap::new(),
        }
    }
}

/// Current on-disk schema version. Bumped on migrations.
const CURRENT_VERSION: u32 = 2;

/// Raw deserialisation target used only by [`load_tab_state`]. It can
/// represent **both** v1 (top-level `connections`) and v2 (nested
/// `workspaces`) shapes, letting us pick the right migration path
/// without two separate `serde_json::from_*` attempts.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RawState {
    version: u32,
    /// v1 only.
    connections: HashMap<String, ConnectionTabState>,
    /// v2 only.
    workspaces: Vec<Workspace>,
    active_workspace_id: Option<String>,
}

impl RawState {
    /// Resolve the raw blob into a fully-shaped `PersistedTabState`,
    /// migrating v1 → v2 in the process.
    fn into_state(self) -> PersistedTabState {
        // Pre-v2 shape: wrap the loose connections in a Default
        // workspace and bump the version. Done in-memory; the new
        // shape is what we persist on the next save.
        if self.version < CURRENT_VERSION {
            let mut ws = Workspace::new_default();
            ws.connections = self.connections;
            let id = ws.id.clone();
            return PersistedTabState {
                version: CURRENT_VERSION,
                workspaces: vec![ws],
                active_workspace_id: Some(id),
            };
        }

        // Already v2 but possibly empty (fresh file, partial write).
        // Seed a Default workspace so callers can always rely on
        // `workspaces` being non-empty — see [`PersistedTabState::default`].
        if self.workspaces.is_empty() {
            return PersistedTabState::default();
        }

        let active = self
            .active_workspace_id
            .filter(|id| self.workspaces.iter().any(|w| &w.id == id))
            .or_else(|| self.workspaces.first().map(|w| w.id.clone()));

        PersistedTabState {
            version: CURRENT_VERSION,
            workspaces: self.workspaces,
            active_workspace_id: active,
        }
    }
}

impl PersistedTabState {
    /// Return the workspace currently in focus, falling back to the
    /// first workspace when `active_workspace_id` is stale or absent.
    pub fn active_workspace(&self) -> &Workspace {
        if let Some(id) = &self.active_workspace_id {
            if let Some(w) = self.workspaces.iter().find(|w| &w.id == id) {
                return w;
            }
        }
        self.workspaces
            .first()
            .expect("invariant: workspaces is non-empty post-load")
    }

    /// Mutable counterpart of [`Self::active_workspace`].
    pub fn active_workspace_mut(&mut self) -> &mut Workspace {
        // We avoid the obvious `find` + early-return because the
        // borrow checker doesn't let us downgrade the index-by-id
        // lookup into a separate mutable borrow without an explicit
        // index. Computing the index first sidesteps the conflict.
        let idx = self
            .active_workspace_id
            .as_ref()
            .and_then(|id| self.workspaces.iter().position(|w| &w.id == id))
            .unwrap_or(0);
        &mut self.workspaces[idx]
    }

    /// Drop the oldest connections beyond [`MAX_REMEMBERED_CONNECTIONS`]
    /// **within each workspace**. We prune per-workspace rather than
    /// globally so a busy workspace doesn't evict another workspace's
    /// long-lived entries.
    pub fn prune(&mut self) {
        for ws in &mut self.workspaces {
            if ws.connections.len() <= MAX_REMEMBERED_CONNECTIONS {
                continue;
            }
            let mut ordered: Vec<(String, i64)> = ws
                .connections
                .iter()
                .map(|(id, s)| (id.clone(), s.last_opened))
                .collect();
            // Highest `last_opened` first; keep the head.
            ordered.sort_by(|a, b| b.1.cmp(&a.1));
            for (id, _) in ordered.into_iter().skip(MAX_REMEMBERED_CONNECTIONS) {
                ws.connections.remove(&id);
            }
        }
    }

    /// Lightweight summaries for the workspace switcher, sorted by `order`.
    pub fn workspace_metas(&self) -> Vec<WorkspaceMeta> {
        let mut metas: Vec<WorkspaceMeta> = self.workspaces.iter().map(Into::into).collect();
        metas.sort_by_key(|m| m.order);
        metas
    }

    /// Compute the next free `order` value (used when creating a new
    /// workspace so it lands at the end of the list).
    fn next_order(&self) -> u32 {
        self.workspaces
            .iter()
            .map(|w| w.order)
            .max()
            .map(|v| v + 1)
            .unwrap_or(0)
    }
}

/// Truncate oversized query bodies before persisting.
fn normalise(state: &mut ConnectionTabState) {
    for tab in &mut state.tabs {
        if let Some(q) = &tab.query {
            if q.len() > MAX_QUERY_BYTES {
                eprintln!(
                    "[tab_state] dropping oversize query body for tab {} ({} bytes)",
                    tab.id,
                    q.len()
                );
                tab.query = None;
            }
        }
    }
}

fn tab_state_path() -> AppResult<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| AppError::InvalidInput("no config dir available".into()))?;
    let dir = base.join(APP_DIR);
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(TAB_STATE_FILE))
}

/// Load persisted tab state, transparently migrating v1 blobs.
///
/// Falls back to an empty (but valid) container on missing or corrupt
/// files so a bad blob never blocks startup.
pub fn load_tab_state() -> PersistedTabState {
    let path = match tab_state_path() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[tab_state] cannot resolve path: {e}; using empty state");
            return PersistedTabState::default();
        }
    };
    if !path.exists() {
        return PersistedTabState::default();
    }
    match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<RawState>(&bytes) {
            Ok(raw) => raw.into_state(),
            Err(e) => {
                eprintln!("[tab_state] failed to parse {path:?}: {e}; using empty state");
                PersistedTabState::default()
            }
        },
        Err(e) => {
            eprintln!("[tab_state] failed to read {path:?}: {e}; using empty state");
            PersistedTabState::default()
        }
    }
}

/// Persist the tab state blob atomically.
pub fn save_tab_state(state: &PersistedTabState) -> AppResult<()> {
    let path = tab_state_path()?;
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(state)?;
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Workspace mutation helpers. These run on the live in-memory state — the
// command layer is responsible for persisting afterwards.
// ---------------------------------------------------------------------------

impl PersistedTabState {
    /// Append a new workspace at the end of the list and return its meta.
    pub fn create_workspace(
        &mut self,
        name: String,
        color: Option<String>,
        icon: Option<String>,
    ) -> WorkspaceMeta {
        let order = self.next_order();
        let ws = Workspace::new(name, color, icon, order);
        let meta = WorkspaceMeta::from(&ws);
        self.workspaces.push(ws);
        meta
    }

    /// Rename an existing workspace. Returns an error if the id doesn't exist.
    pub fn rename_workspace(&mut self, id: &str, name: String) -> AppResult<()> {
        let ws = self
            .workspaces
            .iter_mut()
            .find(|w| w.id == id)
            .ok_or_else(|| AppError::InvalidInput(format!("workspace {id} not found")))?;
        ws.name = name;
        Ok(())
    }

    /// Update the optional color / icon of a workspace.
    pub fn update_workspace_appearance(
        &mut self,
        id: &str,
        color: Option<String>,
        icon: Option<String>,
    ) -> AppResult<()> {
        let ws = self
            .workspaces
            .iter_mut()
            .find(|w| w.id == id)
            .ok_or_else(|| AppError::InvalidInput(format!("workspace {id} not found")))?;
        ws.color = color;
        ws.icon = icon;
        Ok(())
    }

    /// Delete a workspace. Refuses to remove the last remaining
    /// workspace so the rest of the app can always assume one exists.
    pub fn delete_workspace(&mut self, id: &str) -> AppResult<()> {
        if self.workspaces.len() <= 1 {
            return Err(AppError::InvalidInput(
                "cannot delete the only workspace".into(),
            ));
        }
        let idx = self
            .workspaces
            .iter()
            .position(|w| w.id == id)
            .ok_or_else(|| AppError::InvalidInput(format!("workspace {id} not found")))?;
        self.workspaces.remove(idx);
        // If the user deleted the active workspace, focus the first
        // remaining one. The `unwrap` is safe — we just guaranteed
        // there's at least one workspace left.
        if self.active_workspace_id.as_deref() == Some(id) {
            self.active_workspace_id = Some(self.workspaces[0].id.clone());
        }
        Ok(())
    }

    /// Re-assign `order` to match the supplied array. Workspaces not
    /// mentioned keep their existing order and end up after the listed
    /// ones; that's a defensive convenience and not a feature.
    pub fn reorder_workspaces(&mut self, ids: &[String]) -> AppResult<()> {
        // Validate up front so a typo doesn't half-apply.
        for id in ids {
            if !self.workspaces.iter().any(|w| &w.id == id) {
                return Err(AppError::InvalidInput(format!("workspace {id} not found")));
            }
        }
        let listed: u32 = ids.len() as u32;
        for (i, id) in ids.iter().enumerate() {
            if let Some(w) = self.workspaces.iter_mut().find(|w| &w.id == id) {
                w.order = i as u32;
            }
        }
        // Any workspace not in `ids` (shouldn't normally happen, but
        // defensive against the frontend losing one) is pushed to the
        // tail in its original relative order.
        let mut leftovers: Vec<&mut Workspace> = self
            .workspaces
            .iter_mut()
            .filter(|w| !ids.iter().any(|id| id == &w.id))
            .collect();
        leftovers.sort_by_key(|w| w.order);
        for (offset, w) in leftovers.into_iter().enumerate() {
            w.order = listed + offset as u32;
        }
        Ok(())
    }

    /// Switch the active workspace. Errors if the id is unknown so a
    /// stale frontend never silently lands the user on the wrong
    /// workspace.
    pub fn set_active_workspace(&mut self, id: &str) -> AppResult<()> {
        if !self.workspaces.iter().any(|w| w.id == id) {
            return Err(AppError::InvalidInput(format!("workspace {id} not found")));
        }
        self.active_workspace_id = Some(id.to_string());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(last_opened: i64) -> ConnectionTabState {
        ConnectionTabState {
            last_opened,
            ..ConnectionTabState::default()
        }
    }

    #[test]
    fn prune_keeps_most_recent_connections_per_workspace() {
        let mut state = PersistedTabState::default();
        let ws = state.active_workspace_mut();
        for i in 0..(MAX_REMEMBERED_CONNECTIONS as i64 + 5) {
            ws.connections.insert(format!("c{i}"), entry(i));
        }
        state.prune();
        let ws = state.active_workspace();
        assert_eq!(ws.connections.len(), MAX_REMEMBERED_CONNECTIONS);
        assert!(!ws.connections.contains_key("c0"));
        assert!(ws
            .connections
            .contains_key(&format!("c{}", MAX_REMEMBERED_CONNECTIONS as i64 + 4)));
    }

    #[test]
    fn normalise_drops_oversize_query_bodies() {
        let mut state = ConnectionTabState::default();
        state.tabs.push(PersistedTab {
            id: "t1".into(),
            kind: "query".into(),
            query: Some("x".repeat(MAX_QUERY_BYTES + 1)),
            ..PersistedTab::default()
        });
        state.tabs.push(PersistedTab {
            id: "t2".into(),
            kind: "query".into(),
            query: Some("ok".into()),
            ..PersistedTab::default()
        });
        normalise(&mut state);
        assert!(state.tabs[0].query.is_none());
        assert_eq!(state.tabs[1].query.as_deref(), Some("ok"));
    }

    #[test]
    fn v1_blob_migrates_into_default_workspace() {
        // Minimal v1 fixture: top-level `connections`, no `workspaces`.
        let v1 = r#"{ "version": 1, "connections": { "abc": { "tabs": [] } } }"#;
        let raw: RawState = serde_json::from_str(v1).unwrap();
        let state = raw.into_state();
        assert_eq!(state.version, CURRENT_VERSION);
        assert_eq!(state.workspaces.len(), 1);
        assert_eq!(state.workspaces[0].name, "Default");
        assert!(state.workspaces[0].connections.contains_key("abc"));
        assert_eq!(
            state.active_workspace_id,
            Some(state.workspaces[0].id.clone())
        );
    }

    #[test]
    fn empty_v2_file_seeds_default_workspace() {
        let empty = r#"{ "version": 2 }"#;
        let raw: RawState = serde_json::from_str(empty).unwrap();
        let state = raw.into_state();
        assert_eq!(state.workspaces.len(), 1);
        assert_eq!(state.workspaces[0].name, "Default");
    }

    #[test]
    fn create_rename_delete_workspace_round_trip() {
        let mut state = PersistedTabState::default();
        let new = state.create_workspace("Trabajo".into(), Some("#7c3aed".into()), None);
        assert_eq!(state.workspaces.len(), 2);
        state.rename_workspace(&new.id, "Curro".into()).unwrap();
        assert_eq!(
            state
                .workspaces
                .iter()
                .find(|w| w.id == new.id)
                .unwrap()
                .name,
            "Curro"
        );
        state.delete_workspace(&new.id).unwrap();
        assert_eq!(state.workspaces.len(), 1);
    }

    #[test]
    fn cannot_delete_only_workspace() {
        let mut state = PersistedTabState::default();
        let id = state.workspaces[0].id.clone();
        assert!(state.delete_workspace(&id).is_err());
    }

    #[test]
    fn reorder_assigns_indices_in_supplied_order() {
        let mut state = PersistedTabState::default();
        let a = state.create_workspace("A".into(), None, None);
        let b = state.create_workspace("B".into(), None, None);
        // Reverse order.
        state
            .reorder_workspaces(&[b.id.clone(), a.id.clone()])
            .unwrap();
        let metas = state.workspace_metas();
        assert_eq!(metas[0].id, b.id);
        assert_eq!(metas[1].id, a.id);
    }

    #[test]
    fn delete_active_workspace_focuses_first_remaining() {
        let mut state = PersistedTabState::default();
        let new = state.create_workspace("Other".into(), None, None);
        state.set_active_workspace(&new.id).unwrap();
        state.delete_workspace(&new.id).unwrap();
        assert_eq!(
            state.active_workspace_id,
            Some(state.workspaces[0].id.clone())
        );
    }
}

/// Re-export the normalisation hook so command handlers can call it before
/// writing user-supplied state.
pub fn normalise_for_save(state: &mut ConnectionTabState) {
    normalise(state);
}
