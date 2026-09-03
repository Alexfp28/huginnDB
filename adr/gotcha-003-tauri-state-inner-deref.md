# Gotcha #003: tauri::State does not auto-deref into &T

**Fecha:** 2026-09-03

Call `state.inner()` to get `&AppState` at call sites. Every helper that takes `&AppState` is called with `state.inner()`, never `&state`.

## Detail

**`tauri::State<'_, T>` does NOT auto-deref into `&T` at call sites.**
   Use `state.inner()` to get `&AppState`. Every helper that takes `&AppState` (e.g. `pool_for`) is called with `state.inner()`, not `&state`.
