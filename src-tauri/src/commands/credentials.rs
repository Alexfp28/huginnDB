//! Low-level credential commands.
//!
//! These are exposed in addition to [`crate::commands::connection`] for
//! cases where the frontend wants to read or remove a password directly
//! (e.g. when prompting the user before reconnecting). All routes through
//! the centralised [`crate::keychain`] module.

use crate::error::AppResult;
use crate::keychain;

/// Store `password` under `account` in the OS keychain.
#[tauri::command]
pub fn store_password(account: String, password: String) -> AppResult<()> {
    keychain::set_password(&account, &password)
}

/// Return the password for `account`, or `None` if no entry exists.
#[tauri::command]
pub fn load_password(account: String) -> AppResult<Option<String>> {
    keychain::get_password(&account)
}

/// Remove the entry for `account`. Succeeds if it didn't exist.
#[tauri::command]
pub fn delete_password(account: String) -> AppResult<()> {
    keychain::delete_password(&account)
}
