# Gotcha #011: sqlx rejects Vec<u8> reads on a MySQL BIT column

**Fecha:** 2026-09-03

Its blob-compatibility check only accepts BLOB/STRING/VARBINARY. See gotcha #15 for the full, current MySQL integer/BIT decode-and-write story, which supersedes this note.

## Detail

**`sqlx` rejects `try_get::<Vec<u8>>` on a MySQL `BIT` column** (its blob compatibility check accepts only BLOB/STRING/VARBINARY). See gotcha #15 for the full, current MySQL integer/`BIT` decode + write story — it supersedes this note.
