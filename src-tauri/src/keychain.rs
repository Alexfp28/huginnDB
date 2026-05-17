//! OS-keychain integration.
//!
//! Wraps the [`keyring`] crate behind a small, app-specific API so the rest
//! of the codebase never has to know which native keystore is in use.
//! On Windows the backend is the Credential Manager; on Linux the freedesktop
//! Secret Service (libsecret/gnome-keyring/KWallet); on macOS the Keychain.
//!
//! Connection passwords are stored under a single service (`SERVICE`) keyed
//! by a per-profile "account" string. The account is derived by the caller
//! via [`crate::state::ConnectionProfile::keyring_account`].

use crate::error::{AppError, AppResult};
use keyring::Entry;

/// Service identifier registered with the OS keychain.
///
/// All HuginnDB credentials share this service so they show up grouped in
/// platform credential managers and can be cleanly removed if a user
/// uninstalls the application.
pub const SERVICE: &str = "io.huginndb.app";

/// Build a keyring `Entry` for `account` under the HuginnDB service.
fn entry(account: &str) -> AppResult<Entry> {
    Entry::new(SERVICE, account).map_err(AppError::from)
}

/// Persist `password` for `account`. Overwrites any previous value.
pub fn set_password(account: &str, password: &str) -> AppResult<()> {
    entry(account)?.set_password(password)?;
    Ok(())
}

/// Read the password for `account`, returning `Ok(None)` if no entry exists.
pub fn get_password(account: &str) -> AppResult<Option<String>> {
    match entry(account)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Keyring(e)),
    }
}

/// Delete the entry for `account`, succeeding if it didn't exist.
pub fn delete_password(account: &str) -> AppResult<()> {
    match entry(account)?.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Keyring(e)),
    }
}

/// Like [`get_password`] but returns a typed error when the entry is absent.
///
/// Useful in flows where a missing password is unambiguously a setup
/// problem rather than an optional state.
pub fn require_password(account: &str) -> AppResult<String> {
    get_password(account)?.ok_or_else(|| {
        AppError::NotFound(format!("no stored password for keychain account {account}"))
    })
}
