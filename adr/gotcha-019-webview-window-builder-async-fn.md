# Gotcha #019: Building a WebviewWindow must happen inside an async Tauri command

**Fecha:** 2026-09-03

A sync command building a window on Windows deadlocks — a documented WebView2 issue — and renders a blank, "Not Responding" window. Only marking the command `async fn` actually fixes it, per Tauri's own docs and tauri#13963.

## Detail

**`WebviewWindowBuilder::new(...).build()` must be called from an `async fn` Tauri command, never a sync one.** `commands::connection::open_new_window` hit this: a sync command building a new `WebviewWindow` on Windows deadlocks — a documented WebView2 issue — and the symptom is *not* an error, it's a window that renders blank/white and Windows tags "Not Responding". Wrapping the `build()` call in `AppHandle::run_on_main_thread` looked like a fix (the hang went away) but the window still came up blank; only marking the command `async fn` actually works, per Tauri's own docs and [tauri#13963](https://github.com/tauri-apps/tauri/issues/13963). If you add another command that creates a window, make it `async fn` from the start.
