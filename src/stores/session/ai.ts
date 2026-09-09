/**
 * The AI panel's conversations, one per connection.
 *
 * Keyed by connection because the assistant is about a *database*: the schema
 * it was told about, the statements it proposed and the tables it named all
 * belong to one server, and a panel that carried them across a connection
 * switch would be answering about the wrong data with total confidence. The
 * selection already moves on its own (opening a tab, a command-palette jump),
 * so the conversation follows it the way every other panel does rather than
 * pretending to be global.
 *
 * # Nothing here goes to disk
 *
 * Roadmap decision D7. A transcript holds schema names, proposed SQL and — once
 * agent mode lands — row snippets, which is precisely the sensitive artefact
 * this feature promises not to accumulate. Only one UI fold is persisted
 * (`showToolDetails`), under `STORAGE_KEYS.ai`; message content lives and dies
 * with the session. Persistence is a v2 question, and the design question there
 * is not *where* but *what* — see `docs/AI_ROADMAP.md` §9.
 *
 * Every consumer reads a primitive field or a stable record entry as its
 * selector, per the Zustand rule in `CLAUDE.md` — never a value the selector
 * constructs.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { STORAGE_KEYS } from "@/lib/constants";
import { appendText, type AiMessage, type MessagePart } from "@/lib/ai/parts";

/** One connection's transcript, plus whatever is in flight for it. */
export interface AiConversation {
  messages: AiMessage[];
  /**
   * The turn currently streaming, or `null`.
   *
   * The panel's stop button and its "thinking" state both read this, and the
   * id is what `api.aiCancel` addresses — so a turn that was started, streamed
   * and cancelled leaves the text that arrived on screen and this back at
   * `null`, which is the honest result of stopping halfway.
   */
  turnId: string | null;
  /** Last failure, cleared when the next turn starts. */
  error: string | null;
}

/** Stable empty array, so a selector for a connection with no conversation
 *  does not hand React a new reference on every render (gotcha #1). */
const NO_MESSAGES: AiMessage[] = [];

const EMPTY: AiConversation = { messages: [], turnId: null, error: null };

interface AiState {
  /** Absent = this connection has never been asked anything. */
  conversations: Record<string, AiConversation | undefined>;
  /**
   * Which connection each in-flight turn belongs to.
   *
   * The delta events carry only a turn id — the backend has no idea which
   * conversation the panel filed the turn under — so this is the index that
   * routes them. Cleared as each turn ends, so it holds at most one entry per
   * open panel.
   */
  turnOwners: Record<string, string | undefined>;
  /** Unsent composer text per connection. Memory only, like the transcript. */
  drafts: Record<string, string | undefined>;
  /** Whether tool cards start expanded. The one persisted field. */
  showToolDetails: boolean;

  /** Open a turn: record the user's message and an empty assistant reply. */
  startTurn: (connectionId: string, turnId: string, text: string) => void;
  /** Fold one streamed delta into the turn's assistant message. */
  pushDelta: (turnId: string, text: string) => void;
  /**
   * Close a turn, reconciling against the whole reply.
   *
   * `content` is the complete assembled text, which the panel has already seen
   * as deltas — but an event can be dropped, and reconciling here is cheaper
   * than making the event stream reliable. Only replaces the text when it
   * actually differs, so the common case costs no re-render.
   */
  finishTurn: (turnId: string, content: string) => void;
  failTurn: (turnId: string, error: string) => void;
  /** Forget one connection's transcript. */
  clear: (connectionId: string) => void;
  setDraft: (connectionId: string, text: string) => void;
  toggleToolDetails: () => void;
}

/** Replace the last assistant message's parts, leaving everything else. */
function mapLastAssistant(
  messages: AiMessage[],
  fold: (parts: MessagePart[]) => MessagePart[],
): AiMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") continue;
    const parts = fold(messages[i].parts);
    if (parts === messages[i].parts) return messages;
    const next = messages.slice();
    next[i] = { ...messages[i], parts };
    return next;
  }
  return messages;
}

/** Apply `fold` to the conversation owning `turnId`, if it is still in flight. */
function inTurn(
  state: AiState,
  turnId: string,
  fold: (conversation: AiConversation) => AiConversation,
): Partial<AiState> {
  const connectionId = state.turnOwners[turnId];
  if (!connectionId) return {};
  const conversation = state.conversations[connectionId];
  // A delta for a turn this conversation is no longer running arrives after a
  // cancel — the socket closes but a frame already in the queue still lands.
  // Dropping it is the point: the panel keeps what it rendered and gains
  // nothing after the user pressed stop.
  if (!conversation || conversation.turnId !== turnId) return {};
  return {
    conversations: {
      ...state.conversations,
      [connectionId]: fold(conversation),
    },
  };
}

export const useAi = create<AiState>()(
  persist(
    (set) => ({
      conversations: {},
      turnOwners: {},
      drafts: {},
      showToolDetails: false,

      startTurn: (connectionId, turnId, text) =>
        set((s) => {
          const previous = s.conversations[connectionId] ?? EMPTY;
          return {
            conversations: {
              ...s.conversations,
              [connectionId]: {
                messages: [
                  ...previous.messages,
                  { id: `${turnId}:user`, role: "user", parts: [{ type: "text", text }] },
                  { id: `${turnId}:assistant`, role: "assistant", parts: [] },
                ],
                turnId,
                error: null,
              },
            },
            turnOwners: { ...s.turnOwners, [turnId]: connectionId },
            drafts: { ...s.drafts, [connectionId]: "" },
          };
        }),

      pushDelta: (turnId, text) =>
        set((s) =>
          inTurn(s, turnId, (conversation) => ({
            ...conversation,
            messages: mapLastAssistant(conversation.messages, (parts) =>
              appendText(parts, text),
            ),
          })),
        ),

      finishTurn: (turnId, content) =>
        set((s) => {
          const patch = inTurn(s, turnId, (conversation) => ({
            ...conversation,
            turnId: null,
            messages: mapLastAssistant(conversation.messages, (parts) => {
              const streamed = parts
                .filter((p) => p.type === "text")
                .map((p) => (p as { text: string }).text)
                .join("");
              if (streamed === content) return parts;
              // Whatever arrived is replaced wholesale rather than patched:
              // a dropped delta leaves a gap in the middle, not at the end.
              const tools = parts.filter((p) => p.type !== "text");
              return content ? [...tools, { type: "text", text: content }] : tools;
            }),
          }));
          const turnOwners = { ...s.turnOwners };
          delete turnOwners[turnId];
          return { ...patch, turnOwners };
        }),

      failTurn: (turnId, error) =>
        set((s) => {
          const patch = inTurn(s, turnId, (conversation) => ({
            ...conversation,
            turnId: null,
            error,
          }));
          const turnOwners = { ...s.turnOwners };
          delete turnOwners[turnId];
          return { ...patch, turnOwners };
        }),

      clear: (connectionId) =>
        set((s) => {
          const conversations = { ...s.conversations };
          delete conversations[connectionId];
          return { conversations };
        }),

      setDraft: (connectionId, text) =>
        set((s) => ({ drafts: { ...s.drafts, [connectionId]: text } })),

      toggleToolDetails: () =>
        set((s) => ({ showToolDetails: !s.showToolDetails })),
    }),
    {
      name: STORAGE_KEYS.ai,
      version: 1,
      // D7, enforced rather than promised: the only thing that reaches disk is
      // a UI fold. A `partialize` that forgot a field would put a transcript in
      // `localStorage`, so this lists what is saved instead of what is not.
      partialize: (s) => ({ showToolDetails: s.showToolDetails }),
    },
  ),
);

/** One connection's messages, or a stable empty array. */
export function selectMessages(connectionId: string | null) {
  return (s: AiState): AiMessage[] =>
    (connectionId ? s.conversations[connectionId]?.messages : undefined) ??
    NO_MESSAGES;
}

/** The turn streaming for this connection, or `null`. */
export function selectTurnId(connectionId: string | null) {
  return (s: AiState): string | null =>
    (connectionId ? s.conversations[connectionId]?.turnId : null) ?? null;
}

export function selectError(connectionId: string | null) {
  return (s: AiState): string | null =>
    (connectionId ? s.conversations[connectionId]?.error : null) ?? null;
}

export function selectDraft(connectionId: string | null) {
  return (s: AiState): string =>
    (connectionId ? s.drafts[connectionId] : undefined) ?? "";
}
