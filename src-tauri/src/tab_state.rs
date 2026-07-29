//! Persisted session state: environments, and per connection within each one
//! the open tabs, active tab, schema-tree expansion and dockview geometry.
//!
//! The on-disk blob (`tab_state.json`) is a list of [`Environment`]s plus which
//! one is active, alongside a `version` field to drive forward migrations. There
//! is exactly one persisted state, owned by the main window — secondary windows
//! opened via "New window" never read or write it (see
//! `src/stores/persistedTabs.ts`), which is what makes them ephemeral: closing
//! them loses their tabs, same as any in-memory UI state. The active environment
//! is main-window-owned for the same reason.
//!
//! ## History
//!
//! - **v1**: top-level `connections: HashMap<id, ConnectionTabState>`.
//! - **v2**: introduced "workspaces" (each owning its own `connections`
//!   map) as a stand-in for real per-window instances. Removed in v3 once
//!   native multi-window support landed — workspaces were never anything
//!   more than that stand-in.
//! - **v3**: back to a flat `connections` map, structurally identical to v1,
//!   with the dockview geometry and the launch-restore trio hoisted to the top
//!   level. On migration from v2, only the **active** workspace's connections
//!   survive; every other workspace is discarded (confirmed product decision —
//!   there is no "merge" semantics to preserve).
//! - **v4** (current): a list of [`Environment`]s, each owning its own
//!   `connections` map, dockview geometry and [`LaunchState`]. Any earlier blob
//!   folds into a single unnamed environment, so an upgrade is lossless and the
//!   user sees exactly the session they left.
//!
//!   This is a multi-bucket top-level shape again, which v3 removed on purpose —
//!   see [`Environment`] for why an environment is a different thing from a v2
//!   workspace, and CLAUDE.md gotchas #8 and #10.
//!
//! Each environment's `connections` map is LRU-pruned to
//! [`MAX_REMEMBERED_CONNECTIONS`] independently. Query bodies inside tabs are
//! capped at [`MAX_QUERY_BYTES`]; oversized bodies are saved empty.

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

/// Id given to the single environment a pre-v4 blob migrates into, and to the
/// one a fresh install starts with. Deterministic rather than a fresh UUID so
/// the migration is reproducible and testable.
pub const DEFAULT_ENVIRONMENT_ID: &str = "default";

/// Top-level on-disk shape, v4.
///
/// We keep `#[serde(default)]` on every field so partial blobs (from a
/// hand-edit or an interrupted write) deserialise without errors — bad
/// JSON falls back to `Default::default()` upstream.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PersistedTabState {
    pub version: u32,
    /// Every environment the user has defined, in display order. Never empty
    /// once loaded: [`RawState::into_state`] synthesises one from a legacy blob
    /// and [`PersistedTabState::active_environment_mut`] recreates one if the
    /// list is somehow emptied.
    pub environments: Vec<Environment>,
    /// Which environment the main window is currently in. Validated on load —
    /// an id pointing at no environment falls back to the first.
    pub active_environment_id: Option<String>,
}

/// One environment: a named set of connections plus the whole session state
/// that belongs to them (open tabs, pane geometry, what to reconnect at
/// launch).
///
/// This reintroduces a multi-bucket top-level shape that v3 deliberately
/// removed, and the distinction matters. The v2 "workspaces" were a stand-in
/// for real per-window instances, which is why native multi-window made them
/// redundant. An environment is not that: it is an *identity* — which subset of
/// the user's connections is in play, and (from the next phase) where those
/// connections came from — so switching one swaps the whole working set rather
/// than just re-arranging tabs. See CLAUDE.md gotchas #8 and #10.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    /// User-assigned label. **Empty means "not named by the user"**, and the
    /// frontend renders a localised default for it. The migrated/initial
    /// environment is created empty on purpose: a name written here would bake
    /// one language into the user's data forever, and the backend has no
    /// business choosing display copy (see the language notes in CLAUDE.md).
    pub name: String,
    /// Cosmetic accent colour (hex) and icon id, both stored opaquely — the
    /// backend never interprets them, matching `PersistedTab::color`.
    pub color: Option<String>,
    pub icon: Option<String>,
    /// Display order in the switcher. Ties fall back to position in the vector.
    pub order: i32,
    /// Per-connection tab state, LRU-pruned to [`MAX_REMEMBERED_CONNECTIONS`]
    /// *within this environment* rather than globally, so a busy environment
    /// can't evict a quiet one's tabs.
    pub connections: HashMap<String, ConnectionTabState>,
    /// Inner-dockview geometry (the split/float arrangement). Opaque dockview
    /// `toJSON()` blob; the backend never interprets it.
    ///
    /// Scoped to the environment, not to a connection: one inner dockview hosts
    /// the tabs of *every* connection open at once, so its geometry is a
    /// property of the session — and a session now belongs to an environment.
    /// It used to live inside each `ConnectionTabState` (see that field's note),
    /// which duplicated the same blob under every connection and made restore
    /// order-dependent. `None`/absent means the default tabbed layout.
    pub internal_layout: Option<serde_json::Value>,
    /// What to restore when this environment is entered — at launch or on a
    /// switch.
    pub launch: LaunchState,
}

/// The state needed to put a session back the way the user left it: which
/// connections were live, which one had focus, and which tab was showing.
///
/// Lives here (not in `commands::prefs`, where the DTO of the same shape used
/// to be declared) because it is persisted state; the command layer now reuses
/// this type instead of keeping a parallel copy in sync.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LaunchState {
    /// Connection ids that were live in the main window when it last closed.
    /// Used to auto-reconnect them (gated on the `reconnectOnLaunch`
    /// preference). Stale ids (profile since deleted) are harmless — the
    /// reconnect step skips any id with no profile.
    pub active_connections: Vec<String>,
    /// The connection the schema explorer / status bar was focused on
    /// (`useUi.selectedConnectionId`). Restored after auto-reconnect so the
    /// same connection is in focus, instead of whichever pool happened to open
    /// first. `None` if nothing was selected.
    pub selected_connection_id: Option<String>,
    /// The globally-active tab id (`useTabs.activeId`). Restored after
    /// auto-reconnect so the same tab body is shown. `None` if no tab was open.
    pub active_tab_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
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
    /// Table-tab view state (#112): the structured column filters, the
    /// multi-level sort, and the committed free-text search. `None` on a query
    /// tab, which has none of them.
    ///
    /// Stored opaquely as `serde_json::Value` rather than as
    /// `Vec<commands::query::ColumnFilter>`: those types are `Deserialize`-only
    /// (they are command *inputs*), and persistence needs to serialise them back
    /// out too. Adding `Serialize` there would let a filter's internal shape leak
    /// into the on-disk format, so this module keeps them as inert blobs — the
    /// same treatment as `internal_layout`, and consistent with the rule that the
    /// backend doesn't interpret view state.
    ///
    /// Declared here because the field would otherwise never survive: serde
    /// silently drops unknown keys at the typed IPC boundary, so a
    /// "frontend-only" field vanishes before it reaches disk (gotcha #14).
    pub filters: Option<serde_json::Value>,
    pub sort: Option<serde_json::Value>,
    pub search: Option<String>,
}

impl Environment {
    /// The environment a fresh install starts with, and the one a legacy blob is
    /// folded into. Unnamed on purpose — see the `name` field.
    fn initial() -> Self {
        Self {
            id: DEFAULT_ENVIRONMENT_ID.to_string(),
            ..Self::default()
        }
    }
}

impl Default for PersistedTabState {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            environments: vec![Environment::initial()],
            active_environment_id: Some(DEFAULT_ENVIRONMENT_ID.to_string()),
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
            filters: None,
            sort: None,
            search: None,
        }
    }
}

/// Current on-disk schema version. Bumped on migrations.
const CURRENT_VERSION: u32 = 4;

/// Raw deserialisation target used only by [`load_tab_state`]. It can
/// represent v1 (top-level `connections`), v2 (nested `workspaces`), v3
/// (top-level `connections`, same as v1) and v4 (`environments`) shapes,
/// letting us pick the right migration path without separate
/// `serde_json::from_*` attempts.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RawState {
    version: u32,
    /// v4. Non-empty here short-circuits every legacy path below.
    environments: Vec<Environment>,
    /// v4.
    active_environment_id: Option<String>,
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
    /// v3 (launch-focus restore onward).
    selected_connection_id: Option<String>,
    /// v3 (launch-focus restore onward).
    active_tab_id: Option<String>,
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
    /// migrating v1/v2/v3 → v4 in the process.
    fn into_state(self) -> PersistedTabState {
        // v4: already in the new shape. Only the active id needs validating —
        // an environment could have been deleted by another (older) build, or
        // the file hand-edited.
        if !self.environments.is_empty() {
            let active = self
                .active_environment_id
                .filter(|id| self.environments.iter().any(|e| &e.id == id))
                .or_else(|| self.environments.first().map(|e| e.id.clone()));
            return PersistedTabState {
                version: CURRENT_VERSION,
                environments: self.environments,
                active_environment_id: active,
            };
        }

        let launch = LaunchState {
            active_connections: self.active_connections,
            selected_connection_id: self.selected_connection_id,
            active_tab_id: self.active_tab_id,
        };
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
        // that best reflects the session the user last saw. New saves write it
        // on the environment and leave the per-connection copies `None`.
        let internal_layout = top_level_layout.or_else(|| hoist_legacy_layout(&connections));

        // v1/v2/v3 → a single environment holding the whole previous session.
        // Unnamed, so the frontend labels it in the user's language.
        PersistedTabState {
            version: CURRENT_VERSION,
            environments: vec![Environment {
                connections,
                internal_layout,
                launch,
                ..Environment::initial()
            }],
            active_environment_id: Some(DEFAULT_ENVIRONMENT_ID.to_string()),
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
    /// The active environment, creating one if the list is empty and repairing
    /// a stale `active_environment_id` in passing.
    ///
    /// Every command that reads or writes session state goes through this, so
    /// the invariant "there is always exactly one active environment" is
    /// enforced in one place rather than defended at each call site.
    pub fn active_environment_mut(&mut self) -> &mut Environment {
        if self.environments.is_empty() {
            self.environments.push(Environment::initial());
        }
        let idx = self
            .active_environment_id
            .as_ref()
            .and_then(|id| self.environments.iter().position(|e| &e.id == id))
            .unwrap_or(0);
        // Re-anchor the id: it was either absent or pointing at a deleted
        // environment, and leaving it dangling would re-run this fallback (and
        // possibly land elsewhere) on the next call.
        self.active_environment_id = Some(self.environments[idx].id.clone());
        &mut self.environments[idx]
    }

    /// Read-only counterpart. Returns `None` only for a blob that has not been
    /// through [`RawState::into_state`] (which always leaves one environment).
    pub fn active_environment(&self) -> Option<&Environment> {
        self.active_environment_id
            .as_ref()
            .and_then(|id| self.environments.iter().find(|e| &e.id == id))
            .or_else(|| self.environments.first())
    }

    /// Drop each environment's oldest connections beyond
    /// [`MAX_REMEMBERED_CONNECTIONS`].
    ///
    /// The cap is per environment, not global: environments are meant to be
    /// long-lived working sets, and a global cap would let a busy one silently
    /// evict the tabs of one the user hasn't opened in a while — the opposite of
    /// what keeping them apart is for.
    pub fn prune(&mut self) {
        for env in &mut self.environments {
            env.prune();
        }
    }
}

impl Environment {
    /// Drop the oldest connections beyond [`MAX_REMEMBERED_CONNECTIONS`].
    fn prune(&mut self) {
        if self.connections.len() <= MAX_REMEMBERED_CONNECTIONS {
            return;
        }
        let mut ordered: Vec<(String, i64)> = self
            .connections
            .iter()
            .map(|(id, s)| (id.clone(), s.last_opened))
            .collect();
        // Highest `last_opened` first; keep the head. The id is a tie-breaker
        // and it is load-bearing, not cosmetic: entries sharing a timestamp —
        // notably `0`, the default for a v1 blob and for any partially written
        // entry — would otherwise be ordered by `HashMap` iteration, which
        // varies per run, so *which* connections survived a prune was
        // nondeterministic.
        ordered.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        for (id, _) in ordered.into_iter().skip(MAX_REMEMBERED_CONNECTIONS) {
            self.connections.remove(&id);
        }
    }
}

/// Truncate oversized query bodies before persisting. Command handlers call
/// this on user-supplied state before it reaches [`save_tab_state`].
pub(crate) fn normalise(state: &mut ConnectionTabState) {
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

    /// The single environment a migrated legacy blob produces. Panics rather
    /// than returning an Option: every migration path must yield exactly one,
    /// and a test asserting on the wrong count should fail loudly here.
    fn sole_env(state: &PersistedTabState) -> &Environment {
        assert_eq!(
            state.environments.len(),
            1,
            "expected exactly one migrated environment"
        );
        &state.environments[0]
    }

    #[test]
    fn prune_keeps_most_recent_connections() {
        let mut state = PersistedTabState::default();
        for i in 0..(MAX_REMEMBERED_CONNECTIONS as i64 + 5) {
            state
                .active_environment_mut()
                .connections
                .insert(format!("c{i}"), entry(i));
        }
        state.prune();
        let env = sole_env(&state);
        assert_eq!(env.connections.len(), MAX_REMEMBERED_CONNECTIONS);
        assert!(!env.connections.contains_key("c0"));
        assert!(env
            .connections
            .contains_key(&format!("c{}", MAX_REMEMBERED_CONNECTIONS as i64 + 4)));
    }

    #[test]
    fn prune_is_per_environment_not_global() {
        // The cap applies within each environment: a busy one must not evict a
        // quiet one's tabs, which is the point of keeping them apart.
        let mut state = PersistedTabState::default();
        state.environments.push(Environment {
            id: "second".into(),
            ..Environment::default()
        });
        for env in &mut state.environments {
            for i in 0..(MAX_REMEMBERED_CONNECTIONS as i64 + 3) {
                env.connections.insert(format!("c{i}"), entry(i));
            }
        }
        state.prune();
        for env in &state.environments {
            assert_eq!(env.connections.len(), MAX_REMEMBERED_CONNECTIONS);
        }
    }

    #[test]
    fn active_environment_mut_repairs_a_stale_active_id() {
        let mut state = PersistedTabState {
            active_environment_id: Some("deleted-long-ago".into()),
            ..PersistedTabState::default()
        };
        let id = state.active_environment_mut().id.clone();
        assert_eq!(id, DEFAULT_ENVIRONMENT_ID);
        assert_eq!(
            state.active_environment_id.as_deref(),
            Some(DEFAULT_ENVIRONMENT_ID),
            "the dangling id must be re-anchored, not just worked around"
        );
    }

    #[test]
    fn active_environment_mut_recreates_one_when_the_list_is_empty() {
        let mut state = PersistedTabState {
            version: CURRENT_VERSION,
            environments: Vec::new(),
            active_environment_id: None,
        };
        assert_eq!(state.active_environment_mut().id, DEFAULT_ENVIRONMENT_ID);
        assert_eq!(state.environments.len(), 1);
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
    fn v1_blob_migrates_into_the_default_environment() {
        let v1 = r#"{ "version": 1, "connections": { "abc": { "tabs": [] } } }"#;
        let raw: RawState = serde_json::from_str(v1).unwrap();
        let state = raw.into_state();
        assert_eq!(state.version, CURRENT_VERSION);
        assert_eq!(
            state.active_environment_id.as_deref(),
            Some(DEFAULT_ENVIRONMENT_ID)
        );
        let env = sole_env(&state);
        assert_eq!(env.id, DEFAULT_ENVIRONMENT_ID);
        assert!(
            env.name.is_empty(),
            "the migrated environment must stay unnamed so the frontend can \
             localise its label"
        );
        assert!(env.connections.contains_key("abc"));
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
        // Still one environment, not one per workspace: v2 workspaces were a
        // stand-in for windows, and 1.4.0's decision to keep only the active one
        // stands. Environments are a different axis and are not seeded from them.
        let env = sole_env(&state);
        assert!(env.connections.contains_key("keep"));
        assert!(!env.connections.contains_key("drop"));
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
        assert!(sole_env(&state).connections.contains_key("keep"));
    }

    #[test]
    fn empty_v3_file_yields_one_empty_environment() {
        let empty = r#"{ "version": 3 }"#;
        let raw: RawState = serde_json::from_str(empty).unwrap();
        let state = raw.into_state();
        let env = sole_env(&state);
        assert!(env.connections.is_empty());
        assert!(env.internal_layout.is_none());
        assert!(env.launch.active_connections.is_empty());
    }

    #[test]
    fn v4_blob_round_trips_without_migration() {
        let v4 = r#"{
            "version": 4,
            "activeEnvironmentId": "b",
            "environments": [
                { "id": "a", "name": "Clients", "order": 0,
                  "connections": { "c1": { "tabs": [] } } },
                { "id": "b", "name": "Internal", "order": 1,
                  "internalLayout": {"keep": "me"},
                  "launch": { "activeConnections": ["c2"] } }
            ]
        }"#;
        let raw: RawState = serde_json::from_str(v4).unwrap();
        let state = raw.into_state();
        assert_eq!(state.environments.len(), 2);
        assert_eq!(state.active_environment_id.as_deref(), Some("b"));
        let active = state.active_environment().unwrap();
        assert_eq!(active.name, "Internal");
        assert_eq!(
            active.internal_layout,
            Some(serde_json::json!({"keep": "me"}))
        );
        assert_eq!(active.launch.active_connections, vec!["c2"]);
    }

    #[test]
    fn v4_blob_with_stale_active_id_falls_back_to_the_first_environment() {
        let v4 = r#"{
            "version": 4,
            "activeEnvironmentId": "deleted",
            "environments": [ { "id": "a", "name": "Only" } ]
        }"#;
        let raw: RawState = serde_json::from_str(v4).unwrap();
        let state = raw.into_state();
        assert_eq!(state.active_environment_id.as_deref(), Some("a"));
    }

    #[test]
    fn v3_launch_trio_moves_onto_the_environment() {
        // The three top-level launch fields become one `launch` struct scoped to
        // the environment, so switching environments swaps what gets reconnected.
        let v3 = r#"{
            "version": 3,
            "connections": { "c": { "tabs": [] } },
            "internalLayout": {"pick": "top"},
            "activeConnections": ["a", "b"],
            "selectedConnectionId": "a",
            "activeTabId": "tab-1"
        }"#;
        let raw: RawState = serde_json::from_str(v3).unwrap();
        let state = raw.into_state();
        let env = sole_env(&state);
        assert_eq!(env.launch.active_connections, vec!["a", "b"]);
        assert_eq!(env.launch.selected_connection_id.as_deref(), Some("a"));
        assert_eq!(env.launch.active_tab_id.as_deref(), Some("tab-1"));
        assert_eq!(
            env.internal_layout,
            Some(serde_json::json!({"pick": "top"}))
        );
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
            sole_env(&state).internal_layout,
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
            sole_env(&state).internal_layout,
            Some(serde_json::json!({ "pick": "top" }))
        );
    }

    #[test]
    fn launch_state_absent_defaults_to_empty() {
        let blob = r#"{ "version": 3 }"#;
        let raw: RawState = serde_json::from_str(blob).unwrap();
        let state = raw.into_state();
        let launch = &sole_env(&state).launch;
        assert!(launch.active_connections.is_empty());
        assert!(launch.selected_connection_id.is_none());
        assert!(launch.active_tab_id.is_none());
    }
}
