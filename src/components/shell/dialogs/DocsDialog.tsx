/**
 * Documentation viewer — Help → Documentation. Two panes: a navigation tree on
 * the left, one page of the selected doc on the right.
 *
 * A doc opens on its **cover** (the prose before its first `##`, plus a card per
 * section); picking a section shows that section alone. Paging rather than one
 * long scroll because `docs/MCP.md` is 400+ lines in a 70vh pane, and finding
 * what a tool requires meant scrolling blind past five client configurations.
 *
 * The tree is derived from the markdown itself (`lib/appInfo/docOutline`), not
 * from a hand-maintained list — which is also what translates it for free: the
 * Spanish body carries Spanish headings, so `getDocBody` picking the language
 * picks the sidebar's labels too. Adding a section to a doc adds it here with no
 * code change.
 *
 * Controlled by `useDocsDialog`. The active doc defaults to the first entry when
 * none is explicitly selected.
 */

import { BookOpen, ChevronRight, FileText } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { DOCS, getDoc, getDocBody } from "@/lib/appInfo/docs";
import { locate, parseDoc, type ParsedDoc } from "@/lib/appInfo/docOutline";
import { useDocsDialog } from "@/stores/dialogs/docsDialog";
import { Markdown, type DocNavigator } from "@/components/shell/Markdown";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

/** Where an unregistered doc link goes instead of nowhere. */
const REPO_BLOB = "https://github.com/Alexfp28/huginnDB/blob/main";

function formatDate(iso: string | null, lang: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(lang, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * The doc a relative markdown href points at, or `null` when nothing in the
 * registry owns it.
 *
 * Matches on the file name rather than the whole path so `MCP.md`,
 * `./MCP.md` and `docs/MCP.md` all resolve — the docs are written to be read on
 * GitHub from several directories, so all three spellings occur.
 */
function docForHref(href: string): (typeof DOCS)[number] | null {
  const file = href.split("#")[0].split("/").pop()?.toLowerCase();
  if (!file?.endsWith(".md")) return null;
  return (
    DOCS.find((d) => d.path.split("/").pop()?.toLowerCase() === file) ?? null
  );
}

export function DocsDialog() {
  const { t, i18n } = useTranslation();
  const open = useDocsDialog((s) => s.open);
  const activeId = useDocsDialog((s) => s.activeId);
  const sectionSlug = useDocsDialog((s) => s.sectionSlug);
  const pendingAnchor = useDocsDialog((s) => s.pendingAnchor);
  const setOpen = useDocsDialog((s) => s.setOpen);
  const setActive = useDocsDialog((s) => s.setActive);
  const setSection = useDocsDialog((s) => s.setSection);
  const clearAnchor = useDocsDialog((s) => s.clearAnchor);

  const active = (activeId && getDoc(activeId)) || DOCS[0];
  const lang = i18n.language;
  const body = active ? getDocBody(active, lang) : "";
  // Reparsed only when the body changes — a language switch or a different doc,
  // not every render.
  const parsed = React.useMemo<ParsedDoc>(() => parseDoc(body), [body]);
  const section = parsed.sections.find((s) => s.slug === sectionSlug) ?? null;
  const activeDate = active ? formatDate(active.updated, lang) : null;

  /**
   * Follow a link the renderer cannot judge alone: an in-document `#anchor`, or
   * a relative path to another `.md`.
   *
   * `canFollow` and `follow` agree by construction because both go through
   * `resolve`. An href that resolves to nothing is left inert and uncoloured
   * rather than navigating somewhere arbitrary.
   */
  const navigator = React.useMemo<DocNavigator>(() => {
    const resolve = (href: string): (() => void) | null => {
      if (href.startsWith("#")) {
        const hit = locate(parsed, href.slice(1));
        return hit ? () => setSection(hit.section, hit.anchor) : null;
      }
      const target = docForHref(href);
      if (target) {
        const anchor = href.split("#")[1];
        return () => {
          if (target.id === active?.id && anchor) {
            const hit = locate(parsed, anchor);
            if (hit) return setSection(hit.section, hit.anchor);
          }
          setActive(target.id);
        };
      }
      // A doc that exists in the repo but is deliberately not bundled — the
      // roadmaps, SECURITY.md. Hand it to GitHub rather than leaving a link
      // the prose depends on doing nothing. The Tauri capability already
      // allows github.com only, which is where these live.
      if (/\.md(#.*)?$/i.test(href)) {
        const file = href.replace(/^(\.\/|\.\.\/)+/, "");
        const path = href.startsWith("../") ? file : `docs/${file}`;
        return () => void api.openUrl(`${REPO_BLOB}/${path}`);
      }
      return null;
    };
    return {
      canFollow: (href) => resolve(href) !== null,
      follow: (href) => resolve(href)?.(),
    };
  }, [parsed, active?.id, setSection, setActive]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-w-4xl flex-col gap-0 p-0">
        <DialogHeader className="border-b px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand">
              <BookOpen className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <DialogTitle>{t("docs.title")}</DialogTitle>
              <DialogDescription>{t("docs.subtitle")}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex h-[70vh] min-h-0">
          {/* Sidebar: docs, the active one expanded into its sections. */}
          <nav className="w-60 shrink-0 overflow-y-auto border-r py-1">
            {DOCS.map((doc) => {
              const selected = doc.id === active?.id;
              const date = formatDate(doc.updated, lang);
              return (
                <div key={doc.id}>
                  <button
                    type="button"
                    onClick={() => setActive(doc.id)}
                    aria-current={selected ? "true" : undefined}
                    className={cn(
                      "flex w-full items-start gap-2 border-l-2 px-3 py-2 text-left transition-colors",
                      selected
                        ? "border-primary bg-accent/40"
                        : "border-transparent hover:bg-accent/30",
                    )}
                  >
                    <ChevronRight
                      aria-hidden
                      className={cn(
                        "mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                        selected && "rotate-90",
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm">{t(doc.titleKey)}</span>
                      {date && (
                        <span className="block text-[10px] text-muted-foreground">
                          {t("docs.updated", { date })}
                        </span>
                      )}
                    </span>
                  </button>

                  {selected && (
                    <div className="mb-1">
                      <SidebarRow
                        label={t("docs.cover")}
                        depth={1}
                        active={sectionSlug === null}
                        onClick={() => setSection(null)}
                      />
                      {parsed.sections.map((s) => (
                        <React.Fragment key={s.slug}>
                          <SidebarRow
                            label={s.title}
                            depth={1}
                            active={s.slug === sectionSlug}
                            onClick={() => setSection(s.slug)}
                          />
                          {s.slug === sectionSlug &&
                            s.subs.map((sub) => (
                              <SidebarRow
                                key={sub.slug}
                                label={sub.title}
                                depth={2}
                                active={false}
                                onClick={() => setSection(s.slug, sub.slug)}
                              />
                            ))}
                        </React.Fragment>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>

          {/* Page. Keyed so switching page mounts fresh — which also resets the
              scroll offset, something the single-pane version never did. */}
          <div
            key={`${active?.id}:${sectionSlug ?? "cover"}`}
            className="min-w-0 flex-1 overflow-y-auto px-6 py-4"
          >
            {!active ? (
              <p className="text-sm text-muted-foreground">{t("docs.empty")}</p>
            ) : section ? (
              <>
                <ScrollToAnchor
                  anchor={pendingAnchor}
                  onConsumed={clearAnchor}
                />
                {/* The section's own `##` heading is now the first thing on
                    the page, and its `mt-6` was sized for a mid-document
                    heading. */}
                <Markdown
                  source={section.body}
                  navigator={navigator}
                  className="[&>*:first-child]:mt-0"
                />
              </>
            ) : (
              <>
                {activeDate && (
                  <div className="mb-3 text-[11px] uppercase tracking-wide text-muted-foreground">
                    {t("docs.updated", { date: activeDate })}
                  </div>
                )}
                <Markdown source={parsed.cover} navigator={navigator} />
                {parsed.sections.length > 0 && (
                  <>
                    <h2 className="mb-2 mt-6 border-b pb-1 text-lg font-semibold text-foreground">
                      {t("docs.coverSections")}
                    </h2>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {parsed.sections.map((s) => (
                        <button
                          key={s.slug}
                          type="button"
                          onClick={() => setSection(s.slug)}
                          className="flex items-start gap-2 rounded-md border p-3 text-left transition-colors hover:border-brand/60 hover:bg-accent/40"
                        >
                          <FileText
                            aria-hidden
                            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
                          />
                          <span className="min-w-0">
                            <span className="block text-sm font-medium text-foreground">
                              {s.title}
                            </span>
                            {s.subs.length > 0 && (
                              <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                                {s.subs.map((x) => x.title).join(" · ")}
                              </span>
                            )}
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SidebarRow({
  label,
  depth,
  active,
  onClick,
}: {
  label: string;
  depth: 1 | 2;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={cn(
        "block w-full border-l-2 py-1 pr-3 text-left text-xs transition-colors",
        depth === 1 ? "pl-8" : "pl-12",
        active
          ? "border-primary bg-accent/40 text-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent/30 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

/**
 * Scroll to `anchor` once the page it belongs to has mounted, then consume it.
 *
 * The `requestAnimationFrame` is the guard `PrefRow` needs for the same reason:
 * the page mounts in the tick that navigated to it, so scrolling immediately
 * lands on an element that has not been laid out yet and has zero height.
 *
 * The anchor is consumed **inside** the frame, after the scroll — not before it,
 * which is the ordering that reads more naturally and does not work. Clearing
 * first updates the store, which changes this effect's dependencies, which runs
 * its cleanup, which cancels the frame that was going to do the scrolling. The
 * effect would tidy up after itself and never scroll at all.
 */
function ScrollToAnchor({
  anchor,
  onConsumed,
}: {
  anchor: string | null;
  onConsumed: () => void;
}) {
  React.useEffect(() => {
    if (!anchor) return;
    const raf = requestAnimationFrame(() => {
      document
        .getElementById(anchor)
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
      onConsumed();
    });
    return () => cancelAnimationFrame(raf);
  }, [anchor, onConsumed]);
  return null;
}
