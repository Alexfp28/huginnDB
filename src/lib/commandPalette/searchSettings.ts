/**
 * The Preferences dialog's own search box: which settings match what the user
 * typed.
 *
 * Deliberately simpler than the command palette's matcher. The palette ranks a
 * few hundred mixed commands and has to be forgiving about typos; this list is
 * ~70 settings the user is scanning by eye, so the rule is the one people
 * predict — every word typed must appear somewhere in the setting's text — and
 * the ranking only lifts rows whose *label* carries all the words above rows
 * that matched on a description or keyword.
 *
 * Accents are folded so "linea" finds "Línea", which matters because the
 * registry's `keywords` carry both UI languages (see `settingsRegistry.ts`).
 */

export function foldForSearch(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export interface SearchableText {
  label: string;
  /** Description, keywords, section name — matched, never ranked on. */
  rest: string;
}

export function matchSettings<T>(
  query: string,
  items: readonly T[],
  text: (item: T) => SearchableText,
): T[] {
  const words = foldForSearch(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const { label, rest } = text(item);
    const foldedLabel = foldForSearch(label);
    const haystack = `${foldedLabel} ${foldForSearch(rest)}`;
    if (!words.every((w) => haystack.includes(w))) return;
    const score = words.every((w) => foldedLabel.includes(w)) ? 0 : 1;
    scored.push({ item, score, index });
  });
  // Stable within a score: the registry's order is the dialog's section
  // order, which is what the grouped result list renders in.
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.map((s) => s.item);
}
