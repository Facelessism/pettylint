import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createBaseline,
  loadBaseline,
  writeBaseline,
  diffAgainstBaseline,
  BaselineError,
  BASELINE_VERSION,
} from "../src/baseline.js";
import { fingerprint, type Finding } from "../src/core.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  const base: Finding = {
    ruleId: "PL001",
    message: "m",
    severity: "warning",
    confidence: "high",
    file: "a.ts",
    line: 1,
    column: 1,
    category: "debugging",
    ...overrides,
  };
  return { ...base, fingerprint: fingerprint(base, `line ${base.line}`) };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pettylint-baseline-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("createBaseline() / writeBaseline() / loadBaseline()", () => {
  it("round-trips through disk", () => {
    const findings = [finding({ line: 1 }), finding({ line: 2 })];
    const baseline = createBaseline(findings);
    const file = path.join(tmpDir, ".pettylint-baseline.json");
    writeBaseline(file, baseline);

    const loaded = loadBaseline(file);
    expect(loaded?.findings).toHaveLength(2);
    expect(loaded?.version).toBe(BASELINE_VERSION);
  });

  it("returns null for a missing baseline file", () => {
    expect(loadBaseline(path.join(tmpDir, "missing.json"))).toBeNull();
  });

  it("rejects a corrupted (non-JSON) baseline file", () => {
    const file = path.join(tmpDir, "bad.json");
    fs.writeFileSync(file, "{ not valid json");
    expect(() => loadBaseline(file)).toThrow(BaselineError);
  });

  it("rejects a baseline missing required fields", () => {
    const file = path.join(tmpDir, "incomplete.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1 }));
    expect(() => loadBaseline(file)).toThrow(/missing required fields/);
  });

  it("rejects an invalid baseline version", () => {
    const file = path.join(tmpDir, "wrong-version.json");
    fs.writeFileSync(file, JSON.stringify({ version: 999, generatedAt: "x", findings: [] }));
    expect(() => loadBaseline(file)).toThrow(/version 999/);
  });

  it("produces stable fingerprints across separate baseline generations", () => {
    const b1 = createBaseline([finding({ line: 5 })]);
    const b2 = createBaseline([finding({ line: 5 })]);
    expect(b1.findings[0]?.fingerprint).toBe(b2.findings[0]?.fingerprint);
  });
});

describe("diffAgainstBaseline()", () => {
  it("treats everything as new when there is no baseline", () => {
    const findings = [finding({ line: 1 }), finding({ line: 2 })];
    const result = diffAgainstBaseline(findings, null);
    expect(result.newFindings).toHaveLength(2);
    expect(result.existingFindings).toHaveLength(0);
    expect(result.resolvedFindings).toHaveLength(0);
  });

  it("classifies unchanged findings as existing, not new", () => {
    const findings = [finding({ line: 1 }), finding({ line: 2 })];
    const baseline = createBaseline(findings);
    const result = diffAgainstBaseline(findings, baseline);
    expect(result.newFindings).toHaveLength(0);
    expect(result.existingFindings).toHaveLength(2);
  });

  it("identifies a newly introduced finding alongside pre-existing ones", () => {
    const original = [finding({ line: 1 })];
    const baseline = createBaseline(original);
    const current = [finding({ line: 1 }), finding({ line: 2 })];
    const result = diffAgainstBaseline(current, baseline);
    expect(result.newFindings.map((f) => f.line)).toEqual([2]);
    expect(result.existingFindings.map((f) => f.line)).toEqual([1]);
  });

  it("identifies resolved findings that no longer appear", () => {
    const original = [finding({ line: 1 }), finding({ line: 2 })];
    const baseline = createBaseline(original);
    const current = [finding({ line: 1 })];
    const result = diffAgainstBaseline(current, baseline);
    expect(result.resolvedFindings.map((f) => f.line)).toEqual([2]);
  });
});
