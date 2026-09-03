# Gotcha #002: Monaco is bundled, never CDN-loaded

**Fecha:** 2026-09-03

`monaco-setup.ts` wires workers via Vite `?worker` imports and calls `loader.config({ monaco })`; without this the SQL and cell editors go blank whenever Tauri can't reach a CDN. Don't reintroduce a CDN dependency.

## Detail

**Monaco is bundled, not CDN-loaded.**
   `src/lib/monaco/monaco-setup.ts` wires workers via Vite `?worker` imports and calls `loader.config({ monaco })`. Without this, the SQL editor and the cell editor go blank when Tauri can't reach `cdn.jsdelivr.net`. Don't reintroduce a CDN dependency; if you add a new Monaco language, add its worker here.
