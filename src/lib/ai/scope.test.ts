import { describe, expect, it } from "vitest";

import { resolveDataScope } from "./scope";

/**
 * The same truth table as `DataScope::resolve`'s test in
 * `src-tauri/src/ai/scope.rs`. Kept in both places on purpose: this one is what
 * catches the label on the screen drifting away from the rule the backend
 * enforces, which is the only way this mirror can do harm.
 */
describe("resolveDataScope", () => {
  it("is the coupling rule, in full", () => {
    expect(resolveDataScope("trusted", false)).toBe("rows");
    expect(resolveDataScope("trusted", true)).toBe("rows");
    expect(resolveDataScope("untrusted", false)).toBe("metadataOnly");
    expect(resolveDataScope("untrusted", true)).toBe("rows");
  });

  /** The asymmetry, asserted so nobody "fixes" it here without deciding to
   *  fix it in Rust: a trusted endpoint reads rows whatever the flag says. */
  it("lets a trusted endpoint ignore the per-connection flag", () => {
    expect(resolveDataScope("trusted", false)).toBe(
      resolveDataScope("trusted", true),
    );
  });
});
