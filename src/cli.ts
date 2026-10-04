#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { analyze, applyFixes, sortFindings, type Diagnostic, type Finding, type SourceInput } from "./core.js";
import { builtinRules } from "./rules.js";
import { SUPPORTED_EXTENSIONS } from "./languages/registry.js";
import { loadConfig, loadConfigFile, resolveRulesForFile, isIgnored, ConfigError, type PettyLintConfig } from "./config.js";
import { parseUnifiedDiff, filterFindingsByChangedRanges, findingIntersectsRanges, type ChangedRange } from "./diff.js";
import { createBaseline, loadBaseline, writeBaseline, diffAgainstBaseline, BaselineError } from "./baseline.js";
import { formatPretty, formatJson, formatSarif } from "./format.js";
import { runLspServer } from "./lsp.js";
import { PACKAGE_VERSION } from "./version.js";

const HELP_TEXT = `PettyLint

Usage:
  pettylint [path...]           Analyze a repository, directory, or files
  pettylint --changed           Analyze changed working-tree content
  pettylint --diff <base>       Analyze changes against a base revision
  pettylint baseline            Create/update the baseline file
  pettylint --fix               Apply safe autofixes
  pettylint --lsp               Start a minimal LSP server over stdio

Options:
  --config <path>      Path to a configuration file
  --format <f>         pretty | json | sarif (default: pretty)
  --severity <s>        Minimum severity to report: error | warning | notice
  --rule <rule-id>      Only run a single rule (repeatable)
  --changed              Analyze only changed working-tree lines
  --diff <base>          Analyze only lines changed since <base>
  --baseline             Force-enable baseline comparison
  --no-baseline          Disable baseline comparison
  --list-rules           List available rules and exit (respects --format json)
  --verbose              Print timing information
  --quiet                Suppress non-essential output
  --version              Print the version and exit
  --help                 Print this help and exit

Exit codes:
  0  No findings at or above the fail threshold
  1  Findings exist at or above the fail threshold
  2  Configuration, invocation, or fatal runtime error
`;

interface CliArgs {
  command: "analyze" | "baseline" | "help" | "version" | "list-rules" | "lsp";
  paths: string[];
  changed: boolean;
  diffBase: string | null;
  configPath: string | null;
  format: "pretty" | "json" | "sarif" | null;
  severity: "error" | "warning" | "notice" | null;
  rules: string[];
  fix: boolean;
  baselineFlag: "on" | "off" | null;
  verbose: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: "analyze",
    paths: [],
    changed: false,
    diffBase: null,
    configPath: null,
    format: null,
    severity: null,
    rules: [],
    fix: false,
    baselineFlag: null,
    verbose: false,
    quiet: false,
  };

  let i = 0;
  if (argv[0] === "baseline") {
    args.command = "baseline";
    i = 1;
  }

  for (; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--help":
      case "-h":
        args.command = "help";
        break;
      case "--version":
      case "-v":
        args.command = "version";
        break;
      case "--list-rules":
        args.command = "list-rules";
        break;
      case "--lsp":
        args.command = "lsp";
        break;
      case "--changed":
        args.changed = true;
        break;
      case "--diff":
        args.diffBase = argv[++i] ?? null;
        break;
      case "--config":
        args.configPath = argv[++i] ?? null;
        break;
      case "--format":
        args.format = (argv[++i] as CliArgs["format"]) ?? null;
        break;
      case "--severity":
        args.severity = (argv[++i] as CliArgs["severity"]) ?? null;
        break;
      case "--rule":
        args.rules.push(argv[++i] ?? "");
        break;
      case "--fix":
        args.fix = true;
        break;
      case "--baseline":
        args.baselineFlag = "on";
        break;
      case "--no-baseline":
        args.baselineFlag = "off";
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "--quiet":
        args.quiet = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new ConfigError(`Unknown option "${arg}". Run "pettylint --help" for usage.`);
        }
        args.paths.push(arg);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Path handling (section 55): all reported paths are repository-relative,
// POSIX-style, and cannot escape the repository root.
// ---------------------------------------------------------------------------

function toRepoRelativePosix(rootDir: string, absPath: string): string {
  const rel = path.relative(rootDir, absPath);
  if (rel.startsWith("..")) {
    throw new ConfigError(`Refusing to analyze "${absPath}": it is outside the repository root.`);
  }
  return rel.split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function walkDirectory(dir: string, rootDir: string, config: PettyLintConfig, out: string[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow symlinks during discovery
    const rel = toRepoRelativePosix(rootDir, abs);
    if (entry.isDirectory()) {
      if (isIgnored(config, rel + "/")) continue;
      walkDirectory(abs, rootDir, config, out);
    } else if (entry.isFile()) {
      if (!SUPPORTED_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue;
      if (isIgnored(config, rel)) continue;
      out.push(abs);
    }
  }
}

function discoverFiles(inputPaths: string[], rootDir: string, config: PettyLintConfig): string[] {
  if (inputPaths.length === 0) {
    const out: string[] = [];
    walkDirectory(rootDir, rootDir, config, out);
    return out;
  }
  const out: string[] = [];
  for (const p of inputPaths) {
    const abs = path.resolve(rootDir, p);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      walkDirectory(abs, rootDir, config, out);
    } else {
      out.push(abs);
    }
  }
  return out;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;

function readSourceInputs(absPaths: string[], rootDir: string): { inputs: SourceInput[]; skipped: string[] } {
  const inputs: SourceInput[] = [];
  const skipped: string[] = [];
  for (const abs of absPaths) {
    const stat = fs.statSync(abs);
    if (stat.size > MAX_FILE_BYTES) {
      skipped.push(toRepoRelativePosix(rootDir, abs));
      continue;
    }
    const buffer = fs.readFileSync(abs);
    if (buffer.includes(0)) {
      // Binary file (contains a NUL byte): never treat as source text.
      skipped.push(toRepoRelativePosix(rootDir, abs));
      continue;
    }
    inputs.push({ filePath: toRepoRelativePosix(rootDir, abs), text: buffer.toString("utf8") });
  }
  return { inputs, skipped };
}

// ---------------------------------------------------------------------------
// Git integration for --changed / --diff
//
// PettyLint shells out to the git binary, a trusted local development
// tool, purely to read diff text. This is distinct from executing
// repository-supplied code: no repository script, build step, or package
// manager command is ever invoked.
// ---------------------------------------------------------------------------

function getGitDiff(rootDir: string, base: string | null): string {
  try {
    let against = "HEAD";
    if (base) {
      // Compare the working tree against the merge-base, so both committed
      // and uncommitted edits on top of <base> count as "changed".
      against = execFileSync("git", ["merge-base", base, "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim();
    }
    return execFileSync("git", ["diff", "--unified=0", "--relative", against], {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 64,
    });
  } catch (err) {
    throw new ConfigError(
      `Unable to read git history (${(err as Error).message}). "--changed"/"--diff" require a git repository${base ? ` in which "${base}" exists` : ""}.`,
    );
  }
}

/** Changed ranges for --changed/--diff: tracked edits plus untracked files (entirely changed). */
function computeChangedRanges(rootDir: string, base: string | null): ChangedRange[] {
  const ranges = parseUnifiedDiff(getGitDiff(rootDir, base));
  for (const file of getUntrackedFiles(rootDir)) {
    ranges.push({ file, startLine: 1, endLine: Number.MAX_SAFE_INTEGER });
  }
  return ranges;
}

/** Untracked (new, not yet added) files count as entirely changed in --changed mode. */
function getUntrackedFiles(rootDir: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Rule config resolution across overrides, honoring --rule/--severity flags
// ---------------------------------------------------------------------------

function buildRuleConfig(
  config: PettyLintConfig,
  filePath: string,
  cliArgs: CliArgs,
): Record<string, "error" | "warning" | "notice" | "off"> {
  const resolved = resolveRulesForFile(config, filePath);
  if (cliArgs.rules.length > 0) {
    const only: Record<string, "error" | "warning" | "notice" | "off"> = {};
    for (const rule of builtinRules) {
      only[rule.name] =
        cliArgs.rules.includes(rule.id) || cliArgs.rules.includes(rule.name)
          ? (resolved[rule.name] ?? rule.severity)
          : "off";
    }
    return only;
  }
  return resolved;
}

function severityRank(s: "error" | "warning" | "notice"): number {
  return s === "error" ? 3 : s === "warning" ? 2 : 1;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function runCli(argv: string[], rootDir: string = process.cwd()): number {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }

  const knownRuleTokens = new Set(builtinRules.flatMap((r) => [r.id, r.name]));
  const unknownRule = args.rules.find((r) => !knownRuleTokens.has(r));
  if (unknownRule !== undefined) {
    console.error(
      `Unknown rule "${unknownRule}". Expected one of: ${builtinRules.map((r) => r.id).join(", ")}.`,
    );
    return 2;
  }
  if (args.format !== null && !["pretty", "json", "sarif"].includes(args.format)) {
    console.error(`Invalid --format "${args.format}". Expected one of: pretty, json, sarif.`);
    return 2;
  }
  if (args.severity !== null && !["error", "warning", "notice"].includes(args.severity)) {
    console.error(`Invalid --severity "${args.severity}". Expected one of: error, warning, notice.`);
    return 2;
  }
  if (args.command === "help") {
    console.log(HELP_TEXT);
    return 0;
  }
  if (args.command === "version") {
    console.log(PACKAGE_VERSION);
    return 0;
  }
  if (args.command === "list-rules") {
    printRuleList(args.format ?? "pretty");
    return 0;
  }
  if (args.command === "lsp") {
    runLspServer();
    return 0; // unreachable while the server is running; kept for type-checking
  }

  let config: PettyLintConfig;
  try {
    config = args.configPath
      ? loadConfigFile(path.resolve(rootDir, args.configPath))
      : loadConfig(rootDir);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }

  const format = args.format ?? config.format;

  try {
    if (args.command === "baseline") {
      return runBaselineCommand(rootDir, config, args);
    }
    if (args.fix) {
      return runFixCommand(rootDir, config, args);
    }
    return runAnalyzeCommand(rootDir, config, args, format);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof BaselineError) {
      console.error(err.message);
      return 2;
    }
    console.error(`Unexpected error: ${(err as Error).stack ?? (err as Error).message}`);
    return 2;
  }
}

function printRuleList(format: "pretty" | "json" | "sarif"): void {
  if (format === "json") {
    const rows = builtinRules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      category: rule.category,
      severity: rule.severity,
      confidence: rule.confidence,
      languages: rule.languages,
      documentation: rule.documentation ?? null,
      autofix: Boolean(rule.fix),
    }));
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log("ID     Name              Category         Severity  Confidence  Autofix");
  for (const rule of builtinRules) {
    console.log(
      `${rule.id.padEnd(6)} ${rule.name.padEnd(17)} ${rule.category.padEnd(16)} ${rule.severity.padEnd(9)} ${rule.confidence.padEnd(11)} ${rule.fix ? "yes" : "no"}`,
    );
  }
}

function runBaselineCommand(rootDir: string, config: PettyLintConfig, args: CliArgs): number {
  const absPaths = discoverFiles(args.paths, rootDir, config);
  const { inputs } = readSourceInputs(absPaths, rootDir);
  const ruleConfigByFile = new Map(inputs.map((i) => [i.filePath, buildRuleConfig(config, i.filePath, args)]));
  const findings: Finding[] = [];
  for (const input of inputs) {
    const result = analyze([input], { ruleConfig: ruleConfigByFile.get(input.filePath) ?? {} });
    findings.push(...result.findings);
  }
  const baselinePath = path.resolve(rootDir, config.baseline ?? ".pettylint-baseline.json");
  writeBaseline(baselinePath, createBaseline(sortFindings(findings)));
  console.log(`Baseline written to ${path.relative(rootDir, baselinePath)} (${findings.length} finding(s)).`);
  return 0;
}

function reportDiagnostics(diagnostics: Diagnostic[], quiet: boolean): void {
  if (quiet) return;
  for (const d of diagnostics) {
    console.error(`${d.kind === "parse" ? "warning" : "notice"}: ${d.file}: ${d.message}`);
  }
}

function runFixCommand(rootDir: string, config: PettyLintConfig, args: CliArgs): number {
  const changedOnly = args.changed || args.diffBase !== null || config.changedOnly;
  const ranges = changedOnly ? computeChangedRanges(rootDir, args.diffBase) : null;
  const absPaths = discoverFiles(args.paths, rootDir, config);
  const { inputs } = readSourceInputs(absPaths, rootDir);
  const absByRel = new Map(absPaths.map((abs) => [toRepoRelativePosix(rootDir, abs), abs]));

  const plan: Array<{ file: string; abs: string; text: string; fixes: ReturnType<typeof applyFixes>["fixes"] }> = [];
  for (const input of inputs) {
    const ruleConfig = buildRuleConfig(config, input.filePath, args);
    const result = applyFixes(input, {
      ruleConfig,
      ...(ranges ? { filter: (f: Finding) => findingIntersectsRanges(f, ranges) } : {}),
    });
    if (result.fixes.length > 0) {
      plan.push({ file: input.filePath, abs: absByRel.get(input.filePath)!, text: result.text, fixes: result.fixes });
    }
  }

  if (plan.length === 0) {
    console.log("No safe fixes to apply. No files were modified.");
    return 0;
  }

  const total = plan.reduce((n, p) => n + p.fixes.length, 0);
  console.log(`PettyLint will apply ${total} fix${total === 1 ? "" : "es"} in ${plan.length} file${plan.length === 1 ? "" : "s"}:`);
  for (const entry of plan) {
    for (const fix of entry.fixes) {
      console.log(`  ${entry.file}:${fix.finding.line} ${fix.finding.ruleId} ${fix.description}`);
    }
  }
  for (const entry of plan) {
    fs.writeFileSync(entry.abs, entry.text, "utf8");
  }
  console.log("Done. Review the changes with `git diff` before committing.");
  return 0;
}

function runAnalyzeCommand(
  rootDir: string,
  config: PettyLintConfig,
  args: CliArgs,
  format: "pretty" | "json" | "sarif",
): number {
  const totalStart = performance.now();
  const changedOnly = args.changed || args.diffBase !== null || config.changedOnly;

  const discoverStart = performance.now();
  const absPaths = discoverFiles(args.paths, rootDir, config);
  const { inputs, skipped } = readSourceInputs(absPaths, rootDir);
  const discoverMs = performance.now() - discoverStart;

  const findingsByFile: Finding[] = [];
  const diagnostics: Diagnostic[] = [];
  let parseMs = 0;
  let ruleMs = 0;
  for (const input of inputs) {
    const ruleConfig = buildRuleConfig(config, input.filePath, args);
    const result = analyze([input], { ruleConfig });
    findingsByFile.push(...result.findings);
    diagnostics.push(...result.diagnostics);
    parseMs += result.timings.parseMs;
    ruleMs += result.timings.ruleMs;
  }

  let findings = sortFindings(findingsByFile);

  const diffStart = performance.now();
  if (changedOnly) {
    findings = filterFindingsByChangedRanges(findings, computeChangedRanges(rootDir, args.diffBase));
  }
  const diffMs = performance.now() - diffStart;

  const useBaseline = args.baselineFlag !== "off" && (args.baselineFlag === "on" || config.baseline !== null);
  if (useBaseline) {
    const baselinePath = path.resolve(rootDir, config.baseline ?? ".pettylint-baseline.json");
    const baseline = loadBaseline(baselinePath);
    const comparison = diffAgainstBaseline(findings, baseline);
    findings = comparison.newFindings;
  }

  if (args.severity) {
    const minRank = severityRank(args.severity);
    findings = findings.filter((f) => severityRank(f.severity) >= minRank);
  }

  if (!args.quiet) {
    if (format === "json") {
      console.log(JSON.stringify(formatJson(findings), null, 2));
    } else if (format === "sarif") {
      console.log(JSON.stringify(formatSarif(findings), null, 2));
    } else {
      console.log(formatPretty(findings));
    }
  }

  // Parse/suppression diagnostics and timings go to stderr so that JSON and
  // SARIF on stdout stay machine-readable.
  reportDiagnostics(diagnostics, args.quiet);
  if (args.verbose) {
    const fmt = (ms: number) => `${Math.round(ms)}ms`;
    console.error(
      [
        "",
        "PettyLint timings",
        `${absPaths.length} files discovered, ${skipped.length} skipped (too large or binary), ${inputs.length} analyzed`,
        `Discovery + read: ${fmt(discoverMs)}`,
        `Parsing: ${fmt(parseMs)}`,
        `Rules: ${fmt(ruleMs)}`,
        `Diff filtering: ${fmt(diffMs)}`,
        `Total: ${fmt(performance.now() - totalStart)}`,
      ].join("\n"),
    );
  }

  const failOn = config.failOn;
  if (failOn === "never") return 0;
  const failRank = severityRank(failOn);
  const shouldFail = findings.some((f) => severityRank(f.severity) >= failRank);
  return shouldFail ? 1 : 0;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
const isMainModule = isEntryPoint();
if (isMainModule) {
  process.exit(runCli(process.argv.slice(2)));
}
