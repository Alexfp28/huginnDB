# Gotcha #050: The docs viewer slices navigation from the markdown itself, in one scan

**Fecha:** 2026-09-03

`docOutline.ts`'s `parseDoc` produces the outline and page bodies in a single pass so two scans can't disagree about section boundaries, skips fenced code so shell comments aren't mistaken for headings, and `slugify` follows GitHub's punctuation-dropping rule to match existing anchors.

## Detail

**The docs viewer derives its navigation from the markdown, and three things about that are load-bearing.** `docs/*.md` are still one file each, still the only source, still read on GitHub unchanged — `src/lib/appInfo/docOutline.ts` slices them at render time into a cover (everything before the first `##`), one page per `##`, and each `###` as a scroll target inside its page. So adding a section to a guide adds it to the sidebar with no code change, and the sidebar translates itself because the Spanish body carries Spanish headings.
    - **One scan produces both the outline and the bodies.** `parseDoc` returns them together rather than there being a heading-lister and a separate splitter, because two passes over the same markdown are two chances to disagree about where a section ends — and that disagreement is not an error, it is a page that quietly loses its last paragraph. There is a round-trip test over the real corpus for exactly this.
    - **The scan must skip fenced code.** `docs/MCP.md` has shell comments at lines 49 and 164 (`# binary at: …`, `# optional: startup_timeout_sec = 20`); a bare `^#` scan reads them as headings, invents phantom sections, *and* truncates the section they sit in. `docOutline`'s fence regexes are copied from `Markdown.tsx`'s deliberately, so the two cannot disagree about where a fence is.
    - **`slugify` is the join between the ids `Markdown` emits and the `#anchor`s already written in the docs**, so it follows GitHub's rule: punctuation is *dropped*, not replaced (`Sharing the app's pools` → `sharing-the-apps-pools`, never `…app-s-pools`). Duplicate-slug suffixing is scoped per rendered body in `Markdown` and per section in `parseDoc`, which is the same scope — render one section and the two agree. A test asserts every anchor in every shipped guide, in both languages, resolves.
