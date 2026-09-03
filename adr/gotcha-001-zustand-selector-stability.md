# Gotcha #001: Zustand selectors must be reference-stable

**Fecha:** 2026-09-03

Selectors like `s => s.entries.filter(...)` return a fresh array or object on every call, so `Object.is` always sees a difference and React re-renders forever. Subscribe to raw state and derive arrays/objects with `useMemo` in the component instead.

## Detail

**Zustand selectors must return reference-stable values.**
   Anything like `s => s.entries.filter(...)`, `s => [...a, ...b]`, or `s => allThemes(s)` returns a fresh array each call → `Object.is` always differs → infinite re-render → React caps update depth.
   **Rule**: subscribe to the raw state, derive arrays/objects with `useMemo` in the component. The store has a banner comment in `src/stores/preferences/theme.ts` reinforcing this — don't undo it. CONTRIBUTING.md also documents the rule under "Coding standards → TypeScript / React".
