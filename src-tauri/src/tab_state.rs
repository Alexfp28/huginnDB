//! Persisted per-connection session state (open tabs, active tab,
//! schema-tree expansion, dockview geometry).
//!
//! The on-disk blob (`tab_state.json`) is a flat map of connection id →
//! [`ConnectionTabState`], alongside a `version` field to drive forward
//! migrations. There is exactly one persisted state, owned by the main
//! window — secondary windows opened via "New window" never read or write
//! it (see `src/stores/persistedTabs.ts`), which is what makes them
//! ephemeral: closing them loses their tabs, same as any in-memory UI state.
//!
//! ## History
//!
//! - **v1**: top-level `connections: HashMap<id, ConnectionTabState>`.
//! - **v2**: introduced "workspaces" (each owning its own `connections`
//!   map) as a stand-in for real per-window instances. Removed in v3 once
//!   native multi-window support landed — workspaces were never anything
//!   more than that stand-in.
//! - **v3** (current): back to a flat `connections` map, structurally
//!   identical to v1. On migration from v2, only the **active** workspace's
//!   connections survive; every other workspace is discarded (confirmed
//!   product decision — there is no "merge" semantics to preserve).
//!
//! The `connections` map is LRU-pruned to [`MAX_REMEMBERED_CONNECTIONS`].
//! Query bodies inside tabs are capped at [`MAX_QUERY_BYTES`]; oversized
//! bodies are saved empty.

use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

const TAB_STATE_FILE: &str = "tab_state.json";
/// Aliased from [`crate::app_identity`] so a `canary` build isolates its state.
const APP_DIR: &str = crate::app_identity::APP_DIR;

/// Soft cap on how many connections are remembered. Older entries (by
/// `last_opened`) get pruned at save time.
pub const MAX_REMEMBERED_CONNECTIONS: usize = 20;

/// Soft cap on a single tab's query body. Anything larger is truncated
/// to `None` at save time — restoring a 2 MB query body for a tab the
/// user forgot they had open is not worth the startup cost.
pub const MAX_QUERY_BYTES: usize = 64 * 1024;

/// Top-level on-disk shape, v3.
///
/// We keep `#[serde(default)]` on every field so partial blobs (from a
/// hand-edit or an interrupted write) deserialise without errors — bad
/// JSON falls back to `Default::default()` upstream.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PersistedTabState {
    pub version: u32,
    pub connections: HashMap<String, ConnectionTabState>,
    /// Session-level inner-dockview geometry (the workspace's split/float
    /// arrangement). Opaque dockview `toJSON()` blob; the backend never
    /// interprets it.
    ///
    /// This is deliberately **top-level**, not per-connection: the inner
    /// dockview is a single shared instance that hosts tabs from *every*
    /// open connection at once, so its geometry is a property of the
    /// session, not of any one connection. It used to live inside each
    /// `ConnectionTabState` (see that field's note), which duplicated the
    /// same blob under every connection and made restore order-dependent —
    /// whichever connection hydrated first won. `None`/absent means the
    /// default tabbed layout.
    pub internal_layout: Option<serde_json::Value>,
    /// Connection ids that were live in the main window when it last closed.
    /// Used to auto-reconnect them on the next launch (gated on the
    /// `reconnectOnLaunch` preference). Stale ids (profile since deleted)
    /// are harmless — the reconnect step skips any id with no profile.
    pub active_connections: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ConnectionTabState {
    pub tabs: Vec<PersistedTab>,
    pub active_tab_id: Option<String>,
    pub expanded_schema_nodes: Vec<String>,
    /// Unix timestamp (seconds) of the last save. Drives LRU pruning.
    pub last_opened: i64,
    /// **Deprecated.** Legacy per-connection copy of the inner-dockview
    /// geometry. As of the session-level layout refactor the geometry lives
    /// in [`PersistedTabState::internal_layout`] instead; the frontend no
    /// longer writes this field. It is kept declared only so that (a) old
    /// blobs still deserialise, and (b) [`RawState::into_state`] can hoist a
    /// legacy value up to the top level on first load after upgrading. New
    /// saves always leave it `None`.
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
    /// User-assigned cosmetic tab colour (hex string). Stored opaquely; the
    /// backend never interprets it. Must live here or serde drops it on the
    /// typed IPC boundary (see CLAUDE.md gotcha #14).
    pub color: Option<String>,
    /// Whether the tab was pinned. Same IPC-boundary rule as `color` — the
    /// field must exist on the struct or serde drops it on save.
    pub pinned: Option<bool>,
}

impl Default for PersistedTabState {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            connections: HashMap::new(),
            internal_layout: None,
            active_connections: Vec::new(),
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
            color: None,
            pinned: None,
        }
    }
}

/// Current on-disk schema version. Bumped on migrations.
const CURRENT_VERSION: u32 = 3;

/// Raw deserialisation target used only by [`load_tab_state`]. It can
/// represent v1 (top-level `connections`), v2 (nested `workspaces`), and v3
/// (top-level `connections`, same as v1) shapes, letting us pick the right
/// migration path without separate `serde_json::from_*` attempts.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RawState {
    version: u32,
    /// v1 and v3.
    connections: HashMap<String, ConnectionTabState>,
    /// v2 only.
    workspaces: Vec<RawWorkspace>,
    /// v2 only.
    active_workspace_id: Option<String>,
    /// v3 (session-level layout refactor onward).
    internal_layout: Option<serde_json::Value>,
    /// v3 (auto-reconnect-on-launch onward).
    active_connections: Vec<String>,
}

/// Just enough of the removed v2 `Workspace` shape to migrate it — we don't
/// need `name`/`color`/`icon`/`order`, only the connections map and id.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RawWorkspace {
    id: String,
    connections: HashMap<String, ConnectionTabState>,
}

impl RawState {
    /// Resolve the raw blob into a fully-shaped `PersistedTabState`,
    /// migrating v1/v2 → v3 in the process.
    fn into_state(self) -> PersistedTabState {
        let active_connections = self.active_connections;
        let top_level_layout = self.internal_layout;

        // v2: discard every workspace except the active one (or the first,
        // if the active id is stale/absent).
        let connections = if !self.workspaces.is_empty() {
            let active = self
                .active_workspace_id
                .as_ref()
                .and_then(|id| self.workspaces.iter().find(|w| &w.id == id))
                .or_else(|| self.workspaces.first());
            active.map(|w| w.connections.clone()).unwrap_or_default()
        } else {
            // v1 or v3: already flat.
            self.connections
        };

        // The inner-dockview geometry used to live per-connection (the same
        // blob duplicated under every connection). On the first load after
        // upgrading, the top-level field is absent, so hoist the geometry
        // from the most-recently-opened connection that still carries one —
        // that best reflects the session the user last saw. New saves write
        // the top-level field and leave the per-connection copies `None`.
        let internal_layout = top_level_layout.or_else(|| hoist_legacy_layout(&connections));

        PersistedTabState {
            version: CURRENT_VERSION,
            connections,
            internal_layout,
            active_connections,
        }
    }
}

/// Pick the inner-dockview geometry to promote to the top level from a set of
/// legacy per-connection blobs: the one belonging to the connection with the
/// highest `last_opened` that actually carries a layout. Returns `None` when
/// no connection has a legacy layout (the common case for fresh blobs).
fn hoist_legacy_layout(
    connections: &HashMap<String, ConnectionTabState>,
) -> Option<serde_json::Value> {
    connections
        .values()
        .filter(|c| c.internal_layout.is_some())
        .max_by_key(|c| c.last_opened)
        .and_then(|c| c.internal_layout.clone())
}

impl PersistedTabState {
    /// Drop the oldest connections beyond [`MAX_REMEMBERED_CONNECTIONS`].
    pub fn prune(&mut self) {
        if self.connections.len() <= MAX_REMEMBERED_CONNECTIONS {
            return;
        }
        let mut ordered: Vec<(String, i64)> = self
            .connections
            .iter()
            .map(|(id, s)| (id.clone(), s.last_opened))
            .collect();
        // Highest `last_opened` first; keep the head.
        ordered.sort_by(|a, b| b.1.cmp(&a.1));
        for (id, _) in ordered.into_iter().skip(MAX_REMEMBERED_CONNECTIONS) {
            self.connections.remove(&id);
        }
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
        .ok_or_else(|| crate::error::AppError::InvalidInput("no config dir available".into()))?;
    let dir = base.join(APP_DIR);
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(TAB_STATE_FILE))
}

/// Load persisted tab state, transparently migrating v1/v2 blobs.
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
    fn prune_keeps_most_recent_connections() {
        let mut state = PersistedTabState::default();
        for i in 0..(MAX_REMEMBERED_CONNECTIONS as i64 + 5) {
            state.connections.insert(format!("c{i}"), entry(i));
        }
        state.prune();
        assert_eq!(state.connections.len(), MAX_REMEMBERED_CONNECTIONS);
        assert!(!state.connections.contains_key("c0"));
        assert!(state
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
    fn v1_blob_migrates_to_v3_flat_map() {
        let v1 = r#"{ "version": 1, "connections": { "abc": { "tabs": [] } } }"#;
        let raw: RawState = serde_json::from_str(v1).unwrap();
        let state = raw.into_state();
        assert_eq!(state.version, CURRENT_VERSION);
        assert!(state.connections.contains_key("abc"));
    }

    #[test]
    fn v2_blob_discards_non_active_workspaces() {
        let v2 = r#"{
            "version": 2,
            "activeWorkspaceId": "active-id",
            "workspaces": [
                { "id": "active-id", "connections": { "keep": { "tabs": [] } } },
                { "id": "other-id", "connections": { "drop": { "tabs": [] } } }
            ]
        }"#;
        let raw: RawState = serde_json::from_str(v2).unwrap();
        let state = raw.into_state();
        assert_eq!(state.version, CURRENT_VERSION);
        assert!(state.connections.contains_key("keep"));
        assert!(!state.connections.contains_key("drop"));
    }

    #[test]
    fn v2_blob_with_stale_active_id_falls_back_to_first_workspace() {
        let v2 = r#"{
            "version": 2,
            "activeWorkspaceId": "does-not-exist",
            "workspaces": [
                { "id": "first-id", "connections": { "keep": { "tabs": [] } } }
            ]
        }"#;
        let raw: RawState = serde_json::from_str(v2).unwrap();
        let state = raw.into_state();
        assert!(state.connections.contains_key("keep"));
    }

    #[test]
    fn empty_v3_file_yields_empty_map() {
        let empty = r#"{ "version": 3 }"#;
        let raw: RawState = serde_json::from_str(empty).unwrap();
        let state = raw.into_state();
        assert!(state.connections.is_empty());
        assert!(state.internal_layout.is_none());
        assert!(state.active_connections.is_empty());
    }

    #[test]
    fn legacy_per_connection_layout_hoisted_from_most_recent() {
        // No top-level `internalLayout`; two connections each carry a legacy
        // per-connection one. The newer connection's layout wins.
        let blob = r#"{
            "version": 3,
            "connections": {
                "old": { "tabs": [], "lastOpened": 10, "internalLayout": {"pick": "old"} },
                "new": { "tabs": [], "lastOpened": 20, "internalLayout": {"pick": "new"} }
            }
        }"#;
        let raw: RawState = serde_json::from_str(blob).unwrap();
        let state = raw.into_state();
        assert_eq!(
            state.internal_layout,
            Some(serde_json::json!({ "pick": "new" }))
        );
    }

    #[test]
    fn top_level_layout_wins_over_legacy_per_connection() {
        // A blob written by the new code path: top-level layout present, and a
        // stale legacy per-connection copy still on disk. The top-level one is
        // authoritative and must not be overwritten by the hoist.
        let blob = r#"{
            "version": 3,
            "internalLayout": {"pick": "top"},
            "connections": {
                "c": { "tabs": [], "lastOpened": 99, "internalLayout": {"pick": "legacy"} }
            }
        }"#;
        let raw: RawState = serde_json::from_str(blob).unwrap();
        let state = raw.into_state();
        assert_eq!(
            state.internal_layout,
            Some(serde_json::json!({ "pick": "top" }))
        );
    }

    #[test]
    fn active_connections_round_trip() {
        let blob = r#"{ "version": 3, "activeConnections": ["a", "b"] }"#;
        let raw: RawState = serde_json::from_str(blob).unwrap();
        let state = raw.into_state();
        assert_eq!(state.active_connections, vec!["a", "b"]);
    }
}

/// Re-export the normalisation hook so command handlers can call it before
/// writing user-supplied state.
pub fn normalise_for_save(state: &mut ConnectionTabState) {
    normalise(state);
}
