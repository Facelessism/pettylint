import * as fs from "node:fs";
import type { Finding } from "./core.js";

export const BASELINE_VERSION = 1;

export interface BaselineFinding {
  fingerprint: string;
  ruleId: string;
  file: string;
  line: number;
  column: number;
}

export interface Baseline {
  version: number;
  generatedAt: string;
  findings: BaselineFinding[];
}

export class BaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaselineError";
  }
}

export function createBaseline(findings: Finding[]): Baseline {
  const entries: BaselineFinding[] = findings
    .filter((f): f is Finding & { fingerprint: string } => Boolean(f.fingerprint))
    .map((f) => ({
      fingerprint: f.fingerprint,
      ruleId: f.ruleId,
      file: f.file,
      line: f.line,
      column: f.column,
    }))
    .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  return { version: BASELINE_VERSION, generatedAt: new Date().toISOString(), findings: entries };
}

export function loadBaseline(filePath: string): Baseline | null {
  if (!fs.existsSync(filePath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new BaselineError(`Baseline file "${filePath}" is not valid JSON: ${(err as Error).message}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    !("findings" in parsed) ||
    !Array.isArray((parsed as Baseline).findings)
  ) {
    throw new BaselineError(`Baseline file "${filePath}" is missing required fields (version, findings).`);
  }
  const baseline = parsed as Baseline;
  if (baseline.version !== BASELINE_VERSION) {
    throw new BaselineError(
      `Baseline file "${filePath}" has version ${baseline.version}, but this version of PettyLint expects version ${BASELINE_VERSION}. Regenerate it with "pettylint baseline".`,
    );
  }
  return baseline;
}

export function writeBaseline(filePath: string, baseline: Baseline): void {
  fs.writeFileSync(filePath, JSON.stringify(baseline, null, 2) + "\n", "utf8");
}

export interface BaselineComparison {
  newFindings: Finding[];
  existingFindings: Finding[];
  resolvedFindings: BaselineFinding[];
}

/** Splits current findings into new vs. already-known-and-accepted, and reports resolved ones. */
export function diffAgainstBaseline(findings: Finding[], baseline: Baseline | null): BaselineComparison {
  if (!baseline) {
    return { newFindings: findings, existingFindings: [], resolvedFindings: [] };
  }
  const baselineFingerprints = new Set(baseline.findings.map((f) => f.fingerprint));
  const currentFingerprints = new Set(findings.map((f) => f.fingerprint).filter((f): f is string => Boolean(f)));

  const newFindings: Finding[] = [];
  const existingFindings: Finding[] = [];
  for (const finding of findings) {
    if (finding.fingerprint && baselineFingerprints.has(finding.fingerprint)) {
      existingFindings.push(finding);
    } else {
      newFindings.push(finding);
    }
  }
  const resolvedFindings = baseline.findings.filter((f) => !currentFingerprints.has(f.fingerprint));

  return { newFindings, existingFindings, resolvedFindings };
}
