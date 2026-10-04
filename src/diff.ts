import type { Finding } from "./core.js";

export interface ChangedRange {
  file: string;
  startLine: number; // inclusive, 1-based
  endLine: number; // inclusive, 1-based
}

/**
 * Parses unified diff text (as produced by `git diff`) into per-file
 * changed line ranges covering added/modified lines. Deleted-only hunks
 * contribute no ranges, since there is no surviving line to report against.
 *
 * This function does not invoke git itself and has no knowledge of
 * GitHub; callers (cli.ts, github.ts) are responsible for obtaining the
 * diff text.
 */
export function parseUnifiedDiff(diffText: string): ChangedRange[] {
  const ranges: ChangedRange[] = [];
  let currentFile: string | null = null;
  let newLine = 0;
  const addedLines: number[] = [];

  const flush = () => {
    if (currentFile && addedLines.length > 0) {
      ranges.push(...compressToRanges(currentFile, addedLines));
    }
    addedLines.length = 0;
  };

  const lines = diffText.split(/\r\n|\r|\n/);
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      currentFile = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      flush();
      const match = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
      currentFile = match && match[1] !== "/dev/null" ? match[1]! : null;
      continue;
    }
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      continue;
    }
    if (!currentFile) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      addedLines.push(newLine);
      newLine++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // deletion: does not advance the new-file line counter
    } else if (line.startsWith(" ")) {
      newLine++;
    }
  }
  flush();
  return ranges;
}

function compressToRanges(file: string, lines: number[]): ChangedRange[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: ChangedRange[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const line = sorted[i]!;
    if (line === prev! + 1) {
      prev = line;
      continue;
    }
    ranges.push({ file, startLine: start!, endLine: prev! });
    start = line;
    prev = line;
  }
  if (start !== undefined) ranges.push({ file, startLine: start, endLine: prev! });
  return ranges;
}

/** A finding intersects a changed range if any of its reported lines overlap an added line. */
export function findingIntersectsRanges(finding: Finding, ranges: ChangedRange[]): boolean {
  const findingStart = finding.line;
  const findingEnd = finding.endLine ?? finding.line;
  return ranges.some(
    (range) => range.file === finding.file && findingStart <= range.endLine && findingEnd >= range.startLine,
  );
}

/**
 * Filters findings to only those intersecting changed ranges. Findings for
 * files with no changed ranges at all are dropped, since changed-only mode
 * only reports on lines that were actually touched.
 */
export function filterFindingsByChangedRanges(findings: Finding[], ranges: ChangedRange[]): Finding[] {
  return findings.filter((finding) => findingIntersectsRanges(finding, ranges));
}
