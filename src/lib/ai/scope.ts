/**
 * What the assistant may read, for display.
 *
 * **Rust is authoritative.** `DataScope::resolve` in
 * `src-tauri/src/ai/scope.rs` is what actually gates a tool call; this mirror
 * exists so the panel can *say* which of the two scopes is in force without a
 * round trip, and because a guarantee the user cannot see on the screen where
 * they are working is a guarantee they have no reason to believe.
 *
 * The duplication is deliberate and narrow: one boolean expression, one test,
 * and no consequence if it drifts beyond a wrong label — which the test is
 * there to prevent. The alternative, an `ai_scope` command per render, would
 * put an IPC call in a hover.
 */

import type { AiEndpointTrust } from "@/types";

export type AiDataScope = "metadataOnly" | "rows";

/**
 * Apply the coupling rule.
 *
 * A trusted endpoint may read rows. An untrusted one gets metadata only unless
 * this particular connection has been opted in. Note the asymmetry, which is
 * the same one `DataScope::resolve` documents: a trusted endpoint ignores the
 * per-connection flag, so "never send this connection's rows anywhere" is
 * expressed by taking away its reach, not by this flag.
 */
export function resolveDataScope(
  trust: AiEndpointTrust,
  rowsAllowed: boolean,
): AiDataScope {
  return trust === "trusted" || rowsAllowed ? "rows" : "metadataOnly";
}

/**
 * Characters of a connection's context notes the backend keeps.
 *
 * Mirrors `ai::exec::MAX_AI_NOTES_CHARS`. Here it only stops the textarea
 * accepting text the backend would silently drop — the bound that matters is
 * the one on the prompt, and it is enforced there.
 */
export const MAX_AI_NOTES_CHARS = 2000;
