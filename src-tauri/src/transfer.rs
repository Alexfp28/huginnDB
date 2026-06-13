//! Import/Export of connection profiles.
//!
//! Handles the on-disk format for `.json` profile bundles and the optional
//! AES-256-GCM encryption of individual secrets when the user opts to include
//! passwords in the export.
//!
//! ## File format (version 1)
//!
//! ```json
//! {
//!   "meta": { "version": 1, "app": "huginndb", "exported_at": "...", "encrypted": false },
//!   "profiles": [
//!     {
//!       "id": "...",
//!       "name": "...",
//!       ...connection profile fields...,
//!       "secrets": null
//!     }
//!   ]
//! }
//! ```
//!
//! When `meta.encrypted = true` every `secrets` object contains base64-encoded
//! ciphertext blobs. Each blob carries its own random salt and nonce so that
//! different profiles (or even the same profile's DB vs SSH secret) can be
//! decrypted independently even if the file is partially corrupted.
//!
//! ## Encryption scheme
//!
//! Each secret value is encrypted as:
//!   `base64( salt[16] || nonce[12] || AES-256-GCM(plaintext) )`
//!
//! The 256-bit AES key is derived with PBKDF2-HMAC-SHA256 at 600 000
//! iterations (NIST SP 800-132 minimum for interactive use).

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use pbkdf2::pbkdf2_hmac;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::error::{AppError, AppResult};
use crate::state::ConnectionProfile;

// ---------------------------------------------------------------------------
// File-format types
// ---------------------------------------------------------------------------

/// Top-level wrapper for the exported JSON file.
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportFile {
    pub meta: ExportMetadata,
    pub profiles: Vec<ExportedProfile>,
}

/// Metadata header describing the file.
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportMetadata {
    /// Always `1` for this version of the format.
    pub version: u8,
    /// Constant `"huginndb"` — lets importers from other tools detect the origin.
    pub app: String,
    /// RFC 3339 timestamp of when the file was written.
    pub exported_at: String,
    /// `true` when `ExportedSecret` values are AES-256-GCM ciphertext;
    /// `false` when `secrets` is `null` for every profile.
    pub encrypted: bool,
}

/// One profile entry inside the export file.
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportedProfile {
    /// All non-sensitive metadata. Flattened so the JSON shape is a superset
    /// of the regular `profiles.json` entry.
    #[serde(flatten)]
    pub profile: ConnectionProfile,
    /// `None` when the file was exported without passwords.
    /// When present, each field is either `None` (no secret exists for that
    /// slot) or a base64-encoded ciphertext.
    pub secrets: Option<ExportedSecret>,
}

/// Optional secret payload attached to an exported profile.
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportedSecret {
    /// DB password ciphertext, or `None` if the profile has no DB password.
    pub db_password: Option<String>,
    /// SSH secret (password or key passphrase) ciphertext, or `None`.
    pub ssh_secret: Option<String>,
}

// ---------------------------------------------------------------------------
// Analysis / import result types (returned to the frontend as DTOs)
// ---------------------------------------------------------------------------

/// Summary returned by `analyze_import_file` so the UI can present the user
/// with a conflict-resolution step before committing to the import.
#[derive(Debug, Serialize, Deserialize)]
pub struct ImportAnalysis {
    /// Total number of profiles in the file.
    pub total: usize,
    /// Whether the file contains encrypted secrets (requires a passphrase).
    pub encrypted: bool,
    /// Profiles whose `id` already exists in the current profile list.
    pub conflicts: Vec<ImportConflict>,
}

/// One conflicting profile.
#[derive(Debug, Serialize, Deserialize)]
pub struct ImportConflict {
    /// The `id` shared by both the existing and incoming profile.
    pub id: String,
    pub existing_name: String,
    pub incoming_name: String,
}

/// Per-conflict action chosen by the user.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConflictAction {
    /// Replace the existing profile (and its keychain entries) with the
    /// imported one. A fresh UUID is generated for the imported copy so
    /// keychain accounts don't collide.
    Overwrite,
    /// Skip this profile entirely.
    Skip,
    /// Import as a new profile with an auto-generated name suffix.
    Rename,
}

/// Caller-supplied resolution for one conflict.
#[derive(Debug, Serialize, Deserialize)]
pub struct ConflictResolution {
    pub id: String,
    pub action: ConflictAction,
}

/// Summary returned to the frontend after `import_profiles` completes.
#[derive(Debug, Serialize, Deserialize)]
pub struct ImportResult {
    /// Ids (post-UUID-remapping) of profiles that were added successfully.
    pub imported: Vec<String>,
    /// Original ids of profiles that were skipped.
    pub skipped: Vec<String>,
    /// `(original_name, new_name)` pairs for profiles that were renamed to
    /// avoid duplicate display names.
    pub renamed: Vec<(String, String)>,
    /// Ids of imported profiles that arrived without passwords and will
    /// need manual credential setup before they can connect.
    pub needs_password: Vec<String>,
}

// ---------------------------------------------------------------------------
// Encryption helpers
// ---------------------------------------------------------------------------

const PBKDF2_ITERATIONS: u32 = 600_000;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32; // AES-256

/// Encrypt `plaintext` with AES-256-GCM, deriving the key from `passphrase`
/// via PBKDF2-HMAC-SHA256.
///
/// Returns a base64 string containing the concatenated `salt || nonce ||
/// ciphertext+tag` so the output is self-contained.
pub fn encrypt_secret(plaintext: &str, passphrase: &str) -> AppResult<String> {
    // Random salt and nonce — each call produces unique output even for
    // identical plaintexts.
    let mut salt = [0u8; SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce_bytes);

    let key = derive_key(passphrase, &salt);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|_| AppError::Transfer("encryption failed".into()))?;

    // Pack: salt || nonce || ciphertext
    let mut payload = Vec::with_capacity(SALT_LEN + NONCE_LEN + ciphertext.len());
    payload.extend_from_slice(&salt);
    payload.extend_from_slice(&nonce_bytes);
    payload.extend_from_slice(&ciphertext);

    Ok(B64.encode(&payload))
}

/// Decrypt a value produced by [`encrypt_secret`].
pub fn decrypt_secret(encoded: &str, passphrase: &str) -> AppResult<String> {
    let payload = B64
        .decode(encoded)
        .map_err(|_| AppError::Transfer("invalid base64 in encrypted secret".into()))?;

    if payload.len() < SALT_LEN + NONCE_LEN {
        return Err(AppError::Transfer("encrypted secret too short".into()));
    }

    let (salt, rest) = payload.split_at(SALT_LEN);
    let (nonce_bytes, ciphertext) = rest.split_at(NONCE_LEN);

    let key = derive_key(passphrase, salt);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| AppError::Transfer("decryption failed — wrong passphrase?".into()))?;

    String::from_utf8(plaintext)
        .map_err(|_| AppError::Transfer("decrypted value is not UTF-8".into()))
}

fn derive_key(passphrase: &str, salt: &[u8]) -> [u8; KEY_LEN] {
    let mut key = [0u8; KEY_LEN];
    pbkdf2_hmac::<Sha256>(passphrase.as_bytes(), salt, PBKDF2_ITERATIONS, &mut key);
    key
}
