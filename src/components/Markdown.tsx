/**
 * Minimal, dependency-free Markdown renderer for the in-app Documentation
 * viewer ({@link DocsDialog}).
 *
 * Deliberately small — like `lib/changelog.ts`'s hand-rolled parser, it covers
 * exactly the constructs the bundled `docs/*.md` use and nothing more:
 * ATX headings, paragraphs, fenced code blocks, GFM pipe tables, ordered /
 * unordered lists, blockquotes, horizontal rules, and inline code / bold /
 * italic / links. It is NOT a general CommonMark engine; the input is trusted,
 * in-repo documentation, not arbitrary user content.
 *
 * Links to http(s) open in the OS browser via the Tauri opener (an in-webview
 * navigation would be a no-op); other hrefs (anchors, relative doc links) are
 * inert text so a click never blanks the app.
 */

import * as React from "react";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";

// --- inline ---------------------------------------------------------------

// Ordered by precedence: code span, link, bold, italic (`*` and `_`).
const INLINE_RE =
  /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(_[^_]+_)/;

function DocLink({ href, children }: { href: string; children: React.ReactNode }) {
  const external = /^https?:\/\//i.test(href);
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (external) void api.openUrl(href);
      }}
      className={cn(
        "text-brand underline-offset-2 hover:underline",
        !external && "cursor-default",
      )}
      {...(external ? { role: "link" } : {})}
    >
      {children}
    </a>
  );
}

/** Render inline markdown within a single block of text. */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let rest = text;
  let i = 0;
  while (rest.length > 0) {
    const m = INLINE_RE.exec(rest);
    if (!m || m.index === undefined) {
      nodes.push(rest);
      break;
    }
    if (m.index > 0) nodes.push(rest.slice(0, m.index));
    const token = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith("`")) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("[")) {
      const close = token.indexOf("](");
      const label = token.slice(1, close);
      const href = token.slice(close + 2, -1);
      nodes.push(
        <DocLink key={key} href={href}>
          {renderInline(label, key)}
        </DocLink>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(
        <strong key={key} className="font-semibold text-foreground">
          {renderInline(token.slice(2, -2), key)}
        </strong>,
      );
    } else {
      // *italic* or _italic_
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    }
    rest = rest.slice(m.index + token.length);
  }
  return nodes;
}

// --- blocks ---------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*([-*_])\1{2,}\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/** Parse a whole markdown document into a list of rendered block elements. */
function renderBlocks(md: string): React.ReactNode[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  const k = () => `b-${key++}`;

  while (i < lines.length) {
    const line = lines[i];

    // Blank
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence
      out.push(
        <pre
          key={k()}
          className="my-3 overflow-x-auto rounded-md border bg-muted/60 p-3 text-xs leading-relaxed"
        >
          <code className="font-mono text-foreground">{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Heading
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      const sizes: Record<number, string> = {
        1: "mt-1 mb-3 text-xl font-semibold",
        2: "mt-6 mb-2 text-lg font-semibold border-b pb-1",
        3: "mt-5 mb-1.5 text-base font-semibold",
        4: "mt-4 mb-1 text-sm font-semibold",
        5: "mt-3 mb-1 text-sm font-medium",
        6: "mt-3 mb-1 text-xs font-medium uppercase tracking-wide",
      };
      const Tag = `h${Math.min(level, 6)}` as keyof React.JSX.IntrinsicElements;
      out.push(
        <Tag key={k()} className={cn("text-foreground", sizes[level])}>
          {renderInline(text, k())}
        </Tag>,
      );
      i++;
      continue;
    }

    // Horizontal rule
    if (HR_RE.test(line)) {
      out.push(<hr key={k()} className="my-4 border-border" />);
      i++;
      continue;
    }

    // Table (header row followed by a separator row)
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const header = splitRow(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i]));
        i++;
      }
      out.push(
        <div key={k()} className="my-3 overflow-x-auto rounded-md border">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="bg-muted/60">
                {header.map((c, ci) => (
                  <th
                    key={ci}
                    className="border-b px-2.5 py-1.5 text-left font-semibold text-foreground"
                  >
                    {renderInline(c, `${k()}-h${ci}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b last:border-0">
                  {r.map((c, ci) => (
                    <td
                      key={ci}
                      className="px-2.5 py-1.5 align-top text-muted-foreground"
                    >
                      {renderInline(c, `r${ri}-c${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(
        <blockquote
          key={k()}
          className="my-3 border-l-2 border-brand/50 pl-3 text-sm text-muted-foreground"
        >
          {renderInline(body.join(" "), k())}
        </blockquote>,
      );
      continue;
    }

    // List (consecutive list items; ordered if the first marker is numeric)
    if (LIST_RE.test(line)) {
      const items: string[] = [];
      const ordered = /^\s*\d+\.\s/.test(line);
      while (i < lines.length && LIST_RE.test(lines[i])) {
        const m = LIST_RE.exec(lines[i])!;
        items.push(m[3]);
        i++;
        // Fold wrapped continuation lines (indented, not a new item/blank).
        while (
          i < lines.length &&
          lines[i].trim() !== "" &&
          !LIST_RE.test(lines[i]) &&
          !HEADING_RE.test(lines[i]) &&
          /^\s+/.test(lines[i])
        ) {
          items[items.length - 1] += " " + lines[i].trim();
          i++;
        }
      }
      const ListTag = ordered ? "ol" : "ul";
      out.push(
        <ListTag
          key={k()}
          className={cn(
            "my-2 space-y-1 pl-5 text-sm text-muted-foreground",
            ordered ? "list-decimal" : "list-disc",
          )}
        >
          {items.map((it, ii) => (
            <li key={ii} className="leading-relaxed">
              {renderInline(it, `li-${ii}`)}
            </li>
          ))}
        </ListTag>,
      );
      continue;
    }

    // Paragraph: gather until a blank line or a block-starting line.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !HEADING_RE.test(lines[i]) &&
      !HR_RE.test(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !LIST_RE.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i])
    ) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) {
      out.push(
        <p key={k()} className="my-2 text-sm leading-relaxed text-muted-foreground">
          {renderInline(para.join(" "), k())}
        </p>,
      );
    }
  }

  return out;
}

/** Render a trusted in-repo markdown string as themed React elements. */
export function Markdown({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  const blocks = React.useMemo(() => renderBlocks(source), [source]);
  return <div className={cn("min-w-0", className)}>{blocks}</div>;
}
