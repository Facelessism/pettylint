import { describe, it, expect } from "vitest";
import { parseUnifiedDiff, filterFindingsByChangedRanges, findingIntersectsRanges } from "../src/diff.js";
import type { Finding } from "../src/core.js";

function finding(overrides: Partial<Finding>): Finding {
  return {
    ruleId: "PL001",
    message: "m",
    severity: "warning",
    confidence: "high",
    file: "src/server.ts",
    line: 1,
    column: 1,
    category: "debugging",
    ...overrides,
  };
}

const SAMPLE_DIFF = [
  "diff --git a/src/server.ts b/src/server.ts",
  "index 000..111 100644",
  "--- a/src/server.ts",
  "+++ b/src/server.ts",
  "@@ -40,3 +40,4 @@ function handle() {",
  " existingLine();",
  "-oldDebug();",
  "+console.log(oldDebug);",
  "+console.log(newDebug);",
  " tail();",
].join("\n");

describe("parseUnifiedDiff()", () => {
  it("extracts only added line numbers, not context or deletions", () => {
    const ranges = parseUnifiedDiff(SAMPLE_DIFF);
    expect(ranges).toEqual([{ file: "src/server.ts", startLine: 41, endLine: 42 }]);
  });

  it("returns no ranges for a deletion-only hunk", () => {
    const diff = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,2 +1,0 @@",
      "-a();",
      "-b();",
    ].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([]);
  });

  it("handles multiple files in one diff", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,0 +1,1 @@",
      "+x();",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1,0 +1,1 @@",
      "+y();",
    ].join("\n");
    const ranges = parseUnifiedDiff(diff);
    expect(ranges).toEqual([
      { file: "a.ts", startLine: 1, endLine: 1 },
      { file: "b.ts", startLine: 1, endLine: 1 },
    ]);
  });
});

describe("findingIntersectsRanges() / filterFindingsByChangedRanges()", () => {
  const ranges = parseUnifiedDiff(SAMPLE_DIFF);

  it("keeps a finding on a newly added line", () => {
    const f = finding({ line: 42 });
    expect(findingIntersectsRanges(f, ranges)).toBe(true);
  });

  it("drops a finding on an untouched line in the same file", () => {
    const f = finding({ line: 100 });
    expect(findingIntersectsRanges(f, ranges)).toBe(false);
  });

  it("drops a finding entirely outside the changed file set", () => {
    const f = finding({ file: "src/other.ts", line: 41 });
    expect(findingIntersectsRanges(f, ranges)).toBe(false);
  });

  it("keeps a multi-line finding that partially overlaps a changed range", () => {
    const f = finding({ line: 39, endLine: 41 });
    expect(findingIntersectsRanges(f, ranges)).toBe(true);
  });

  it("filterFindingsByChangedRanges only reports newly introduced findings", () => {
    const findings = [finding({ line: 41 }), finding({ line: 42 }), finding({ line: 100 })];
    const filtered = filterFindingsByChangedRanges(findings, ranges);
    expect(filtered.map((f) => f.line)).toEqual([41, 42]);
  });
});
