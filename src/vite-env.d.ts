/// <reference types="vite/client" />

/**
 * Last-commit date (ISO 8601) per bundled documentation file, keyed by the
 * repo-relative path (e.g. "docs/MCP.md"). Injected at build time by the
 * `docDates` step in `vite.config.ts` (git `log -1`, with an mtime fallback).
 * `undefined` for a path with no resolvable date.
 */
declare const __DOC_UPDATED__: Record<string, string | undefined>;

declare module "*?worker" {
  const workerConstructor: {
    new (): Worker;
  };
  export default workerConstructor;
}
