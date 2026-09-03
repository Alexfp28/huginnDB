# Gotcha #006: MySQL order_clause no longer string-rewrites identifiers

**Fecha:** 2026-09-03

`fetch_table_data` computes `pg_or_sqlite` once and passes the right boolean straight to `quote_ident`, replacing the old brittle `"col"` → `` `col` `` string-rewriting hack. Don't reintroduce it.

## Detail

**The MySQL `order_clause` previously had a brittle string-rewriting hack** to convert `"col"` → `` `col` ``. Now `fetch_table_data` computes `pg_or_sqlite` once and passes the right boolean to `quote_ident` from the start. Don't reintroduce the hack.
