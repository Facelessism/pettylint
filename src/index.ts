import * as fs from "node:fs";
import * as path from "node:path";
import * as core from "@actions/core";
import { analyze, sortFindings, type Finding, type SourceInput } from "./core.js";
import { detectLanguage } from "./languages/registry.js";
import {
  loadConfig,
  loadConfigFile,
  parseYaml,
  validateConfig,
  resolveRulesForFile,
  isIgnored,
  ConfigError,
  DEFAULT_CONFIG,
  type PettyLintConfig,
} from "./config.js";
import { filterFindingsByChangedRanges } from "./diff.js";
import { loadBaseline, diffAgainstBaseline, createBaseline, writeBaseline, BaselineError } from "./baseline.js";
import { formatJson, formatSarif, formatPretty } from "./format.js";
import {
  getPullRequestInfo,
  createOctokit,
  getChangedRanges,
  emitAnnotations,
  upsertSummaryComment,
  GithubContextError,
} from "./github.js";

async function run(): Promise<void> {
  const workspace = process.env["GITHUB_WORKSPACE"] ?? process.cwd();

  try {
    const config = resolveConfig(workspace);
    const changedOnlyInput = core.getInput("changed-only");
    const changedOnly = changedOnlyInput ? changedOnlyInput === "true" : config.changedOnly;
    const shouldComment = core.getInput("comment") ? core.getInput("comment") === "true" : true;
    const format = (core.getInput("format") || config.format) as "pretty" | "json" | "sarif";

    const token = core.getInput("github-token") || process.env["GITHUB_TOKEN"] || "";
    if (!token) {
      throw new GithubContextError('No GitHub token available. Set "github-token" input or GITHUB_TOKEN.');
    }

    const info = getPullRequestInfo();
    const octokit = createOctokit(token);
    const { changedFiles, ranges } = await getChangedRanges(octokit, info);

    const analyzableFiles = changedFiles.filter((f) => detectLanguage(f) && !isIgnored(config, f));

    const inputs: SourceInput[] = [];
    for (const file of analyzableFiles) {
      const abs = path.join(workspace, file);
      if (!fs.existsSync(abs)) continue; // e.g. renamed/deleted between events
      const stat = fs.statSync(abs);
      if (stat.size > 5 * 1024 * 1024) continue;
      const buffer = fs.readFileSync(abs);
      if (buffer.includes(0)) continue; // binary
      inputs.push({ filePath: file, text: buffer.toString("utf8") });
    }

    let findings: Finding[] = [];
    for (const input of inputs) {
      const ruleConfig = resolveRulesForFile(config, input.filePath);
      const result = analyze([input], { ruleConfig });
      findings.push(...result.findings);
    }
    findings = sortFindings(findings);

    if (changedOnly) {
      findings = filterFindingsByChangedRanges(findings, ranges);
    }

    let resolvedFindings: ReturnType<typeof diffAgainstBaseline>["resolvedFindings"] = [];
    const baselinePath = config.baseline ? path.resolve(workspace, config.baseline) : null;
    if (baselinePath) {
      const baseline = loadBaseline(baselinePath);
      const comparison = diffAgainstBaseline(findings, baseline);
      findings = comparison.newFindings;
      resolvedFindings = comparison.resolvedFindings;
    }

    emitAnnotations(findings);
    if (shouldComment) {
      await upsertSummaryComment(octokit, info, findings, resolvedFindings);
    }

    if (format === "json") core.info(JSON.stringify(formatJson(findings), null, 2));
    else if (format === "sarif") core.info(JSON.stringify(formatSarif(findings), null, 2));
    else core.info(formatPretty(findings));

    const errors = findings.filter((f) => f.severity === "error").length;
    const warnings = findings.filter((f) => f.severity === "warning").length;
    const notices = findings.filter((f) => f.severity === "notice").length;

    core.setOutput("findings", JSON.stringify(findings));
    core.setOutput("errors", String(errors));
    core.setOutput("warnings", String(warnings));
    core.setOutput("notices", String(notices));

    const failOn = (core.getInput("fail-on") || config.failOn) as PettyLintConfig["failOn"];
    const failed =
      failOn !== "never" &&
      findings.some((f) => {
        if (failOn === "notice") return true;
        if (failOn === "warning") return f.severity === "warning" || f.severity === "error";
        return f.severity === "error";
      });

    core.setOutput("failed", String(failed));
    if (failed) {
      core.setFailed(`PettyLint found ${findings.length} finding(s) at or above the "${failOn}" threshold.`);
    }
  } catch (err) {
    if (err instanceof ConfigError || err instanceof BaselineError || err instanceof GithubContextError) {
      core.setFailed(err.message);
      return;
    }
    core.setFailed(`Unexpected error: ${(err as Error).stack ?? (err as Error).message}`);
  }
}

// The Action's own sensible defaults differ from the bare library/CLI
// defaults in one place: changed-only. A PR check that silently analyzed
// the whole repository the first time it was installed would violate
// PettyLint's own "never dump every historical finding on you" rule, so
// the Action defaults changed-only to true when neither an explicit input
// nor the repository's config file says otherwise.
const ACTION_DEFAULT_CONFIG: PettyLintConfig = { ...DEFAULT_CONFIG, changedOnly: true };

function resolveConfig(workspace: string): PettyLintConfig {
  const configInput = core.getInput("config").trim();
  const fileConfig = configInput
    ? loadConfigFile(path.resolve(workspace, configInput), ACTION_DEFAULT_CONFIG)
    : loadConfig(workspace, ACTION_DEFAULT_CONFIG);

  const rulesInput = core.getInput("rules");
  const ignoreInput = core.getInput("ignore");

  let rules = fileConfig.rules;
  if (rulesInput.trim()) {
    const parsed = validateConfig(parseYaml(`rules:\n${indent(rulesInput)}`));
    if (parsed.rules) rules = { ...rules, ...parsed.rules };
  }

  let ignore = fileConfig.ignore;
  if (ignoreInput.trim()) {
    ignore = [...ignore, ...ignoreInput.split("\n").map((l) => l.trim()).filter(Boolean)];
  }

  return { ...fileConfig, rules, ignore };
}

function indent(text: string): string {
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => `  ${l.trim()}`)
    .join("\n");
}

void run();
