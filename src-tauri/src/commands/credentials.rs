use crate::error::{AppError, AppResult};
use keyring::Entry;

const SERVICE: &str = "io.huginn.app";

fn entry(account: &str) -> AppResult<Entry> {
    Entry::new(SERVICE, account).map_err(AppError::from)
}

#[tauri::command]
pub fn store_password(account: String, password: String) -> AppResult<()> {
    entry(&account)?.set_password(&password)?;
    Ok(())
}

#[tauri::command]
pub fn load_password(account: String) -> AppResult<Option<String>> {
    match entry(&account)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Keyring(e)),
    }
}

#[tauri::command]
pub fn delete_password(account: String) -> AppResult<()> {
    match entry(&account)?.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Keyring(e)),
    }
}
