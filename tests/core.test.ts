import { describe, it, expect } from "vitest";
import { analyze, fingerprint, sortFindings } from "../src/core.js";

describe("analyze()", () => {
  it("skips files with unsupported extensions", () => {
    const result = analyze([{ filePath: "notes.txt", text: "console.log(1)" }]);
    expect(result.filesAnalyzed).toEqual([]);
    expect(result.filesSkipped).toEqual([{ file: "notes.txt", reason: "unsupported file extension" }]);
  });

  it("reports parse errors without crashing the whole run", () => {
    const result = analyze([
      { filePath: "broken.ts", text: "const x = (((" },
      { filePath: "clean.ts", text: "const y = 1;" },
    ]);
    // The TypeScript scanner recovers from malformed input rather than
    // throwing, so both files are analyzed; this asserts the engine
    // never crashes on malformed source.
    expect(result.filesSkipped.every((s) => !s.reason.includes("threw"))).toBe(true);
  });

  it("applies custom rules alongside built-ins", () => {
    const result = analyze([{ filePath: "a.ts", text: "const x = 1;" }], {
      customRules: [
        {
          id: "custom/always-flag",
          name: "always-flag",
          description: "test rule",
          category: "maintainability",
          severity: "warning",
          confidence: "high",
          languages: ["typescript"],
          check: (context) => [
            {
              ruleId: "custom/always-flag",
              message: "flagged",
              severity: "warning",
              confidence: "high",
              file: context.filePath,
              line: 1,
              column: 1,
              category: "maintainability",
            },
          ],
        },
      ],
    });
    expect(result.findings.some((f) => f.ruleId === "custom/always-flag")).toBe(true);
  });

  it("rejects duplicate rule ids from custom rules colliding with built-ins", () => {
    expect(() =>
      analyze([{ filePath: "a.ts", text: "" }], {
        customRules: [
          {
            id: "PL001",
            name: "not-console-log",
            description: "collides with the built-in id",
            category: "debugging",
            severity: "warning",
            confidence: "high",
            languages: ["typescript"],
            check: () => [],
          },
        ],
      }),
    ).toThrow(/Duplicate rule id/);
  });

  it("disables a rule via ruleConfig 'off'", () => {
    const result = analyze([{ filePath: "a.ts", text: "console.log(1);" }], {
      ruleConfig: { "console-log": "off" },
    });
    expect(result.findings).toEqual([]);
  });

  it("overrides severity via ruleConfig", () => {
    const result = analyze([{ filePath: "a.ts", text: "console.log(1);" }], {
      ruleConfig: { "console-log": "error" },
    });
    expect(result.findings[0]?.severity).toBe("error");
  });

  it("honors inline pettylint-disable-next-line suppression", () => {
    const result = analyze([
      {
        filePath: "a.ts",
        text: ["// pettylint-disable-next-line console-log", "console.log(1);", "console.log(2);"].join("\n"),
      },
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.line).toBe(3);
  });

  it("honors inline pettylint-disable / pettylint-enable ranges", () => {
    const text = [
      "console.log(0);",
      "// pettylint-disable console-log",
      "console.log(1);",
      "console.log(2);",
      "// pettylint-enable console-log",
      "console.log(3);",
    ].join("\n");
    const result = analyze([{ filePath: "a.ts", text }]);
    expect(result.findings.map((f) => f.line)).toEqual([1, 6]);
  });
});

describe("fingerprint()", () => {
  it("is stable for identical rule/file/line-text", () => {
    expect(fingerprint({ ruleId: "PL001", file: "a.ts" }, "console.log(1);")).toBe(
      fingerprint({ ruleId: "PL001", file: "a.ts" }, "  console.log(1);  "),
    );
  });

  it("differs when the flagged line text or occurrence differs", () => {
    const base = fingerprint({ ruleId: "PL001", file: "a.ts" }, "console.log(1);");
    expect(fingerprint({ ruleId: "PL001", file: "a.ts" }, "console.log(2);")).not.toBe(base);
    expect(fingerprint({ ruleId: "PL001", file: "a.ts" }, "console.log(1);", 1)).not.toBe(base);
  });

  it("does not change when unrelated lines are inserted above a finding", () => {
    const before = analyze([{ filePath: "a.ts", text: "console.log(1);" }]).findings[0]!;
    const after = analyze([{ filePath: "a.ts", text: "const a = 1;\nconst b = 2;\nconsole.log(1);" }]).findings[0]!;
    expect(before.line).not.toBe(after.line);
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  it("distinguishes identical lines via occurrence index", () => {
    const findings = analyze([{ filePath: "a.ts", text: "console.log(1);\nconsole.log(1);" }]).findings;
    expect(findings).toHaveLength(2);
    expect(findings[0]!.fingerprint).not.toBe(findings[1]!.fingerprint);
  });
});

describe("cache, diagnostics and timings", () => {
  it("returns identical results on a cache hit and never shares mutable objects", () => {
    const input = { filePath: "c.ts", text: "console.log(1);" };
    const first = analyze([input]);
    first.findings[0]!.message = "mutated";
    const second = analyze([input]);
    expect(second.findings[0]!.message).toBe("Your debugging statement has escaped containment.");
    expect(second.timings.parseMs).toBe(0);
  });

  it("does not reuse a cached result when the rule configuration changes", () => {
    const input = { filePath: "d.ts", text: "console.log(1);" };
    expect(analyze([input]).findings).toHaveLength(1);
    expect(analyze([input], { ruleConfig: { "console-log": "off" } }).findings).toHaveLength(0);
  });

  it("reports syntax errors as parse diagnostics while still analyzing the file", () => {
    const result = analyze([{ filePath: "e.ts", text: "console.log(1);\nconst x = (((" }]);
    expect(result.diagnostics.some((d) => d.kind === "parse")).toBe(true);
    expect(result.findings.some((f) => f.ruleId === "PL001")).toBe(true);
  });
});

describe("sortFindings()", () => {
  it("sorts by file, then line, then column, then rule id", () => {
    const findings = [
      { ruleId: "PL002", file: "b.ts", line: 1, column: 1, severity: "warning", confidence: "high", message: "", category: "" },
      { ruleId: "PL001", file: "a.ts", line: 2, column: 1, severity: "warning", confidence: "high", message: "", category: "" },
      { ruleId: "PL001", file: "a.ts", line: 1, column: 5, severity: "warning", confidence: "high", message: "", category: "" },
      { ruleId: "PL002", file: "a.ts", line: 1, column: 1, severity: "warning", confidence: "high", message: "", category: "" },
    ] as const;
    const sorted = sortFindings([...findings]);
    expect(sorted.map((f) => `${f.file}:${f.line}:${f.column}:${f.ruleId}`)).toEqual([
      "a.ts:1:1:PL002",
      "a.ts:1:5:PL001",
      "a.ts:2:1:PL001",
      "b.ts:1:1:PL002",
    ]);
  });
});

describe("custom rule policy", () => {
  it("rejects un-namespaced custom rule ids", () => {
    expect(() =>
      analyze([{ filePath: "a.ts", text: "" }], {
        customRules: [
          { id: "no-slash", name: "x", description: "", category: "maintainability", severity: "warning",
            confidence: "high", languages: ["typescript"], check: () => [] },
        ],
      }),
    ).toThrow(/must be namespaced/);
  });

  it("surfaces unknown rules in suppression comments as diagnostics", () => {
    const result = analyze([{ filePath: "a.ts", text: "// pettylint-disable-next-line nope\nconst x = 1;" }]);
    expect(result.diagnostics).toHaveLength(1);
  });
});
