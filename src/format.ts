import type { Finding, Severity } from "./core.js";
import type { BaselineFinding } from "./baseline.js";

import { builtinRules } from "./rules.js";
import { PACKAGE_VERSION } from "./version.js";

const RULE_NAMES = new Map(builtinRules.map((r) => [r.id, r.name]));

function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, notice: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

function offenseVerdict(count: number): string {
  if (count === 0) return "Nothing to complain about.";
  if (count <= 2) return "Petty.";
  if (count <= 5) return "Getting petty.";
  return "This PR has attracted attention.";
}

// ---------------------------------------------------------------------------
// Pretty (human) terminal output
// ---------------------------------------------------------------------------

export function formatPretty(findings: Finding[]): string {
  const lines: string[] = ["PettyLint", ""];
  if (findings.length === 0) {
    lines.push("Nothing to complain about.");
    return lines.join("\n");
  }

  const noun = findings.length === 1 ? "offense" : "offenses";
  lines.push(`${findings.length} petty ${noun} found.`, "");

  for (const f of findings) {
    const loc = f.column ? `${f.file}:${f.line}:${f.column}` : `${f.file}:${f.line}`;
    lines.push(loc);
    lines.push(`${f.ruleId} ${ruleNameFromId(f)}`);
    lines.push(f.severity);
    lines.push(f.message);
    lines.push("");
  }

  const counts = countBySeverity(findings);
  const parts: string[] = [];
  if (counts.error) parts.push(`${counts.error} error${counts.error === 1 ? "" : "s"}`);
  if (counts.warning) parts.push(`${counts.warning} warning${counts.warning === 1 ? "" : "s"}`);
  if (counts.notice) parts.push(`${counts.notice} notice${counts.notice === 1 ? "" : "s"}`);
  lines.push(parts.join(" \u00b7 "));

  return lines.join("\n").trimEnd();
}

function ruleNameFromId(finding: Finding): string {
  // Custom rules aren't in the built-in table; fall back to their category.
  return RULE_NAMES.get(finding.ruleId) ?? finding.category;
}

export function formatCompact(findings: Finding[]): string {
  return findings
    .map((f) => `${f.file}:${f.line}:${f.column}: ${f.severity} ${f.ruleId} ${f.message}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

export interface JsonReport {
  findings: Finding[];
  summary: { total: number; errors: number; warnings: number; notices: number };
}

export function formatJson(findings: Finding[]): JsonReport {
  const counts = countBySeverity(findings);
  return {
    findings,
    summary: {
      total: findings.length,
      errors: counts.error,
      warnings: counts.warning,
      notices: counts.notice,
    },
  };
}

// ---------------------------------------------------------------------------
// SARIF 2.1.0
// ---------------------------------------------------------------------------

function sarifLevel(severity: Severity): "error" | "warning" | "note" {
  if (severity === "error") return "error";
  if (severity === "warning") return "warning";
  return "note";
}

export function formatSarif(findings: Finding[]): unknown {
  const ruleIds = [...new Set(findings.map((f) => f.ruleId))].sort();
  return {
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "PettyLint",
            version: PACKAGE_VERSION,
            rules: ruleIds.map((ruleId) => {
              const example = findings.find((f) => f.ruleId === ruleId)!;
              return {
                id: ruleId,
                name: RULE_NAMES.get(ruleId) ?? ruleId,
                shortDescription: { text: example.category },
                defaultConfiguration: { level: sarifLevel(example.severity) },
              };
            }),
          },
        },
        results: findings.map((f) => ({
          ruleId: f.ruleId,
          level: sarifLevel(f.severity),
          message: { text: f.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file },
                region: {
                  startLine: f.line,
                  startColumn: f.column,
                  ...(f.endLine ? { endLine: f.endLine } : {}),
                  ...(f.endColumn ? { endColumn: f.endColumn } : {}),
                },
              },
            },
          ],
        })),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// GitHub workflow-command annotations
// ---------------------------------------------------------------------------

function annotationLevel(severity: Severity): "error" | "warning" | "notice" {
  return severity;
}

function escapeAnnotationText(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function formatGithubAnnotations(findings: Finding[]): string[] {
  return findings.map((f) => {
    const level = annotationLevel(f.severity);
    const params = [`file=${f.file}`, `line=${f.line}`, `col=${f.column}`];
    if (f.endLine) params.push(`endLine=${f.endLine}`);
    if (f.endColumn) params.push(`endColumn=${f.endColumn}`);
    params.push(`title=${f.ruleId}`);
    return `::${level} ${params.join(",")}::${escapeAnnotationText(f.message)}`;
  });
}

// ---------------------------------------------------------------------------
// PR summary (one comment per PR, never one per finding)
// ---------------------------------------------------------------------------

export interface PrSummaryInput {
  newFindings: Finding[];
  resolvedFindings?: BaselineFinding[];
  maxHighlights?: number;
}

const SUMMARY_MARKER = "<!-- pettylint-summary -->";

export function formatPrSummary(input: PrSummaryInput): string {
  const { newFindings, resolvedFindings = [], maxHighlights = 10 } = input;
  const counts = countBySeverity(newFindings);
  const lines: string[] = [SUMMARY_MARKER, "## PettyLint", ""];

  if (newFindings.length === 0) {
    lines.push("Nothing to complain about.");
  } else {
    lines.push(
      `PettyLint found ${newFindings.length} thing${newFindings.length === 1 ? "" : "s"} worth being petty about.`,
      "",
      `_${offenseVerdict(newFindings.length)}_`,
      "",
    );

    const byRule = new Map<string, number>();
    for (const f of newFindings) byRule.set(f.ruleId, (byRule.get(f.ruleId) ?? 0) + 1);

    lines.push("| Rule | Findings |", "|---|---:|");
    for (const [ruleId, count] of [...byRule.entries()].sort()) {
      lines.push(`| ${ruleId} | ${count} |`);
    }
    lines.push("");

    lines.push("### Highlights", "");
    for (const f of newFindings.slice(0, maxHighlights)) {
      lines.push(`\`${f.file}:${f.line}\``, "", `> ${f.message}`, "");
    }
    if (newFindings.length > maxHighlights) {
      lines.push(`_...and ${newFindings.length - maxHighlights} more._`, "");
    }
  }

  if (resolvedFindings.length > 0) {
    lines.push(`### Resolved`, "", `${resolvedFindings.length} previously reported finding(s) no longer appear.`, "");
  }

  lines.push(
    `${counts.error} error${counts.error === 1 ? "" : "s"} \u00b7 ${counts.warning} warning${counts.warning === 1 ? "" : "s"} \u00b7 ${counts.notice} notice${counts.notice === 1 ? "" : "s"}`,
    "",
    "PettyLint does not replace your existing linter. It simply has opinions about a few things.",
  );

  return lines.join("\n");
}

export function isPettyLintSummaryComment(body: string): boolean {
  return body.startsWith(SUMMARY_MARKER);
}
