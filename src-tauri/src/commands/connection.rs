use crate::error::{AppError, AppResult};
use crate::state::{AppState, ConnectionProfile, DbPool, Driver};
use crate::store;
use sqlx::mysql::MySqlPoolOptions;
use sqlx::postgres::PgPoolOptions;
use sqlx::sqlite::SqlitePoolOptions;
use tauri::State;
use uuid::Uuid;

const KEYRING_SERVICE: &str = "io.huginn.app";

fn build_url(profile: &ConnectionProfile, password: &str) -> String {
    let pwd = urlencoding(password);
    let user = urlencoding(&profile.username);
    match profile.driver {
        Driver::Postgres => format!(
            "postgres://{}:{}@{}:{}/{}{}",
            user, pwd, profile.host, profile.port, profile.database,
            if profile.ssl { "?sslmode=require" } else { "" }
        ),
        Driver::Mysql => format!(
            "mysql://{}:{}@{}:{}/{}{}",
            user, pwd, profile.host, profile.port, profile.database,
            if profile.ssl { "?ssl-mode=REQUIRED" } else { "" }
        ),
        Driver::Sqlite => {
            // For SQLite the `database` field is the file path.
            format!("sqlite://{}", profile.database)
        }
    }
}

fn urlencoding(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

async fn open_pool(profile: &ConnectionProfile, password: &str) -> AppResult<DbPool> {
    let url = build_url(profile, password);
    match profile.driver {
        Driver::Postgres => {
            let pool = PgPoolOptions::new()
                .max_connections(5)
                .connect(&url)
                .await?;
            Ok(DbPool::Postgres(pool))
        }
        Driver::Mysql => {
            let pool = MySqlPoolOptions::new()
                .max_connections(5)
                .connect(&url)
                .await?;
            Ok(DbPool::Mysql(pool))
        }
        Driver::Sqlite => {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect(&url)
                .await?;
            Ok(DbPool::Sqlite(pool))
        }
    }
}

fn read_password(profile: &ConnectionProfile) -> AppResult<String> {
    if matches!(profile.driver, Driver::Sqlite) {
        return Ok(String::new());
    }
    let account = profile.keyring_account();
    let entry = keyring::Entry::new(KEYRING_SERVICE, &account)?;
    match entry.get_password() {
        Ok(p) => Ok(p),
        Err(keyring::Error::NoEntry) => Err(AppError::NotFound(format!(
            "no stored password for {}",
            account
        ))),
        Err(e) => Err(AppError::Keyring(e)),
    }
}

#[tauri::command]
pub fn list_profiles(state: State<'_, AppState>) -> AppResult<Vec<ConnectionProfile>> {
    Ok(state.profiles.read().clone())
}

#[tauri::command]
pub fn save_profile(
    state: State<'_, AppState>,
    mut profile: ConnectionProfile,
    password: Option<String>,
) -> AppResult<ConnectionProfile> {
    if profile.id.is_empty() {
        profile.id = Uuid::new_v4().to_string();
    }

    if let Some(pw) = password {
        if !matches!(profile.driver, Driver::Sqlite) {
            let entry = keyring::Entry::new(KEYRING_SERVICE, &profile.keyring_account())?;
            entry.set_password(&pw)?;
        }
    }

    {
        let mut profiles = state.profiles.write();
        if let Some(existing) = profiles.iter_mut().find(|p| p.id == profile.id) {
            *existing = profile.clone();
        } else {
            profiles.push(profile.clone());
        }
        store::save_profiles(&profiles)?;
    }
    Ok(profile)
}

#[tauri::command]
pub fn delete_profile(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let mut profiles = state.profiles.write();
    let removed = profiles
        .iter()
        .position(|p| p.id == id)
        .map(|i| profiles.remove(i));
    if let Some(p) = removed {
        if !matches!(p.driver, Driver::Sqlite) {
            let entry = keyring::Entry::new(KEYRING_SERVICE, &p.keyring_account())?;
            let _ = entry.delete_credential();
        }
    }
    store::save_profiles(&profiles)?;
    Ok(())
}

#[tauri::command]
pub async fn test_connection(
    profile: ConnectionProfile,
    password: Option<String>,
) -> AppResult<String> {
    let pw = match password {
        Some(p) => p,
        None => read_password(&profile)?,
    };
    let pool = open_pool(&profile, &pw).await?;
    // Run a trivial query to confirm.
    match pool {
        DbPool::Postgres(p) => {
            sqlx::query("SELECT 1").execute(&p).await?;
        }
        DbPool::Mysql(p) => {
            sqlx::query("SELECT 1").execute(&p).await?;
        }
        DbPool::Sqlite(p) => {
            sqlx::query("SELECT 1").execute(&p).await?;
        }
    }
    Ok("ok".into())
}

#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    id: String,
    password: Option<String>,
) -> AppResult<()> {
    let profile = state
        .profiles
        .read()
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("profile {}", id)))?;

    let pw = match password {
        Some(p) => p,
        None => read_password(&profile)?,
    };

    let pool = open_pool(&profile, &pw).await?;
    state.connections.write().insert(id, pool);
    Ok(())
}

#[tauri::command]
pub fn disconnect(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.connections.write().remove(&id);
    Ok(())
}

#[tauri::command]
pub fn active_connections(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    Ok(state.connections.read().ids())
}
