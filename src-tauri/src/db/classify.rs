//! Which write tier a single statement needs, across every driver.
//!
//! [`crate::db::sql::classify`] answers for SQL by first-keyword heuristic and
//! [`crate::db::mongo::shell::MongoOp::class`] answers for mongosh by parsing;
//! this module is the one place that picks between them. It exists because the
//! choice used to be made twice, differently, and neither copy was a compile
//! error:
//!
//! * The connector's `run_query` decided "is this Mongo?" by looking the
//!   resolved id up in its **own** connection map. With the desktop app serving
//!   the shared pool that map is empty (see `resolve_mongo_target`), so every
//!   bridged Mongo statement fell through to the SQL classifier. `db.c.find({})`
//!   starts with none of `select`/`with`/`show`/`explain`/`pragma`, so a plain
//!   read came back `DataWrite` and a `read-only` MongoDB connection was refused
//!   its own reads.
//! * `crate::bridge::server`'s `class_of` re-derived the tier with the same
//!   SQL-only classifier, so the app agreed for the same wrong reason.
//!
//! While the mongosh grammar had no DDL that was merely too strict. It stopped
//! being harmless when the grammar gained `createIndex` / `drop` /
//! `renameCollection`: both sides would have tiered those `DataWrite` and handed
//! a `data` connection the schema changes its policy denies — a privilege
//! escalation introduced by a grammar rule rather than by a permission change.
//!
//! The discriminator is the statement **text**, not the pool. That is the one
//! input both enforcement points always have, and it makes the decision pure and
//! testable without a server.

use crate::db::mongo::shell;
use crate::db::sql::StmtClass;

/// The tier `sql` requires, whichever grammar it is written in.
///
/// An unparseable `db.…` statement is reported as [`StmtClass::Ddl`] — the
/// strictest tier. It will fail at parse time anyway when it runs, so the only
/// thing this choice affects is which policies get to *reach* that error, and
/// the safe direction for an authorisation decision is to assume the most.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
pub fn classify_statement(sql: &str) -> StmtClass {
    if shell::looks_like_mongo(sql) {
        return shell::parse(sql)
            .map(|c| c.op.class())
            .unwrap_or(StmtClass::Ddl);
    }
    crate::db::sql::classify(sql)
}

/// Whether `sql` is a whole-relation `UPDATE`/`DELETE` with no predicate, in
/// either grammar — the footgun the MCP connector refuses at every tier.
///
/// Mongo was exempt from this guard while it lived only in [`crate::db::sql`],
/// so `db.users.deleteMany({})` was accepted at `data` while `DELETE FROM users`
/// was refused everywhere. Same operation, same blast radius, opposite answers.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
pub fn is_unfiltered_write(sql: &str) -> bool {
    if shell::looks_like_mongo(sql) {
        return shell::parse(sql)
            .map(|c| c.op.is_unfiltered_write())
            .unwrap_or(false);
    }
    crate::db::sql::is_unfiltered_write(sql)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mongo_reads_are_reads() {
        for sql in [
            "db.users.find({})",
            "db.users.findOne({_id: 1})",
            "db.users.aggregate([{$match: {a: 1}}])",
            "db.users.countDocuments({})",
            "db.users.distinct(\"city\")",
        ] {
            assert_eq!(classify_statement(sql), StmtClass::Read, "{sql}");
        }
    }

    #[test]
    fn mongo_dml_is_data_write() {
        for sql in [
            "db.users.insertOne({a: 1})",
            "db.users.insertMany([{a: 1}])",
            "db.users.updateOne({a: 1}, {$set: {b: 2}})",
            "db.users.updateMany({a: 1}, {$set: {b: 2}})",
            "db.users.replaceOne({a: 1}, {a: 2})",
            "db.users.deleteOne({a: 1})",
            "db.users.deleteMany({a: 1})",
        ] {
            assert_eq!(classify_statement(sql), StmtClass::DataWrite, "{sql}");
        }
    }

    /// The escalation guard: every operation the grammar gained must land on the
    /// `full` tier, not on `data`.
    #[test]
    fn mongo_ddl_is_ddl() {
        for sql in [
            "db.users.createIndex({createdAt: -1})",
            "db.users.dropIndex(\"createdAt_-1\")",
            "db.users.hideIndex(\"createdAt_-1\")",
            "db.users.unhideIndex(\"createdAt_-1\")",
            "db.users.drop()",
            "db.users.renameCollection(\"clients\")",
        ] {
            assert_eq!(classify_statement(sql), StmtClass::Ddl, "{sql}");
        }
    }

    #[test]
    fn unparseable_mongo_falls_to_the_strictest_tier() {
        assert_eq!(classify_statement("db.users.explode()"), StmtClass::Ddl);
        assert_eq!(classify_statement("db.users."), StmtClass::Ddl);
    }

    /// A `db.` prefix is what routes to the Mongo grammar, so a SQL statement
    /// must not be able to acquire one by accident. Nothing in SQL starts that
    /// way, and these are the near misses.
    #[test]
    fn sql_still_goes_to_the_sql_classifier() {
        assert_eq!(
            classify_statement("SELECT * FROM db.users"),
            StmtClass::Read
        );
        assert_eq!(
            classify_statement("  select 1"),
            StmtClass::Read,
            "leading whitespace"
        );
        assert_eq!(
            classify_statement("UPDATE t SET a = 1 WHERE id = 1"),
            StmtClass::DataWrite
        );
        assert_eq!(classify_statement("DROP TABLE t"), StmtClass::Ddl);
        assert_eq!(classify_statement("TRUNCATE TABLE t"), StmtClass::Ddl);
        assert_eq!(classify_statement("SELECT a INTO t FROM u"), StmtClass::Ddl);
    }

    #[test]
    fn unfiltered_write_spans_both_grammars() {
        assert!(is_unfiltered_write("db.users.deleteMany({})"));
        assert!(is_unfiltered_write(
            "db.users.updateMany({}, {$set: {a: 1}})"
        ));
        assert!(is_unfiltered_write("DELETE FROM users"));

        assert!(!is_unfiltered_write("db.users.deleteMany({a: 1})"));
        assert!(!is_unfiltered_write(
            "db.users.updateMany({a: 1}, {$set: {b: 2}})"
        ));
        // The documented opt-in: a predicate that is trivially true.
        assert!(!is_unfiltered_write(
            "db.users.deleteMany({_id: {$exists: true}})"
        ));
        assert!(!is_unfiltered_write("DELETE FROM users WHERE 1=1"));
        // Scope-unambiguous by construction, and already behind `full` — the
        // SQL guard leaves `DROP TABLE` alone for the same reason.
        assert!(!is_unfiltered_write("db.users.drop()"));
        assert!(!is_unfiltered_write("db.users.deleteOne({})"));
    }
}
