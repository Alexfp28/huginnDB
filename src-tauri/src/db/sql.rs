//! Small SQL helpers shared across command handlers.

/// Wrap `name` in the quoting characters appropriate for the driver.
///
/// * `pg_or_sqlite = true`  → use double quotes (`"name"`).
/// * `pg_or_sqlite = false` → use backticks (`` `name` ``), MySQL style.
///
/// The function escapes any embedded quote characters by doubling them,
/// matching the standard SQL identifier-quoting rules. Callers are still
/// responsible for sourcing `name` from a trusted catalog query — this
/// helper is for layout, not for sanitising arbitrary user input.
pub fn quote_ident(pg_or_sqlite: bool, name: &str) -> String {
    if pg_or_sqlite {
        format!("\"{}\"", name.replace('"', "\"\""))
    } else {
        format!("`{}`", name.replace('`', "``"))
    }
}

/// Best-effort classification of a SQL statement as a read-only query.
///
/// We use this to decide whether [`crate::commands::query::execute_query`]
/// should fetch a result set or just report `rows_affected`. The check is
/// intentionally simple — it inspects the first keyword after leading
/// whitespace. Anything unusual (e.g. multi-statement scripts, DDL that
/// returns rows on some drivers) falls back to the write path and the user
/// still sees the row-count summary.
pub fn is_read_only(sql: &str) -> bool {
    let head = sql.trim_start().to_ascii_lowercase();
    head.starts_with("select")
        || head.starts_with("with")
        || head.starts_with("show")
        || head.starts_with("explain")
        || head.starts_with("pragma")
}

/// Write-capability tier a single SQL statement requires. Drives the MCP
/// connector's per-connection enforcement against [`crate::state::McpWritePolicy`]:
/// a `read-only` connection admits only [`StmtClass::Read`], `data` admits
/// [`StmtClass::DataWrite`] as well, and `full` admits [`StmtClass::Ddl`] too.
///
/// This classifier (and its siblings below) is consumed only by the `mcp`
/// feature's enforcement path, but its unit tests run under the default
/// feature set, so it stays compiled unconditionally and only silences the
/// dead-code lint when `mcp` is off.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StmtClass {
    /// `SELECT` / `WITH` / `SHOW` / `EXPLAIN` / `PRAGMA` — reads nothing back
    /// that changes state.
    Read,
    /// Row-level DML: `INSERT` / `UPDATE` / `DELETE` / `MERGE` / … — changes
    /// data but not schema.
    DataWrite,
    /// Schema / privilege change: `CREATE` / `DROP` / `ALTER` / `TRUNCATE` /
    /// `RENAME` / `GRANT` / `REVOKE` / `COMMENT`.
    Ddl,
}

/// Best-effort classification of a statement as DDL (schema/privilege change).
///
/// Same first-keyword heuristic as [`is_read_only`]. `TRUNCATE` is grouped
/// with DDL rather than DML on purpose: it is an irreversible whole-table
/// operation, so it belongs behind the strictest (`full`) tier, not the
/// row-level `data` tier.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
pub fn is_ddl(sql: &str) -> bool {
    let head = sql.trim_start().to_ascii_lowercase();
    const DDL_PREFIXES: [&str; 8] = [
        "create", "drop", "alter", "truncate", "rename", "grant", "revoke", "comment",
    ];
    DDL_PREFIXES.iter().any(|p| head.starts_with(p))
}

/// Classify a single statement into the write tier it requires. Reads win
/// first (so a read never counts as a write), then DDL, then everything else
/// is treated as row-level DML — the conservative default, since an
/// unrecognised non-read statement must not slip in under a read-only or
/// data-only policy.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
pub fn classify(sql: &str) -> StmtClass {
    if is_read_only(sql) {
        StmtClass::Read
    } else if is_ddl(sql) {
        StmtClass::Ddl
    } else {
        StmtClass::DataWrite
    }
}

/// Whether `sql` is an `UPDATE` or `DELETE` with no `WHERE` clause — a
/// whole-table mutation. The MCP connector refuses these outright (even at
/// `data`/`full` tiers): an AI client emitting an unqualified `DELETE FROM t`
/// or `UPDATE t SET …` is a classic footgun, and requiring an explicit
/// predicate (a literal `WHERE 1=1` if the user really means "all rows")
/// turns a silent whole-table wipe into a deliberate one.
///
/// `WHERE` is matched as a whole token (case-insensitive) so a column or value
/// merely containing the substring doesn't count. A `WHERE` living only inside
/// a comment is a tolerated blind spot — single AI-authored statements rarely
/// carry comments, and this is a guard-rail layered on top of the tier check,
/// not the primary authorisation.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
pub fn is_unfiltered_write(sql: &str) -> bool {
    let head = sql.trim_start().to_ascii_lowercase();
    if !(head.starts_with("update") || head.starts_with("delete")) {
        return false;
    }
    !contains_word(&head, "where")
}

/// True if `word` appears in `haystack_lower` (already lowercased) delimited by
/// non-identifier characters on both sides — a poor-man's tokeniser good enough
/// to spot SQL keywords without a full parser.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
fn contains_word(haystack_lower: &str, word: &str) -> bool {
    haystack_lower
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .any(|tok| tok == word)
}

#[cfg(test)]
mod tests {
    use super::{classify, is_ddl, is_read_only, is_unfiltered_write, StmtClass};

    #[test]
    fn classifies_reads_as_read_only() {
        for sql in [
            "SELECT * FROM t",
            "  select 1",
            "\n\tWITH x AS (SELECT 1) SELECT * FROM x",
            "SHOW TABLES",
            "EXPLAIN SELECT 1",
            "PRAGMA table_info(t)",
        ] {
            assert!(is_read_only(sql), "expected read-only: {sql:?}");
        }
    }

    #[test]
    fn classifies_writes_as_not_read_only() {
        // Backs the MCP `run_query` guard: none of these may pass in the
        // read-only server mode.
        for sql in [
            "UPDATE t SET a = 1",
            "DELETE FROM t",
            "INSERT INTO t VALUES (1)",
            "DROP TABLE t",
            "CREATE TABLE t (id INT)",
            "ALTER TABLE t ADD COLUMN c INT",
            "TRUNCATE t",
        ] {
            assert!(!is_read_only(sql), "expected write: {sql:?}");
        }
    }

    #[test]
    fn classify_splits_read_data_and_ddl() {
        assert_eq!(classify("SELECT 1"), StmtClass::Read);
        assert_eq!(
            classify("  with x as (select 1) select * from x"),
            StmtClass::Read
        );
        assert_eq!(classify("INSERT INTO t VALUES (1)"), StmtClass::DataWrite);
        assert_eq!(
            classify("UPDATE t SET a = 1 WHERE id = 2"),
            StmtClass::DataWrite
        );
        assert_eq!(classify("delete from t where id = 1"), StmtClass::DataWrite);
        assert_eq!(classify("CREATE TABLE t (id INT)"), StmtClass::Ddl);
        assert_eq!(classify("drop table t"), StmtClass::Ddl);
        assert_eq!(classify("ALTER TABLE t ADD COLUMN c INT"), StmtClass::Ddl);
        assert_eq!(classify("TRUNCATE t"), StmtClass::Ddl);
        assert_eq!(classify("GRANT SELECT ON t TO u"), StmtClass::Ddl);
        // An unrecognised non-read statement is conservatively DataWrite so it
        // can never pass under a read-only policy.
        assert_eq!(
            classify("MERGE INTO t USING s ON (t.id = s.id)"),
            StmtClass::DataWrite
        );
    }

    #[test]
    fn is_ddl_matches_schema_and_privilege_statements() {
        for sql in [
            "CREATE TABLE t (id INT)",
            "drop index i",
            "REVOKE ALL ON t FROM u",
        ] {
            assert!(is_ddl(sql), "expected DDL: {sql:?}");
        }
        for sql in ["SELECT 1", "UPDATE t SET a = 1", "INSERT INTO t VALUES (1)"] {
            assert!(!is_ddl(sql), "expected non-DDL: {sql:?}");
        }
    }

    #[test]
    fn flags_whole_table_updates_and_deletes() {
        for sql in [
            "DELETE FROM t",
            "  delete from t  ",
            "UPDATE t SET a = 1",
            "update t set a = 1",
            // A column whose name merely contains "where" is not a WHERE clause,
            // so this whole-table update is still flagged.
            "UPDATE t SET wherever = 1",
        ] {
            assert!(
                is_unfiltered_write(sql),
                "expected whole-table write: {sql:?}"
            );
        }
        for sql in [
            "DELETE FROM t WHERE id = 1",
            "UPDATE t SET a = 1 WHERE id = 2",
            "SELECT * FROM t",
            "INSERT INTO t VALUES (1)",
            // Real WHERE clause even though a value also contains the substring.
            "DELETE FROM t WHERE note = 'nowhere'",
        ] {
            assert!(!is_unfiltered_write(sql), "expected not-flagged: {sql:?}");
        }
    }
}
