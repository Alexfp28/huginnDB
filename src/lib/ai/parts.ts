/**
 * The AI panel's message anatomy, and the pure folds that build it.
 *
 * # Why these three part types
 *
 * Roadmap decision D5: the chat UI is built from this repo's own primitives
 * rather than adopting `assistant-ui` or the AI SDK's UI layer — both assume a
 * streaming HTTP server that Tauri does not have, so the adapter cost is paid
 * either way. What *is* adopted is assistant-ui's **message anatomy**: a
 * message is a list of parts, and a part is text, a tool call, or a tool
 * result. Keeping that shape means a later migration is mechanical rather than
 * a rewrite of every renderer.
 *
 * # Why this file is pure
 *
 * Everything here is a function from values to values: no store, no Tauri, no
 * React. The folding of stream deltas into parts is the one piece of the panel
 * with real edge cases — a fence that has not closed yet, a tool result
 * arriving before its call, a delta landing after the turn was cancelled — and
 * a pure reducer is the difference between covering those in Vitest and
 * discovering them against a live model.
 */

/** A message part, mirroring assistant-ui's text / tool-call / tool-result. */
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; args: unknown }
  | {
      type: "toolResult";
      id: string;
      name: string;
      result: unknown;
      /** Set when the tool refused or failed. Rendered as the card's body. */
      error?: string;
    };

export type AiRole = "user" | "assistant";

export interface AiMessage {
  /** Stable within a conversation; the list's React key. */
  id: string;
  role: AiRole;
  parts: MessagePart[];
}

/**
 * Append streamed text to `parts`.
 *
 * Coalesces into the trailing text part rather than pushing one part per
 * delta: a token stream would otherwise produce hundreds of parts per message,
 * each its own React element, and a fenced code block split across them could
 * never be recognised as one block.
 *
 * Returns a new array — the store holds these and Zustand compares by
 * reference.
 */
export function appendText(parts: MessagePart[], text: string): MessagePart[] {
  if (!text) return parts;
  const last = parts[parts.length - 1];
  if (last?.type === "text") {
    return [
      ...parts.slice(0, -1),
      { type: "text", text: last.text + text },
    ];
  }
  return [...parts, { type: "text", text }];
}

/** Append a tool call. */
export function appendToolCall(
  parts: MessagePart[],
  call: { id: string; name: string; args: unknown },
): MessagePart[] {
  return [...parts, { type: "toolCall", ...call }];
}

/**
 * Append a tool result.
 *
 * Deliberately appended rather than merged into its call: the call and its
 * result are two events separated by however long the database took, and the
 * renderer pairs them by `id` when both are present. Merging would mean the
 * card could not render at all until the result arrived, which is the opposite
 * of what a user watching a slow query wants.
 */
export function appendToolResult(
  parts: MessagePart[],
  result: { id: string; name: string; result: unknown; error?: string },
): MessagePart[] {
  return [...parts, { type: "toolResult", ...result }];
}

/** The result belonging to `callId`, if it has arrived. */
export function resultFor(
  parts: MessagePart[],
  callId: string,
): Extract<MessagePart, { type: "toolResult" }> | undefined {
  return parts.find(
    (p): p is Extract<MessagePart, { type: "toolResult" }> =>
      p.type === "toolResult" && p.id === callId,
  );
}

/** One run of a text part: prose, or a fenced code block. */
export type TextBlock =
  | { kind: "prose"; text: string }
  | {
      kind: "code";
      /** The fence's info string, lowercased and trimmed. `""` when absent. */
      lang: string;
      code: string;
      /**
       * Whether the closing fence has arrived.
       *
       * Load-bearing while streaming: an open fence must render as a code
       * block immediately, or the SQL a user is waiting for appears first as
       * prose and then reflows into an editor mid-sentence. It also tells the
       * renderer not to offer "open in editor" for a statement that is still
       * half-written.
       */
      closed: boolean;
    };

/** Fence lines: ``` or ~~~, at least three, optionally indented. */
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^\r\n`]*)$/;

/**
 * Split a text part into prose and fenced code blocks.
 *
 * A deliberately small subset of markdown: fences and nothing else. The panel
 * renders prose as plain text (no bold, no lists, no links), because the one
 * structure that genuinely needs rendering is a code block — that is where the
 * SQL is — and every other construct is a rendering surface with its own
 * escaping and link-handling questions. When prose formatting earns its keep it
 * can be added here; guessing now would mean shipping a markdown renderer
 * nobody asked for and a `target="_blank"` nobody audited.
 */
export function splitBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  const lines = text.split("\n");
  let prose: string[] = [];
  let code: string[] | null = null;
  let lang = "";
  let opener = "";

  const flushProse = () => {
    if (prose.length === 0) return;
    const joined = prose.join("\n");
    // Whitespace-only prose between two fences is framing, not content.
    if (joined.trim()) blocks.push({ kind: "prose", text: joined });
    prose = [];
  };

  for (const line of lines) {
    const fence = FENCE.exec(line);
    if (code === null) {
      if (fence) {
        flushProse();
        code = [];
        opener = fence[1];
        lang = fence[2].trim().toLowerCase();
        continue;
      }
      prose.push(line);
      continue;
    }
    // Inside a block: only a fence of the same character closes it, so a `~~~`
    // inside a ``` block is content.
    if (fence && fence[1][0] === opener[0] && fence[1].length >= opener.length) {
      blocks.push({ kind: "code", lang, code: code.join("\n"), closed: true });
      code = null;
      continue;
    }
    code.push(line);
  }

  if (code !== null) {
    blocks.push({ kind: "code", lang, code: code.join("\n"), closed: false });
  } else {
    flushProse();
  }
  return blocks;
}

/**
 * Monaco's language id for a fence's info string, or `null` when the block is
 * not something this app can highlight as a statement.
 *
 * `""` (a fence with no language) maps to SQL: a model asked about a database
 * that emits a bare fence is, overwhelmingly, emitting SQL — and the cost of
 * being wrong is syntax colouring, not correctness.
 */
export function fenceLanguage(lang: string): string | null {
  switch (lang) {
    case "":
    case "sql":
    case "mysql":
    case "postgres":
    case "postgresql":
    case "psql":
    case "sqlite":
    case "tsql":
    case "mssql":
      return "sql";
    // MongoDB's query surface is mongosh syntax, which models label as JS.
    case "js":
    case "javascript":
    case "mongo":
    case "mongodb":
    case "mongosh":
      return "javascript";
    case "json":
      return "json";
    default:
      return null;
  }
}

/** Whether a fenced block holds something the query editor could run. */
export function isRunnable(block: TextBlock): boolean {
  if (block.kind !== "code" || !block.closed) return false;
  const language = fenceLanguage(block.lang);
  return (
    (language === "sql" || language === "javascript") &&
    block.code.trim().length > 0
  );
}

/** A message's text, with tool parts dropped. */
export function messageText(message: AiMessage): string {
  return message.parts
    .filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * How many messages of history a turn carries.
 *
 * A cap rather than the whole transcript, because the endpoint this feature is
 * built around is a small local model: its context is the scarcest thing in
 * the system, an unbounded history silently starts truncating server-side (or
 * erroring, depending on the server), and the failure looks like the assistant
 * losing its mind rather than running out of room. Twenty messages is ten
 * exchanges, which is well past where a database question either got answered
 * or needs restating.
 */
export const MAX_HISTORY_MESSAGES = 20;

/**
 * The conversation as the wire wants it: `{role, content}`, newest kept.
 *
 * Drops messages with no text at all — an assistant turn that only made tool
 * calls, or one cancelled before its first token. Sending those as empty
 * strings makes several servers reject the whole request.
 */
export function toWireMessages(
  messages: AiMessage[],
  max: number = MAX_HISTORY_MESSAGES,
): Array<{ role: AiRole; content: string }> {
  return messages
    .map((message) => ({ role: message.role, content: messageText(message) }))
    .filter((m) => m.content.trim().length > 0)
    .slice(-max);
}
