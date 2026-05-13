mod commands;
mod error;
mod state;
mod store;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::connection::list_profiles,
            commands::connection::save_profile,
            commands::connection::delete_profile,
            commands::connection::test_connection,
            commands::connection::connect,
            commands::connection::disconnect,
            commands::connection::active_connections,
            commands::schema::list_databases,
            commands::schema::list_tables,
            commands::schema::list_columns,
            commands::schema::list_indexes,
            commands::query::execute_query,
            commands::query::fetch_table_data,
            commands::query::update_cell,
            commands::credentials::store_password,
            commands::credentials::load_password,
            commands::credentials::delete_password,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Huginn");
}
