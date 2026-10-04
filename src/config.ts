import * as fs from "node:fs";
import * as path from "node:path";
import { load as loadYaml } from "js-yaml";
import type { RuleSeverityConfig } from "./core.js";
import { builtinRules } from "./rules.js";

export type OutputFormat = "pretty" | "json" | "sarif";
export type FailOn = "error" | "warning" | "notice" | "never";

export interface OverrideConfig {
  files: string[];
  rules: Record<string, RuleSeverityConfig>;
}

export interface PettyLintConfig {
  rules: Record<string, RuleSeverityConfig>;
  ignore: string[];
  overrides: OverrideConfig[];
  failOn: FailOn;
  baseline: string | null;
  format: OutputFormat;
  changedOnly: boolean;
}

export const DEFAULT_CONFIG: PettyLintConfig = {
  rules: {},
  ignore: [],
  overrides: [],
  failOn: "error",
  baseline: null,
  format: "pretty",
  changedOnly: false,
};

export const DEFAULT_IGNORE = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/coverage/**"];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const CONFIG_FILENAMES = [".pettylintrc.yml", "pettylint.yml"];

const KNOWN_TOP_LEVEL_KEYS = new Set([
  "rules",
  "ignore",
  "overrides",
  "fail-on",
  "baseline",
  "format",
  "changed-only",
]);

const KNOWN_RULE_TOKENS = new Set<string>();
for (const rule of builtinRules) {
  KNOWN_RULE_TOKENS.add(rule.id);
  KNOWN_RULE_TOKENS.add(rule.name);
}

const KNOWN_SEVERITIES = new Set(["error", "warning", "notice", "off"]);
const KNOWN_FORMATS = new Set(["pretty", "json", "sarif"]);
const KNOWN_FAIL_ON = new Set(["error", "warning", "notice", "never"]);

// ---------------------------------------------------------------------------
// YAML parsing
//
// Delegates to js-yaml (its default schema permits no arbitrary tag
// execution and no custom types — js-yaml never executes anything from
// the document, it only produces data). PettyLint's own job here is
// limited to validating the resulting plain JS value against its small,
// documented configuration schema (below).
//
// Targets js-yaml v5+ specifically: v5 is an ESM-only rewrite with no
// default export (hence the named `load` import above) and no backward
// compatibility with 4.x's CommonJS shape. It also changed load("") to
// throw rather than return undefined, which we special-case below so an
// empty config file still means "use every default" rather than an error.
// v4.x and earlier carry multiple fixed-but-real CVEs (prototype
// pollution via `__proto__`, and several quadratic-complexity denial of
// service issues in merge-key/`!!omap` handling) and should not be used.
// ---------------------------------------------------------------------------

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

/**
 * Hard cap on config file size before we even attempt to parse it. This is
 * a defense-in-depth measure, not a complete one: in the GitHub Action, the
 * config file is read from the repository under analysis, which in a PR
 * context is untrusted input. A small YAML document can still expand to a
 * very large in-memory structure via anchors/aliases (a "billion laughs"
 * style payload) entirely inside js-yaml's own parsing step, before this
 * cap or anything else in this file gets a chance to run — see SECURITY.md
 * for the full picture and why this alone is not a complete mitigation.
 */
const MAX_CONFIG_FILE_BYTES = 256 * 1024;

export function parseYaml(text: string): Record<string, YamlValue> {
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_FILE_BYTES) {
    throw new ConfigError(
      `Configuration file is larger than ${MAX_CONFIG_FILE_BYTES} bytes; refusing to parse it.`,
    );
  }
  if (text.trim() === "") return {}; // js-yaml v5's load("") throws; an empty file means "use defaults".

  let value: unknown;
  try {
    value = loadYaml(text);
  } catch (err) {
    throw new ConfigError(`Invalid YAML: ${(err as Error).message}`);
  }
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("Configuration file must contain a YAML mapping (key: value pairs) at the top level.");
  }
  return value as Record<string, YamlValue>;
}

// ---------------------------------------------------------------------------
// Glob matching (standard globs only: *, **, ?)
// ---------------------------------------------------------------------------

export function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        pattern += "(?:.*/)?";
        i += 2;
      } else {
        pattern += ".*";
        i++;
      }
    } else if (ch === "*") {
      pattern += "[^/]*";
    } else if (ch === "?") {
      pattern += "[^/]";
    } else if (".+^${}()|[]\\".includes(ch!)) {
      pattern += "\\" + ch;
    } else {
      pattern += ch;
    }
  }
  return new RegExp(`^${pattern}$`);
}

export function matchesAnyGlob(filePath: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(filePath));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function assertString(value: YamlValue, context: string): string {
  if (typeof value !== "string") throw new ConfigError(`Expected a string for ${context}.`);
  return value;
}

function validateSeverityMap(raw: YamlValue, context: string): Record<string, RuleSeverityConfig> {
  if (raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`Expected a mapping of rule -> severity for ${context}.`);
  }
  const result: Record<string, RuleSeverityConfig> = {};
  for (const [ruleToken, severityRaw] of Object.entries(raw)) {
    if (!KNOWN_RULE_TOKENS.has(ruleToken)) {
      throw new ConfigError(
        `Configuration error: unknown rule "${ruleToken}". Expected one of: ${[...KNOWN_RULE_TOKENS].join(", ")}.`,
      );
    }
    const severity = assertString(severityRaw, `${context}.${ruleToken}`);
    if (!KNOWN_SEVERITIES.has(severity)) {
      throw new ConfigError(
        `Configuration error: invalid severity "${severity}" for rule "${ruleToken}". Expected one of: error, warning, notice, off.`,
      );
    }
    result[ruleToken] = severity as RuleSeverityConfig;
  }
  return result;
}

/**
 * Bounds on ignore/override glob lists. These exist because, in the GitHub
 * Action, the config file (and therefore every pattern in it) is read from
 * the repository under analysis — untrusted input in a PR context. Without
 * a cap, a crafted config could declare an enormous number of patterns, or
 * a single pathologically long one, multiplying the cost of the per-file
 * glob matching done during analysis, or feeding a wildcard-heavy string
 * into RegExp construction. These caps keep that cost bounded; they are a
 * mitigation, not a guarantee of safety for arbitrarily adversarial input.
 */
const MAX_LIST_ENTRIES = 500;
const MAX_PATTERN_LENGTH = 300;

function validateStringList(raw: YamlValue, context: string): string[] {
  if (raw === null) return [];
  if (!Array.isArray(raw)) throw new ConfigError(`Expected a list for ${context}.`);
  if (raw.length > MAX_LIST_ENTRIES) {
    throw new ConfigError(`${context} has ${raw.length} entries, which exceeds the limit of ${MAX_LIST_ENTRIES}.`);
  }
  return raw.map((v, idx) => {
    const s = assertString(v, `${context}[${idx}]`);
    if (s.length > MAX_PATTERN_LENGTH) {
      throw new ConfigError(`${context}[${idx}] is ${s.length} characters, which exceeds the limit of ${MAX_PATTERN_LENGTH}.`);
    }
    return s;
  });
}

/**
 * Validates a raw parsed-YAML object and returns only the keys the document
 * actually specified. This is deliberately *not* filled in with defaults:
 * callers (the CLI, the GitHub Action) each apply their own defaults via
 * withDefaults(), because "unset" and "explicitly set to the default value"
 * need to remain distinguishable — otherwise a caller-supplied default can
 * never be told apart from a value the config file genuinely specified,
 * and one silently wins over the other regardless of which was intended.
 */
export function validateConfig(raw: Record<string, YamlValue>): Partial<PettyLintConfig> {
  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      throw new ConfigError(
        `Configuration error: unknown top-level key "${key}". Expected one of: ${[...KNOWN_TOP_LEVEL_KEYS].join(", ")}.`,
      );
    }
  }

  const result: Partial<PettyLintConfig> = {};

  if (raw["rules"] !== undefined) {
    result.rules = validateSeverityMap(raw["rules"], "rules");
  }
  if (raw["ignore"] !== undefined) {
    result.ignore = validateStringList(raw["ignore"], "ignore");
  }

  const rawOverrides = raw["overrides"];
  if (rawOverrides !== undefined && rawOverrides !== null) {
    if (!Array.isArray(rawOverrides)) throw new ConfigError("Expected a list for overrides.");
    if (rawOverrides.length > MAX_LIST_ENTRIES) {
      throw new ConfigError(`overrides has ${rawOverrides.length} entries, which exceeds the limit of ${MAX_LIST_ENTRIES}.`);
    }
    result.overrides = rawOverrides.map((entry, idx) => {
      if (typeof entry !== "object" || Array.isArray(entry) || entry === null) {
        throw new ConfigError(`overrides[${idx}] must be a mapping with "files" and "rules".`);
      }
      const files = validateStringList(entry["files"] ?? null, `overrides[${idx}].files`);
      if (files.length === 0) {
        throw new ConfigError(`overrides[${idx}] must declare at least one file pattern.`);
      }
      const overrideRules = validateSeverityMap(entry["rules"] ?? null, `overrides[${idx}].rules`);
      return { files, rules: overrideRules };
    });
  }

  if (raw["fail-on"] !== undefined && raw["fail-on"] !== null) {
    const value = assertString(raw["fail-on"], "fail-on");
    if (!KNOWN_FAIL_ON.has(value)) {
      throw new ConfigError(`Configuration error: invalid fail-on "${value}". Expected one of: error, warning, notice, never.`);
    }
    result.failOn = value as FailOn;
  }

  if (raw["format"] !== undefined && raw["format"] !== null) {
    const value = assertString(raw["format"], "format");
    if (!KNOWN_FORMATS.has(value)) {
      throw new ConfigError(`Configuration error: invalid format "${value}". Expected one of: pretty, json, sarif.`);
    }
    result.format = value as OutputFormat;
  }

  if (raw["baseline"] !== undefined && raw["baseline"] !== null) {
    result.baseline = assertString(raw["baseline"], "baseline");
  }

  if (raw["changed-only"] !== undefined && raw["changed-only"] !== null) {
    if (typeof raw["changed-only"] !== "boolean") {
      throw new ConfigError('Configuration error: "changed-only" must be true or false.');
    }
    result.changedOnly = raw["changed-only"];
  }

  return result;
}

/** Layers an explicitly-set partial config over a caller-supplied set of defaults. */
export function withDefaults(partial: Partial<PettyLintConfig>, defaults: PettyLintConfig): PettyLintConfig {
  return {
    rules: partial.rules ?? defaults.rules,
    ignore: partial.ignore ?? defaults.ignore,
    overrides: partial.overrides ?? defaults.overrides,
    failOn: partial.failOn ?? defaults.failOn,
    baseline: partial.baseline !== undefined ? partial.baseline : defaults.baseline,
    format: partial.format ?? defaults.format,
    changedOnly: partial.changedOnly ?? defaults.changedOnly,
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function parseConfigFile(filePath: string, displayName: string): Partial<PettyLintConfig> {
  const text = fs.readFileSync(filePath, "utf8");
  let raw: Record<string, YamlValue>;
  try {
    raw = parseYaml(text);
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`Failed to parse ${displayName}: ${(err as Error).message}`);
  }
  return validateConfig(raw);
}

/**
 * Loads a specific, explicitly-named configuration file (e.g. from
 * `--config <path>` or the Action's `config` input). Unlike loadConfig(),
 * this does not search a directory for canonical filenames — it loads
 * exactly the file it's given, and fails clearly if it doesn't exist.
 */
export function loadConfigFile(filePath: string, defaults: PettyLintConfig = DEFAULT_CONFIG): PettyLintConfig {
  if (!fs.existsSync(filePath)) {
    throw new ConfigError(`Configuration file "${filePath}" does not exist.`);
  }
  return withDefaults(parseConfigFile(filePath, filePath), defaults);
}

/**
 * Searches rootDir for a canonical configuration file (.pettylintrc.yml or
 * pettylint.yml) and loads it, or returns `defaults` unchanged if neither
 * exists. `defaults` lets different entry points (CLI vs. GitHub Action)
 * apply different sensible defaults for fields the config file doesn't
 * mention, without one silently masking the other (see validateConfig()).
 */
export function loadConfig(rootDir: string, defaults: PettyLintConfig = DEFAULT_CONFIG): PettyLintConfig {
  const found = CONFIG_FILENAMES.filter((name) => fs.existsSync(path.join(rootDir, name)));
  if (found.length > 1) {
    throw new ConfigError(
      `Both ${found.join(" and ")} exist. PettyLint requires a single configuration file; remove one.`,
    );
  }
  if (found.length === 0) return defaults;

  const filePath = path.join(rootDir, found[0]!);
  return withDefaults(parseConfigFile(filePath, found[0]!), defaults);
}

/**
 * Resolves the effective rule-severity map for a given repo-relative file
 * path, applying overrides in declaration order (later, more specific
 * matches win, per section 16).
 */
export function resolveRulesForFile(config: PettyLintConfig, filePath: string): Record<string, RuleSeverityConfig> {
  let effective: Record<string, RuleSeverityConfig> = { ...config.rules };
  for (const override of config.overrides) {
    if (matchesAnyGlob(filePath, override.files)) {
      effective = { ...effective, ...override.rules };
    }
  }
  return effective;
}

export function isIgnored(config: PettyLintConfig, filePath: string): boolean {
  return matchesAnyGlob(filePath, [...DEFAULT_IGNORE, ...config.ignore]);
}
