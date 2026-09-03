# Gotcha #012: Double-click on a grid cell edits inline, not in a modal

**Fecha:** 2026-09-03

`DataGrid.openCellEdit` routes by column type — a single-column FK opens `FkCombobox`, an editable cell opens inline `CellInput`, a read-only query result opens the modal as a viewer — tracked by the row's values-array identity rather than a display index.

## Detail

**Double-click on a data-grid cell edits inline, not in a modal.** `DataGrid.openCellEdit` routes by column: single-column FK → `FkCombobox`; editable cell → inline `CellInput` (the shared input also used by the insert draft row, with an *expand* button that escalates to the Monaco `CellEditor`); read-only query result → the modal as a viewer. `inlineEdit` is tracked by the row's *values array* identity (gotcha #7), not a display index. The inline commit no-ops when the value is unchanged, which is what makes the blur fired during *expand* harmless. Don't route double-click straight to the modal again.
