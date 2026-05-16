//! Per-connection session state — open tabs, active tab, and schema-tree
//! expansion — persisted to disk so reconnecting a profile restores the
//! user's workspace exactly as they left it.
//!
//! Stored in `tab_state.json` next to `profiles.json` and `prefs.json`. We
//! keep this in its own file instead of embedding it into [`crate::prefs`]
//! because (a) it churns on every tab open/close while the user works and
//! (b) it is opaque to humans hand-editing the prefs file.
//!
//! Only the last [`MAX_REMEMBERED_CONNECTIONS`] connections are kept, ranked
//! by `last_opened`, to bound on-disk growth. Each tab's `query` body is
//! capped at [`MAX_QUERY_BYTES`]; oversized bodies are saved empty.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

const TAB_STATE_FILE: &str = "tab_state.json";
const APP_DIR: &str = "HuginnDB";

/// Soft cap on how many connections we remember. Older entries (by
/// `last_opened`) get pruned on save.
pub const MAX_REMEMBERED_CONNECTIONS: usize = 20;

/// Soft cap on a single tab's query body. Anything larger is truncated to
/// `None` at save time — restoring a 2 MB query body for a tab the user
/// forgot they had open is not worth the startup cost.
pub const MAX_QUERY_BYTES: usize = 64 * 1024;

/// Top-level on-disk shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PersistedTabState {
    pub version: u32,
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

impl Default for PersistedTabState {
    fn default() -> Self {
        Self {
            version: 1,
            connections: HashMap::new(),
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
        .ok_or_else(|| AppError::InvalidInput("no config dir available".into()))?;
    let dir = base.join(APP_DIR);
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(TAB_STATE_FILE))
}

/// Load persisted tab state. Falls back to an empty container on missing or
/// corrupt file so a bad blob never blocks startup.
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
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(state) => state,
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
        // The oldest five should have been dropped.
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
    fn missing_fields_round_trip_safely() {
        let partial = r#"{ "connections": { "abc": { "tabs": [] } } }"#;
        let parsed: PersistedTabState = serde_json::from_str(partial).unwrap();
        assert!(parsed.connections.contains_key("abc"));
        assert_eq!(parsed.version, 1);
    }
}

/// Re-export the normalisation hook so command handlers can call it before
/// writing user-supplied state.
pub fn normalise_for_save(state: &mut ConnectionTabState) {
    normalise(state);
}
