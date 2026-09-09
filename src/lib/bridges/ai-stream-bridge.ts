/**
 * Wires the Rust `huginndb://ai-delta` Tauri event into the AI store.
 *
 * **One subscription per window, mounted once at App startup** — the same rule
 * every bridge in this folder follows, and the same reasoning `usePulseLive`
 * uses for its clock: the panel and any future expanded window must not each
 * hold their own listener, or a token stream is folded into the store twice and
 * the reply renders doubled.
 *
 * `target: label` matters here for the same reason it does in `log-bridge.ts`:
 * `commands::ai` emits with `emit_to(window_label, …)` so two windows can each
 * run their own conversation, but a bare `listen()` registers with
 * `EventTarget::Any` and Tauri delivers every `emit_to` to an `Any` listener
 * regardless of target — which would render one window's tokens in the other.
 *
 * The bridge starts whether or not the user ever opens the panel. That is
 * deliberate: it costs one listener, and it has to exist *before* the first
 * delta arrives — a subscription set up when the panel mounts would drop the
 * opening tokens of the first turn.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useAi } from "@/stores/session/ai";
import type { AiDelta } from "@/types";

const AI_DELTA_EVENT = "huginndb://ai-delta";

export async function startAiStreamBridge(): Promise<UnlistenFn> {
  const label = getCurrentWindow().label;
  return listen<AiDelta>(
    AI_DELTA_EVENT,
    (event) => {
      useAi.getState().pushDelta(event.payload.turnId, event.payload.text);
    },
    { target: label },
  );
}
