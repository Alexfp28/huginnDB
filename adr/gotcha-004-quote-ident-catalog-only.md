# Gotcha #004: quote_ident is for catalog identifiers, not user input

**Fecha:** 2026-09-03

User input always goes through bound parameters (`$1` / `?`), never `quote_ident`, except for the one sanctioned, validation-mediated exception in the DDL builder documented separately (gotcha #16).

## Detail

**`quote_ident` is for catalog-sourced identifiers, not arbitrary user input.**
   Documented in `src-tauri/src/db/sql.rs` and in `SECURITY.md`. User input always goes through bound parameters (`$1` / `?`).
