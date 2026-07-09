//! User preferences persisted to disk.
//!
//! Lives next to `profiles.json` in the platform config dir:
//!
//! * Windows — `%APPDATA%\HuginnDB\prefs.json`
//! * Linux   — `$XDG_CONFIG_HOME/HuginnDB/prefs.json`
//! * macOS   — `~/Library/Application Support/HuginnDB/prefs.json`
//!
//! A missing or corrupted file degrades to [`Preferences::default()`] — the
//! user can always relaunch the app even if they hand-edit the JSON into
//! garbage. Writes go through an atomic temp-file rename so a crash mid-save
//! cannot leave a half-written file on Windows.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// File name used for the persisted preferences blob.
const PREFS_FILE: &str = "prefs.json";

/// Application directory within the platform's config base. Matches the
/// directory used by [`crate::store`].
const APP_DIR: &str = "HuginnDB";

/// Top-level preferences blob. Bumped on incompatible schema changes; the
/// `#[serde(default)]` everywhere means older files keep loading.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    pub version: u32,
    pub editor: EditorPrefs,
    pub grid: GridPrefs,
    pub ui: UiPrefs,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EditorPrefs {
    pub font_family: String,
    pub font_size: u16,
    pub tab_size: u16,
    pub word_wrap: bool,
    pub minimap: bool,
    pub line_numbers: bool,
    pub format_on_paste: bool,
    /// Monaco theme id (e.g. `"one-dark-pro"`, `"github-dark"`,
    /// `"vs-light"`). Stringly-typed so the frontend's theme catalogue
    /// stays the single source of truth — the backend just round-trips
    /// whatever id the user picked.
    pub theme: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GridPrefs {
    pub row_height: u16,
    pub null_display: String,
    pub truncate_long_text_at: u32,
    pub zebra_stripes: bool,
    pub sticky_header: bool,
    pub default_page_size: u32,
    /// Whether the floating cell-value preview panel appears when a cell is
    /// selected in the data grid. Defaults to `true` (the historical
    /// behaviour); turning it off keeps single-click as pure navigation.
    pub cell_preview: bool,
    /// How MySQL `BIT` columns are rendered. One of "true_false" | "zero_one".
    /// Stringly-typed; the backend always ships BIT as a number and the
    /// frontend grid maps it to the chosen representation, so toggling this
    /// re-renders without re-querying.
    pub bit_display: String,
    /// User-resized column widths (px), keyed by `"<schema>.<table>"` then by
    /// column name. Only populated for real browsed tables — ad-hoc query
    /// result grids resize in-session only and never write here. Entries are
    /// tiny (a `u16` each), so unlike `tab_state.json`'s query bodies this
    /// isn't pruned; even thousands of tables/columns stay a small blob.
    pub column_widths: HashMap<String, HashMap<String, u16>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UiPrefs {
    pub confirm_destructive: bool,
    pub query_history_limit: u32,
    pub restore_tabs_on_open: bool,
    /// Schema-tree metric column. One of "none" | "row-count" | "size".
    /// Stringly-typed so the frontend `ViewMenu` enum stays the source of
    /// truth; the backend doesn't interpret the value.
    pub schema_table_metric: String,
    /// UI language. BCP-47-ish short code ("en", "es"). The frontend's
    /// i18next instance owns the list of supported locales; the backend
    /// just round-trips whatever string the user picked.
    pub language: String,
    /// Where the heavyweight cell editor opens by default when escalated
    /// from an inline edit / preview. One of "modal" | "side". Stringly-typed;
    /// the frontend owns the enum.
    pub cell_editor_mode: String,
    /// Driver used when a connection is created without an explicit choice.
    /// One of "postgres" | "mysql" | "sqlite", or `None` (not configured) —
    /// in which case the CLI prompts for the driver instead of guessing.
    /// Stringly-typed; the frontend owns the enum.
    pub default_driver: Option<String>,
    /// Remembered choice for the "second launch" connect dialog when a
    /// running instance receives a new CLI connection intent. One of
    /// "ask" | "current" | "new". "ask" (the default) always shows the
    /// dialog; the other two apply that action silently. Stringly-typed;
    /// the frontend owns the enum.
    pub cli_connect_default: String,
    /// Names of connection-list groups (`ConnectionProfile.group`) currently
    /// collapsed in the sidebar. Purely a display convenience — matched by
    /// string equality against the live group names, so a renamed/deleted
    /// group's stale entry here is harmless (it just never matches again).
    pub collapsed_connection_groups: Vec<String>,
    /// Visual treatment for a tab's active/colour accent. One of
    /// "cap" | "rail" | "boxed". Stringly-typed; the frontend owns the enum
    /// and applies it via CSS + an inline style, the backend just round-trips.
    pub tab_accent_style: String,
    /// How grouped connections start out in the tree views (File menu,
    /// connections manager). One of "expanded" | "collapsed" | "remember".
    /// "remember" defers to `collapsed_connection_groups`; the other two force
    /// the initial state (per-surface session toggles still apply on top).
    /// Stringly-typed; the frontend owns the enum.
    pub connection_group_expand_mode: String,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            version: 1,
            editor: EditorPrefs::default(),
            grid: GridPrefs::default(),
            ui: UiPrefs::default(),
        }
    }
}

impl Default for EditorPrefs {
    fn default() -> Self {
        Self {
            font_family: "JetBrains Mono".into(),
            font_size: 13,
            tab_size: 2,
            word_wrap: false,
            minimap: false,
            line_numbers: true,
            format_on_paste: false,
            theme: "one-dark-pro".into(),
        }
    }
}

impl Default for GridPrefs {
    fn default() -> Self {
        Self {
            row_height: 26,
            null_display: "NULL".into(),
            truncate_long_text_at: 200,
            zebra_stripes: true,
            sticky_header: true,
            default_page_size: 100,
            cell_preview: true,
            bit_display: "true_false".into(),
            column_widths: HashMap::new(),
        }
    }
}

impl Default for UiPrefs {
    fn default() -> Self {
        Self {
            confirm_destructive: true,
            query_history_limit: 50,
            restore_tabs_on_open: true,
            schema_table_metric: "none".into(),
            language: "en".into(),
            cell_editor_mode: "modal".into(),
            default_driver: None,
            cli_connect_default: "ask".into(),
            collapsed_connection_groups: Vec::new(),
            tab_accent_style: "cap".into(),
            connection_group_expand_mode: "remember".into(),
        }
    }
}

/// Resolve (and create on demand) the path where preferences live.
fn prefs_path() -> AppResult<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| AppError::InvalidInput("no config dir available".into()))?;
    let dir = base.join(APP_DIR);
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(PREFS_FILE))
}

/// Read the preferences blob from disk.
///
/// Returns [`Preferences::default`] when the file is missing or unparseable —
/// the caller logs the underlying error but never blocks app startup on a
/// corrupted prefs file.
pub fn load_preferences() -> Preferences {
    let path = match prefs_path() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[prefs] cannot resolve path: {e}; using defaults");
            return Preferences::default();
        }
    };
    if !path.exists() {
        return Preferences::default();
    }
    match std::fs::read(&path).and_then(|bytes| {
        serde_json::from_slice(&bytes)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
    }) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[prefs] failed to read {path:?}: {e}; using defaults");
            Preferences::default()
        }
    }
}

/// Persist `prefs` to disk using a temp-file + rename to keep the on-disk
/// file readable even if the process is killed mid-write.
pub fn save_preferences(prefs: &Preferences) -> AppResult<()> {
    let path = prefs_path()?;
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(prefs)?;
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_round_trip() {
        let original = Preferences::default();
        let bytes = serde_json::to_vec(&original).unwrap();
        let parsed: Preferences = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed.version, original.version);
        assert_eq!(parsed.editor.font_size, original.editor.font_size);
        assert_eq!(
            parsed.grid.default_page_size,
            original.grid.default_page_size
        );
        assert_eq!(
            parsed.ui.schema_table_metric,
            original.ui.schema_table_metric
        );
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        // Older clients may write a partial blob; we want to read it back without losing fields.
        let partial = r#"{ "version": 1, "editor": { "fontSize": 17 } }"#;
        let parsed: Preferences = serde_json::from_str(partial).unwrap();
        assert_eq!(parsed.editor.font_size, 17);
        assert_eq!(parsed.editor.font_family, "JetBrains Mono");
        assert_eq!(parsed.grid.default_page_size, 100);
        assert!(parsed.ui.restore_tabs_on_open);
    }

    #[test]
    fn corrupt_json_does_not_panic() {
        let parsed: Result<Preferences, _> = serde_json::from_str("{ this is not json");
        assert!(parsed.is_err());
    }
}
