import { describe, it, expect } from "vitest";
import {
  formatPretty,
  formatJson,
  formatSarif,
  formatGithubAnnotations,
  formatPrSummary,
  isPettyLintSummaryComment,
} from "../src/format.js";
import type { Finding } from "../src/core.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: "PL001",
    message: "Your debugging statement has escaped containment.",
    severity: "warning",
    confidence: "high",
    file: "src/server.ts",
    line: 42,
    column: 5,
    category: "debugging",
    ...overrides,
  };
}

describe("formatPretty()", () => {
  it("reports a clean result", () => {
    expect(formatPretty([])).toContain("Nothing to complain about.");
  });

  it("includes file/line/column, rule id, severity, and message", () => {
    const output = formatPretty([finding()]);
    expect(output).toContain("src/server.ts:42:5");
    expect(output).toContain("PL001");
    expect(output).toContain("warning");
    expect(output).toContain("Your debugging statement has escaped containment.");
  });

  it("summarizes counts by severity", () => {
    const output = formatPretty([
      finding({ severity: "error" }),
      finding({ severity: "warning" }),
      finding({ severity: "notice" }),
    ]);
    expect(output).toMatch(/1 error/);
    expect(output).toMatch(/1 warning/);
    expect(output).toMatch(/1 notice/);
  });
});

describe("formatJson()", () => {
  it("produces a summary matching the findings", () => {
    const report = formatJson([finding({ severity: "error" }), finding({ severity: "warning" })]);
    expect(report.summary).toEqual({ total: 2, errors: 1, warnings: 1, notices: 0 });
    expect(report.findings).toHaveLength(2);
  });
});

describe("formatSarif()", () => {
  it("produces a valid-shaped SARIF 2.1.0 document", () => {
    const sarif = formatSarif([finding()]) as any;
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].tool.driver.name).toBe("PettyLint");
    expect(sarif.runs[0].results[0]).toMatchObject({
      ruleId: "PL001",
      level: "warning",
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: "src/server.ts" },
            region: { startLine: 42, startColumn: 5 },
          },
        },
      ],
    });
  });

  it("maps severities to SARIF levels", () => {
    const sarif = formatSarif([finding({ severity: "notice" })]) as any;
    expect(sarif.runs[0].results[0].level).toBe("note");
  });
});

describe("formatGithubAnnotations()", () => {
  it("emits a workflow-command annotation with accurate location", () => {
    const [line] = formatGithubAnnotations([finding()]);
    expect(line).toBe(
      "::warning file=src/server.ts,line=42,col=5,title=PL001::Your debugging statement has escaped containment.",
    );
  });

  it("maps severities to the correct annotation level", () => {
    const [line] = formatGithubAnnotations([finding({ severity: "notice" })]);
    expect(line?.startsWith("::notice ")).toBe(true);
  });
});

describe("formatPrSummary()", () => {
  it("produces a single comment covering all findings, not one per finding", () => {
    const body = formatPrSummary({ newFindings: [finding(), finding({ line: 43 })] });
    expect(body.match(/## PettyLint/g)).toHaveLength(1);
    expect(isPettyLintSummaryComment(body)).toBe(true);
  });

  it("reports resolved findings separately from new findings", () => {
    const body = formatPrSummary({
      newFindings: [],
      resolvedFindings: [{ fingerprint: "x", ruleId: "PL001", file: "a.ts", line: 1, column: 1 }],
    });
    expect(body).toContain("Resolved");
  });
});

describe("rule names in pretty output", () => {
  it("shows the rule name, not the category", () => {
    expect(formatPretty([finding()])).toContain("PL001 console-log");
  });
});
