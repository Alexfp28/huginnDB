//! Common error type returned from every Tauri command.
//!
//! Errors are serialised to the frontend as plain strings via the manual
//! [`Serialize`] impl below; the frontend renders them to the user as-is.
//! Wrapping native error types here (instead of returning `String`
//! directly) keeps Rust call sites idiomatic and allows future structured
//! error reporting without changing the wire format.

use serde::Serialize;
use thiserror::Error;

/// The single error variant exposed by the backend.
#[derive(Debug, Error)]
pub enum AppError {
    /// SQL driver or pool failure surfaced by `sqlx`.
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

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

    /// The supplied driver name is not one of the supported backends.
    #[error("unsupported driver: {0}")]
    UnsupportedDriver(String),
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
