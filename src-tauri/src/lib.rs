//! HuginnDB — desktop database manager.
//!
//! The library crate hosts all of the Tauri command handlers and the
//! shared state they operate on. `main.rs` is a thin shim that calls
//! [`run`] so the same binary can be re-used in different bundling modes
//! (custom protocol, mobile, etc.).
//!
//! ### Module map
//!
//! * [`commands`]  — public command surface exposed to the frontend via
//!                   `invoke`. Each submodule maps to one feature area.
//! * [`db`]        — database abstraction layer shared by all commands.
//! * [`keychain`]  — OS-keychain integration for password storage.
//! * [`state`]     — runtime state (active pools, saved profiles).
//! * [`store`]     — on-disk persistence for non-sensitive profile metadata.
//! * [`error`]     — common error type, serialised to the frontend.

mod commands;
mod db;
mod error;
mod keychain;
mod prefs;
mod ssh_known_hosts;
mod state;
mod store;
mod tab_state;

use state::AppState;

/// Entry point invoked from `main.rs`.
///
/// Initialises the application state, registers the Tauri dialog plugin
/// (used for SQLite file pickers), and wires up every command handler.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Remembers window position, size, and maximised state across
        // launches. The plugin writes its own JSON blob alongside our
        // `prefs.json` / `tab_state.json` in the app config dir.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::connection::list_profiles,
            commands::connection::save_profile,
            commands::connection::delete_profile,
            commands::connection::test_connection,
            commands::connection::connect,
            commands::connection::disconnect,
            commands::connection::active_connections,
            commands::connection::forget_host_key,
            commands::connection::get_host_key,
            commands::schema::list_databases,
            commands::schema::list_tables,
            commands::schema::list_columns,
            commands::schema::list_indexes,
            commands::schema::server_version,
            commands::query::execute_query,
            commands::query::fetch_table_data,
            commands::query::update_cell,
            commands::query::delete_rows,
            commands::query::insert_row,
            commands::query::fetch_fk_options,
            commands::credentials::store_password,
            commands::credentials::load_password,
            commands::credentials::delete_password,
            commands::prefs::get_preferences,
            commands::prefs::update_preferences,
            commands::prefs::get_tab_state,
            commands::prefs::save_tab_state,
            commands::prefs::clear_tab_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running HuginnDB");
}
