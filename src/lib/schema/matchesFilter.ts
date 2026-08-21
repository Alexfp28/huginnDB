/**
 * Match a table/database name against the filter box. HeidiSQL-style: the
 * filter may hold several `;`-separated patterns and a name matches when it
 * contains ANY of them (OR), so `users; orders` surfaces both tables at once.
 * An empty filter (or one that's only separators/whitespace) matches all.
 */
export function matchesFilter(name: string, filter: string): boolean {
  const patterns = filter
    .split(";")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (patterns.length === 0) return true;
  const n = name.toLowerCase();
  return patterns.some((p) => n.includes(p));
}
