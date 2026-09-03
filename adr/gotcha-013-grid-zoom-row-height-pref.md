# Gotcha #013: Grid "zoom" is one persisted rowHeight preference

**Fecha:** 2026-09-03

`DataGrid` derives cell height, padding and font size from `gridPrefs.rowHeight` and adjusts it via a non-passive native `Ctrl`+wheel listener, since a JSX `onWheel` is passive and can't `preventDefault` to suppress page zoom. It already round-trips through `prefs.json`.

## Detail

**Grid "zoom" is a single persisted px value: `gridPrefs.rowHeight`.** `DataGrid` derives cell height, padding and font-size from it (via inline `style`, since the values are dynamic and can't be Tailwind classes) and adjusts it on `Ctrl`+wheel (bound as a **non-passive** native listener so `preventDefault` suppresses page-zoom — a JSX `onWheel` is passive and can't). The `TableDataTab` toolbar `+`/`−` buttons nudge the same pref. It already round-trips through `prefs.json`; no backend change is needed to use it. Subscribe to it as a primitive (gotcha #1).
