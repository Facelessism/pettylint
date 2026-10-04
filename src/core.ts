import * as crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import ts from "typescript";
import { detectLanguage } from "./languages/registry.js";
import type { LanguageId, ParsedSource } from "./languages/types.js";
import { collectComments, toLineColumn, type CommentInfo } from "./languages/comments.js";
import { builtinRules } from "./rules.js";

// ---------------------------------------------------------------------------
// Core data model (section 10 of the spec). This is PettyLint's public API
// surface: rule IDs, the Finding shape, and configuration names are all
// treated as stable, documented contracts (section 77).
// ---------------------------------------------------------------------------

export type Severity = "error" | "warning" | "notice";
export type Confidence = "high" | "medium" | "low";

export interface Finding {
  ruleId: string;
  message: string;
  explanation?: string;
  severity: Severity;
  confidence: Confidence;
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  category: string;
  fingerprint?: string;
  documentation?: string | undefined;
}

export interface RuleConfigResolved {
  severity: Severity;
  options?: Record<string, unknown>;
}

export interface RuleContext {
  readonly source: ParsedSource;
  readonly filePath: string;
  readonly language: LanguageId;
  readonly config: RuleConfigResolved;
  /** Converts a 0-based character offset in the source text to a 1-based line/column. */
  lineAndColumnAt(pos: number): { line: number; column: number };
}

/** A single replacement of source text [start, end) with `text` (offsets into the original source). */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

export interface RuleFix {
  description: string;
  /**
   * Returns the edits that fix `finding`, or null when this particular
   * instance cannot be fixed with a guaranteed behavior-preserving change.
   * Must be deterministic and must never execute code or touch the network.
   */
  edits(context: RuleContext, finding: Finding): TextEdit[] | null;
}

export interface Rule {
  id: string;
  name: string;
  description: string;
  category: string;
  severity: Severity;
  confidence: Confidence;
  languages: LanguageId[];
  documentation?: string;
  check(context: RuleContext): Finding[];
  fix?: RuleFix;
}

export interface SourceInput {
  /** Repository-relative, POSIX-style path (e.g. "src/server.ts"). */
  filePath: string;
  text: string;
}

export type RuleSeverityConfig = Severity | "off";

export interface AnalyzeOptions {
  /** Additional rules to register alongside the built-ins (see section 32). */
  customRules?: Rule[];
  /** Map from rule name OR rule id to a severity, or "off" to disable. */
  ruleConfig?: Record<string, RuleSeverityConfig>;
}

export interface AnalysisResult {
  findings: Finding[];
  filesAnalyzed: string[];
  filesSkipped: { file: string; reason: string }[];
  /** Non-fatal notices, e.g. suppression comments naming unknown rules. */
  diagnostics: Diagnostic[];
  /** Wall-clock milliseconds spent parsing and running rules (0 for cache hits). */
  timings: { parseMs: number; ruleMs: number };
}

export type { CommentInfo } from "./languages/comments.js";

// ---------------------------------------------------------------------------
// Inline suppression (section 17)
//
//   // pettylint-disable-next-line <rule> [<rule> ...]
//   // pettylint-disable <rule> [<rule> ...]
//   // pettylint-enable <rule> [<rule> ...]
//
// Rule tokens may be either the stable ID (PL001) or the rule name
// (console-log). There is no wildcard form: a directive with no rule
// tokens is a configuration diagnostic, not a suppression.
// ---------------------------------------------------------------------------

const NEXT_LINE_RE = /^\s*pettylint-disable-next-line\b(.*)$/;
const DISABLE_RE = /^\s*pettylint-disable\b(?!-next-line)(.*)$/;
const ENABLE_RE = /^\s*pettylint-enable\b(.*)$/;

export interface Diagnostic {
  file: string;
  message: string;
  kind: "suppression" | "parse";
  line?: number;
}
export type SuppressionDiagnostic = Diagnostic;

interface ParsedDirective {
  type: "next-line" | "disable" | "enable";
  line: number;
  tokens: string[];
}

function stripCommentMarkers(raw: string): string {
  if (raw.startsWith("//")) return raw.slice(2);
  if (raw.startsWith("/*")) return raw.slice(2, raw.endsWith("*/") ? -2 : undefined);
  return raw;
}

function parseDirectives(
  comments: CommentInfo[],
  knownRuleTokens: Set<string>,
  file: string,
  diagnostics: SuppressionDiagnostic[],
): ParsedDirective[] {
  const directives: ParsedDirective[] = [];
  for (const comment of comments) {
    const body = stripCommentMarkers(comment.text).trim();
    const nextLine = NEXT_LINE_RE.exec(body);
    const disable = !nextLine ? DISABLE_RE.exec(body) : null;
    const enable = !nextLine && !disable ? ENABLE_RE.exec(body) : null;
    const match = nextLine ?? disable ?? enable;
    if (!match) continue;

    const type = nextLine ? "next-line" : disable ? "disable" : "enable";
    const tokens = match[1]!.trim().split(/[\s,]+/).filter(Boolean);
    if (tokens.length === 0) {
      diagnostics.push({
        file,
        kind: "suppression",
        message: `pettylint-${type} on line ${comment.line} does not name a rule; global suppression is not supported. Specify one or more rule IDs or names.`,
      });
      continue;
    }
    for (const token of tokens) {
      if (!knownRuleTokens.has(token)) {
        diagnostics.push({
          file,
          kind: "suppression",
          message: `pettylint-${type} on line ${comment.line} references unknown rule "${token}".`,
        });
      }
    }
    directives.push({ type, line: comment.line, tokens });
  }
  return directives;
}

/** Computes, per rule token, the set of half-open [start, end) line ranges it suppresses. */
function buildSuppressionRanges(directives: ParsedDirective[]): Map<string, Array<[number, number]>> {
  const ranges = new Map<string, Array<[number, number]>>();
  const openDisables = new Map<string, number>(); // rule token -> line the disable started

  const sorted = [...directives].sort((a, b) => a.line - b.line);
  for (const directive of sorted) {
    if (directive.type === "next-line") {
      for (const token of directive.tokens) {
        const list = ranges.get(token) ?? [];
        list.push([directive.line + 1, directive.line + 2]);
        ranges.set(token, list);
      }
    } else if (directive.type === "disable") {
      for (const token of directive.tokens) {
        if (!openDisables.has(token)) openDisables.set(token, directive.line);
      }
    } else {
      for (const token of directive.tokens) {
        const start = openDisables.get(token);
        if (start !== undefined) {
          const list = ranges.get(token) ?? [];
          list.push([start, directive.line]);
          ranges.set(token, list);
          openDisables.delete(token);
        }
      }
    }
  }
  for (const [token, start] of openDisables) {
    const list = ranges.get(token) ?? [];
    list.push([start, Number.POSITIVE_INFINITY]);
    ranges.set(token, list);
  }
  return ranges;
}

function isLineSuppressed(ranges: Array<[number, number]> | undefined, line: number): boolean {
  if (!ranges) return false;
  return ranges.some(([start, end]) => line >= start && line < end);
}

// ---------------------------------------------------------------------------
// Fingerprinting (sections 20-21): stable, based only on rule + relative
// path + the finding's syntactic location. Never includes timestamps or
// absolute paths.
// ---------------------------------------------------------------------------

/**
 * Fingerprints identify a finding by rule + relative path + the normalized
 * text of the line it sits on + its occurrence index among identical
 * (rule, line-text) pairs in the file. Line numbers are deliberately NOT
 * included, so inserting or deleting unrelated lines above a finding does
 * not change its fingerprint (baselines stay stable). Editing the flagged
 * line itself does change it, which is the intended trade-off.
 */
export function fingerprint(
  finding: Pick<Finding, "ruleId" | "file">,
  lineContext: string,
  occurrence = 0,
): string {
  const normalized = lineContext.trim().replace(/\s+/g, " ");
  const hash = crypto.createHash("sha256");
  for (const part of [finding.ruleId, finding.file, normalized, String(occurrence)]) {
    hash.update(part);
    hash.update("\u0000");
  }
  return hash.digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Deterministic ordering (section 54)
// ---------------------------------------------------------------------------

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    if (a.column !== b.column) return a.column - b.column;
    return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Rule registration & validation (section 64)
// ---------------------------------------------------------------------------

function validateRules(rules: Rule[]): void {
  const seenIds = new Map<string, Rule>();
  for (const rule of rules) {
    if (!rule.id) throw new Error("Rule is missing a stable id.");
    const existing = seenIds.get(rule.id);
    if (existing && existing !== rule) {
      throw new Error(
        `Duplicate rule id "${rule.id}": built-in rules cannot be replaced by a custom rule with the same id.`,
      );
    }
    seenIds.set(rule.id, rule);
    if (!["error", "warning", "notice"].includes(rule.severity)) {
      throw new Error(`Rule "${rule.id}" has an invalid default severity "${rule.severity}".`);
    }
    if (!["high", "medium", "low"].includes(rule.confidence)) {
      throw new Error(`Rule "${rule.id}" has an invalid confidence "${rule.confidence}".`);
    }
    if (!rule.languages || rule.languages.length === 0) {
      throw new Error(`Rule "${rule.id}" does not declare any supported languages.`);
    }
  }
}

function resolveRuleConfig(rule: Rule, options: AnalyzeOptions): RuleConfigResolved | "off" {
  const raw = options.ruleConfig?.[rule.name] ?? options.ruleConfig?.[rule.id];
  if (raw === "off") return "off";
  const severity = raw ?? rule.severity;
  return { severity };
}

// ---------------------------------------------------------------------------
// Per-file analysis with a deterministic in-memory cache (section 36).
// The key covers everything that can change the result: file path, file
// content, parser version, and the rule configuration. Caching is skipped
// entirely when custom rules are supplied (their code is not hashable).
// ---------------------------------------------------------------------------

interface FileResult {
  analyzed: boolean;
  findings: Finding[];
  diagnostics: Diagnostic[];
  skipped: { file: string; reason: string }[];
  parseMs: number;
  ruleMs: number;
}

const CACHE_LIMIT = 1000;
const fileCache = new Map<string, FileResult>();

export function clearAnalysisCache(): void {
  fileCache.clear();
}

function cacheKey(input: SourceInput, options: AnalyzeOptions): string {
  const config = options.ruleConfig ?? {};
  const stableConfig = Object.keys(config)
    .sort()
    .map((k) => `${k}=${config[k]}`)
    .join(",");
  return crypto
    .createHash("sha256")
    .update([ts.version, input.filePath, stableConfig, input.text].join("\u0000"))
    .digest("hex");
}

function cloneResult(r: FileResult): FileResult {
  return {
    ...r,
    findings: r.findings.map((f) => ({ ...f })),
    diagnostics: r.diagnostics.map((d) => ({ ...d })),
    skipped: r.skipped.map((x) => ({ ...x })),
    parseMs: 0,
    ruleMs: 0,
  };
}

function analyzeFile(input: SourceInput, allRules: Rule[], ruleTokens: Set<string>, options: AnalyzeOptions): FileResult {
  const empty: FileResult = { analyzed: false, findings: [], diagnostics: [], skipped: [], parseMs: 0, ruleMs: 0 };
  const language = detectLanguage(input.filePath);
  if (!language) {
    return { ...empty, skipped: [{ file: input.filePath, reason: "unsupported file extension" }] };
  }

  const parseStart = performance.now();
  let parsed: ParsedSource;
  try {
    parsed = language.parse(input.text, input.filePath);
  } catch (err) {
    return { ...empty, skipped: [{ file: input.filePath, reason: `parse error: ${(err as Error).message}` }] };
  }
  const parseMs = performance.now() - parseStart;

  const result: FileResult = { ...empty, analyzed: true, parseMs };

  // Syntax errors: the TypeScript parser recovers and still yields a usable
  // tree, so we report them as diagnostics and keep analyzing.
  const syntaxErrors =
    (parsed.sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  for (const d of syntaxErrors) {
    const line = d.start !== undefined ? toLineColumn(parsed.sourceFile, d.start).line : undefined;
    result.diagnostics.push({
      file: input.filePath,
      kind: "parse",
      message: `Syntax error${line !== undefined ? ` on line ${line}` : ""}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
      ...(line !== undefined ? { line } : {}),
    });
  }

  const comments = collectComments(parsed.text, parsed.sourceFile);
  const directives = parseDirectives(comments, ruleTokens, input.filePath, result.diagnostics);
  const suppressionRanges = buildSuppressionRanges(directives);

  const ruleStart = performance.now();
  const raw: Array<{ finding: Finding; suppressed: boolean }> = [];
  for (const rule of allRules.filter((r) => r.languages.includes(language.id))) {
    const resolved = resolveRuleConfig(rule, options);
    if (resolved === "off") continue;
    const context = makeContext(parsed, input.filePath, language.id, resolved);
    let ruleFindings: Finding[];
    try {
      ruleFindings = rule.check(context);
    } catch (err) {
      result.skipped.push({
        file: input.filePath,
        reason: `rule "${rule.id}" threw during analysis: ${(err as Error).message}`,
      });
      continue;
    }
    for (const r of ruleFindings) {
      const finding: Finding = {
        ...r,
        ruleId: rule.id,
        severity: resolved.severity,
        confidence: r.confidence ?? rule.confidence,
        category: r.category ?? rule.category,
        documentation: r.documentation ?? rule.documentation,
      };
      const suppressed =
        isLineSuppressed(suppressionRanges.get(rule.id), finding.line) ||
        isLineSuppressed(suppressionRanges.get(rule.name), finding.line);
      raw.push({ finding, suppressed });
    }
  }

  // Fingerprints are assigned over ALL findings (suppressed or not) in
  // source order, so adding/removing a suppression comment never shifts
  // the occurrence index of its neighbours.
  const lines = parsed.text.split(/\r\n|\r|\n/);
  const ordered = sortFindings(raw.map((r) => r.finding));
  const suppressedSet = new Set(raw.filter((r) => r.suppressed).map((r) => r.finding));
  const seen = new Map<string, number>();
  for (const finding of ordered) {
    const lineText = lines[finding.line - 1] ?? "";
    const key = `${finding.ruleId}\u0000${lineText.trim().replace(/\s+/g, " ")}`;
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    finding.fingerprint = fingerprint(finding, lineText, occurrence);
    if (!suppressedSet.has(finding)) result.findings.push(finding);
  }
  result.ruleMs = performance.now() - ruleStart;
  return result;
}

function makeContext(
  parsed: ParsedSource,
  filePath: string,
  language: LanguageId,
  config: RuleConfigResolved,
): RuleContext {
  return {
    source: parsed,
    filePath,
    language,
    config,
    lineAndColumnAt: (pos: number) => toLineColumn(parsed.sourceFile, pos),
  };
}

function prepareRules(options: AnalyzeOptions): { allRules: Rule[]; ruleTokens: Set<string> } {
  const allRules = [...builtinRules, ...(options.customRules ?? [])];
  validateRules(allRules);
  for (const rule of options.customRules ?? []) {
    if (!rule.id.includes("/")) {
      throw new Error(
        `Custom rule id "${rule.id}" must be namespaced (for example "your-org/rule-name"); unnamespaced ids are reserved for built-in rules.`,
      );
    }
  }
  const ruleTokens = new Set<string>();
  for (const rule of allRules) {
    ruleTokens.add(rule.id);
    ruleTokens.add(rule.name);
  }
  return { allRules, ruleTokens };
}

// ---------------------------------------------------------------------------
// analyze(): the engine's single entry point. It never touches GitHub,
// never touches the filesystem, and never executes target source.
// ---------------------------------------------------------------------------

export function analyze(inputs: SourceInput[], options: AnalyzeOptions = {}): AnalysisResult {
  const { allRules, ruleTokens } = prepareRules(options);
  const useCache = !options.customRules || options.customRules.length === 0;

  const findings: Finding[] = [];
  const filesAnalyzed: string[] = [];
  const filesSkipped: { file: string; reason: string }[] = [];
  const diagnostics: Diagnostic[] = [];
  const timings = { parseMs: 0, ruleMs: 0 };

  for (const input of inputs) {
    let result: FileResult;
    const key = useCache ? cacheKey(input, options) : "";
    const cached = useCache ? fileCache.get(key) : undefined;
    if (cached) {
      result = cloneResult(cached);
    } else {
      result = analyzeFile(input, allRules, ruleTokens, options);
      if (useCache) {
        if (fileCache.size >= CACHE_LIMIT) {
          const oldest = fileCache.keys().next().value;
          if (oldest !== undefined) fileCache.delete(oldest);
        }
        fileCache.set(key, cloneResult({ ...result, parseMs: result.parseMs, ruleMs: result.ruleMs }));
      }
    }
    if (result.analyzed) filesAnalyzed.push(input.filePath);
    filesSkipped.push(...result.skipped);
    diagnostics.push(...result.diagnostics);
    findings.push(...result.findings);
    timings.parseMs += result.parseMs;
    timings.ruleMs += result.ruleMs;
  }

  return { findings: sortFindings(findings), filesAnalyzed, filesSkipped, diagnostics, timings };
}

// ---------------------------------------------------------------------------
// Autofix (section 22). Only rules that expose fix.edits() participate.
// All edits are computed against the ORIGINAL text and applied from the
// end of the file backwards, so earlier offsets never shift; overlapping
// edits are dropped rather than guessed at.
// ---------------------------------------------------------------------------

export interface PlannedFix {
  finding: Finding;
  description: string;
}

export interface FixResult {
  text: string;
  fixes: PlannedFix[];
}

export function applyFixes(
  input: SourceInput,
  options: AnalyzeOptions & { filter?: (finding: Finding) => boolean } = {},
): FixResult {
  const { allRules } = prepareRules(options);
  const language = detectLanguage(input.filePath);
  if (!language) return { text: input.text, fixes: [] };

  const { findings } = analyze([input], options);
  const parsed = language.parse(input.text, input.filePath);
  const ruleById = new Map(allRules.map((r) => [r.id, r]));

  const planned: Array<{ edit: TextEdit; fix: PlannedFix }> = [];
  for (const finding of findings) {
    if (options.filter && !options.filter(finding)) continue;
    const rule = ruleById.get(finding.ruleId);
    if (!rule?.fix) continue;
    const context = makeContext(parsed, input.filePath, language.id, { severity: finding.severity });
    const edits = rule.fix.edits(context, finding);
    if (!edits || edits.length !== 1) continue; // v1: single-edit fixes only
    planned.push({ edit: edits[0]!, fix: { finding, description: rule.fix.description } });
  }

  planned.sort((a, b) => b.edit.start - a.edit.start);
  let text = input.text;
  const applied: PlannedFix[] = [];
  let lowestStart = Number.POSITIVE_INFINITY;
  for (const { edit, fix } of planned) {
    if (edit.end > lowestStart) continue; // overlaps a later edit; skip
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    lowestStart = edit.start;
    applied.push(fix);
  }
  applied.reverse();
  return { text, fixes: applied };
}

export { builtinRules } from "./rules.js";
