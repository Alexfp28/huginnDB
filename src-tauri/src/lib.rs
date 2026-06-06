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
mod log_bus;
mod prefs;
mod ssh_known_hosts;
mod state;
mod store;
mod tab_state;
mod transfer;

use state::{AppState, StartupArgs};

/// Parse command-line arguments into [`StartupArgs`].
///
/// We intentionally avoid pulling in `clap` for the small set of flags we
/// support. Unknown flags are ignored silently so external launchers can pass
/// extra metadata without breaking the app.
fn parse_startup_args() -> StartupArgs {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut result = StartupArgs::default();
    let mut iter = args.iter().peekable();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--connect-profile" => {
                result.connect_profile = iter.next().cloned();
            }
            "--connect-profile-id" => {
                result.connect_profile = iter.next().cloned();
                result.connect_by_id = true;
            }
            "--host" => {
                result.adhoc_host = iter.next().cloned();
            }
            "--port" => {
                result.adhoc_port = iter.next().and_then(|v| v.parse().ok());
            }
            "--database" => {
                result.adhoc_database = iter.next().cloned();
            }
            // `--user` is an alias for `--username` — most CLI database tools
            // (psql, mysql) spell it `--user`/`-u`, so we accept both.
            "--username" | "--user" => {
                result.adhoc_username = iter.next().cloned();
            }
            // The password is opt-in via the CLI and lives only in memory for
            // this launch — it is passed straight to `connect` and never
            // written to the OS keychain. Works for both `--connect-profile`
            // (overrides the stored password) and ad-hoc connections.
            "--password" | "--pass" => {
                result.adhoc_password = iter.next().cloned();
            }
            "--driver" => {
                result.adhoc_driver = iter.next().cloned();
            }
            "--name" => {
                result.adhoc_name = iter.next().cloned();
            }
            _ => {}
        }
    }
    result
}

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
        // Auto-update infrastructure. The frontend calls `check()` on
        // launch (see `src/stores/update.ts`); endpoints and the public
        // verification key live in `tauri.conf.json`.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Lets the frontend relaunch the app after installing an update.
        .plugin(tauri_plugin_process::init())
        .manage(AppState::new_with_args(parse_startup_args()))
        .invoke_handler(tauri::generate_handler![
            commands::connection::list_profiles,
            commands::connection::save_profile,
            commands::connection::delete_profile,
            commands::connection::test_connection,
            commands::connection::connect,
            commands::connection::disconnect,
            commands::connection::active_connections,
            commands::connection::open_database_view,
            commands::connection::forget_host_key,
            commands::connection::get_host_key,
            commands::connection::analyze_import_file,
            commands::connection::export_profiles,
            commands::connection::import_profiles,
            commands::connection::get_startup_args,
            commands::schema::list_databases,
            commands::schema::list_tables,
            commands::schema::list_columns,
            commands::schema::list_indexes,
            commands::schema::drop_table,
            commands::schema::rename_table,
            commands::schema::server_version,
            commands::structure::get_table_structure,
            commands::structure::preview_structure_change,
            commands::structure::apply_structure_change,
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
            commands::workspaces::list_workspaces,
            commands::workspaces::get_active_workspace_id,
            commands::workspaces::create_workspace,
            commands::workspaces::rename_workspace,
            commands::workspaces::update_workspace_appearance,
            commands::workspaces::delete_workspace,
            commands::workspaces::reorder_workspaces,
            commands::workspaces::set_active_workspace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running HuginnDB");
}
