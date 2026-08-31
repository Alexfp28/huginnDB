/**
 * Why an engine has no statement statistics.
 *
 * The "not available" line is deliberately engine-neutral — a MongoDB user was
 * being told about `performance_schema` — so the actionable half is this: each
 * answer names the server-side switch that would fill the section. Pure, and in
 * `lib/` rather than in either surface, so the panel and the window cannot
 * explain the same gap differently.
 */

export function slowestHint(driver: string, t: (key: string) => string): string {
  if (driver === "mongodb") return t("pulse.slowest.hintMongo");
  if (driver === "mysql") return t("pulse.slowest.hintMysql");
  return "";
}
