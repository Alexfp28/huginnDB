//! Common error type returned from every Tauri command.
//!
//! Errors are serialised to the frontend as plain strings via the manual
//! [`Serialize`] impl below; the frontend renders them to the user as-is.
//! Wrapping native error types here (instead of returning `String`
//! directly) keeps Rust call sites idiomatic and allows future structured
//! error reporting without changing the wire format.

use serde::Serialize;
use thiserror::Error;

/// The error type every Tauri command returns. Each variant maps to one
/// failure domain; the `#[error(...)]` prefix is what the user actually sees,
/// so keep those messages actionable.
#[derive(Debug, Error)]
pub enum AppError {
    /// SQL driver or pool failure surfaced by `sqlx`.
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    /// MongoDB driver, command, or BSON failure surfaced by the `mongodb` crate.
    #[error("mongodb error: {0}")]
    Mongo(#[from] mongodb::error::Error),

    /// SQL Server (TDS) failure surfaced by the `tiberius` crate. Kept separate
    /// from [`Self::Database`] because SQL Server does not go through `sqlx`
    /// (see [`crate::db::mssql`]); its `Server` variant already carries the
    /// server's own message and number, which is what the user needs to see.
    #[error("sql server error: {0}")]
    MsSql(#[from] tiberius::error::Error),

    /// OS keychain failure (Credential Manager / libsecret / Keychain).
    #[error("keyring error: {0}")]
    Keyring(#[from] keyring::Error),

    /// Filesystem I/O failure when reading or writing profile metadata.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// JSON (de)serialisation failure for persisted profiles.
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    /// A caller-provided argument failed validation.
    #[error("invalid input: {0}")]
    InvalidInput(String),

    /// A command was invoked against a profile that has no live connection.
    #[error("not connected: {0}")]
    NotConnected(String),

    /// Lookup failure for a profile, password, or other addressable resource.
    #[error("not found: {0}")]
    NotFound(String),

    /// The connection's driver does not support the requested operation (e.g.
    /// view editing against MongoDB). Distinct from [`Self::InvalidInput`]:
    /// the argument was well-formed, the *backend* can't honour it.
    #[error("unsupported driver: {0}")]
    UnsupportedDriver(String),

    /// SSH transport, authentication, or channel failure surfaced by `russh`.
    #[error("ssh error: {0}")]
    Ssh(String),

    /// Import/export error (format validation, encryption, decryption).
    #[error("transfer error: {0}")]
    Transfer(String),

    /// Outbound HTTP failure surfaced by `reqwest` (in-app issue reporter).
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),

    /// Tauri window-management failure (e.g. creating a new window).
    #[error("window error: {0}")]
    Window(#[from] tauri::Error),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Shorthand for `Result<T, AppError>`.
pub type AppResult<T> = Result<T, AppError>;
