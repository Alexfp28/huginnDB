//! Shared connection origins (#108).
//!
//! An origin is a **file** on a path the OS already mounts — a UNC share, a
//! mapped drive, a synced folder — in the format `export_profiles` writes
//! (`crate::transfer` v1). One person curates it; everyone else pulls from it.
//! There is no protocol and no service here: reading one is `std::fs::read`, and
//! the share's ACL is the actual access control.
//!
//! This module owns the origin *registry* (add / rename / remove), the
//! keychain handling for an encrypted origin's passphrase, and the pull
//! itself ([`sync_origin`]).
//!
//! ## Why the registry is global, not scoped to an environment
//!
//! An origin describes a *server-side* resource — a file on a share — not a
//! Producción/Staging axis, and what it produces (`profiles.json` entries,
//! and whole mirrored environments) is already global. Scoping the
//! registration itself to one environment reproduced the `visible_databases`
//! bug (CLAUDE.md gotcha #27) one level up: the same physical file needed a
//! second, independent registration to be seen from a second environment, and
//! deleting whichever environment happened to hold the registration silently
//! orphaned every connection it had ever imported, with no notice raised at
//! all — worse than removing the origin on purpose, which at least tells the
//! frontend (`useOriginSync.noticeOriginRemoved`). `tab_state.json` v5 moved
//! `origins` to [`crate::tab_state::PersistedTabState`] for exactly this
//! reason; see that module's history for the migration.
//!
//! ## Why the passphrase goes in the keychain
//!
//! An encrypted export needs its passphrase on every pull, including the
//! unattended one at launch. Storing it in `tab_state.json` would put a secret
//! that decrypts a whole set of database passwords into a plaintext file that is
//! also, by design, the most-frequently-rewritten state we have — the exact
//! thing `profiles.json` avoids. It goes to the OS keychain under the same
//! service as connection passwords, keyed by origin id.
//!
//! Worth being explicit about the threat model, because the encryption invites
//! more confidence than it earns: read access to the share **plus** the
//! passphrase yields every password in the file. The passphrase travels
//! out-of-band (the admin tells the new hire), so the share's ACL is the real
//! perimeter. See `SECURITY.md`.

use crate::error::{AppError, AppResult};
use crate::keychain;
use crate::state::{ActiveConnections, AppState, ConnectionProfile};
use crate::tab_state::{self, Environment, LaunchState, Origin};
use crate::transfer::{
    EnvironmentExportFile, ExportMetadata, ExportedEnvironmentBundle, ExportedProfile,
    KIND_ENVIRONMENT,
};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

/// Keychain account for an origin's passphrase.
///
/// Namespaced with an `origin::` prefix so it can never collide with a
/// connection's account, which is `<profile-id>::<username>`. A profile id is a
/// UUID, so the prefix is what keeps the two spaces disjoint by construction
/// rather than by luck.
fn passphrase_account(origin_id: &str) -> String {
    format!("origin::{origin_id}")
}

/// Emitted whenever the origin registry changes: one was added, renamed,
/// repointed, removed, or synced (which stamps `last_synced_at`).
///
/// Broadcast with an unscoped `emit`, and the frontend listens **without a
/// `target`**, which looks like gotcha #25's cross-window leak and is its
/// deliberate opposite — same reasoning as
/// [`crate::commands::json_schemas::JSON_SCHEMAS_CHANGED_EVENT`]. The registry
/// is one global list in `tab_state.json`; a rename in the Settings window must
/// reach the connection manager in the main window, and every window's cached
/// id-to-name map goes stale at the same instant. Scoping it would leave one
/// window rendering a name that no longer exists.
///
/// The payload is `()`: listeners re-run `list_origins`, which is a clone of a
/// short `Vec`, and shipping the list would put `landed_secrets` fingerprints on
/// an event bus for no reason.
pub const ORIGINS_CHANGED_EVENT: &str = "huginndb://origins-changed";

/// Every registered origin, global across all environments, in insertion
/// order.
#[tauri::command]
pub fn list_origins(state: State<'_, AppState>) -> AppResult<Vec<Origin>> {
    Ok(state.tab_state.read().origins.clone())
}

/// Register a shared origin.
///
/// The path is **not** validated here beyond being non-empty. A share can be
/// legitimately unreachable at the moment it is configured — VPN down, laptop
/// off the corporate network — and refusing to save it then would force the user
/// to re-enter it later. Reachability is the sync's problem, where a failure has
/// somewhere sensible to be reported.
///
/// `passphrase` is stored in the keychain when the file is encrypted; pass
/// `None` for a plaintext export. It is never written to `tab_state.json`.
#[tauri::command]
pub fn add_origin(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    path: String,
    passphrase: Option<String>,
) -> AppResult<Origin> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("origin path is empty".into()));
    }
    let origin = Origin {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        path,
        last_synced_at: None,
        landed_secrets: HashMap::new(),
    };

    // Keychain first: a failure here must not leave a registered origin whose
    // passphrase silently went nowhere, since the next sync would then report a
    // decryption error the user has no way to connect to this moment.
    if let Some(secret) = passphrase.as_deref().filter(|s| !s.is_empty()) {
        keychain::set_password(&passphrase_account(&origin.id), secret)?;
    }

    let created = origin.clone();
    tab_state::mutate(&state.tab_state, |ts| {
        ts.origins.push(origin);
        Ok(())
    })?;
    let _ = app.emit(ORIGINS_CHANGED_EVENT, ());
    Ok(created)
}

/// Rename an origin, repoint it at a different file, and/or replace its stored
/// passphrase.
///
/// `passphrase` is tri-state on purpose: `None` leaves whatever is in the
/// keychain untouched (so a plain rename does not require the user to retype a
/// secret they already stored), while `Some("")` clears it — which is how an
/// origin that used to be encrypted becomes a plaintext one.
#[tauri::command]
pub fn update_origin(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    name: String,
    path: String,
    passphrase: Option<String>,
) -> AppResult<Origin> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("origin path is empty".into()));
    }
    match passphrase.as_deref() {
        Some("") => keychain::delete_password(&passphrase_account(&id))?,
        Some(secret) => keychain::set_password(&passphrase_account(&id), secret)?,
        None => {}
    }

    let updated = tab_state::mutate(&state.tab_state, |ts| {
        let origin = ts
            .origins
            .iter_mut()
            .find(|o| o.id == id)
            .ok_or_else(|| AppError::InvalidInput(format!("no origin with id {id}")))?;
        origin.name = name;
        origin.path = path;
        Ok(origin.clone())
    })?;
    let _ = app.emit(ORIGINS_CHANGED_EVENT, ());
    Ok(updated)
}

/// Unregister an origin and forget its passphrase.
///
/// The connections it imported are deliberately **left in place**, tagged with
/// its now-dangling `origin_id`. Removing an origin says "stop pulling from
/// here", not "delete these servers": the user may well have work open against
/// one, and silently deleting a batch of connections (plus their keychain
/// entries) on a config change is not a trade anyone would choose. A dangling
/// `origin_id` is harmless — no sync resolves against it any more, and the
/// frontend can offer to release those profiles into ordinary local ones.
#[tauri::command]
pub fn remove_origin(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<()> {
    tab_state::mutate(&state.tab_state, |ts| {
        let before = ts.origins.len();
        ts.origins.retain(|o| o.id != id);
        if ts.origins.len() == before {
            return Err(AppError::InvalidInput(format!("no origin with id {id}")));
        }
        Ok(())
    })?;
    // Best-effort: a missing entry is the desired end state, and failing the
    // whole command over it would leave the origin registered.
    let _ = keychain::delete_password(&passphrase_account(&id));
    let _ = app.emit(ORIGINS_CHANGED_EVENT, ());
    Ok(())
}

/// Pull an origin: refresh what it publishes, report what disappeared.
///
/// Three outcomes are kept strictly apart, and the separation matters more than
/// the feature does:
///
/// 1. **Unreadable or unparseable** — share offline, VPN down, or the publisher
///    mid-save without an atomic rename. Returns `Err` and touches *nothing*: no
///    profiles, no `last_synced_at`. A failed read must never be mistaken for
///    "the file now says less".
/// 2. **Read cleanly, entries missing** — reported in `vanished` for the user to
///    decide on.
/// 3. **Read cleanly but suspiciously empty** — flagged via `suspicious` so the
///    frontend withholds removal offers. See [`disappearance_is_trustworthy`].
///
/// Metadata for an existing profile is refreshed in place, except while a pool is
/// open for it: repointing host/port under a running query changes the server
/// beneath the user, so those land in `deferred` and apply on disconnect.
///
/// Never writes to the origin's path.
///
/// `async fn` with the whole body on `spawn_blocking`, and that is not a
/// stylistic choice. A synchronous `#[tauri::command]` runs on the **main
/// thread** — the one pumping the window — and this one does two things that
/// can hold it for a long time: it reads the export off a network share (a
/// slow VPN is enough), and it lands every published secret into the keychain,
/// which costs ~600 000 PBKDF2 rounds *per slot*. A shared origin publishing
/// thirty tunnelled connections therefore froze the app for as long as tens of
/// millions of SHA-256 rounds take, on every launch, with Windows painting the
/// window "Not Responding" throughout. [`already_landed`] removes almost all
/// of that work; running off the main thread is what stops whatever remains
/// from being felt as a freeze.
#[tauri::command]
pub async fn sync_origin(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<OriginSyncReport> {
    let connections = state.connections.clone();
    let profiles = state.profiles.clone();
    let tab_state_lock = state.tab_state.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        sync_origin_inner(&connections, &profiles, &tab_state_lock, &id)
    })
    .await
    .map_err(|e| AppError::Transfer(format!("origin sync task failed: {e}")))?;
    // Only on success: a failed pull writes nothing, `last_synced_at` included,
    // so there is no registry change to announce (outcome 1 in the doc above).
    // The emit stays out of `sync_origin_inner` so that body needs no
    // `AppHandle` and stays callable off the main thread.
    if report.is_ok() {
        let _ = app.emit(ORIGINS_CHANGED_EVENT, ());
    }
    report
}

/// The body of [`sync_origin`], off the main thread. Takes the three locks it
/// needs rather than `AppState`, mirroring `import_environment`.
fn sync_origin_inner(
    connections: &Arc<RwLock<ActiveConnections>>,
    profiles_lock: &Arc<RwLock<Vec<ConnectionProfile>>>,
    tab_state_lock: &Arc<RwLock<tab_state::PersistedTabState>>,
    id: &str,
) -> AppResult<OriginSyncReport> {
    let origin = {
        let guard = tab_state_lock.read();
        guard
            .origins
            .iter()
            .find(|o| o.id == id)
            .cloned()
            .ok_or_else(|| AppError::InvalidInput(format!("no origin with id {id}")))?
    };

    // State 1. Any failure here returns early, before a single profile is
    // touched.
    let data = std::fs::read_to_string(&origin.path).map_err(|e| {
        AppError::InvalidInput(format!("cannot read origin {:?}: {e}", origin.path))
    })?;

    // Peek `meta.kind` before committing to a shape. This used to always
    // assume a plain `ExportFile`, which — since `serde_json` silently drops
    // unknown fields — parsed a `kind = "environment"` file just fine while
    // quietly ignoring its whole `environments` array. Now the file's own
    // declared kind decides which shape it's read as.
    #[derive(serde::Deserialize)]
    struct MetaPeek {
        meta: ExportMetadata,
    }
    let meta_peek: MetaPeek = serde_json::from_str(&data).map_err(|e| {
        AppError::InvalidInput(format!(
            "origin {:?} is not a HuginnDB export: {e}",
            origin.path
        ))
    })?;

    let passphrase = keychain::get_password(&passphrase_account(id))?;
    if meta_peek.meta.encrypted && passphrase.is_none() {
        return Err(AppError::InvalidInput(
            "this origin is encrypted but no passphrase is stored for it".into(),
        ));
    }

    let is_environment_kind = meta_peek.meta.kind == KIND_ENVIRONMENT;
    let (incoming_profiles, environment_bundles): (
        Vec<ExportedProfile>,
        Vec<ExportedEnvironmentBundle>,
    ) = if is_environment_kind {
        let export: EnvironmentExportFile = serde_json::from_str(&data).map_err(|e| {
            AppError::InvalidInput(format!(
                "origin {:?} is not a valid environment export: {e}",
                origin.path
            ))
        })?;
        (export.profiles, export.environments)
    } else {
        let export: crate::transfer::ExportFile = serde_json::from_str(&data).map_err(|e| {
            AppError::InvalidInput(format!(
                "origin {:?} is not a HuginnDB export: {e}",
                origin.path
            ))
        })?;
        (export.profiles, Vec::new())
    };

    // Carried in and back out so the expensive keychain landing can recognise
    // ciphertext it has already dealt with; see `already_landed`.
    let mut landed = origin.landed_secrets.clone();
    let mut report = merge_profiles_bundle(
        connections,
        profiles_lock,
        id,
        passphrase.as_deref(),
        &incoming_profiles,
        &mut landed,
    )?;
    report.synced_at = chrono::Utc::now().to_rfc3339();

    tab_state::mutate(tab_state_lock, |ts| {
        // Run this whenever the file is environment-kind, even with zero
        // bundles: an origin that used to publish environments and now
        // publishes none must still get its previously-mirrored environments
        // reported vanished, not silently skipped. Gating on the file's kind
        // rather than on `environment_bundles` being non-empty is what makes
        // that degenerate case behave the same as an ordinary disappearance.
        if is_environment_kind {
            let (added, updated, vanished, suspicious) =
                sync_environment_bundles(ts, id, &environment_bundles);
            report.environments_added = added;
            report.environments_updated = updated;
            report.environments_vanished = vanished;
            report.environments_suspicious = suspicious;
        }
        if let Some(o) = ts.origins.iter_mut().find(|o| o.id == id) {
            o.last_synced_at = Some(report.synced_at.clone());
            o.landed_secrets = std::mem::take(&mut landed);
        }
        Ok(())
    })?;
    Ok(report)
}

/// Has this machine already decrypted exactly this ciphertext for
/// `profile_id`, and does every keychain account it covers still hold a value?
///
/// Both halves are needed. The fingerprint alone would let a keychain entry the
/// user (or another tool) deleted stay missing forever, since the published
/// blob never changes; the presence check alone would never notice a rotated
/// password, since the old entry is still there. Together they skip exactly the
/// case that dominates every launch — an origin file that has not changed since
/// the last sync — and nothing else.
///
/// `present` is injected so the decision is testable without a keychain.
fn already_landed(
    landed: &HashMap<String, String>,
    profile_id: &str,
    fingerprint: &str,
    accounts: &[String],
    present: impl Fn(&str) -> bool,
) -> bool {
    landed.get(profile_id).map(String::as_str) == Some(fingerprint)
        && accounts.iter().all(|a| present(a))
}

/// Apply one origin's published list to `profiles` in memory, returning what
/// changed. No I/O whatsoever: no disk, no keychain.
///
/// Split out of [`merge_profiles_bundle`] so the merge *rules* — ownership,
/// deferral while a pool is live, vanished detection, which fields a refresh may
/// overwrite — are testable without writing the real `profiles.json`. They were
/// not, and the first test written against the combined function silently
/// clobbered the developer's own saved connections. A rule this fiddly needs
/// tests; tests this cheap must not need a disk.
///
/// `live` is the set of connection ids with an open pool, passed in for the same
/// reason.
fn merge_into(
    profiles: &mut Vec<ConnectionProfile>,
    origin_id: &str,
    incoming: &[ExportedProfile],
    live: &[String],
) -> OriginSyncReport {
    let incoming_ids: std::collections::HashSet<&str> =
        incoming.iter().map(|p| p.profile.id.as_str()).collect();
    let mut report = OriginSyncReport::default();

    // Local profiles this origin owns, before the merge — the denominator for
    // the suspicion check.
    let owned: Vec<String> = profiles
        .iter()
        .filter(|p| p.origin_id.as_deref() == Some(origin_id))
        .map(|p| p.id.clone())
        .collect();
    report.vanished = owned
        .iter()
        .filter(|pid| !incoming_ids.contains(pid.as_str()))
        .cloned()
        .collect();
    report.suspicious = !disappearance_is_trustworthy(owned.len(), report.vanished.len());
    if report.suspicious {
        // Say nothing actionable about a read we don't trust.
        report.vanished.clear();
    }

    for entry in incoming {
        let mut profile = entry.profile.clone();
        profile.origin_id = Some(origin_id.to_string());
        // An origin never publishes session-only profiles.
        profile.ephemeral = false;

        match profiles.iter_mut().find(|p| p.id == profile.id) {
            Some(existing) => {
                // Only ever refresh a profile this origin already owns. A
                // local profile that happens to share an id (an earlier
                // import, later detached) is the user's, not the file's.
                if existing.origin_id.as_deref() != Some(origin_id) {
                    continue;
                }
                if live.iter().any(|c| c == &profile.id) {
                    report.deferred.push(profile.id.clone());
                    continue;
                }
                // The MCP write policy is a LOCAL trust decision and must
                // survive the refresh. It is the one field on a published
                // profile that says what an AI client is allowed to do on
                // *this* machine, which the publisher cannot know; before
                // this, setting a shared connection to "data" in Settings
                // silently reverted on the next pull, so the whole panel was
                // unusable for anyone whose connections all come from an
                // origin. Everything else — host, port, credentials, the
                // visible-database default — is the file's to dictate.
                profile.mcp_write = existing.mcp_write;
                *existing = profile.clone();
                report.updated.push(profile.id);
            }
            None => {
                report.added.push(profile.id.clone());
                profiles.push(profile);
            }
        }
    }
    report
}

/// Merge one origin's published profile list into the global pool, and land
/// any secrets it carries into this user's keychain. Shared by a plain
/// `ExportFile` (`kind = "profiles"`, or the pre-`kind` legacy shape) and the
/// `profiles` section of an `EnvironmentExportFile` (`kind = "environment"`)
/// — the connection-sync rules (ownership by `origin_id`, deferral while a
/// pool is live, vanished detection) don't care which envelope they arrived
/// in, only `sync_origin`'s caller does.
fn merge_profiles_bundle(
    connections: &Arc<RwLock<ActiveConnections>>,
    profiles_lock: &Arc<RwLock<Vec<ConnectionProfile>>>,
    origin_id: &str,
    passphrase: Option<&str>,
    incoming: &[ExportedProfile],
    landed: &mut HashMap<String, String>,
) -> AppResult<OriginSyncReport> {
    let report;
    let live: Vec<String> = connections.read().ids();

    {
        let mut profiles = profiles_lock.write();
        report = merge_into(&mut profiles, origin_id, incoming, &live);
        crate::store::save_profiles(&profiles)?;
    }

    // Secrets land in this user's own keychain, decrypted with the passphrase
    // stored for this origin. `BestEffort` because this runs unattended (launch,
    // the 4-hourly poll, "Sync now"): one undecryptable profile must leave that
    // connection needing a password rather than aborting the whole pass.
    //
    // The decryption itself lives in `transfer::land_secrets` — see its doc for
    // why "no passphrase" can never mean "store the blob as-is".
    for entry in incoming {
        let Some(secrets) = &entry.secrets else {
            continue;
        };
        let fingerprint = crate::transfer::secrets_fingerprint(secrets);
        let accounts: Vec<String> = crate::transfer::secret_slots(&entry.profile, secrets)
            .into_iter()
            .map(|(account, _)| account)
            .collect();
        if already_landed(landed, &entry.profile.id, &fingerprint, &accounts, |a| {
            keychain::get_password(a).ok().flatten().is_some()
        }) {
            continue;
        }
        // Only remember the fingerprint once something was actually stored: a
        // failed decrypt (wrong or missing passphrase) must be retried on the
        // next sync, not cached as done.
        if crate::transfer::land_secrets(
            &entry.profile,
            secrets,
            passphrase,
            crate::transfer::LandMode::BestEffort,
        )
        .unwrap_or(false)
        {
            landed.insert(entry.profile.id.clone(), fingerprint);
        }
    }

    Ok(report)
}

/// Reconcile the environments an origin's `EnvironmentExportFile` describes
/// against this machine's local mirrors of them, matched by
/// `(origin_id, origin_source_id)` — not by position in the file or by name,
/// which can both change between syncs. See `Environment::origin_source_id`
/// for why that pair is the identity that survives repeated syncs, given
/// `ExportedEnvironment` itself carries no portable id.
///
/// Deliberately does **not** register a bundle's own nested `origins`: a file
/// an origin points at must not be able to make this machine register more
/// origins on its own — that stays reserved for the conscious, one-shot
/// `import_environment`.
///
/// Returns (added env ids, updated env ids, vanished env ids, suspicious).
fn sync_environment_bundles(
    guard: &mut tab_state::PersistedTabState,
    origin_id: &str,
    bundles: &[ExportedEnvironmentBundle],
) -> (Vec<String>, Vec<String>, Vec<String>, bool) {
    let owned_count = guard
        .environments
        .iter()
        .filter(|e| e.origin_id.as_deref() == Some(origin_id))
        .count();
    let incoming_source_ids: std::collections::HashSet<&str> = bundles
        .iter()
        .map(|b| b.environment.source_environment_id.as_str())
        .collect();

    let mut vanished: Vec<String> = guard
        .environments
        .iter()
        .filter(|e| e.origin_id.as_deref() == Some(origin_id))
        .filter(|e| {
            e.origin_source_id
                .as_deref()
                .map(|src| !incoming_source_ids.contains(src))
                .unwrap_or(false)
        })
        .map(|e| e.id.clone())
        .collect();
    let suspicious = !disappearance_is_trustworthy(owned_count, vanished.len());
    if suspicious {
        vanished.clear();
    }

    let mut added = Vec::new();
    let mut updated = Vec::new();
    let base_order = guard
        .environments
        .iter()
        .map(|e| e.order)
        .max()
        .unwrap_or(0)
        + 1;
    for (i, bundle) in bundles.iter().enumerate() {
        let src_id = bundle.environment.source_environment_id.as_str();
        let visible_connections = if bundle.connection_ids.is_empty() {
            None
        } else {
            Some(bundle.connection_ids.clone())
        };

        match guard.environments.iter_mut().find(|e| {
            e.origin_id.as_deref() == Some(origin_id)
                && e.origin_source_id.as_deref() == Some(src_id)
        }) {
            Some(existing) => {
                existing.name = bundle.environment.name.clone();
                existing.color = bundle.environment.color.clone();
                existing.icon = bundle.environment.icon.clone();
                existing.theme_id = bundle.environment.theme_id.clone();
                existing.launch.visible_connections = visible_connections;
                updated.push(existing.id.clone());
            }
            None => {
                let env_id = uuid::Uuid::new_v4().to_string();
                let env = Environment {
                    id: env_id.clone(),
                    name: bundle.environment.name.clone(),
                    color: bundle.environment.color.clone(),
                    icon: bundle.environment.icon.clone(),
                    order: base_order + i as i32,
                    theme_id: bundle.environment.theme_id.clone(),
                    origin_id: Some(origin_id.to_string()),
                    origin_source_id: Some(src_id.to_string()),
                    launch: LaunchState {
                        visible_connections,
                        ..LaunchState::default()
                    },
                    ..Environment::default()
                };
                guard.environments.push(env);
                added.push(env_id);
            }
        }
    }

    (added, updated, vanished, suspicious)
}

/// Below this many origin-tagged profiles, the "too many vanished at once" check
/// is skipped — with two or three connections, losing both is plausibly a real
/// deletion rather than a corrupt read.
const SUSPICION_FLOOR: usize = 4;

/// Fraction of an origin's profiles that has to disappear in one sync before the
/// result is treated as untrustworthy rather than as a batch of deletions.
const SUSPICION_RATIO: f32 = 0.5;

/// Should this set of disappearances be acted on, or is the file probably not
/// telling us the truth?
///
/// A publisher writing the export without an atomic rename, a share dropping
/// mid-read, or a truncated file can all parse successfully while listing far
/// fewer profiles than they should. Treating that as "the admin deleted 25
/// clients" would bury the user in removal notices for connections that are
/// perfectly alive — and the recovery (re-adopting each one) is manual.
///
/// Pure so the threshold is testable without a filesystem.
fn disappearance_is_trustworthy(local_count: usize, vanished_count: usize) -> bool {
    if vanished_count == 0 {
        return true;
    }
    if local_count < SUSPICION_FLOOR {
        return true;
    }
    (vanished_count as f32 / local_count as f32) < SUSPICION_RATIO
}

/// Outcome of one [`sync_origin`] run.
///
/// Note what is absent: nothing here deletes. Disappearances are *reported* and
/// the user decides per connection whether to adopt it as local or retire it
/// (#108) — another user's edit to a shared file must never destroy credentials
/// on this machine.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginSyncReport {
    /// Profile ids created by this sync.
    pub added: Vec<String>,
    /// Profile ids whose metadata was refreshed from the file.
    pub updated: Vec<String>,
    /// Ids whose metadata changed but which have a live pool, so the change is
    /// held back rather than repointing a server under a running query.
    pub deferred: Vec<String>,
    /// Ids present locally under this origin but absent from the file. Reported
    /// only; see the type-level note.
    pub vanished: Vec<String>,
    /// True when `vanished` was large enough relative to the origin's footprint
    /// that the read is more likely broken than authoritative. The frontend must
    /// not offer removals in this state.
    pub suspicious: bool,
    /// RFC 3339 stamp written back onto the origin on success.
    pub synced_at: String,
    /// Environment ids created by this sync, when the origin publishes whole
    /// environments (`kind = "environment"`). Empty for a plain profile origin.
    #[serde(default)]
    pub environments_added: Vec<String>,
    /// Environment ids whose cosmetics/membership were refreshed from the file.
    #[serde(default)]
    pub environments_updated: Vec<String>,
    /// Environment ids this origin owns locally whose bundle disappeared from
    /// the file. Reported only, same as `vanished` one level up: nothing here
    /// deletes on its own.
    #[serde(default)]
    pub environments_vanished: Vec<String>,
    /// Same purpose as `suspicious`, scoped to the environment count instead
    /// of the profile count.
    #[serde(default)]
    pub environments_suspicious: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::McpWritePolicy;
    use crate::testkit;
    use crate::transfer::ExportedProfile;

    /// One published entry with no attached secrets, so the merge never touches
    /// the keychain and the test needs no OS credential store.
    fn published(profile: ConnectionProfile) -> ExportedProfile {
        ExportedProfile {
            profile,
            secrets: None,
        }
    }

    /// Runs the merge rules against `local` with no pools open.
    ///
    /// Deliberately `merge_into`, not `merge_profiles_bundle`: the latter writes
    /// the real `profiles.json`, so calling it from a test both raced the other
    /// tests and overwrote the developer's own saved connections.
    fn merge(
        mut local: Vec<ConnectionProfile>,
        incoming: &[ExportedProfile],
    ) -> Vec<ConnectionProfile> {
        merge_into(&mut local, "o1", incoming, &[]);
        local
    }

    /// The write policy says what an AI client may do on *this* machine, which
    /// the publisher cannot know. Before it was preserved, setting a shared
    /// connection to "data" reverted on the next pull — silently, so the MCP
    /// panel was unusable for anyone whose connections all come from an origin.
    #[test]
    fn a_sync_preserves_the_local_mcp_write_policy() {
        let local = ConnectionProfile {
            origin_id: Some("o1".into()),
            mcp_write: McpWritePolicy::Data,
            ..testkit::profile("shared")
        };
        let incoming = published(ConnectionProfile {
            host: "newhost".into(),
            mcp_write: McpWritePolicy::ReadOnly,
            ..testkit::profile("shared")
        });

        let after = merge(vec![local], &[incoming]);

        assert_eq!(after[0].mcp_write, McpWritePolicy::Data, "policy is local");
        assert_eq!(after[0].host, "newhost", "everything else is the file's");
    }

    /// A profile arriving for the first time has no local decision to keep, so
    /// it takes whatever the file published (which is the export's default,
    /// read-only, unless the publisher changed it).
    #[test]
    fn a_newly_published_profile_takes_the_files_policy() {
        let incoming = published(ConnectionProfile {
            mcp_write: McpWritePolicy::Full,
            ..testkit::profile("fresh")
        });
        let after = merge(vec![], &[incoming]);
        assert_eq!(after[0].mcp_write, McpWritePolicy::Full);
        assert_eq!(after[0].origin_id.as_deref(), Some("o1"));
    }

    /// A local profile that merely shares an id is the user's, not the file's —
    /// the existing ownership guard, pinned here because the policy line sits
    /// right next to it.
    #[test]
    fn a_sync_never_claims_a_profile_another_origin_owns() {
        let local = ConnectionProfile {
            origin_id: Some("other".into()),
            host: "mine".into(),
            ..testkit::profile("contested")
        };
        let incoming = published(ConnectionProfile {
            host: "theirs".into(),
            ..testkit::profile("contested")
        });
        let after = merge(vec![local], &[incoming]);
        assert_eq!(after[0].host, "mine");
        assert_eq!(after[0].origin_id.as_deref(), Some("other"));
    }

    #[test]
    fn a_single_disappearance_is_trusted() {
        assert!(disappearance_is_trustworthy(20, 1));
    }

    #[test]
    fn a_wholesale_disappearance_is_not() {
        // A truncated or half-written file looks exactly like this.
        assert!(!disappearance_is_trustworthy(20, 20));
        assert!(!disappearance_is_trustworthy(20, 10));
    }

    #[test]
    fn small_origins_are_exempt_from_the_ratio() {
        // With three connections, losing two is plausibly deliberate; the ratio
        // alone would call it suspicious and block a legitimate cleanup.
        assert!(disappearance_is_trustworthy(3, 2));
    }

    #[test]
    fn no_disappearances_is_always_trusted() {
        assert!(disappearance_is_trustworthy(0, 0));
    }

    #[test]
    fn passphrase_account_cannot_collide_with_a_connection_account() {
        // Connection accounts are `<profile-id>::<username>`; origin accounts
        // carry a prefix instead, so the two namespaces can't overlap.
        let account = passphrase_account("2f1c8a0e-0000-4000-8000-000000000000");
        assert!(account.starts_with("origin::"));
        assert!(!account.contains("::origin"));
    }

    fn bundle(
        source_id: &str,
        name: &str,
        connection_ids: Vec<String>,
    ) -> ExportedEnvironmentBundle {
        ExportedEnvironmentBundle {
            environment: crate::transfer::ExportedEnvironment {
                name: name.into(),
                color: None,
                icon: None,
                theme_id: None,
                source_environment_id: source_id.into(),
            },
            connection_ids,
            // A sync must never auto-register origins from the file — see
            // `sync_environment_bundles`'s doc — so tests deliberately leave
            // this non-empty to prove it's ignored, not just untested.
            origins: vec![crate::transfer::ExportedOrigin {
                name: "should be ignored".into(),
                path: "/should/be/ignored".into(),
            }],
        }
    }

    #[test]
    fn first_sync_creates_a_mirrored_environment() {
        let mut state = tab_state::PersistedTabState::default();
        let (added, updated, vanished, suspicious) = sync_environment_bundles(
            &mut state,
            "origin-1",
            &[bundle("src-a", "Producción", vec!["conn-1".into()])],
        );

        assert_eq!(added.len(), 1);
        assert!(updated.is_empty());
        assert!(vanished.is_empty());
        assert!(!suspicious);

        let env = state
            .environments
            .iter()
            .find(|e| e.id == added[0])
            .unwrap();
        assert_eq!(env.name, "Producción");
        assert_eq!(env.origin_id.as_deref(), Some("origin-1"));
        assert_eq!(env.origin_source_id.as_deref(), Some("src-a"));
        assert_eq!(
            env.launch.visible_connections,
            Some(vec!["conn-1".to_string()])
        );
        // The bundle's own nested origin must never be auto-registered.
        assert!(env.origins.is_empty());
    }

    #[test]
    fn a_later_sync_updates_the_same_mirrored_environment_instead_of_duplicating() {
        let mut state = tab_state::PersistedTabState::default();
        let (added, ..) = sync_environment_bundles(
            &mut state,
            "origin-1",
            &[bundle("src-a", "Producción", vec!["conn-1".into()])],
        );
        let env_id = added[0].clone();

        // The publisher renamed it and added a second connection — same
        // `source_environment_id`, so it must be recognised as the same
        // environment, not create a sibling.
        let (added2, updated2, vanished2, _) = sync_environment_bundles(
            &mut state,
            "origin-1",
            &[bundle(
                "src-a",
                "Producción (EU)",
                vec!["conn-1".into(), "conn-2".into()],
            )],
        );

        assert!(added2.is_empty());
        assert_eq!(updated2, vec![env_id.clone()]);
        assert!(vanished2.is_empty());
        assert_eq!(
            state
                .environments
                .iter()
                .filter(|e| e.origin_id.as_deref() == Some("origin-1"))
                .count(),
            1
        );
        let env = state.environments.iter().find(|e| e.id == env_id).unwrap();
        assert_eq!(env.name, "Producción (EU)");
        assert_eq!(
            env.launch.visible_connections,
            Some(vec!["conn-1".to_string(), "conn-2".to_string()])
        );
    }

    #[test]
    fn an_environment_dropped_from_the_file_is_reported_vanished_not_deleted() {
        let mut state = tab_state::PersistedTabState::default();
        sync_environment_bundles(
            &mut state,
            "origin-1",
            &[bundle("src-a", "Producción", vec![])],
        );

        // The publisher stopped including it in the file.
        let (added, updated, vanished, suspicious) =
            sync_environment_bundles(&mut state, "origin-1", &[]);

        assert!(added.is_empty());
        assert!(updated.is_empty());
        assert_eq!(vanished.len(), 1);
        assert!(!suspicious);
        // Never deleted on our own initiative — same rule as a vanished profile.
        assert_eq!(
            state
                .environments
                .iter()
                .filter(|e| e.origin_id.as_deref() == Some("origin-1"))
                .count(),
            1
        );
    }

    #[test]
    fn an_unrelated_origins_environments_are_never_touched() {
        let mut state = tab_state::PersistedTabState::default();
        sync_environment_bundles(
            &mut state,
            "origin-1",
            &[bundle("src-a", "Producción", vec![])],
        );

        let (added, updated, vanished, _) = sync_environment_bundles(
            &mut state,
            "origin-2",
            &[bundle("src-b", "Staging", vec![])],
        );

        assert_eq!(added.len(), 1);
        assert!(updated.is_empty());
        // origin-2's own first sync must not flag origin-1's environment as
        // vanished — vanished detection is scoped per origin.
        assert!(vanished.is_empty());
    }

    // --- the launch-freeze guard --------------------------------------------
    //
    // Landing a secret costs ~600 000 PBKDF2 rounds per slot. A shared origin
    // publishing thirty tunnelled connections re-did all of them on every
    // sync, on the main thread, which is what made every launch a multi-second
    // "Not Responding". These pin the two halves of the skip that stops it.
    // All keychain-free: `already_landed` takes its presence check as an
    // argument precisely so the decision can be tested without one.

    fn fp_map(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn an_unchanged_secret_whose_accounts_are_present_is_skipped() {
        let landed = fp_map(&[("p1", "abc")]);
        assert!(already_landed(
            &landed,
            "p1",
            "abc",
            &["p1::user".to_string()],
            |_| true
        ));
    }

    #[test]
    fn a_rotated_secret_is_landed_again_even_though_the_account_exists() {
        // The keychain entry is still there, so the presence check alone would
        // wrongly skip and the new password would never arrive.
        let landed = fp_map(&[("p1", "old")]);
        assert!(!already_landed(
            &landed,
            "p1",
            "new",
            &["p1::user".to_string()],
            |_| true
        ));
    }

    #[test]
    fn a_deleted_keychain_entry_is_relanded_even_though_the_blob_is_unchanged() {
        // The published blob never changes, so the fingerprint alone would
        // wrongly skip and the connection would stay without a password
        // forever. This is why the check has two halves.
        let landed = fp_map(&[("p1", "abc")]);
        assert!(!already_landed(
            &landed,
            "p1",
            "abc",
            &["p1::user".to_string()],
            |_| false
        ));
    }

    #[test]
    fn one_missing_account_of_two_is_enough_to_reland() {
        // A tunnelled profile has a DB slot and an SSH slot; either being gone
        // must redo the pair rather than leave half a credential behind.
        let landed = fp_map(&[("p1", "abc")]);
        let accounts = ["p1::user".to_string(), "p1::ssh".to_string()];
        assert!(!already_landed(&landed, "p1", "abc", &accounts, |a| a != "p1::ssh"));
    }

    #[test]
    fn a_profile_never_landed_here_is_never_skipped() {
        assert!(!already_landed(
            &HashMap::new(),
            "p1",
            "abc",
            &["p1::user".to_string()],
            |_| true
        ));
    }
}
