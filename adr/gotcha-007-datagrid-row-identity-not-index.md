# Gotcha #007: DataGrid mutation callbacks use row values, not a row index

**Fecha:** 2026-09-03

TanStack's `row.index` is the filtered display index while parents used to resolve the PK from the unfiltered backend page, so the two diverge as soon as a client filter is active. Anything needing identity must read `row.original`, the values array passed to the callback.

## Detail

**DataGrid cell-mutation callbacks pass `row.original` (the full values array), NOT a row index.** The previous index-based contract corrupted data when the user had `globalFilter` active: TanStack's `row.index` is the *filtered display* index, while parents resolved the PK from `result.rows[index]` (the unfiltered backend page). The two diverge as soon as the client filter is non-trivial. Anything that needs identity (PK lookup, delete, duplicate, FK overlay anchor) reads from the values array passed to the callback. See `DataGrid.tsx` props + `TableDataTab.pkValueFromRow`.
