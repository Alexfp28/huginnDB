use crate::error::AppResult;
use crate::state::ConnectionProfile;
use std::path::PathBuf;

fn profiles_path() -> AppResult<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| crate::error::AppError::InvalidInput("no config dir".into()))?;
    let dir = base.join("Huginn");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("profiles.json"))
}

pub fn load_profiles() -> AppResult<Vec<ConnectionProfile>> {
    let path = profiles_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = std::fs::read(&path)?;
    let profiles: Vec<ConnectionProfile> = serde_json::from_slice(&bytes)?;
    Ok(profiles)
}

pub fn save_profiles(profiles: &[ConnectionProfile]) -> AppResult<()> {
    let path = profiles_path()?;
    let bytes = serde_json::to_vec_pretty(profiles)?;
    std::fs::write(&path, bytes)?;
    Ok(())
}
