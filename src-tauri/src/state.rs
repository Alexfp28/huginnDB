use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use sqlx::{MySqlPool, PgPool, SqlitePool};
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Driver {
    Postgres,
    Mysql,
    Sqlite,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub driver: Driver,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    #[serde(default)]
    pub ssl: bool,
    #[serde(default)]
    pub ssh_tunnel: Option<SshTunnel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshTunnel {
    pub host: String,
    pub port: u16,
    pub username: String,
}

impl ConnectionProfile {
    pub fn keyring_account(&self) -> String {
        format!("{}::{}", self.id, self.username)
    }
}

#[derive(Clone)]
pub enum DbPool {
    Postgres(PgPool),
    Mysql(MySqlPool),
    Sqlite(SqlitePool),
}

#[derive(Default)]
pub struct ActiveConnections {
    inner: HashMap<String, DbPool>,
}

impl ActiveConnections {
    pub fn insert(&mut self, id: String, pool: DbPool) {
        self.inner.insert(id, pool);
    }

    pub fn remove(&mut self, id: &str) -> Option<DbPool> {
        self.inner.remove(id)
    }

    pub fn get(&self, id: &str) -> Option<DbPool> {
        self.inner.get(id).cloned()
    }

    pub fn ids(&self) -> Vec<String> {
        self.inner.keys().cloned().collect()
    }
}

pub struct AppState {
    pub connections: Arc<RwLock<ActiveConnections>>,
    pub profiles: Arc<RwLock<Vec<ConnectionProfile>>>,
}

impl AppState {
    pub fn new() -> Self {
        let profiles = crate::store::load_profiles().unwrap_or_default();
        Self {
            connections: Arc::new(RwLock::new(ActiveConnections::default())),
            profiles: Arc::new(RwLock::new(profiles)),
        }
    }
}
