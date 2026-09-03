import { describe, expect, it } from "vitest";
import { colorForWindowLabel, ribbonColorForWindowLabel } from "./windowColor";

describe("colorForWindowLabel", () => {
  it("is deterministic for the same label", () => {
    expect(colorForWindowLabel("win-abc123")).toBe(
      colorForWindowLabel("win-abc123"),
    );
  });

  it("differs across distinct labels in practice", () => {
    const colors = new Set(
      ["main", "win-a", "win-b", "win-c", "win-d"].map(colorForWindowLabel),
    );
    expect(colors.size).toBeGreaterThan(1);
  });

  it("always returns a valid hsl() string", () => {
    expect(colorForWindowLabel("main")).toMatch(
      /^hsl\(\d{1,3} \d{1,3}% \d{1,3}%\)$/,
    );
  });

  it("ribbon tint shares the accent's hue but is lighter", () => {
    expect(ribbonColorForWindowLabel("win-abc123")).toMatch(
      /^hsl\((\d{1,3}) \d{1,3}% 85%\)$/,
    );
    const [, accentHue] = /^hsl\((\d{1,3})/.exec(
      colorForWindowLabel("win-abc123"),
    )!;
    const [, ribbonHue] = /^hsl\((\d{1,3})/.exec(
      ribbonColorForWindowLabel("win-abc123"),
    )!;
    expect(ribbonHue).toBe(accentHue);
  });
});
