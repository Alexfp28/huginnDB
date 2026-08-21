import { describe, expect, it } from "vitest";

import { joinStatements } from "./formatStatements";

describe("joinStatements", () => {
  it("separates with a semicolon and newline and terminates the last one", () => {
    expect(joinStatements(["ALTER TABLE a ADD b int", "CREATE INDEX i ON a(b)"])).toBe(
      "ALTER TABLE a ADD b int;\nCREATE INDEX i ON a(b);",
    );
  });

  it("terminates a single statement", () => {
    expect(joinStatements(["DROP VIEW v"])).toBe("DROP VIEW v;");
  });

  // An unchanged table must preview as blank, not as a lone semicolon.
  it("renders an empty list as an empty string", () => {
    expect(joinStatements([])).toBe("");
  });
});
