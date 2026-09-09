/**
 * Rendered markdown for the assistant's prose.
 *
 * The parsing is pure and tested in `lib/ai/markdown.ts`; this file is only the
 * mapping from those blocks onto the app's own elements. Two rules run through
 * it:
 *
 * - **Nothing here is `dangerouslySetInnerHTML`.** Every node becomes a React
 *   element, so untrusted model output cannot become markup. That is the whole
 *   reason the parser exists rather than a library plus a sanitiser.
 * - **A link is shown, not offered.** Its text renders, its target renders
 *   beside it in muted type, and neither is an anchor. A model-authored URL
 *   that opens the system browser on one click is a decision to take
 *   deliberately.
 *
 * Sized for a 360px dock panel: `text-xs` body, tight leading, list markers
 * inside the content box so a wrapped item does not hang into the gutter.
 */

import { Fragment } from "react";

import { cn } from "@/lib/utils";
import { parseProse, type Block, type Inline } from "@/lib/ai/markdown";

function Runs({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, i) => (
        <Fragment key={i}>
          {node.kind === "text" && node.text}
          {node.kind === "strong" && (
            <strong className="font-semibold text-foreground">
              <Runs nodes={node.children} />
            </strong>
          )}
          {node.kind === "em" && (
            <em className="italic">
              <Runs nodes={node.children} />
            </em>
          )}
          {node.kind === "strike" && (
            <s className="text-muted-foreground">
              <Runs nodes={node.children} />
            </s>
          )}
          {node.kind === "code" && (
            <code className="rounded bg-muted/60 px-1 py-px font-mono text-[0.9em]">
              {node.text}
            </code>
          )}
          {node.kind === "link" && (
            <span>
              {node.text}
              <span className="ml-1 break-all font-mono text-3xs text-muted-foreground">
                {node.href}
              </span>
            </span>
          )}
        </Fragment>
      ))}
    </>
  );
}

const HEADING_SIZE = {
  1: "text-xs font-semibold",
  2: "text-2xs font-semibold",
  3: "text-2xs font-medium",
} as const;

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "paragraph":
      return (
        <p className="break-words text-xs leading-relaxed">
          <Runs nodes={block.content} />
        </p>
      );
    case "heading":
      return (
        <p
          className={cn(
            "break-words uppercase tracking-wide text-foreground",
            HEADING_SIZE[block.level],
          )}
        >
          <Runs nodes={block.content} />
        </p>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag
          start={block.ordered ? block.start : undefined}
          className={cn(
            "ml-4 space-y-1 text-xs leading-relaxed",
            block.ordered ? "list-decimal" : "list-disc",
          )}
        >
          {block.items.map((item, i) => (
            <li key={i} className="break-words pl-0.5">
              <Runs nodes={item} />
            </li>
          ))}
        </Tag>
      );
    }
    case "quote":
      return (
        <p className="break-words border-l-2 border-border pl-2 text-xs italic leading-relaxed text-muted-foreground">
          <Runs nodes={block.content} />
        </p>
      );
    case "rule":
      return <hr className="border-border/60" />;
  }
}

export function Prose({ text }: { text: string }) {
  const blocks = parseProse(text);
  if (blocks.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </div>
  );
}
