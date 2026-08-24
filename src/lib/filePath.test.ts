import { describe, expect, it } from "vitest";
import { baseName, dirName } from "./filePath";

describe("baseName", () => {
  it("reads a Windows path", () => {
    expect(baseName("C:\\Users\\me\\exports\\artist-2026-08-24.csv")).toBe(
      "artist-2026-08-24.csv",
    );
  });

  it("reads a POSIX path", () => {
    expect(baseName("/home/me/exports/artist.csv")).toBe("artist.csv");
  });

  it("accepts the foreign separator on either platform", () => {
    // A path can arrive from an exported profile written on another OS.
    expect(baseName("C:/Users/me/dump.sql")).toBe("dump.sql");
  });

  it("ignores a trailing separator", () => {
    expect(baseName("/home/me/exports/")).toBe("exports");
    expect(baseName("C:\\exports\\\\")).toBe("exports");
  });

  it("passes a bare file name through", () => {
    expect(baseName("artist.csv")).toBe("artist.csv");
  });

  it("falls back to the input rather than an empty label", () => {
    expect(baseName("/")).toBe("/");
    expect(baseName("")).toBe("");
  });
});

describe("dirName", () => {
  it("drops the file name", () => {
    expect(dirName("C:\\Users\\me\\exports\\artist.csv")).toBe(
      "C:\\Users\\me\\exports",
    );
    expect(dirName("/home/me/exports/artist.csv")).toBe("/home/me/exports");
  });

  it("keeps the root separator so the path still reads as absolute", () => {
    expect(dirName("/dump.sql")).toBe("/");
  });

  it("is empty for a bare file name", () => {
    expect(dirName("artist.csv")).toBe("");
  });
});
