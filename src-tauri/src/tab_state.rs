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
//! - **v4**: a list of [`Environment`]s, each owning its own `connections`
//!   map, dockview geometry and [`LaunchState`]. Any earlier blob folds into a
//!   single unnamed environment, so an upgrade is lossless and the user sees
//!   exactly the session they left.
//!
//!   This is a multi-bucket top-level shape again, which v3 removed on purpose —
//!   see [`Environment`] for why an environment is a different thing from a v2
//!   workspace, and CLAUDE.md gotchas #8 and #10.
//! - **v5** (current): [`Origin`]s move to a top-level, global
//!   [`PersistedTabState::origins`] — an origin describes a shared file on a
//!   server, not a Producción/Staging axis, and `profiles.json` (what an origin
//!   actually populates) is already global. Keeping the registration itself
//!   scoped to one environment was the same class of bug `visible_databases`
//!   had before it moved onto `LaunchState` (CLAUDE.md gotcha #27): the same
//!   physical file needed a second, independent registration — a second id — to
//!   be seen from a second environment, and deleting the environment that
//!   happened to hold the registration silently orphaned every connection it had
//!   ever imported with no notice raised at all. Migration dedupes every v4
//!   environment's origins by `path` into the one global list (first one seen
//!   wins the id) and remaps every dangling reference — a profile's
//!   `origin_id`, a mirrored environment's `origin_id` — from a deduped-away id
//!   to the surviving one. See [`RawState::into_state_with_remap`].
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
    /// once loaded: [`RawState::into_state_with_remap`] synthesises one from a
    /// legacy blob and [`PersistedTabState::active_environment_mut`] recreates
    /// one if the list is somehow emptied.
    pub environments: Vec<Environment>,
    /// Which environment the main window is currently in. Validated on load —
    /// an id pointing at no environment falls back to the first.
    pub active_environment_id: Option<String>,
    /// Shared connection sources (#108), global rather than scoped to any one
    /// environment — see the v5 entry in this module's history for why. Same
    /// precedent as [`crate::json_schemas`]'s library: the thing an origin
    /// produces (`profiles.json` entries, and whole mirrored environments) is
    /// global, so the registration that produces it has to be too, or the two
    /// drift out of sync the moment more than one environment is in play.
    pub origins: Vec<Origin>,
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
    /// **Deprecated.** Origins used to be registered per environment; as of
    /// v5 they live in [`PersistedTabState::origins`] instead (see this
    /// module's history). Kept declared only so an old v4 blob still
    /// deserialises losslessly — [`RawState::into_state_with_remap`] drains it
    /// into the global list on migration and always clears it. New saves
    /// always leave it empty, same convention as
    /// [`ConnectionTabState::internal_layout`].
    #[serde(default)]
    pub origins: Vec<Origin>,
    /// Theme id (a [`crate::app_identity`]-agnostic string matching a built-in
    /// or user-defined `Theme.id` on the frontend) to apply whenever this
    /// environment is entered. `None` means "no override" — the app's regular
    /// default theme applies, same as before this field existed. Stored
    /// opaquely, like `color`/`icon`: the backend never validates it against
    /// the frontend's theme list, so a custom theme deleted after being
    /// assigned here just falls back to the default (the frontend's job, not
    /// this one's).
    #[serde(default)]
    pub theme_id: Option<String>,
    /// Which registered [`Origin`] this environment mirrors, if any — same
    /// pattern as [`crate::state::ConnectionProfile::origin_id`], one level up.
    /// `None` means an ordinary, locally-owned environment.
    ///
    /// Set only by `sync_origin`'s continuous-sync path (never by the one-shot
    /// `import_environment`, which always creates an ordinary local
    /// environment): a mirrored environment's cosmetics and connection
    /// membership are overwritten on every sync, so it is read-only in the
    /// switcher/rail the same way an origin-owned profile is read-only in
    /// `ConnectionDialog` — released only via adopt/retire, never edited
    /// directly.
    #[serde(default)]
    pub origin_id: Option<String>,
    /// The publisher's own `Environment.id` for the bundle this environment
    /// mirrors ([`crate::transfer::ExportedEnvironment::source_environment_id`]).
    /// Used together with `origin_id` to recognise "the same" environment
    /// across repeated syncs — `ExportedEnvironment` deliberately carries no
    /// portable id of its own (a one-shot import always mints a fresh
    /// `Environment.id`), so this is the continuous-sync path's own way of
    /// re-casing a bundle it has already mirrored once. `None` unless
    /// `origin_id` is also set.
    #[serde(default)]
    pub origin_source_id: Option<String>,
}

/// A shared folder this environment imports connections from (#108).
///
/// "Shared folder" means a path the OS already mounts — a UNC share
/// (`\\server\huginndb\clients\`), a mapped drive, or a synced folder. There is
/// no protocol and no service: reading one is `std::fs::read`, and the share's
/// ACL is the actual access control. `path` points at a **file**, in the format
/// `export_profiles` already writes (`crate::transfer`, v1, with AES-256-GCM
/// secrets when the publisher included passwords).
///
/// Strictly pull-only. HuginnDB never writes to `path`: the file belongs to
/// whoever curates it, and a concurrent write over SMB has no transaction to
/// protect it. The passphrase lives in *this* user's keychain, keyed by the
/// origin id — it is never stored here, so the on-disk state stays free of
/// secrets exactly like `profiles.json`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Origin {
    pub id: String,
    /// User-facing label. Unlike an environment's name this is expected to be
    /// set at creation (the user typed a path, so they can name it), and it is
    /// only ever display copy — nothing resolves against it.
    pub name: String,
    /// Absolute path to the export file. Stored verbatim, including its
    /// platform-specific separators: a UNC path is not portable to another OS
    /// and rewriting it would only obscure why it stopped resolving.
    pub path: String,
    /// RFC 3339 timestamp of the last successful sync, or `None` if it has
    /// never completed one. Display only — the sync never diffs against it.
    pub last_synced_at: Option<String>,
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
    /// Connections the user folded in the connections tree (#107).
    ///
    /// Deliberately the *collapsed* set and not the expanded one. A connection's
    /// row follows its pool by default — open when live — so the only state worth
    /// remembering is the user having overridden that. It also makes every stale
    /// entry harmless: an id whose profile is gone, or which failed to reconnect,
    /// can at worst mean "show folded if it ever comes back", whereas a list of
    /// expanded ids could claim a row should be open over a subtree that does not
    /// exist.
    pub collapsed_connections: Vec<String>,
    /// DataGrip-style subset of saved connections to show in the connections
    /// tree. Scoped to the environment, not global: `Environment` is
    /// already "which subset of connections is in play" (gotcha #27), and a
    /// filter tuned for one environment being visible in another — e.g. after
    /// switching from a curated "Pruebas" set back to "Predeterminado" — was
    /// the reported bug. `None`/absent means "show all", same convention as
    /// the pre-move `Preferences.ui.visible_connections` it replaces. A
    /// leftover id with no matching profile is harmless (never matches, so
    /// effectively ignored), same reasoning as `collapsed_connections`.
    pub visible_connections: Option<Vec<String>>,
    /// Per-connection override of the "databases to show" subset
    /// ([`crate::state::ConnectionProfile::visible_databases`]), keyed by
    /// connection id.
    ///
    /// The profile-level field stays the **default**: it ships with the profile
    /// through export/import and shared origins, so a curated file can still
    /// arrive with a sensible subset. What it cannot be is the *only* value,
    /// because a profile is global while the reason to hide databases is not:
    /// the same test server is a full replica set in one environment and a
    /// single client's database in another, and storing that on the profile
    /// made the narrower filter leak into every environment (the reported bug —
    /// the same one `visible_connections` had one level up, before it moved
    /// here).
    ///
    /// The two layers resolve as: **key present → this environment's value
    /// wins; key absent → fall back to the profile**. That is why the value is
    /// itself an `Option`: `Some(names)` restricts, and `None` means "show all
    /// *here*" — an override that has to be distinguishable from "no override",
    /// or an environment could never widen a subset the profile narrows.
    ///
    /// Cloning the profile per environment would express the same thing, and is
    /// deliberately not what we do: it would duplicate credentials and keychain
    /// entries, open a second pool against one server, and break the invariant
    /// that connections are global and an environment only scopes which of them
    /// are in play (see [`Environment`]).
    ///
    /// An entry whose profile is gone is swept by `delete_profile` — unlike the
    /// id lists above, a map entry carries a payload, so it is worth reaping
    /// rather than leaving inert.
    pub database_visibility: HashMap<String, Option<Vec<String>>>,
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
    /// This tab's own "table" vs "list" row layout, independent of the
    /// `documentViewMode` default preference used only to seed a newly opened
    /// tab. Same IPC-boundary rule as the three fields above (gotcha #14).
    pub document_view_mode: Option<String>,
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
            origins: Vec::new(),
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
            document_view_mode: None,
        }
    }
}

/// Current on-disk schema version. Bumped on migrations.
const CURRENT_VERSION: u32 = 5;

/// Raw deserialisation target used only by [`load_tab_state`]. It can
/// represent v1 (top-level `connections`), v2 (nested `workspaces`), v3
/// (top-level `connections`, same as v1), v4 (`environments`, origins per
/// environment) and v5 (`environments` + global `origins`) shapes, letting us
/// pick the right migration path without separate `serde_json::from_*`
/// attempts.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RawState {
    version: u32,
    /// v4/v5. Non-empty here short-circuits every legacy path below. Each
    /// environment's own (deprecated as of v5) `origins` field still
    /// deserialises here, which is what [`RawState::into_state_with_remap`]
    /// migrates into the top-level list below.
    environments: Vec<Environment>,
    /// v4/v5.
    active_environment_id: Option<String>,
    /// v5. Empty (not absent — `#[serde(default)]` can't tell the two apart)
    /// for a v4 blob, since the global list didn't exist yet.
    origins: Vec<Origin>,
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
    /// Resolve the raw blob into a fully-shaped `PersistedTabState`, migrating
    /// v1/v2/v3/v4 → v5 in the process. Thin wrapper over
    /// [`Self::into_state_with_remap`] for tests that don't care about the
    /// origin-id remap table — `load_tab_state` (the one production caller)
    /// needs the remap, so it calls that directly instead.
    #[cfg(test)]
    fn into_state(self) -> PersistedTabState {
        self.into_state_with_remap().0
    }

    /// Same as [`Self::into_state`], but also returns the origin-id remap a
    /// v4→v5 migration produced: `old id → surviving id`, for every origin
    /// that was deduped away because another environment already registered
    /// the same `path`. Empty for a blob that was already v5 (nothing to
    /// dedupe) or pre-v4 (no origins existed yet).
    ///
    /// The caller (`state.rs`) is responsible for applying this to
    /// `profiles.json`'s `origin_id` — a *different* file this module knows
    /// nothing about — which is why the remap is returned rather than applied
    /// here.
    pub fn into_state_with_remap(self) -> (PersistedTabState, HashMap<String, String>) {
        // v4/v5: already in the new shape. Only the active id needs
        // validating — an environment could have been deleted by another
        // (older) build, or the file hand-edited.
        if !self.environments.is_empty() {
            let active = self
                .active_environment_id
                .filter(|id| self.environments.iter().any(|e| &e.id == id))
                .or_else(|| self.environments.first().map(|e| e.id.clone()));
            let (environments, origins, remap) =
                migrate_origins_to_global(self.environments, self.origins);
            return (
                PersistedTabState {
                    version: CURRENT_VERSION,
                    environments,
                    active_environment_id: active,
                    origins,
                },
                remap,
            );
        }

        let launch = LaunchState {
            active_connections: self.active_connections,
            selected_connection_id: self.selected_connection_id,
            active_tab_id: self.active_tab_id,
            // Pre-v4 blobs predate the connections tree, so nothing was ever
            // folded: the default (follow the pool) is the right migration.
            collapsed_connections: Vec::new(),
            // Pre-v4 blobs predate the visibility filter too (it lived in
            // global `Preferences.ui` at the time): "show all" is the right
            // migration, and that global value is left untouched (a one-time
            // dangling field, harmless — see the `prefs.rs` removal note).
            visible_connections: None,
            // No overrides on migration: every connection keeps resolving to
            // its profile's `visible_databases`, so the upgrade is a no-op for
            // anyone who never opens the picker again.
            database_visibility: HashMap::new(),
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
        // Unnamed, so the frontend labels it in the user's language. Predates
        // origins entirely, so there is nothing to migrate or remap.
        (
            PersistedTabState {
                version: CURRENT_VERSION,
                environments: vec![Environment {
                    connections,
                    internal_layout,
                    launch,
                    ..Environment::initial()
                }],
                active_environment_id: Some(DEFAULT_ENVIRONMENT_ID.to_string()),
                origins: Vec::new(),
            },
            HashMap::new(),
        )
    }
}

/// Drain every environment's (deprecated as of v5) per-environment `origins`
/// into one global list, deduplicated by `path` — the same shared file
/// registered under two environments must collapse into a single entry, not
/// two independent ones with independent ids. The first occurrence wins the
/// surviving id (deterministic: environments and their origins keep their
/// on-disk order), starting from whatever `top_level_origins` already holds
/// (a genuine v5 blob, or — theoretically — a hand-edited file that already
/// has some).
///
/// Returns the migrated environments (their own `origins` field always
/// cleared), the deduplicated global list, and the remap (`old id → surviving
/// id`) every id merged away needs applied wherever it's referenced outside
/// this module — namely a `ConnectionProfile.origin_id` in the *separate*
/// `profiles.json`, which is why the remap is returned rather than resolved
/// in place.
fn migrate_origins_to_global(
    mut environments: Vec<Environment>,
    top_level_origins: Vec<Origin>,
) -> (Vec<Environment>, Vec<Origin>, HashMap<String, String>) {
    let mut origins = top_level_origins;
    let mut by_path: HashMap<String, String> = origins
        .iter()
        .map(|o| (o.path.clone(), o.id.clone()))
        .collect();
    let mut remap: HashMap<String, String> = HashMap::new();

    for env in &mut environments {
        for o in std::mem::take(&mut env.origins) {
            match by_path.get(&o.path) {
                Some(winner) if winner != &o.id => {
                    remap.insert(o.id, winner.clone());
                }
                Some(_) => {
                    // Same id already registered under this exact path —
                    // nothing to merge, nothing to remap.
                }
                None => {
                    by_path.insert(o.path.clone(), o.id.clone());
                    origins.push(o);
                }
            }
        }
    }

    if !remap.is_empty() {
        for env in &mut environments {
            if let Some(old) = env.origin_id.take() {
                env.origin_id = Some(remap.get(&old).cloned().unwrap_or(old));
            }
        }
    }

    (environments, origins, remap)
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

/// Load persisted tab state, transparently migrating v1-v4 blobs.
///
/// Falls back to an empty (but valid) container on missing or corrupt
/// files so a bad blob never blocks startup. The second element is the
/// origin-id remap a v4→v5 migration produced (see
/// [`RawState::into_state_with_remap`]) — empty unless this load just
/// deduped two environments' origins that shared a `path`. The caller
/// (`state::AppState::new_with_args`) is responsible for applying it to
/// `profiles.json`, a file this module never touches.
pub fn load_tab_state() -> (PersistedTabState, HashMap<String, String>) {
    let path = match tab_state_path() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[tab_state] cannot resolve path: {e}; using empty state");
            return (PersistedTabState::default(), HashMap::new());
        }
    };
    if !path.exists() {
        return (PersistedTabState::default(), HashMap::new());
    }
    match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<RawState>(&bytes) {
            Ok(raw) => raw.into_state_with_remap(),
            Err(e) => {
                eprintln!("[tab_state] failed to parse {path:?}: {e}; using empty state");
                (PersistedTabState::default(), HashMap::new())
            }
        },
        Err(e) => {
            eprintln!("[tab_state] failed to read {path:?}: {e}; using empty state");
            (PersistedTabState::default(), HashMap::new())
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
            origins: Vec::new(),
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
    fn document_view_mode_round_trips_and_defaults_to_absent() {
        // Same gotcha #14 failure this guards against as the collapsed-
        // connections test above: a field the frontend sends but the struct
        // doesn't declare is silently dropped before it reaches disk.
        let without = r#"{ "version": 4, "environments": [ { "id": "a", "connections": {
            "c1": { "tabs": [ { "id": "t1", "kind": "table" } ] }
        } } ] }"#;
        let raw: RawState = serde_json::from_str(without).unwrap();
        let state = raw.into_state();
        assert_eq!(
            sole_env(&state).connections["c1"].tabs[0].document_view_mode,
            None
        );

        let with = r#"{ "version": 4, "environments": [ { "id": "a", "connections": {
            "c1": { "tabs": [ { "id": "t1", "kind": "table", "documentViewMode": "list" } ] }
        } } ] }"#;
        let raw: RawState = serde_json::from_str(with).unwrap();
        let state = raw.into_state();
        assert_eq!(
            sole_env(&state).connections["c1"].tabs[0]
                .document_view_mode
                .as_deref(),
            Some("list")
        );

        // And it survives being written back out.
        let json = serde_json::to_string(&state).unwrap();
        let reparsed: RawState = serde_json::from_str(&json).unwrap();
        assert_eq!(
            sole_env(&reparsed.into_state()).connections["c1"].tabs[0]
                .document_view_mode
                .as_deref(),
            Some("list")
        );
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
    fn origins_default_to_empty() {
        // A v4 blob written before origins existed must still load, with the
        // global list defaulting rather than failing the whole parse.
        let without = r#"{ "version": 4, "environments": [ { "id": "a" } ] }"#;
        let raw: RawState = serde_json::from_str(without).unwrap();
        assert!(raw.into_state().origins.is_empty());
    }

    #[test]
    fn a_v4_environments_origins_migrate_into_the_global_v5_list() {
        // A v4 blob's per-environment origins (the pre-v5 shape) must land in
        // the new top-level, global list on load — not stay nested on the
        // environment, which is deprecated and always cleared.
        let with = r#"{
            "version": 4,
            "environments": [ { "id": "a", "origins": [
                { "id": "o1", "name": "Clients",
                  "path": "\\\\server\\huginndb\\clients.json",
                  "lastSyncedAt": "2026-07-29T10:00:00Z" }
            ] } ]
        }"#;
        let raw: RawState = serde_json::from_str(with).unwrap();
        let state = raw.into_state();
        assert_eq!(state.origins.len(), 1);
        assert_eq!(state.origins[0].path, r"\\server\huginndb\clients.json");
        assert_eq!(
            state.origins[0].last_synced_at.as_deref(),
            Some("2026-07-29T10:00:00Z")
        );
        assert!(sole_env(&state).origins.is_empty());
    }

    #[test]
    fn origins_registered_under_two_environments_for_the_same_path_dedupe_into_one() {
        // The exact scenario the v5 migration exists for: two environments
        // each registered "the same" shared file independently (two ids, one
        // path). They must collapse into a single global entry, and the
        // second environment's dangling `originId` (it mirrors a bundle from
        // its own copy) must be remapped to the surviving id.
        let with = r#"{
            "version": 4,
            "environments": [
                { "id": "a", "origins": [
                    { "id": "o1", "name": "Clients (from A)",
                      "path": "\\\\server\\huginndb\\clients.json" }
                ] },
                { "id": "b", "originId": "o2", "origins": [
                    { "id": "o2", "name": "Clients (from B)",
                      "path": "\\\\server\\huginndb\\clients.json" }
                ] }
            ]
        }"#;
        let raw: RawState = serde_json::from_str(with).unwrap();
        let (state, remap) = raw.into_state_with_remap();

        assert_eq!(state.origins.len(), 1, "must dedupe by path");
        assert_eq!(state.origins[0].id, "o1", "first occurrence wins the id");
        assert_eq!(remap.get("o2").map(String::as_str), Some("o1"));

        let env_b = state.environments.iter().find(|e| e.id == "b").unwrap();
        assert_eq!(
            env_b.origin_id.as_deref(),
            Some("o1"),
            "the deduped-away id must be remapped, not left dangling"
        );
        for env in &state.environments {
            assert!(
                env.origins.is_empty(),
                "the per-environment field is deprecated"
            );
        }
    }

    #[test]
    fn collapsed_connections_round_trip_and_default_to_empty() {
        // The failure this guards against is gotcha #14: a field the frontend
        // sends but the struct doesn't declare is dropped on deserialize, so it
        // never reaches disk. Assert both directions — an older blob without the
        // key still loads (every row follows its pool, the pre-#107 behaviour),
        // and a blob carrying folds keeps them.
        let without = r#"{ "version": 4, "environments": [ { "id": "a" } ] }"#;
        let raw: RawState = serde_json::from_str(without).unwrap();
        assert!(sole_env(&raw.into_state())
            .launch
            .collapsed_connections
            .is_empty());

        let with = r#"{
            "version": 4,
            "environments": [ { "id": "a", "launch": {
                "activeConnections": ["c1", "c2"],
                "collapsedConnections": ["c2"]
            } } ]
        }"#;
        let raw: RawState = serde_json::from_str(with).unwrap();
        let state = raw.into_state();
        assert_eq!(
            sole_env(&state).launch.collapsed_connections,
            vec!["c2".to_string()]
        );

        // And it survives being written back out, which is the half a
        // missing-field bug would break silently.
        let json = serde_json::to_string(&state).unwrap();
        let reparsed: RawState = serde_json::from_str(&json).unwrap();
        assert_eq!(
            sole_env(&reparsed.into_state())
                .launch
                .collapsed_connections,
            vec!["c2".to_string()]
        );
    }

    #[test]
    fn visible_connections_are_scoped_per_environment() {
        // The filter used to live in global `Preferences.ui`, so switching
        // environments never changed it — a subset tuned for one environment
        // stayed active in every other one. Moving it onto `LaunchState` fixes
        // that only if each environment round-trips its own value independently.
        let v4 = r#"{
            "version": 4,
            "activeEnvironmentId": "b",
            "environments": [
                { "id": "a", "launch": { "visibleConnections": ["c1", "c2"] } },
                { "id": "b", "launch": {} }
            ]
        }"#;
        let raw: RawState = serde_json::from_str(v4).unwrap();
        let state = raw.into_state();
        assert_eq!(
            state.environments[0].launch.visible_connections,
            Some(vec!["c1".to_string(), "c2".to_string()])
        );
        // "b" is active and never set a subset: must default to "show all"
        // (`None`), not inherit "a"'s.
        assert_eq!(
            state
                .active_environment()
                .unwrap()
                .launch
                .visible_connections,
            None
        );

        let json = serde_json::to_string(&state).unwrap();
        let reparsed: RawState = serde_json::from_str(&json).unwrap();
        assert_eq!(
            reparsed.into_state().environments[0]
                .launch
                .visible_connections,
            Some(vec!["c1".to_string(), "c2".to_string()])
        );
    }

    #[test]
    fn database_visibility_overrides_are_scoped_per_environment() {
        // The bug this guards: `visible_databases` lives on the (global)
        // profile, so a subset chosen while inside one environment showed up in
        // every other one. Each environment must round-trip its own map, and an
        // environment that never overrode anything must come back empty rather
        // than inheriting a neighbour's.
        let v4 = r#"{
            "version": 4,
            "activeEnvironmentId": "prod",
            "environments": [
                { "id": "prod", "launch": { "databaseVisibility": {
                    "test-server": ["client_a"]
                } } },
                { "id": "pruebas", "launch": {} }
            ]
        }"#;
        let raw: RawState = serde_json::from_str(v4).unwrap();
        let state = raw.into_state();
        assert_eq!(
            state.environments[0].launch.database_visibility["test-server"],
            Some(vec!["client_a".to_string()])
        );
        assert!(state.environments[1].launch.database_visibility.is_empty());

        let json = serde_json::to_string(&state).unwrap();
        let reparsed: RawState = serde_json::from_str(&json).unwrap();
        assert_eq!(
            reparsed.into_state().environments[0]
                .launch
                .database_visibility["test-server"],
            Some(vec!["client_a".to_string()])
        );
    }

    #[test]
    fn a_null_database_visibility_override_survives_the_round_trip() {
        // `null` is the override that means "show all *here*", and it is only
        // useful if it stays distinguishable from "no override at all" — that
        // is what lets an environment widen a subset its profile narrows.
        // Serde would happily collapse the two if the value stopped being an
        // `Option`, and nothing else in the app would notice.
        let v4 = r#"{
            "version": 4,
            "environments": [
                { "id": "a", "launch": { "databaseVisibility": { "conn": null } } }
            ]
        }"#;
        let raw: RawState = serde_json::from_str(v4).unwrap();
        let state = raw.into_state();
        let map = &sole_env(&state).launch.database_visibility;
        assert!(
            map.contains_key("conn"),
            "an explicit null must stay an override, not disappear"
        );
        assert_eq!(map["conn"], None);

        let json = serde_json::to_string(&state).unwrap();
        let reparsed: RawState = serde_json::from_str(&json).unwrap();
        let reloaded = reparsed.into_state();
        let map = &sole_env(&reloaded).launch.database_visibility;
        assert!(map.contains_key("conn"));
        assert_eq!(map["conn"], None);
    }

    #[test]
    fn v3_blob_migrates_without_any_database_visibility_override() {
        // Pre-v4 blobs predate the override entirely: every connection must
        // keep resolving to its profile's `visible_databases`, so the upgrade
        // changes nothing on screen.
        let v3 = r#"{ "version": 3, "connections": { "c": { "tabs": [] } } }"#;
        let raw: RawState = serde_json::from_str(v3).unwrap();
        let state = raw.into_state();
        assert!(sole_env(&state).launch.database_visibility.is_empty());
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
