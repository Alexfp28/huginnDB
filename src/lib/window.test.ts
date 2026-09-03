import { describe, expect, it } from "vitest";
import { windowKindOf } from "./window";

describe("windowKindOf", () => {
  it("classifies the main window", () => {
    expect(windowKindOf("main")).toBe("main");
  });

  it("classifies a detached tab window", () => {
    expect(windowKindOf("tabwin-abc123")).toBe("tabWindow");
  });

  it("classifies a Pulse window", () => {
    expect(windowKindOf("pulsewin-abc123")).toBe("pulseWindow");
  });

  it("classifies a 'New window' as secondary", () => {
    expect(windowKindOf("win-abc123")).toBe("secondary");
  });
});
