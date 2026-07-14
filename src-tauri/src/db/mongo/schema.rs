//! MongoDB introspection: databases, collections, inferred fields, indexes.
//!
//! MongoDB is schemaless, so there is no catalog to read column types from the
//! way the SQL drivers do. Field lists are **inferred** by sampling documents
//! ([`infer_columns`]); the result is best-effort and reflects only what the
//! sample contained. Everything here returns the same DTOs the SQL explorer
//! uses ([`DatabaseInfo`], [`TableInfo`], [`ColumnInfo`], [`IndexInfo`]) so the
//! frontend tree renders MongoDB without a separate code path.

use crate::commands::schema::{
    ColumnInfo, DatabaseInfo, IndexInfo, PrivilegeInfo, TableInfo, UserInfo,
};
use crate::db::ddl::{ColumnDef, IndexDef, TableStructure};
use crate::error::{AppError, AppResult};
use crate::state::MongoConn;
use mongodb::bson::{doc, Document};
use mongodb::results::CollectionType;

/// Number of documents sampled when inferring a collection's field list.
const SAMPLE_SIZE: i64 = 100;

/// Resolve the [`mongodb::Database`] a connection handle targets, or fail if no
/// database has been selected (the parent cluster connection before the user
/// expands a database in the explorer).
pub fn resolve_db(conn: &MongoConn) -> AppResult<mongodb::Database> {
    let name = conn
        .database
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AppError::InvalidInput(
                "no database selected — expand a database in the explorer or include one in the \
             connection URI (mongodb://host/<database>)"
                    .into(),
            )
        })?;
    Ok(conn.client.database(name))
}

/// List every database in the cluster.
pub async fn list_databases(conn: &MongoConn) -> AppResult<Vec<DatabaseInfo>> {
    let names = conn.client.list_database_names().await?;
    Ok(names
        .into_iter()
        .map(|name| DatabaseInfo { name })
        .collect())
}

/// List the collections (and views) of the target database, with approximate
/// document counts and on-disk sizes.
pub async fn list_collections(conn: &MongoConn) -> AppResult<Vec<TableInfo>> {
    // A parent cluster connection has no database selected yet — the explorer
    // browses collections only after the user expands a specific database (a
    // synthetic `<id>::db::<name>` child pool is opened then). Return empty
    // rather than erroring via `resolve_db`, mirroring MySQL's `list_tables`
    // returning `Ok(vec![])` when `SELECT DATABASE()` is NULL. Without this the
    // frontend's parallel `listDatabases()` + `listTables()` boot probe rejects
    // and blanks the entire tree for a multi-DB Mongo connection (#52).
    if no_database_selected(conn) {
        return Ok(Vec::new());
    }
    let db = resolve_db(conn)?;
    let db_name = db.name().to_string();

    let sizes = collection_sizes(&db, &db_name).await;

    let mut cursor = db.list_collections().await?;
    let mut out = Vec::new();
    while cursor.advance().await? {
        let spec = cursor.deserialize_current()?;
        let is_view = spec.collection_type == CollectionType::View;
        let row_count = if is_view {
            None
        } else {
            // estimated_document_count uses collection metadata: a single fast
            // call, unlike a full COUNT scan.
            db.collection::<Document>(&spec.name)
                .estimated_document_count()
                .await
                .ok()
        };
        out.push(TableInfo {
            schema: db_name.clone(),
            size_bytes: sizes.get(&spec.name).copied(),
            name: spec.name,
            kind: if is_view {
                "view".into()
            } else {
                "table".into()
            },
            row_count,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// On-disk size (data + indexes) per collection name, sourced from a single
/// `$collStats` aggregation run at the database level — one round trip for
/// every collection at once, rather than a `collStats` command per collection
/// (the N+1 cost this was originally deferred over). Best-effort: an older
/// server or a role without the `collStats` privilege just leaves sizes
/// unknown (empty map) instead of failing the whole listing.
async fn collection_sizes(
    db: &mongodb::Database,
    db_name: &str,
) -> std::collections::HashMap<String, u64> {
    let mut sizes = std::collections::HashMap::new();
    let Ok(mut cursor) = db
        .aggregate(vec![doc! {"$collStats": {"storageStats": {}}}])
        .await
    else {
        return sizes;
    };
    let prefix = format!("{db_name}.");
    while matches!(cursor.advance().await, Ok(true)) {
        let Ok(stat) = cursor.deserialize_current() else {
            continue;
        };
        let name = stat
            .get_str("ns")
            .ok()
            .and_then(|ns| ns.strip_prefix(&prefix));
        let Some(name) = name else { continue };
        let size = stat
            .get_document("storageStats")
            .ok()
            .and_then(|s| {
                s.get_i64("totalSize")
                    .or_else(|_| s.get_i64("storageSize"))
                    .or_else(|_| s.get_i64("size"))
                    .ok()
            })
            .map(|n| n.max(0) as u64);
        if let Some(size) = size {
            sizes.insert(name.to_string(), size);
        }
    }
    sizes
}

/// Infer a collection's field list by sampling documents.
///
/// Returns one [`ColumnInfo`] per distinct top-level field seen across the
/// sample, `_id` first. `data_type` is the BSON type name of the field's first
/// observed value; `nullable` is true when the field was absent from at least
/// one sampled document (so it is not guaranteed present). `is_primary_key` is
/// set only for `_id`.
pub async fn infer_columns(conn: &MongoConn, collection: &str) -> AppResult<Vec<ColumnInfo>> {
    let db = resolve_db(conn)?;
    let coll = db.collection::<Document>(collection);

    let mut cursor = coll
        .aggregate(vec![doc! {"$sample": {"size": SAMPLE_SIZE}}])
        .await?;

    // Preserve first-seen field order; track type + how many docs contained it.
    let mut order: Vec<String> = Vec::new();
    let mut types: std::collections::HashMap<String, &'static str> =
        std::collections::HashMap::new();
    let mut present: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut sampled = 0usize;

    while cursor.advance().await? {
        let docu = cursor.deserialize_current()?;
        sampled += 1;
        for (k, v) in &docu {
            if !types.contains_key(k) {
                order.push(k.clone());
                types.insert(k.clone(), super::values::bson_type_name(v));
            }
            *present.entry(k.clone()).or_insert(0) += 1;
        }
    }

    // Ensure `_id` is first even if the sample happened to order it later.
    order.sort_by_key(|k| if k == "_id" { 0 } else { 1 });

    let cols = order
        .into_iter()
        .map(|name| {
            let always_present = present.get(&name).copied().unwrap_or(0) >= sampled.max(1);
            ColumnInfo {
                data_type: types.get(&name).copied().unwrap_or("null").to_string(),
                nullable: name != "_id" && !always_present,
                is_primary_key: name == "_id",
                referenced_schema: None,
                referenced_table: None,
                referenced_column: None,
                name,
            }
        })
        .collect();
    Ok(cols)
}

/// List the indexes defined on a collection.
pub async fn list_indexes(conn: &MongoConn, collection: &str) -> AppResult<Vec<IndexInfo>> {
    let db = resolve_db(conn)?;
    let coll = db.collection::<Document>(collection);
    let mut cursor = coll.list_indexes().await?;
    let mut out = Vec::new();
    while cursor.advance().await? {
        let model = cursor.deserialize_current()?;
        let columns: Vec<String> = model.keys.keys().cloned().collect();
        let name = model
            .options
            .as_ref()
            .and_then(|o| o.name.clone())
            .unwrap_or_else(|| columns.join("_"));
        let unique = model
            .options
            .as_ref()
            .and_then(|o| o.unique)
            .unwrap_or(false);
        out.push(IndexInfo {
            name,
            columns,
            unique,
        });
    }
    Ok(out)
}

/// Build a read-only [`TableStructure`] for a collection (inferred fields +
/// real indexes). MongoDB has no foreign keys; structure *editing* is deferred
/// to the roadmap, so the visual editor renders this in read-only mode.
pub async fn table_structure(conn: &MongoConn, collection: &str) -> AppResult<TableStructure> {
    let db_name = resolve_db(conn)?.name().to_string();
    let columns = infer_columns(conn, collection).await?;
    let indexes = list_indexes(conn, collection).await?;

    let column_defs = columns
        .into_iter()
        .map(|c| ColumnDef {
            name: c.name,
            original_name: None,
            data_type: c.data_type,
            nullable: c.nullable,
            default: None,
            is_primary_key: c.is_primary_key,
            auto_increment: false,
        })
        .collect();

    let index_defs = indexes
        .into_iter()
        .map(|i| IndexDef {
            name: Some(i.name),
            columns: i.columns,
            unique: i.unique,
        })
        .collect();

    Ok(TableStructure {
        schema: Some(db_name),
        name: collection.to_string(),
        columns: column_defs,
        indexes: index_defs,
        foreign_keys: vec![],
    })
}

/// Roles that imply admin-equivalent access, used to derive
/// [`UserInfo::is_superuser`]. Not exhaustive (custom roles can grant
/// equivalent power) — best-effort, matching the built-in role names
/// MongoDB ships.
const SUPERUSER_ROLES: &[&str] = &[
    "root",
    "dbOwner",
    "userAdminAnyDatabase",
    "dbAdminAnyDatabase",
    "clusterAdmin",
    "atlasAdmin",
];

/// Whether the connection has no database selected (the parent cluster
/// connection before the user expands a specific database in the explorer).
fn no_database_selected(conn: &MongoConn) -> bool {
    conn.database.as_deref().filter(|s| !s.is_empty()).is_none()
}

/// List the users defined on the resolved database via `usersInfo`.
///
/// MongoDB scopes users per-database (not per-cluster), so this normally
/// mirrors [`list_collections`] in only covering the database the connection
/// handle currently targets. A parent cluster connection has no database to
/// scope to, though — unlike `list_collections` (which can just return an
/// empty list, since collections are inherently per-database), "who can log
/// into this cluster" has a real cluster-wide answer: `usersInfo` accepts
/// `{forAllDBs: true}` to return every user on every database, run against
/// any database (`admin` here, mirroring [`ping`]'s cluster-level probe).
pub async fn list_users(conn: &MongoConn) -> AppResult<Vec<UserInfo>> {
    let result = if no_database_selected(conn) {
        conn.client
            .database("admin")
            .run_command(doc! {"usersInfo": 1, "forAllDBs": true})
            .await?
    } else {
        resolve_db(conn)?.run_command(doc! {"usersInfo": 1}).await?
    };
    let users = result.get_array("users").cloned().unwrap_or_default();

    let mut out: Vec<UserInfo> = users
        .into_iter()
        .filter_map(|u| u.as_document().cloned())
        .map(|u| {
            let name = u.get_str("user").unwrap_or("").to_string();
            let roles: Vec<(String, bool)> = u
                .get_array("roles")
                .ok()
                .into_iter()
                .flatten()
                .filter_map(|r| r.as_document())
                .map(|r| {
                    let role = r.get_str("role").unwrap_or("").to_string();
                    let db_name = r.get_str("db").unwrap_or("").to_string();
                    let is_super = SUPERUSER_ROLES.contains(&role.as_str());
                    (format!("{role}@{db_name}"), is_super)
                })
                .collect();
            UserInfo {
                name,
                is_superuser: roles.iter().any(|(_, is_super)| *is_super),
                // MongoDB has no per-account lock flag reachable via
                // usersInfo; a user document existing means it can log in.
                can_login: true,
                roles: roles.into_iter().map(|(r, _)| r).collect(),
            }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// List `user`'s effective privileges (resource + action) on the resolved
/// database, via `usersInfo` with `showPrivileges: true`.
///
/// Same cluster-wide fallback as [`list_users`]: without a selected database
/// there is no single `db` to qualify `user` with, so the lookup runs
/// `{forAllDBs: true}` against `admin` and filters the returned users by name
/// client-side instead (a user with the same name can exist on more than one
/// database; privileges from every match are concatenated).
pub async fn list_privileges(conn: &MongoConn, user: &str) -> AppResult<Vec<PrivilegeInfo>> {
    let users = if no_database_selected(conn) {
        let result = conn
            .client
            .database("admin")
            .run_command(doc! {
                "usersInfo": {"forAllDBs": true},
                "showPrivileges": true,
            })
            .await?;
        result
            .get_array("users")
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|u| {
                u.as_document()
                    .and_then(|d| d.get_str("user").ok())
                    .is_some_and(|name| name == user)
            })
            .collect()
    } else {
        let db = resolve_db(conn)?;
        let db_name = db.name().to_string();
        let result = db
            .run_command(doc! {
                "usersInfo": {"user": user, "db": db_name},
                "showPrivileges": true,
            })
            .await?;
        result.get_array("users").cloned().unwrap_or_default()
    };

    let mut out = Vec::new();
    for u in users.iter().filter_map(|u| u.as_document()) {
        let privs = u
            .get_array("inheritedPrivileges")
            .ok()
            .into_iter()
            .flatten();
        for p in privs.filter_map(|p| p.as_document()) {
            let resource = p.get_document("resource").ok();
            let schema = resource
                .and_then(|r| r.get_str("db").ok())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let table = resource
                .and_then(|r| r.get_str("collection").ok())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            for action in p.get_array("actions").ok().into_iter().flatten() {
                if let Some(action) = action.as_str() {
                    out.push(PrivilegeInfo {
                        privilege: action.to_string(),
                        schema: schema.clone(),
                        table: table.clone(),
                    });
                }
            }
        }
    }
    Ok(out)
}

/// Best-effort liveness check used by `test_connection`: ping the admin db.
pub async fn ping(conn: &MongoConn) -> AppResult<()> {
    conn.client
        .database("admin")
        .run_command(doc! {"ping": 1})
        .await?;
    Ok(())
}
