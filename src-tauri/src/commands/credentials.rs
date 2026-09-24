//! A person's own database credentials for a connection — phase 3 of managed
//! policy. Which user a connection signs in as is decided in
//! [`crate::credentials`]; these commands read that decision for the
//! interface, and write the two things a person can: their own user (unless
//! the policy pins it) and their own password.
//!
//! None of them touches a database, so none needs the policy's guard
//! (`guard::HUMAN_POLICY` classifies them as `none`). What they write is local
//! by construction: `personal_username` never leaves this machine
//! (`merge_into`, the export, the origin file all drop it), and the password
//! goes to the keychain account the effective user keys.

use crate::credentials::{effective_profile, personal_user, PersonalSource};
use crate::error::{AppError, AppResult};
use crate::keychain;
use crate::state::{AppState, ConnectionProfile, Driver};
use crate::tab_state;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// What the connection dialog's "Your credentials" block shows.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalCredentials {
    /// The user this connection signs in as when it is not the published one.
    pub username: Option<String>,
    /// Where `username` came from — `policy` means the field is locked.
    pub source: Option<PersonalSource>,
    /// The user the connection itself (or its origin) names.
    pub published_username: String,
    /// Whether the keychain holds a password for the user that signs in.
    pub has_password: bool,
}

fn profile_of(state: &AppState, id: &str) -> AppResult<ConnectionProfile> {
    state
        .profiles
        .read()
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("profile {id}")))
}

fn describe(state: &AppState, profile: &ConnectionProfile) -> AppResult<PersonalCredentials> {
    let personal = personal_user(&state.policy, profile);
    let effective = effective_profile(&state.policy, profile);
    Ok(PersonalCredentials {
        username: personal.as_ref().map(|(u, _)| u.clone()),
        source: personal.map(|(_, s)| s),
        published_username: profile.username.clone(),
        has_password: profile.driver == Driver::Sqlite
            || keychain::get_password(&effective.keyring_account())?.is_some(),
    })
}

#[tauri::command]
pub fn personal_credentials(
    state: State<'_, AppState>,
    profile_id: String,
) -> AppResult<PersonalCredentials> {
    let profile = profile_of(&state, &profile_id)?;
    describe(&state, &profile)
}

/// Sign in to `profile_id` as `username` (ignored, and refused if different,
/// when the policy pins the user) with `password`, from now on.
///
/// Offered on a connection from a shared origin, where the published user is
/// not the person's to edit, and on any connection the policy pins a user
/// for. A local connection's user is edited by saving the connection —
/// offering two ways to write one field is how they drift.
#[tauri::command]
pub fn set_personal_credentials(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    username: Option<String>,
    password: Option<String>,
) -> AppResult<PersonalCredentials> {
    let profile = profile_of(&state, &profile_id)?;
    if profile.driver == Driver::Sqlite {
        return Err(AppError::InvalidInput(
            "SQLite has no database users; the file's permissions are what protect it".into(),
        ));
    }
    let pinned = crate::policy::pinned_db_user(&state.policy, &profile);
    let wanted = username
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .map(str::to_string);
    if let (Some(pinned), Some(wanted)) = (&pinned, &wanted) {
        if pinned != wanted {
            return Err(AppError::InvalidInput(format!(
                "your organization's policy signs you in to this server as {pinned:?}"
            )));
        }
    }
    if pinned.is_none() && profile.origin_id.is_none() {
        return Err(AppError::InvalidInput(
            "this connection is yours to edit — change its user by saving it instead".into(),
        ));
    }

    let mut updated = profile.clone();
    if pinned.is_none() {
        match wanted {
            Some(user) => updated.personal_username = Some(user),
            None if updated.personal_username.is_some() => {}
            None => {
                return Err(AppError::InvalidInput(
                    "say which database user you sign in as".into(),
                ))
            }
        }
    }
    if let Some(pw) = password.as_deref().filter(|p| !p.is_empty()) {
        let account = effective_profile(&state.policy, &updated).keyring_account();
        keychain::set_password(&account, pw)?;
    }
    {
        let mut profiles = state.profiles.write();
        let entry = profiles
            .iter_mut()
            .find(|p| p.id == profile_id)
            .ok_or_else(|| AppError::NotFound(format!("profile {profile_id}")))?;
        entry.personal_username = updated.personal_username.clone();
        crate::store::save_profiles(&profiles)?;
    }
    let _ = app.emit(crate::commands::connection::PROFILES_CHANGED_EVENT, ());
    describe(&state, &updated)
}

/// Go back to the published user: forget the person's own user and the
/// password stored for it. With the policy pinning the user only the password
/// goes, since the user is not the person's to drop.
///
/// For a connection from an origin, the fingerprint of the secret it last
/// landed is forgotten too, so the next sync lands the shared password again
/// — the same step `clear_secret_override` takes, for the same reason.
#[tauri::command]
pub fn clear_personal_credentials(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
) -> AppResult<PersonalCredentials> {
    let profile = profile_of(&state, &profile_id)?;
    let effective = effective_profile(&state.policy, &profile);
    if effective.keyring_account() != profile.keyring_account() {
        keychain::delete_password(&effective.keyring_account())?;
    }
    let updated = {
        let mut profiles = state.profiles.write();
        let entry = profiles
            .iter_mut()
            .find(|p| p.id == profile_id)
            .ok_or_else(|| AppError::NotFound(format!("profile {profile_id}")))?;
        entry.personal_username = None;
        let updated = entry.clone();
        crate::store::save_profiles(&profiles)?;
        updated
    };
    if let Some(origin_id) = &updated.origin_id {
        tab_state::mutate(&state.tab_state, |ts| {
            if let Some(o) = ts.origins.iter_mut().find(|o| &o.id == origin_id) {
                o.landed_secrets.remove(&profile_id);
            }
            Ok(())
        })?;
    }
    let _ = app.emit(crate::commands::connection::PROFILES_CHANGED_EVENT, ());
    describe(&state, &updated)
}

/// Store the password a connect found missing, under the account the
/// connection signs in with — the person's own user's when one is in force.
///
/// Not for a connection from an origin that signs in with the published user:
/// storing there would be overwritten by the next sync, and the way to keep
/// one's own password against an origin is `set_secret_override`, which the
/// prompt calls instead.
#[tauri::command]
pub fn remember_password(
    state: State<'_, AppState>,
    profile_id: String,
    password: String,
) -> AppResult<()> {
    let profile = profile_of(&state, &profile_id)?;
    if profile.driver == Driver::Sqlite {
        return Ok(());
    }
    if profile.origin_id.is_some() && personal_user(&state.policy, &profile).is_none() {
        return Err(AppError::InvalidInput(
            "this connection comes from a shared origin — keep your own password instead".into(),
        ));
    }
    let account = effective_profile(&state.policy, &profile).keyring_account();
    keychain::set_password(&account, &password)
}
