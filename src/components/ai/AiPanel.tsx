/**
 * The AI panel in the right dock.
 *
 * # What it is in phase 4
 *
 * A conversation that streams. `commands::ai`'s `ai_send` declares no tools
 * yet — assisted mode's deterministic context builders are phase 5 and the
 * agent loop is phase 6 — so what this surface can do today is talk, and
 * propose statements the user opens in their editor. The part renderers for
 * tool calls exist and are wired; nothing produces them until the loop does.
 *
 * # Three things it does not do, on purpose
 *
 * - **It does not run SQL.** A proposed statement opens in a query tab, where
 *   every guard already lives. See `parts/SqlBlock.tsx`.
 * - **It does not keep a transcript.** Decision D7: nothing here reaches disk
 *   except one UI fold. Closing the app forgets the conversation, which is the
 *   promise, not a limitation to be fixed.
 * - **It does not hold the stream.** The `huginndb://ai-delta` subscription is
 *   one per window, in `lib/bridges/ai-stream-bridge.ts` — this component only
 *   reads the store, so having the panel open twice (a second window) costs one
 *   listener, not two.
 *
 * The panel follows the tree's selected connection rather than pinning one.
 * That is a real difference from Pulse, whose pin exists because a chart that
 * silently changed servers mid-diagnosis is misleading; here the conversation
 * is *keyed* by connection (see `stores/session/ai.ts`), so switching shows
 * that connection's own thread instead of re-pointing this one.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot, Copy, Eraser, Send, Settings2, Square } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { MICRO_HEADING } from "@/components/ui/styles";
import { api } from "@/lib/tauri";
import { notify } from "@/lib/notify";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import {
  parentConnectionId,
  resolveConnectionLabel,
} from "@/lib/connectionLabel";
import { resolveDataScope } from "@/lib/ai/scope";
import {
  hasVisibleContent,
  messageText,
  resultFor,
  toWireMessages,
  type AiMessage,
} from "@/lib/ai/parts";
import { SYSTEM_PROMPT } from "@/lib/ai/prompt";
import {
  selectDraft,
  selectError,
  selectMessages,
  selectTurnId,
  useAi,
} from "@/stores/session/ai";
import { useConnections } from "@/stores/session/connections";
import {
  selectAiPrefs,
  usePreferences,
} from "@/stores/preferences/preferences";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import { ReasoningPicker } from "./ReasoningPicker";
import { TextPart } from "./parts/TextPart";
import { ToolCallCard } from "./parts/ToolCallCard";

export function AiPanel({ connectionId }: { connectionId: string | null }) {
  const { t } = useTranslation();
  const ai = usePreferences(selectAiPrefs);
  const updateAi = usePreferences((s) => s.updateAi);
  const profiles = useConnections((s) => s.profiles);
  const openSettings = useSettingsDialog((s) => s.openAt);

  const messages = useAi(selectMessages(connectionId));
  const turnId = useAi(selectTurnId(connectionId));
  const error = useAi(selectError(connectionId));
  const draft = useAi(selectDraft(connectionId));
  const showToolDetails = useAi((s) => s.showToolDetails);
  const toggleToolDetails = useAi((s) => s.toggleToolDetails);
  const setDraft = useAi((s) => s.setDraft);
  const clear = useAi((s) => s.clear);

  // Populated from `GET /models`, which is one cheap request rather than the
  // probe's real completion. An endpoint that does not serve the route (normal
  // for llama-server) leaves this empty and the picker falls back to the model
  // the user typed in Settings.
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    if (!ai.enabled) return;
    let cancelled = false;
    void api
      .aiModels()
      .then((list) => {
        if (!cancelled) setModels(list);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [ai.enabled, ai.baseUrl]);

  // The connection's own half of the coupling rule. A synthetic per-database id
  // (`<parent>::db::<name>`) carries no profile of its own, so the flags are
  // read from the parent — the same connection as far as the backend's gate is
  // concerned.
  const profile = useMemo(() => {
    if (!connectionId) return undefined;
    const parent = parentConnectionId(connectionId);
    return profiles.find((p) => p.id === parent);
  }, [profiles, connectionId]);
  const reachable = !!profile?.ai_enabled;
  const scope = resolveDataScope(
    ai.endpointTrust,
    !!profile?.ai_rows_allowed,
  );

  const scroller = useRef<HTMLDivElement>(null);
  // Follow the stream. Only ever pinned to the bottom — a "scroll up to read
  // while it writes" affordance needs to know whether the user scrolled away,
  // and getting that wrong (yanking them back mid-read) is worse than not
  // having it. Deliberately left for when someone actually asks.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, turnId]);

  async function send() {
    const text = draft.trim();
    if (!text || !connectionId || turnId) return;
    const id =
      globalThis.crypto?.randomUUID?.() ??
      `turn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    // The history is read *before* the turn is opened, so the user's own
    // message is not sent twice — `startTurn` appends it to the store, and the
    // wire copy is built from what came before plus `text`.
    const history = toWireMessages(messages);
    useAi.getState().startTurn(connectionId, id, text);
    try {
      const result = await api.aiSend(id, [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
        { role: "user", content: text },
      ]);
      useAi.getState().finishTurn(id, result.content);
    } catch (e) {
      useAi.getState().failTurn(id, String(e));
    }
  }

  function stop() {
    if (!turnId) return;
    void api.aiCancel(turnId).catch((e) => notify.error(String(e)));
  }

  if (!ai.enabled) {
    return (
      <EmptyState
        icon={Bot}
        title={t("ai.disabledTitle")}
        hint={t("ai.disabledHint")}
        action={
          <Button variant="outline" size="sm" onClick={() => openSettings("ai")}>
            {t("ai.openSettings")}
          </Button>
        }
      />
    );
  }

  if (!connectionId) {
    return (
      <EmptyState
        icon={Bot}
        title={t("ai.noConnectionTitle")}
        hint={t("ai.noConnectionHint")}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1">
        <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className={cn(MICRO_HEADING, "truncate text-muted-foreground")}>
          {resolveConnectionLabel(profiles, connectionId)}
        </span>
        <SimpleTooltip
          label={
            scope === "rows"
              ? t("ai.scope.rowsHint")
              : t("ai.scope.metadataOnlyHint")
          }
        >
          <span className="shrink-0">
            <Badge tone={scope === "rows" ? "warning" : "neutral"} size="xs">
              {t(`ai.scope.${scope}`)}
            </Badge>
          </span>
        </SimpleTooltip>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <IconButton
            size="xs"
            icon={Settings2}
            label={
              showToolDetails
                ? t("ai.hideToolDetails")
                : t("ai.showToolDetails")
            }
            aria-pressed={showToolDetails}
            onClick={toggleToolDetails}
          />
          <IconButton
            size="xs"
            icon={Eraser}
            label={t("ai.clear")}
            disabled={messages.length === 0 || !!turnId}
            onClick={() => clear(connectionId)}
          />
        </span>
      </div>

      {!reachable && (
        <div className="border-b border-warning/40 bg-warning/5 px-2 py-1.5">
          <p className="text-2xs text-warning">{t("ai.notReachable")}</p>
          <Button
            variant="link"
            size="xs"
            className="h-auto p-0 text-2xs"
            onClick={() => openSettings("ai")}
          >
            {t("ai.openSettings")}
          </Button>
        </div>
      )}

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {messages.length === 0 ? (
          <EmptyState
            size="sm"
            icon={Bot}
            title={t("ai.emptyTitle")}
            hint={t("ai.emptyHint")}
          />
        ) : (
          <div className="space-y-2">
            {messages.map((message, i) => (
              <Message
                key={message.id}
                message={message}
                connectionId={connectionId}
                showToolDetails={showToolDetails}
                // Only the last assistant message can be the one in flight,
                // and `hasVisibleContent` (not `parts.length`) decides whether
                // it has anything to show — a message whose only part is an
                // unterminated reasoning block has a part and renders nothing.
                streaming={
                  !!turnId &&
                  i === messages.length - 1 &&
                  message.role === "assistant"
                }
              />
            ))}
          </div>
        )}
        {error && (
          <p className="mt-2 whitespace-pre-wrap break-words rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-2xs text-destructive">
            {error}
          </p>
        )}
      </div>

      <div className="border-t border-border p-2">
        {/* The two knobs that change an answer, next to the thing that asks
            for one. Both write straight to preferences rather than to a
            per-conversation override: this *is* the model and the effort in
            force, so Settings → AI shows the same values live, and a panel
            that quietly diverged from the settings screen would be the worse
            surprise. */}
        <div className="mb-1.5 flex items-center gap-1">
          <NativeSelect
            size="xs"
            mono
            aria-label={t("ai.modelLabel")}
            value={ai.model}
            onChange={(e) => updateAi({ model: e.target.value })}
            className="min-w-0 flex-1"
          >
            {ai.model === "" && (
              <option value="">{t("ai.noModel")}</option>
            )}
            {/* The configured model always appears, even when the endpoint
                serves no list or has not been asked yet — otherwise the select
                would render blank and look like it had lost the setting. */}
            {(models.includes(ai.model) || ai.model === ""
              ? models
              : [ai.model, ...models]
            ).map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </NativeSelect>
          <ReasoningPicker
            value={ai.reasoningEffort}
            onChange={(reasoningEffort) => updateAi({ reasoningEffort })}
          />
        </div>
        <Textarea
          value={draft}
          rows={2}
          placeholder={t("ai.placeholder")}
          onChange={(e) => setDraft(connectionId, e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line — the convention every
            // chat surface uses, and the composer is two rows tall precisely
            // because a multi-line question is normal here.
            if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
              e.preventDefault();
              void send();
            }
          }}
          className="mb-1.5 resize-none text-xs"
        />
        <div className="flex items-center gap-1.5">
          <span className="truncate text-3xs text-muted-foreground">
            {t("ai.enterHint")}
          </span>
          <span className="ml-auto shrink-0">
            {turnId ? (
              <Button variant="outline" size="xs" onClick={stop}>
                <Square className="h-3 w-3" />
                {t("ai.stop")}
              </Button>
            ) : (
              <Button
                size="xs"
                disabled={draft.trim().length === 0}
                onClick={() => void send()}
              >
                <Send className="h-3 w-3" />
                {t("ai.send")}
              </Button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

function Message({
  message,
  connectionId,
  showToolDetails,
  streaming,
}: {
  message: AiMessage;
  connectionId: string;
  showToolDetails: boolean;
  /** The assistant turn that has been opened but has produced nothing yet. */
  streaming: boolean;
}) {
  const { t } = useTranslation();
  const mine = message.role === "user";
  const text = messageText(message);
  return (
    <div
      className={cn(
        "group/row rounded-md px-2 py-1.5",
        mine ? "bg-muted/40" : "bg-transparent",
      )}
    >
      <div className="flex items-center gap-1">
        <span className={cn(MICRO_HEADING, "text-muted-foreground")}>
          {mine ? t("ai.you") : t("ai.assistant")}
        </span>
        {text.trim().length > 0 && (
          <span className="ml-auto shrink-0">
            <IconButton
              size="xs"
              icon={Copy}
              label={t("common.copy")}
              revealOnHover="row"
              onClick={() => {
                void copyToClipboard(text).then(() =>
                  notify.success(t("ai.copied")),
                );
              }}
            />
          </span>
        )}
      </div>
      <div className="mt-1 space-y-1.5">
        {message.parts.map((part, i) => {
          if (part.type === "text") {
            return (
              <TextPart key={i} text={part.text} connectionId={connectionId} />
            );
          }
          if (part.type === "toolCall") {
            return (
              <ToolCallCard
                key={i}
                call={part}
                result={resultFor(message.parts, part.id)}
                defaultOpen={showToolDetails}
              />
            );
          }
          // A tool result renders inside its call's card; a stray one (a result
          // whose call never arrived) would otherwise be invisible, so it is
          // dropped silently rather than shown as an orphan the user cannot
          // interpret.
          return null;
        })}
        {streaming && !hasVisibleContent(message.parts) && (
          <p className="text-2xs text-muted-foreground">{t("ai.thinking")}</p>
        )}
      </div>
    </div>
  );
}
