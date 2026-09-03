# Gotcha #051: Markdown's navigator is React context, and its scroll-to-anchor clears last

**Fecha:** 2026-09-03

`renderBlocks` is memoized on `source` alone, so a callback prop would either go stale or force a full reparse; `DocsDialog`'s `ScrollToAnchor` clears the pending anchor inside the `requestAnimationFrame` after scrolling, not before, or the effect's own cleanup cancels the frame.

## Detail

**`Markdown`'s navigator arrives by React context, not as a prop — and its scroll-to-anchor consumes the anchor *after* the scroll, not before.** Two separate traps in the same component:
    - `renderBlocks` is memoized on `source` alone (`Markdown.tsx`), so a callback threaded down through `renderBlocks` → `renderInline` → `DocLink` would either be captured stale or have to join the dependency array and throw the whole parse away on every parent render. A context that `DocLink` reads during its own render has neither problem. `DocNavigator` is deliberately two methods (`canFollow` / `follow`) so the cursor can tell the truth about a link the host cannot resolve.
    - `DocsDialog`'s `ScrollToAnchor` clears the pending anchor **inside** the `requestAnimationFrame`, after scrolling. Clearing first is the ordering that reads more naturally and does not work: it updates the store, which changes the effect's dependencies, which runs its cleanup, which cancels the frame that was going to do the scrolling — the effect tidies up after itself and never scrolls. `PrefRow` (gotcha #32's settings highlight) clears before its own rAF and may well have the same latent bug; it was not touched here because its flash works and the scroll half was never verified.
