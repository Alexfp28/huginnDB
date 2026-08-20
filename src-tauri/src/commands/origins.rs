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
use crate::state::AppState;
use crate::tab_state::{self, Environment, LaunchState, Origin};
use crate::transfer::{
    EnvironmentExportFile, ExportMetadata, ExportedEnvironmentBundle, ExportedProfile,
    KIND_ENVIRONMENT,
};
use tauri::State;

/// Keychain account for an origin's passphrase.
///
/// Namespaced with an `origin::` prefix so it can never collide with a
/// connection's account, which is `<profile-id>::<username>`. A profile id is a
/// UUID, so the prefix is what keeps the two spaces disjoint by construction
/// rather than by luck.
fn passphrase_account(origin_id: &str) -> String {
    format!("origin::{origin_id}")
}

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
    };

    // Keychain first: a failure here must not leave a registered origin whose
    // passphrase silently went nowhere, since the next sync would then report a
    // decryption error the user has no way to connect to this moment.
    if let Some(secret) = passphrase.as_deref().filter(|s| !s.is_empty()) {
        keychain::set_password(&passphrase_account(&origin.id), secret)?;
    }

    let snapshot = {
        let mut guard = state.tab_state.write();
        guard.origins.push(origin.clone());
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(origin)
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

    let (snapshot, updated) = {
        let mut guard = state.tab_state.write();
        let origin = guard
            .origins
            .iter_mut()
            .find(|o| o.id == id)
            .ok_or_else(|| AppError::InvalidInput(format!("no origin with id {id}")))?;
        origin.name = name;
        origin.path = path;
        let updated = origin.clone();
        (guard.clone(), updated)
    };
    tab_state::save_tab_state(&snapshot)?;
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
pub fn remove_origin(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let snapshot = {
        let mut guard = state.tab_state.write();
        let before = guard.origins.len();
        guard.origins.retain(|o| o.id != id);
        if guard.origins.len() == before {
            return Err(AppError::InvalidInput(format!("no origin with id {id}")));
        }
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    // Best-effort: a missing entry is the desired end state, and failing the
    // whole command over it would leave the origin registered.
    let _ = keychain::delete_password(&passphrase_account(&id));
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
#[tauri::command]
pub fn sync_origin(state: State<'_, AppState>, id: String) -> AppResult<OriginSyncReport> {
    let origin = {
        let guard = state.tab_state.read();
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

    let passphrase = keychain::get_password(&passphrase_account(&id))?;
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

    let mut report = merge_profiles_bundle(
        state.inner(),
        &id,
        passphrase.as_deref(),
        &incoming_profiles,
    )?;
    report.synced_at = chrono::Utc::now().to_rfc3339();

    let snapshot = {
        let mut guard = state.tab_state.write();
        // Run this whenever the file is environment-kind, even with zero
        // bundles: an origin that used to publish environments and now
        // publishes none must still get its previously-mirrored environments
        // reported vanished, not silently skipped. Gating on the file's kind
        // rather than on `environment_bundles` being non-empty is what makes
        // that degenerate case behave the same as an ordinary disappearance.
        if is_environment_kind {
            let (added, updated, vanished, suspicious) =
                sync_environment_bundles(&mut guard, &id, &environment_bundles);
            report.environments_added = added;
            report.environments_updated = updated;
            report.environments_vanished = vanished;
            report.environments_suspicious = suspicious;
        }
        if let Some(o) = guard.origins.iter_mut().find(|o| o.id == id) {
            o.last_synced_at = Some(report.synced_at.clone());
        }
        guard.clone()
    };
    tab_state::save_tab_state(&snapshot)?;
    Ok(report)
}

/// Merge one origin's published profile list into the global pool, and land
/// any secrets it carries into this user's keychain. Shared by a plain
/// `ExportFile` (`kind = "profiles"`, or the pre-`kind` legacy shape) and the
/// `profiles` section of an `EnvironmentExportFile` (`kind = "environment"`)
/// — the connection-sync rules (ownership by `origin_id`, deferral while a
/// pool is live, vanished detection) don't care which envelope they arrived
/// in, only `sync_origin`'s caller does.
fn merge_profiles_bundle(
    state: &AppState,
    origin_id: &str,
    passphrase: Option<&str>,
    incoming: &[ExportedProfile],
) -> AppResult<OriginSyncReport> {
    let incoming_ids: std::collections::HashSet<&str> =
        incoming.iter().map(|p| p.profile.id.as_str()).collect();

    let mut report = OriginSyncReport::default();
    let live: Vec<String> = state.connections.read().ids();

    {
        let mut profiles = state.profiles.write();

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
                    *existing = profile.clone();
                    report.updated.push(profile.id);
                }
                None => {
                    report.added.push(profile.id.clone());
                    profiles.push(profile);
                }
            }
        }

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
        let _ = crate::transfer::land_secrets(
            &entry.profile,
            secrets,
            passphrase,
            crate::transfer::LandMode::BestEffort,
        );
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
}
