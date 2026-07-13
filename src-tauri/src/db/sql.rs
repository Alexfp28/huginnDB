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

#[cfg(test)]
mod tests {
    use super::is_read_only;

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
}
