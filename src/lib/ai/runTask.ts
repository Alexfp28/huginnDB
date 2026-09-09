/**
 * Start an assisted task and file it in the panel's conversation.
 *
 * One function rather than one per entry point, because every caller wants the
 * same four things: the panel open and pointed at the right connection, a turn
 * id, a user message that says what was asked, and the answer streamed into the
 * same transcript a chat turn lands in.
 *
 * # Why the request is written into the transcript as a user message
 *
 * A task invoked from a context menu produces an answer with no visible
 * question, which reads as the assistant volunteering something. Writing the
 * request in — as markdown, so a statement arrives in a real code block — makes
 * the exchange legible later and makes the transcript one kind of thing rather
 * than two.
 */

import i18n from "@/lib/i18n";
import { api } from "@/lib/tauri";
import { useAi } from "@/stores/session/ai";
import { useSessionPanelLayout } from "@/stores/session/panelLayout";
import type { AiTaskInput } from "@/types";

/** A turn id. `crypto.randomUUID` is present in the webview; the fallback is
 *  for a jsdom test and for an older WebView2 that predates it. */
function turnId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `turn-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

/** The request, as the transcript should show it. */
function requestText(input: AiTaskInput): string {
  const fence = (body: string) =>
    `\n\n\`\`\`sql\n${body.trim()}\n\`\`\``;
  switch (input.task) {
    case "explainQuery":
      return i18n.t("ai.task.explainQuery") + fence(input.statement ?? "");
    case "explainSlow":
      return i18n.t("ai.task.explainSlow") + fence(input.statement ?? "");
    case "documentRelation":
      return i18n.t("ai.task.documentRelation", {
        relation: [input.schema, input.table].filter(Boolean).join("."),
      });
    case "nlToSql":
      return input.question ?? "";
  }
}

/**
 * Run `input` as a turn in `connection`'s conversation, opening the panel.
 *
 * Never throws: a failure lands on the turn, in the panel, next to the request
 * that caused it — which is where someone invoking this from a context menu is
 * looking. A rejected promise would leave the transcript showing a question
 * with no answer and put the reason in a toast that has already gone.
 */
export async function runAiTask(input: AiTaskInput): Promise<void> {
  const id = turnId();
  // Opened first: a task whose answer streams into a collapsed dock is a task
  // that appears to have done nothing.
  //
  // Guarded, because `selectRightPanel` is the *activity bar's* behaviour —
  // picking the panel that is already showing collapses the dock. Calling it
  // blind would close the panel for anyone who invoked a task while looking
  // at it, which is most people.
  const layout = useSessionPanelLayout.getState();
  if (layout.rightPanel !== "ai") layout.selectRightPanel("ai");
  useAi.getState().startTurn(input.connection, id, requestText(input));
  try {
    const result = await api.aiTask(id, input);
    useAi.getState().finishTurn(id, result.content);
  } catch (e) {
    useAi.getState().failTurn(id, String(e));
  }
}
