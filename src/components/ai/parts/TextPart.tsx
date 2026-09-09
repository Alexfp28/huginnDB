/**
 * One text part: prose runs, with fenced code rendered as a block.
 *
 * The split itself is pure and tested (`lib/ai/parts.ts`'s `splitBlocks`); this
 * component only chooses a renderer per run. Prose is plain text on purpose —
 * see `splitBlocks`'s doc comment for why the panel does not ship a markdown
 * renderer, and `whitespace-pre-wrap` is what makes a model's own line breaks
 * and indentation survive.
 */

import {
  fenceLanguage,
  isRunnable,
  splitBlocks,
  type TextBlock,
} from "@/lib/ai/parts";
import { SqlBlock } from "./SqlBlock";

export function TextPart({
  text,
  connectionId,
}: {
  text: string;
  connectionId: string | null;
}) {
  const blocks = splitBlocks(text);
  return (
    <>
      {blocks.map((block, i) => (
        <Block key={i} block={block} connectionId={connectionId} />
      ))}
    </>
  );
}

function Block({
  block,
  connectionId,
}: {
  block: TextBlock;
  connectionId: string | null;
}) {
  if (block.kind === "prose") {
    return (
      <p className="whitespace-pre-wrap break-words text-xs leading-relaxed">
        {block.text}
      </p>
    );
  }
  const language = fenceLanguage(block.lang);
  if (!language) {
    // A fence in a language this app cannot run — a shell snippet, a diff.
    // Shown as preformatted text rather than dropped: the model said it for a
    // reason, and a Monaco with no lens and no colouring would only be a
    // heavier `<pre>`.
    return (
      <pre className="overflow-x-auto rounded-md border border-border bg-muted/20 px-2 py-1.5 font-mono text-2xs leading-relaxed">
        {block.code}
      </pre>
    );
  }
  return (
    <SqlBlock
      code={block.code}
      language={language}
      connectionId={connectionId}
      runnable={isRunnable(block)}
    />
  );
}
