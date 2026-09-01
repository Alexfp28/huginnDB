/**
 * @vitest-environment jsdom
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NativeSelect, nativeSelectVariants } from "./native-select";

afterEach(() => {
  cleanup();
});

describe("NativeSelect", () => {
  it("always paints its own background and foreground", () => {
    // The WebView2 bug this primitive exists to centralise: Chromium draws the
    // native popup using the trigger's own colours, so a transparent trigger
    // gives you an OS-light popup on a dark theme. These two must be in the
    // base, unconditionally — a variant could omit them.
    for (const size of ["md", "sm", "xs"] as const) {
      const cls = nativeSelectVariants({ size });
      expect(cls).toContain("bg-background");
      expect(cls).toContain("text-foreground");
      expect(cls).not.toContain("bg-transparent");
    }
  });

  it("shares the xs/sm/md density vocabulary", () => {
    expect(nativeSelectVariants({ size: "xs" })).toContain("h-7");
    expect(nativeSelectVariants({ size: "sm" })).toContain("h-8");
    expect(nativeSelectVariants({ size: "md" })).toContain("h-9");
  });

  it("offers the monospace option the type picker needs", () => {
    expect(nativeSelectVariants({ mono: true })).toContain("font-mono");
    expect(nativeSelectVariants({ mono: false })).not.toContain("font-mono");
  });

  it("renders a real select, so the OS popup and form semantics are intact", () => {
    render(
      <NativeSelect aria-label="Driver" defaultValue="mysql">
        <option value="mysql">MySQL</option>
        <option value="postgres">Postgres</option>
      </NativeSelect>,
    );
    const el = screen.getByRole("combobox") as HTMLSelectElement;
    expect(el.tagName).toBe("SELECT");
    expect(el.value).toBe("mysql");
  });
});
