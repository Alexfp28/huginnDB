/**
 * One tool call the assistant made, and its result once it arrives.
 *
 * **This is the trust feature, in miniature.** The roadmap says it of the
 * Console emission in agent mode and it is just as true here: a user who can
 * see which tool ran, with which arguments, and how much came back will believe
 * the metadata-only guarantee; one who cannot, will not. So the card names the
 * tool and shows the arguments verbatim, and its result summary reports a *row
 * count* rather than a vague tick — "42 rows" is the number that tells someone
 * whether data left the machine.
 *
 * Renders as soon as the call exists, with the result folded in when it lands.
 * A card that waited for the result would leave a slow query looking like a
 * hung assistant — which is exactly when someone wants to know what it is
 * doing.
 *
 * Nothing produces these yet: `commands::ai`'s `ai_send` declares no tools
 * until the loop lands in phase 6. The renderer is here because the part types
 * are (decision D5's message anatomy), and because a card designed after the
 * loop exists is a card designed under pressure.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ChevronDown, ChevronRight, TriangleAlert, Wrench } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { MessagePart } from "@/lib/ai/parts";

type ToolCall = Extract<MessagePart, { type: "toolCall" }>;
type ToolResult = Extract<MessagePart, { type: "toolResult" }>;

/** A one-line summary of what came back, without rendering the payload. */
function summarise(result: unknown, t: TFunction): string {
  if (result === null || result === undefined) return t("ai.tool.noResult");
  if (Array.isArray(result)) return t("ai.tool.rowCount", { count: result.length });
  if (typeof result === "object") {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) {
      const truncated = (result as { truncated?: boolean }).truncated === true;
      const label = t("ai.tool.rowCount", { count: rows.length });
      return truncated ? `${label} ${t("ai.tool.truncated")}` : label;
    }
    return t("ai.tool.objectResult");
  }
  return String(result);
}

export function ToolCallCard({
  call,
  result,
  defaultOpen,
}: {
  call: ToolCall;
  result?: ToolResult;
  defaultOpen: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const failed = !!result?.error;
  const args = JSON.stringify(call.args ?? {}, null, 2);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border text-2xs",
        failed ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/20",
      )}
    >
      {/* `Button variant="ghost"` rather than a bare `<button>`: the hover
          alpha, the focus ring and the disabled treatment are decided once in
          `ui/`, and `uiAdoption.test.ts` counts every new raw one. The
          overrides are the density this card needs (`h-auto`, a 2xs label),
          which the shared sizes do not carry. */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        className="h-auto w-full justify-start gap-1.5 rounded-none px-2 py-1 text-2xs font-normal"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        {failed ? (
          <TriangleAlert className="h-3 w-3 shrink-0 text-destructive" />
        ) : (
          <Wrench className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate font-mono">{call.name}</span>
        <span className="ml-auto shrink-0">
          {result ? (
            <Badge tone={failed ? "destructive" : "neutral"} size="xs" mono>
              {failed ? t("ai.tool.refused") : summarise(result.result, t)}
            </Badge>
          ) : (
            <Badge tone="warning" size="xs">
              {t("ai.tool.running")}
            </Badge>
          )}
        </span>
      </Button>
      {open && (
        <div className="space-y-1 border-t border-border/60 px-2 py-1.5">
          <div>
            <span className="text-muted-foreground">{t("ai.tool.arguments")}</span>
            <pre className="mt-0.5 overflow-x-auto font-mono leading-relaxed">
              {args}
            </pre>
          </div>
          {result?.error && (
            <div>
              <span className="text-muted-foreground">{t("ai.tool.error")}</span>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-destructive">
                {result.error}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
