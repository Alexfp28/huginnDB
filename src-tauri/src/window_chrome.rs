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
//! One consequence outside this file: `tauri-plugin-window-state` saves and
//! restores `decorations` by default, which would bring the native bar back on
//! the first launch after an update from whatever the old build saved. `lib.rs`
//! registers it with [`window_state_flags`] for that reason.

use tauri::{Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::StateFlags;

/// Whether this platform keeps the OS title bar. Mirrors `usesNativeFrame()`
/// in `TitleBar.tsx`, which decides whether to draw the caption buttons.
pub const USES_NATIVE_FRAME: bool = cfg!(target_os = "macos");

/// Everything the window-state plugin remembers except `DECORATIONS` — see
/// the module docs.
pub fn window_state_flags() -> StateFlags {
    StateFlags::all() & !StateFlags::DECORATIONS
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
    let Some(window) = app.get_webview_window("main") else {
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
