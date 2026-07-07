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
mod keepalive;
mod keychain;
mod log_bus;
mod prefs;
mod ssh_known_hosts;
mod state;
mod store;
mod tab_state;
mod transfer;

use state::{AppState, StartupArgs};

/// Parse the process's own command-line arguments into [`StartupArgs`].
///
/// Thin wrapper over [`parse_cli_args`] for the cold-start path. We
/// intentionally avoid pulling in `clap` for the small set of flags we
/// support. Unknown flags are ignored silently so external launchers can pass
/// extra metadata without breaking the app.
fn parse_startup_args() -> StartupArgs {
    let argv: Vec<String> = std::env::args().collect();
    parse_cli_args(&argv)
}

/// Parse a full `argv` (program name at `argv[0]`) into [`StartupArgs`] and
/// log a redacted summary.
///
/// Shared by the cold-start path ([`parse_startup_args`]) and the
/// single-instance callback, which receives the *second* launch's argv with
/// the same shape (`argv[0]` is the executable). Both must `skip(1)` so the
/// program name is never mistaken for a flag value.
fn parse_cli_args(argv: &[String]) -> StartupArgs {
    let args: Vec<String> = argv.iter().skip(1).cloned().collect();
    let result = parse_args(&args);
    log_parsed_args(&result);
    result
}

/// Echo what we parsed to stderr when any flag was supplied. The user
/// typically launches from a terminal, so this is the quickest way to confirm
/// the args actually reached the app (and were spelled right) without opening
/// devtools. The password is intentionally not logged.
fn log_parsed_args(result: &StartupArgs) {
    let has_any = result.connect_profile.is_some()
        || result.adhoc_host.is_some()
        || result.adhoc_database.is_some()
        || result.adhoc_username.is_some()
        || result.adhoc_driver.is_some()
        || result.adhoc_connection_string.is_some();
    if has_any {
        eprintln!(
            "[cli] startup args: connect_profile={:?} by_id={} host={:?} port={:?} db={:?} user={:?} driver={:?} name={:?} password={}",
            result.connect_profile,
            result.connect_by_id,
            result.adhoc_host,
            result.adhoc_port,
            result.adhoc_database,
            result.adhoc_username,
            result.adhoc_driver,
            result.adhoc_name,
            if result.adhoc_password.is_some() { "<provided>" } else { "<none>" },
        );
    }
}

/// Pure arg-parser over an explicit slice (so it's unit-testable without
/// touching the process environment).
fn parse_args(args: &[String]) -> StartupArgs {
    let mut result = StartupArgs::default();
    let mut iter = args.iter().peekable();
    while let Some(raw) = iter.next() {
        // Accept both `--flag value` and `--flag=value`. We split on the FIRST
        // `=` so a value that itself contains `=` (e.g. a password) survives;
        // when there's no inline value we fall back to the next token. Without
        // this, `--password=secret` never matched `"--password"` and the
        // password was silently dropped.
        let (flag, inline) = match raw.split_once('=') {
            Some((f, v)) => (f, Some(v.to_string())),
            None => (raw.as_str(), None),
        };
        // Resolve a value: prefer the inline `=value`, else consume the next
        // token. Each arm calls this at most once, so moving `inline` is fine.
        let value = move |iter: &mut std::iter::Peekable<std::slice::Iter<'_, String>>| {
            inline.or_else(|| iter.next().cloned())
        };
        match flag {
            "--connect-profile" => {
                result.connect_profile = value(&mut iter);
            }
            "--connect-profile-id" => {
                result.connect_profile = value(&mut iter);
                result.connect_by_id = true;
            }
            "--host" => {
                result.adhoc_host = value(&mut iter);
            }
            "--port" => {
                result.adhoc_port = value(&mut iter).and_then(|v| v.parse().ok());
            }
            "--database" => {
                result.adhoc_database = value(&mut iter);
            }
            // `--user` is an alias for `--username` — most CLI database tools
            // (psql, mysql) spell it `--user`/`-u`, so we accept both.
            "--username" | "--user" => {
                result.adhoc_username = value(&mut iter);
            }
            // The password is opt-in via the CLI and lives only in memory for
            // this launch — it is passed straight to `connect` and never
            // written to the OS keychain. Works for both `--connect-profile`
            // (overrides the stored password) and ad-hoc connections.
            "--password" | "--pass" => {
                result.adhoc_password = value(&mut iter);
            }
            "--driver" => {
                result.adhoc_driver = value(&mut iter);
            }
            // Connection URI for an ad-hoc launch. The primary path for MongoDB
            // (`mongodb://…` / `mongodb+srv://…`); implies `--driver mongodb`
            // when no driver is given.
            "--connection-string" | "--uri" => {
                result.adhoc_connection_string = value(&mut iter);
            }
            // MongoDB authSource for the URI-less ad-hoc path (`--host … \
            // --auth-source admin`). Ignored when a full `--uri` is supplied,
            // which carries its own `?authSource=…`.
            "--auth-source" => {
                result.adhoc_auth_source = value(&mut iter);
            }
            "--name" => {
                result.adhoc_name = value(&mut iter);
            }
            _ => {}
        }
    }
    result
}

#[cfg(test)]
mod cli_tests {
    use super::parse_args;

    fn v(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn equals_form_is_accepted() {
        // The original bug: `--password=secret` (and friends) never matched
        // and the value was silently dropped.
        let a = parse_args(&v(&[
            "--host=db.example.com",
            "--port=46005",
            "--database=iMesPyme",
            "--username=ITB_industria",
            "--password=ITBCastellon",
        ]));
        assert_eq!(a.adhoc_host.as_deref(), Some("db.example.com"));
        assert_eq!(a.adhoc_port, Some(46005));
        assert_eq!(a.adhoc_database.as_deref(), Some("iMesPyme"));
        assert_eq!(a.adhoc_username.as_deref(), Some("ITB_industria"));
        assert_eq!(a.adhoc_password.as_deref(), Some("ITBCastellon"));
    }

    #[test]
    fn space_form_still_works_and_user_alias() {
        let a = parse_args(&v(&[
            "--host",
            "localhost",
            "--user",
            "root",
            "--pass",
            "hunter2",
        ]));
        assert_eq!(a.adhoc_host.as_deref(), Some("localhost"));
        assert_eq!(a.adhoc_username.as_deref(), Some("root"));
        assert_eq!(a.adhoc_password.as_deref(), Some("hunter2"));
    }

    #[test]
    fn password_may_contain_equals() {
        // split_once('=') must only split on the first '='.
        let a = parse_args(&v(&["--password=a=b=c"]));
        assert_eq!(a.adhoc_password.as_deref(), Some("a=b=c"));
    }

    #[test]
    fn connection_string_uri_flag() {
        // `--uri` is the MongoDB-friendly alias; the value (an SRV URI with its
        // own `=` query params) must survive the first-`=` split.
        let a = parse_args(&v(&[
            "--uri=mongodb+srv://u:p@cluster.mongodb.net/db?retryWrites=true",
        ]));
        assert_eq!(
            a.adhoc_connection_string.as_deref(),
            Some("mongodb+srv://u:p@cluster.mongodb.net/db?retryWrites=true")
        );
        // The long spelling and the space form work too.
        let b = parse_args(&v(&["--connection-string", "mongodb://localhost:27017"]));
        assert_eq!(
            b.adhoc_connection_string.as_deref(),
            Some("mongodb://localhost:27017")
        );
    }

    #[test]
    fn auth_source_flag() {
        let a = parse_args(&v(&[
            "--host=localhost",
            "--username=root",
            "--auth-source=admin",
        ]));
        assert_eq!(a.adhoc_auth_source.as_deref(), Some("admin"));
        // Space form too.
        let b = parse_args(&v(&["--auth-source", "myAuthDb"]));
        assert_eq!(b.adhoc_auth_source.as_deref(), Some("myAuthDb"));
    }

    #[test]
    fn connect_profile_id_sets_flag() {
        let a = parse_args(&v(&["--connect-profile-id=abc-123"]));
        assert_eq!(a.connect_profile.as_deref(), Some("abc-123"));
        assert!(a.connect_by_id);
    }
}

/// Does this parsed arg set carry a connection intent (vs. just flags we
/// ignore)? Mirrors the frontend's own check in `App.tsx`.
fn has_connection_intent(args: &StartupArgs) -> bool {
    args.connect_profile.is_some()
        || args.adhoc_host.is_some()
        || args.adhoc_connection_string.is_some()
}

/// Tauri event carrying a *second* launch's connection intent to the running
/// instance. The frontend listens on this (see `cli-connect-bridge.ts`) and
/// asks the user whether to open it in a new or the active workspace.
#[cfg(desktop)]
const CLI_CONNECT_EVENT: &str = "huginndb://cli-connect";

/// Single-instance callback: a second `huginndb …` launch landed while this
/// process owns the lock. Focus the existing window and, if the new argv
/// carries a connection, buffer it and emit [`CLI_CONNECT_EVENT`] so the
/// frontend can route it into a workspace. A launch with no connection flags
/// just brings the window to the front.
#[cfg(desktop)]
fn handle_second_instance(app: &tauri::AppHandle, argv: Vec<String>) {
    use tauri::{Emitter, Manager};

    // Bring the existing window forward. Prefer the labelled "main" window;
    // fall back to whatever window exists so a config change to the label
    // can't silently break focus.
    if let Some(window) = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next())
    {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }

    let args = parse_cli_args(&argv);
    if !has_connection_intent(&args) {
        return;
    }
    // Buffer before emitting so a launch that races the window's boot is not
    // lost (events are not replayed for late subscribers). The frontend
    // drains this on bridge mount and then relies on the live event.
    *app.state::<AppState>().pending_cli_connect.write() = Some(args.clone());
    let _ = app.emit(CLI_CONNECT_EVENT, args);
}

/// Entry point invoked from `main.rs`.
///
/// Initialises the application state, registers the Tauri dialog plugin
/// (used for SQLite file pickers), and wires up every command handler.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();
    // The single-instance plugin MUST be registered before any other so its
    // argv-forwarding lock is installed first. Desktop-only: there is no
    // second-launch concept on mobile.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            handle_second_instance(app, argv);
        }));
    }
    builder
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
        // Opens external URLs in the OS default browser. The in-app issue
        // reporter relies on this: `window.open` is a no-op in the WebView.
        .plugin(tauri_plugin_opener::init())
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
            commands::connection::take_pending_cli_connect,
            commands::connection::open_new_window,
            commands::connection::take_window_startup_intent,
            commands::schema::list_databases,
            commands::schema::create_database,
            commands::schema::drop_database,
            commands::schema::list_tables,
            commands::schema::list_columns,
            commands::schema::list_indexes,
            commands::schema::drop_table,
            commands::schema::rename_table,
            commands::schema::server_version,
            commands::schema::list_users,
            commands::schema::list_privileges,
            commands::structure::get_table_structure,
            commands::structure::preview_structure_change,
            commands::structure::apply_structure_change,
            commands::query::execute_query,
            commands::query::execute_batch,
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
            commands::feedback::get_diagnostics,
            commands::feedback::set_github_pat,
            commands::feedback::has_github_pat,
            commands::feedback::clear_github_pat,
            commands::feedback::submit_issue,
            commands::feedback::mailto_report_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running HuginnDB");
}
