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
use crate::json_schemas::{JsonSchemaBinding, JsonSchemaItem};
use crate::keychain;
use crate::state::{ConnectionProfile, Driver};

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
    /// `"profiles"` (a plain profile bundle) or `"environment"` (an
    /// [`EnvironmentExportFile`]). `#[serde(default)]` so a pre-existing
    /// profile-bundle file — written before this field existed — loads as
    /// `""`, which every `kind` check below treats the same as `"profiles"`.
    /// Lets `import_profiles` refuse an environment file (and vice versa)
    /// with a clear error instead of silently importing half of it.
    #[serde(default)]
    pub kind: String,
}

/// A profile bundle's `meta.kind` — also the default for a legacy file that
/// predates the field.
pub const KIND_PROFILES: &str = "profiles";
/// An [`EnvironmentExportFile`]'s `meta.kind`.
pub const KIND_ENVIRONMENT: &str = "environment";
/// A [`JsonSchemaExportFile`]'s `meta.kind`.
pub const KIND_JSON_SCHEMAS: &str = "json-schemas";

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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
// Environment export/import
// ---------------------------------------------------------------------------
//
// An environment's *portable* identity is its name/color/icon/theme, the
// connection profiles it groups, and the shared origins it pulls from — not
// its tabs, dockview geometry or launch state. Those are session artifacts
// tied to the machine that produced them (CLAUDE.md gotcha #10: the inner
// dockview's geometry is a JSON blob keyed to panel ids from that machine's
// `useTabs`), so portability stops at "which connections, from where".
//
// A single export can bundle **more than one** environment — the picker lets
// the user select any subset — so the file format is one file, N environment
// bundles, and one deduplicated pool of connection profiles the bundles
// reference by id (see `EnvironmentExportFile`'s doc for why they're not
// duplicated per environment).
//
// Importing an environment always creates a **new** one — never merges into
// an existing one — so there is nothing for its origins or cosmetic fields to
// conflict with. The only genuine conflict is at the connection-profile layer
// (`profiles.json` is global), which is why this reuses the exact
// `ImportConflict` / `ConflictAction` / `ImportResult` machinery `import_profiles`
// already has, rather than inventing a parallel one.

/// Top-level wrapper for one or more exported environments. Shares
/// [`ExportMetadata`] with [`ExportFile`] (with `meta.kind` set to
/// [`KIND_ENVIRONMENT`]) so both formats carry the same version/encryption
/// header.
///
/// `profiles` is a single **deduplicated** union of every connection profile
/// referenced by any environment in `environments` — not one copy per
/// environment. Two exported environments sharing a connection (a common
/// "Producción" + "Staging" split against the same jump-box server) would
/// otherwise duplicate that profile, its secrets, and — on import — its
/// keychain entry. Each bundle instead lists which of the shared `profiles`
/// it references by id, resolved back into that environment's
/// `launch.visible_connections` after import (`connection_ids` names
/// *original* ids, the same ones `ExportedProfile.profile.id` carries; the
/// map from original id to post-import fresh id is threaded through
/// `apply_profile_imports`'s second return value).
#[derive(Debug, Serialize, Deserialize)]
pub struct EnvironmentExportFile {
    pub meta: ExportMetadata,
    pub environments: Vec<ExportedEnvironmentBundle>,
    pub profiles: Vec<ExportedProfile>,
    /// Optional JSON Schema library slice, present when the user ticked
    /// "include JSON Schemas".
    ///
    /// Schemas are **global**, not owned by an environment (see
    /// [`crate::json_schemas`]), so this is not part of an environment's
    /// portable identity the way `origins` and `connection_ids` are — it rides
    /// along so one file can set up a new machine. `#[serde(default)]` so every
    /// file written before 1.17.0 still loads, and `skip_serializing_if` so an
    /// export without them stays byte-identical to a 1.16 one.
    #[serde(default, skip_serializing_if = "JsonSchemaBundle::is_empty")]
    pub json_schemas: JsonSchemaBundle,
}

/// The portable JSON Schema payload.
///
/// One type with three homes: flattened into a standalone
/// [`JsonSchemaExportFile`], carried by [`EnvironmentExportFile`], and — from
/// 1.18.0 — by the plain [`ExportFile`] a shared origin publishes. That reuse is
/// what makes the origin work purely additive: one `#[serde(default)]` field.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct JsonSchemaBundle {
    #[serde(default)]
    pub schemas: Vec<JsonSchemaItem>,
    #[serde(default)]
    pub bindings: Vec<JsonSchemaBinding>,
}

impl JsonSchemaBundle {
    pub fn is_empty(&self) -> bool {
        self.schemas.is_empty() && self.bindings.is_empty()
    }
}

/// A standalone schema-library export.
///
/// No passphrase and no `encrypted` payload: a JSON Schema is not a secret and
/// there is no keychain material anywhere in it, so [`ExportMetadata::encrypted`]
/// is always `false` here.
#[derive(Debug, Serialize, Deserialize)]
pub struct JsonSchemaExportFile {
    pub meta: ExportMetadata,
    #[serde(flatten)]
    pub bundle: JsonSchemaBundle,
}

/// Summary returned by `analyze_json_schema_import`, so the wizard can show
/// what a file holds — and what it will have to disable — before committing.
#[derive(Debug, Serialize, Deserialize)]
pub struct JsonSchemaImportAnalysis {
    pub total_schemas: usize,
    pub total_bindings: usize,
    /// Schemas in the file whose **name** already exists locally. Keyed on the
    /// name rather than the id, unlike [`detect_conflicts`] — see
    /// [`crate::json_schemas::JsonSchemaItem::name`] for why an id can never
    /// collide here and a name always will.
    pub conflicts: Vec<ImportConflict>,
    /// How many bindings would land disabled because they name a connection
    /// this machine does not have. Reported up front so the count is not a
    /// surprise buried in the result.
    pub bindings_unresolvable: usize,
}

/// Outcome of `import_json_schemas`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct JsonSchemaImportResult {
    /// Names of schemas added as new entries.
    pub imported: Vec<String>,
    pub skipped: Vec<String>,
    pub overwritten: Vec<String>,
    /// `(original name, stored name)` for each renamed entry.
    pub renamed: Vec<(String, String)>,
    pub bindings_imported: usize,
    /// Imported with `enabled: false` because their connection is unknown here.
    pub bindings_disabled: usize,
    /// Dropped because the schema they point at was skipped.
    pub bindings_dropped: usize,
    /// Not inserted because an identical rule already existed.
    pub bindings_duplicate: usize,
}

/// One environment's slice of an [`EnvironmentExportFile`]: its cosmetic
/// identity, which of the file's shared `profiles` it groups, and its own
/// registered origins.
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportedEnvironmentBundle {
    pub environment: ExportedEnvironment,
    /// Ids into the sibling `EnvironmentExportFile::profiles` list.
    pub connection_ids: Vec<String>,
    pub origins: Vec<ExportedOrigin>,
}

/// The environment's cosmetic identity. Deliberately has no portable `id`:
/// the one-shot `import_environment` always mints a fresh one, since it never
/// merges into an existing environment (see the module-level note above).
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportedEnvironment {
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub theme_id: Option<String>,
    /// The publisher's own `Environment.id` at export time. `import_environment`
    /// ignores this field on purpose — it always mints a fresh local id. It
    /// exists for the *other* consumer of this file shape: an origin (#108)
    /// registered against a `kind = "environment"` export, whose continuous
    /// `sync_origin` pull needs a stable way to recognise "the same" bundle
    /// across repeated syncs (`tab_state::Environment::origin_source_id`).
    /// `#[serde(default)]` so a file exported before this field existed still
    /// parses — it just can never be matched by the sync path, only imported
    /// once.
    #[serde(default)]
    pub source_environment_id: String,
}

/// A shared origin's *registration* — name and path only, never its
/// passphrase. Mirrors the threat model `origins.rs` already documents: the
/// passphrase travels out-of-band (the admin tells the new hire), never
/// through a file. An imported encrypted origin surfaces the same "no
/// passphrase stored" state a freshly `add_origin`-ed one does until the user
/// enters it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedOrigin {
    pub name: String,
    pub path: String,
}

/// Summary returned by `analyze_environment_import`. Mirrors [`ImportAnalysis`]
/// but scoped to what an environment import needs decided up front — one
/// entry per environment in the file, plus the conflicts and encryption flag
/// that apply to the file's shared `profiles` as a whole.
#[derive(Debug, Serialize, Deserialize)]
pub struct EnvironmentImportAnalysis {
    pub environments: Vec<EnvironmentImportAnalysisEntry>,
    pub total_profiles: usize,
    pub encrypted: bool,
    pub conflicts: Vec<ImportConflict>,
    /// How many JSON Schemas ride along in this file, for display only. Schema
    /// name conflicts are resolved by the *same* `conflict_resolutions` list as
    /// the profiles, keyed by the incoming schema id, so they need no separate
    /// step in the wizard.
    #[serde(default)]
    pub total_json_schemas: usize,
    #[serde(default)]
    pub total_json_schema_bindings: usize,
}

/// Display summary for one environment inside an
/// [`EnvironmentImportAnalysis`] — enough for the picker to show what each
/// one is without decrypting or importing anything yet.
///
/// `camelCase` on the wire (unlike its parent [`EnvironmentImportAnalysis`],
/// which keeps `total_profiles` etc. snake_case): the frontend's
/// `EnvironmentImportAnalysisEntry` in `src/types.ts` was written expecting
/// `connectionCount`, and nothing round-trips this type through disk, so
/// there is no old file format to stay compatible with.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentImportAnalysisEntry {
    pub name: String,
    pub connection_count: usize,
    /// For display only ("N shared origins will be registered") — origins
    /// never conflict, since import always lands in a brand-new environment.
    pub origins: Vec<ExportedOrigin>,
}

/// Result of `import_environment` — one new environment per bundle in the
/// file, plus the shared profile-import outcome (imported/skipped/renamed
/// apply across the whole file, not per environment, since `profiles` is a
/// single deduplicated list).
#[derive(Debug, Serialize, Deserialize)]
pub struct EnvironmentImportResult {
    pub environments: Vec<ImportedEnvironment>,
    pub profiles: ImportResult,
    /// Present only when the file carried a JSON Schema bundle. `None` is
    /// meaningfully different from a zeroed result: it means the exporter did
    /// not tick the box, so the UI says nothing rather than "0 schemas".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub json_schemas: Option<JsonSchemaImportResult>,
}

/// One environment created by `import_environment`.
///
/// `camelCase` on the wire, matching `src/types.ts`'s `environmentId` /
/// `originIds` — this DTO is a command return value, never read back from a
/// file, so there is no on-disk format to keep snake_case for (contrast
/// [`EnvironmentImportResult::json_schemas`], which deliberately stays
/// snake_case one level up).
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedEnvironment {
    pub environment_id: String,
    pub name: String,
    /// Ids of the origins registered in this environment, in file order.
    pub origin_ids: Vec<String>,
}

/// Profiles in `incoming` whose `id` already exists in `existing`. Shared by
/// `analyze_import_file` and `analyze_environment_import` — the conflict rule
/// (same id, different bundle) doesn't care which command found it.
pub fn detect_conflicts(
    existing: &[ConnectionProfile],
    incoming: &[ExportedProfile],
) -> Vec<ImportConflict> {
    incoming
        .iter()
        .filter_map(|ep| {
            existing
                .iter()
                .find(|p| p.id == ep.profile.id)
                .map(|found| ImportConflict {
                    id: ep.profile.id.clone(),
                    existing_name: found.name.clone(),
                    incoming_name: ep.profile.name.clone(),
                })
        })
        .collect()
}

/// Build the `profiles` section of an export file: snapshot each profile's
/// metadata and, when `include_passwords` is set, its keychain secrets
/// encrypted with `passphrase`. Shared by `export_profiles` and
/// `export_environment` — same rules either way, just a different subset of
/// profiles feeding in.
pub fn build_exported_profiles(
    profiles: &[ConnectionProfile],
    include_passwords: bool,
    passphrase: Option<&str>,
) -> AppResult<Vec<ExportedProfile>> {
    let mut exported = Vec::with_capacity(profiles.len());
    for profile in profiles {
        let secrets = if include_passwords {
            let pp = passphrase.ok_or_else(|| {
                AppError::InvalidInput(
                    "a passphrase is required when include_passwords is true".into(),
                )
            })?;
            let db_password = if matches!(profile.driver, Driver::Sqlite) {
                None
            } else {
                keychain::get_password(&profile.keyring_account())?
                    .map(|pw| encrypt_secret(&pw, pp))
                    .transpose()?
            };
            let ssh_secret = profile
                .ssh_keyring_account()
                .and_then(|acct| keychain::get_password(&acct).ok().flatten())
                .map(|s| encrypt_secret(&s, pp))
                .transpose()?;
            Some(ExportedSecret {
                db_password,
                ssh_secret,
            })
        } else {
            None
        };
        exported.push(ExportedProfile {
            profile: profile.clone(),
            secrets,
        });
    }
    Ok(exported)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Driver;

    fn profile(id: &str, name: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: id.into(),
            name: name.into(),
            driver: Driver::Postgres,
            host: "localhost".into(),
            port: 5432,
            database: String::new(),
            username: "u".into(),
            ssl: false,
            ssh_tunnel: None,
            connection_string: None,
            auth_source: None,
            mssql: None,
            ephemeral: false,
            group: None,
            visible_databases: None,
            mcp_write: Default::default(),
            max_connections: None,
            origin_id: None,
        }
    }

    fn exported(id: &str, name: &str) -> ExportedProfile {
        ExportedProfile {
            profile: profile(id, name),
            secrets: None,
        }
    }

    #[test]
    fn detect_conflicts_matches_by_id_not_name() {
        // A profile renamed on either side is still the same connection — the
        // conflict is keyed on `id`, and the two names are carried through so
        // the UI can show both.
        let existing = vec![profile("a", "Prod")];
        let incoming = vec![
            exported("a", "Prod (renamed upstream)"),
            exported("b", "New"),
        ];
        let conflicts = detect_conflicts(&existing, &incoming);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].id, "a");
        assert_eq!(conflicts[0].existing_name, "Prod");
        assert_eq!(conflicts[0].incoming_name, "Prod (renamed upstream)");
    }

    #[test]
    fn detect_conflicts_is_empty_when_no_ids_overlap() {
        let existing = vec![profile("a", "Prod")];
        let incoming = vec![exported("b", "New")];
        assert!(detect_conflicts(&existing, &incoming).is_empty());
    }

    #[test]
    fn export_metadata_kind_defaults_to_empty_for_legacy_files() {
        // A profile bundle written before `kind` existed must still parse,
        // and every `kind` check downstream (import_profiles,
        // analyze_import_file) treats "" the same as `KIND_PROFILES`.
        let legacy = r#"{
            "version": 1, "app": "huginndb",
            "exported_at": "2020-01-01T00:00:00Z", "encrypted": false
        }"#;
        let meta: ExportMetadata = serde_json::from_str(legacy).unwrap();
        assert_eq!(meta.kind, "");
    }

    #[test]
    fn the_three_export_kinds_are_distinct() {
        // Each importer rejects the other two by exact match, so a collision
        // here would let one silently import half of another kind of file.
        assert_ne!(KIND_PROFILES, KIND_ENVIRONMENT);
        assert_ne!(KIND_PROFILES, KIND_JSON_SCHEMAS);
        assert_ne!(KIND_ENVIRONMENT, KIND_JSON_SCHEMAS);
    }

    #[test]
    fn an_environment_export_written_before_1_17_still_parses() {
        // The direct analogue of the `kind` test above: `json_schemas` is a
        // `#[serde(default)]` addition, so every file already in the wild loads
        // unchanged and simply carries an empty bundle.
        let legacy = r#"{
            "meta": {
                "version": 1, "app": "huginndb",
                "exported_at": "2020-01-01T00:00:00Z",
                "encrypted": false, "kind": "environment"
            },
            "environments": [],
            "profiles": []
        }"#;
        let file: EnvironmentExportFile = serde_json::from_str(legacy).unwrap();
        assert!(file.json_schemas.is_empty());
    }

    #[test]
    fn an_export_without_schemas_serialises_no_json_schemas_key() {
        // `skip_serializing_if` keeps a 1.17 export that did not opt in
        // byte-identical to a 1.16 one, so diffing two exports stays useful.
        let file = EnvironmentExportFile {
            meta: ExportMetadata {
                version: 1,
                app: "huginndb".into(),
                exported_at: "2026-08-19T00:00:00Z".into(),
                encrypted: false,
                kind: KIND_ENVIRONMENT.into(),
            },
            environments: vec![],
            profiles: vec![],
            json_schemas: JsonSchemaBundle::default(),
        };
        let json = serde_json::to_string(&file).unwrap();
        assert!(!json.contains("json_schemas"));
    }

    #[test]
    fn a_json_schema_export_file_round_trips_its_flattened_bundle() {
        let file = JsonSchemaExportFile {
            meta: ExportMetadata {
                version: 1,
                app: "huginndb".into(),
                exported_at: "2026-08-19T00:00:00Z".into(),
                encrypted: false,
                kind: KIND_JSON_SCHEMAS.into(),
            },
            bundle: JsonSchemaBundle {
                schemas: vec![JsonSchemaItem {
                    id: "s1".into(),
                    name: "cfg".into(),
                    body: r#"{"type":"object"}"#.into(),
                    ..Default::default()
                }],
                bindings: vec![],
            },
        };
        let json = serde_json::to_string(&file).unwrap();
        // Flattened: `schemas` sits next to `meta`, not nested under a `bundle`.
        assert!(json.contains(r#""schemas""#));
        assert!(!json.contains(r#""bundle""#));
        let back: JsonSchemaExportFile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.meta.kind, KIND_JSON_SCHEMAS);
        assert_eq!(back.bundle.schemas.len(), 1);
        assert_eq!(back.bundle.schemas[0].name, "cfg");
    }
}
