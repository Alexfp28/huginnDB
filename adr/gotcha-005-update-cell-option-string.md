# Gotcha #005: update_cell's value is Option<String> end-to-end

**Fecha:** 2026-09-03

The cell editor only ever emits text and drivers cast textual literals server-side, so `serde_json::Value` can't be pushed through `update_cell` — sqlx postgres won't encode `Value` to arbitrary column types.

## Detail

**`update_cell` value is `Option<String>` end-to-end.**
   The cell editor only emits text; drivers cast textual literals server-side. Don't try to push `serde_json::Value` through it — `sqlx` postgres won't encode `Value` to arbitrary column types.
