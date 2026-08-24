/**
 * Running a table/collection export and reporting the outcome.
 *
 * One rule is worth owning here rather than repeating per call site: the user
 * dismissing the save dialog comes back from Rust as an ordinary `Err`
 * (`error::EXPORT_CANCELLED`, matched by `isExportCancelled`), not as a distinct
 * result. Announcing that as a failure would tell someone who *just cancelled*
 * that the export broke, so it is swallowed — while every other error is a real
 * one and must surface.
 *
 * `save` resolves to the path written; `announce`/`fail` keep i18n and the toast
 * surface at the call site, which is what makes this testable.
 */

import { isExportCancelled } from "@/lib/db/driver";

export async function runExport(
  save: () => Promise<string>,
  announce: (path: string) => void,
  fail: (message: string) => void,
): Promise<void> {
  try {
    announce(await save());
  } catch (e) {
    const message = String(e);
    if (!isExportCancelled(message)) fail(message);
  }
}
