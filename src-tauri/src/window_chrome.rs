//! Who draws a window's title bar: the OS, or HuginnDB.
//!
//! On Windows and Linux every window is undecorated and the frontend's
//! `TitleBar` (`src/components/shell/TitleBar.tsx`) draws the one bar the
//! window has — menus, breadcrumb and the minimise / maximise / close buttons
//! in a single row, instead of the native caption stacked above the app's own
//! menu bar. macOS keeps its native frame: the traffic lights sit on the left,
//! the platform is not a primary target, and an overlay title bar nobody has
//! verified there is worse than the one it would replace.
//!
//! The decision lives here once, for both places a window comes from:
//! the main window, declared in `tauri.conf.json` (and the canary overlay) with
//! `decorations: false` — see [`adapt_main_window`] for macOS — and the three
//! `open_*_window` commands, which build theirs through [`builder`].
//!
//! It also owns how `tauri-plugin-window-state` is configured, for two reasons.
//! The plugin saves and restores `decorations` by default, which would bring
//! the native bar back on the first launch after an update from whatever the
//! old build saved — hence [`window_state_flags`]. And it remembers every
//! window it sees, by label, while the secondary windows are labelled with a
//! fresh uuid each time (`win-…`, `tabwin-…`, `pulsewin-…`): their entries
//! could never be restored and were never removed, so the file grew by one
//! for every window ever opened. [`remembers`] limits the plugin to the main
//! window and [`forget_unremembered_windows`] clears what older builds left.

use std::path::Path;

use tauri::plugin::TauriPlugin;
use tauri::{Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::{StateFlags, DEFAULT_FILENAME};

/// The label of the window `tauri.conf.json` declares — the only one whose
/// placement is worth remembering, because it is the only one that comes back
/// under the same label.
pub const MAIN_WINDOW: &str = "main";

/// Whether this platform keeps the OS title bar. Mirrors `usesNativeFrame()`
/// in `TitleBar.tsx`, which decides whether to draw the caption buttons.
pub const USES_NATIVE_FRAME: bool = cfg!(target_os = "macos");

/// Everything the window-state plugin remembers except `DECORATIONS` — see
/// the module docs.
pub fn window_state_flags() -> StateFlags {
    StateFlags::all() & !StateFlags::DECORATIONS
}

/// Whether the window-state plugin should track the window labelled `label`.
///
/// An allowlist rather than a denylist of the three secondary prefixes: a
/// fourth kind of window added later is kept out of the file without anyone
/// having to remember this function exists. A secondary window opens where the
/// OS or its `open_*_window` command puts it, as it always effectively did —
/// a uuid label never matched a saved entry.
pub fn remembers(label: &str) -> bool {
    label == MAIN_WINDOW
}

/// A plugin with no commands whose only job is to drop, from the window-state
/// file, every entry [`remembers`] rejects — the ones builds before the filter
/// accumulated.
///
/// It has to be a plugin, registered **before** the window-state one: that
/// plugin reads the whole file into memory in its own setup and writes the
/// whole of it back on exit, so a prune in the app's `setup` (which runs after
/// every plugin's) would be undone at the next exit. Plugins are initialised in
/// registration order.
///
/// The path is the one the plugin itself uses — the identifier-named config
/// dir (`io.huginndb.app`, `io.huginndb.canary`), not `app_identity::APP_DIR` —
/// so canary and stable each prune their own file.
pub fn forget_unremembered_windows<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("window-state-prune")
        .setup(|app, _api| {
            if let Ok(dir) = app.path().app_config_dir() {
                prune_window_state_file(&dir.join(DEFAULT_FILENAME));
            }
            Ok(())
        })
        .build()
}

/// Best effort: a file that is missing, unreadable or not the JSON object the
/// plugin writes is left exactly as it is, and so is one with nothing to drop.
/// Losing a window position is never worth failing a launch over.
fn prune_window_state_file(path: &Path) {
    let Ok(bytes) = std::fs::read(path) else {
        return;
    };
    let Some(pruned) = prune_window_state(&bytes) else {
        return;
    };
    if let Err(e) = crate::state_file::write_atomic(path, &pruned) {
        eprintln!("[window_state] failed to prune {path:?}: {e}");
    }
}

/// `bytes` without the entries [`remembers`] rejects, or `None` when there is
/// nothing to rewrite.
///
/// Only the top-level keys are read: each value is the plugin's own
/// `WindowState`, passed through untouched as a `serde_json::Value` so this
/// does not depend on that struct's private shape.
fn prune_window_state(bytes: &[u8]) -> Option<Vec<u8>> {
    let serde_json::Value::Object(mut states) = serde_json::from_slice(bytes).ok()? else {
        return None;
    };
    let before = states.len();
    states.retain(|label, _| remembers(label));
    if states.len() == before {
        return None;
    }
    serde_json::to_vec_pretty(&states).ok()
}

/// A builder for a secondary window of the app's own page, with the chrome
/// this platform uses — every `open_*_window` command starts from here.
pub fn builder<'a, R: Runtime, M: Manager<R>>(
    manager: &'a M,
    label: &str,
) -> WebviewWindowBuilder<'a, R, M> {
    WebviewWindowBuilder::new(manager, label, WebviewUrl::App("index.html".into()))
        .decorations(USES_NATIVE_FRAME)
}

/// The main window is created from the config, which cannot say "undecorated
/// except on macOS" — a platform-specific config file would be overridden
/// wholesale by the canary overlay's `windows` array. So the config says
/// undecorated and macOS puts its frame back here, before the window is shown.
pub fn adapt_main_window<R: Runtime>(app: &tauri::App<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    if USES_NATIVE_FRAME {
        let _ = window.set_decorations(true);
    } else {
        keep_title_bar_on_screen(&window);
    }
}

/// Pull a restored window down if its top edge sits above its monitor's work
/// area.
///
/// The window-state plugin puts the window back where it was, and a position
/// saved by a build with the native frame can leave the top of the window a
/// few pixels above the screen (seen at -17px). With the native caption that
/// hid part of a bar Windows let you grab anyway; now the hidden strip is the
/// in-app title bar, the only place the window can be dragged from. Runs after
/// the plugin has restored the state (it does so as the window is created,
/// before `setup`), and leaves a maximised window alone — its position is the
/// OS's to decide.
fn keep_title_bar_on_screen<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    if window.is_maximized().unwrap_or(false) {
        return;
    }
    let (Ok(position), Ok(Some(monitor))) = (window.outer_position(), window.current_monitor())
    else {
        return;
    };
    let top = monitor.work_area().position.y;
    if position.y < top {
        let _ = window.set_position(tauri::PhysicalPosition::new(position.x, top));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATE: &str = r#"{"width":1280,"height":800,"x":10,"y":20,"prev_x":0,"prev_y":0,"maximized":false,"visible":true,"decorated":false,"fullscreen":false}"#;

    #[test]
    fn only_the_main_window_is_remembered() {
        assert!(remembers("main"));
        for label in [
            "win-d1b20642-0000-0000-0000-000000000000",
            "tabwin-e924c58b-0000-0000-0000-000000000000",
            "pulsewin-1",
            "mainwin",
            "",
        ] {
            assert!(!remembers(label), "{label}");
        }
    }

    #[test]
    fn prune_drops_secondary_windows_and_keeps_main_verbatim() {
        let file = format!(r#"{{"main":{STATE},"win-a":{STATE},"tabwin-b":{STATE}}}"#);
        let pruned = prune_window_state(file.as_bytes()).expect("something to drop");
        let value: serde_json::Value = serde_json::from_slice(&pruned).unwrap();
        let expected: serde_json::Value = serde_json::from_str(STATE).unwrap();
        let map = value.as_object().unwrap();
        assert_eq!(map.len(), 1);
        assert_eq!(map["main"], expected);
    }

    #[test]
    fn prune_leaves_a_clean_or_unrecognised_file_alone() {
        let clean = format!(r#"{{"main":{STATE}}}"#);
        assert!(prune_window_state(clean.as_bytes()).is_none());
        assert!(prune_window_state(b"{}").is_none());
        assert!(prune_window_state(b"not json").is_none());
        assert!(prune_window_state(b"[1,2]").is_none());
    }

    #[test]
    fn prune_file_rewrites_only_when_needed() {
        let path = std::env::temp_dir().join(format!(
            "huginndb-window-state-{}.json",
            uuid::Uuid::new_v4()
        ));

        prune_window_state_file(&path); // missing: nothing happens
        assert!(!path.exists());

        std::fs::write(&path, format!(r#"{{"main":{STATE},"pulsewin-x":{STATE}}}"#)).unwrap();
        prune_window_state_file(&path);
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            value.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["main"]
        );
        let _ = std::fs::remove_file(&path);
    }
}
