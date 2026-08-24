import { create } from "zustand";

interface DocsDialogState {
  open: boolean;
  /** Currently previewed doc id; `null` falls back to the first entry. */
  activeId: string | null;
  /**
   * Which `##` section of the active doc is showing; `null` is its cover.
   *
   * A slug, not an index, so it survives a doc being edited: a section that
   * moved keeps its identity, and a section that was renamed falls back to the
   * cover rather than showing whatever now sits at that position.
   */
  sectionSlug: string | null;
  /**
   * A `###` slug the freshly-shown section should scroll to, consumed by the
   * heading once it has mounted.
   *
   * Separate from `sectionSlug` because a section is a *page* and a `###` is a
   * position inside it — the same pairing `useSettingsDialog` uses for a section
   * plus the preference to flash within it.
   */
  pendingAnchor: string | null;
  /** Open the viewer, optionally selecting a doc and a section within it. */
  openTo: (id?: string, section?: string | null, anchor?: string | null) => void;
  setOpen: (open: boolean) => void;
  /** Select a doc, landing on its cover. */
  setActive: (id: string) => void;
  /** Select a section of the active doc, optionally scrolling to a `###`. */
  setSection: (slug: string | null, anchor?: string | null) => void;
  clearAnchor: () => void;
}

export const useDocsDialog = create<DocsDialogState>()((set) => ({
  open: false,
  activeId: null,
  sectionSlug: null,
  pendingAnchor: null,
  openTo: (id, section = null, anchor = null) =>
    set({
      open: true,
      activeId: id ?? null,
      sectionSlug: section,
      pendingAnchor: anchor,
    }),
  setOpen: (open) => set({ open }),
  // Changing doc lands on the cover: a section slug from the previous doc means
  // nothing here, and silently keeping it would show the cover anyway while the
  // sidebar highlighted a row that does not exist.
  setActive: (id) => set({ activeId: id, sectionSlug: null, pendingAnchor: null }),
  // Navigating by hand abandons any pending scroll — the same call
  // `useSettingsDialog.setSection` makes about a pending highlight.
  setSection: (slug, anchor = null) =>
    set({ sectionSlug: slug, pendingAnchor: anchor }),
  clearAnchor: () => set({ pendingAnchor: null }),
}));
