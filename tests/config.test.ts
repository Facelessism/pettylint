import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, resolveRulesForFile, isIgnored, ConfigError, DEFAULT_CONFIG } from "../src/config.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pettylint-config-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(name: string, contents: string) {
  fs.writeFileSync(path.join(tmpDir, name), contents);
}

describe("loadConfig()", () => {
  it("returns defaults when no config file exists", () => {
    expect(loadConfig(tmpDir)).toEqual(DEFAULT_CONFIG);
  });

  it("loads a valid .pettylintrc.yml", () => {
    write(
      ".pettylintrc.yml",
      ["rules:", "  console-log: warning", "  debugger: error", "fail-on: error", "changed-only: true"].join("\n"),
    );
    const config = loadConfig(tmpDir);
    expect(config.rules["console-log"]).toBe("warning");
    expect(config.rules["debugger"]).toBe("error");
    expect(config.failOn).toBe("error");
    expect(config.changedOnly).toBe(true);
  });

  it("also accepts pettylint.yml", () => {
    write("pettylint.yml", "fail-on: warning");
    expect(loadConfig(tmpDir).failOn).toBe("warning");
  });

  it("fails clearly when both config files exist", () => {
    write(".pettylintrc.yml", "fail-on: error");
    write("pettylint.yml", "fail-on: warning");
    expect(() => loadConfig(tmpDir)).toThrow(/Both .pettylintrc.yml and pettylint.yml exist/);
  });

  it("rejects an unknown rule id", () => {
    write(".pettylintrc.yml", ["rules:", "  console: warning"].join("\n"));
    expect(() => loadConfig(tmpDir)).toThrow(/unknown rule "console"/);
  });

  it("rejects an invalid severity", () => {
    write(".pettylintrc.yml", ["rules:", "  console-log: catastrophic"].join("\n"));
    expect(() => loadConfig(tmpDir)).toThrow(/invalid severity/);
  });

  it("rejects an unknown top-level key", () => {
    write(".pettylintrc.yml", "not-a-real-key: 1");
    expect(() => loadConfig(tmpDir)).toThrow(/unknown top-level key/);
  });

  it("rejects an invalid format", () => {
    write(".pettylintrc.yml", "format: xml");
    expect(() => loadConfig(tmpDir)).toThrow(/invalid format/);
  });

  it("rejects malformed YAML syntax", () => {
    write(".pettylintrc.yml", "rules: [unterminated");
    expect(() => loadConfig(tmpDir)).toThrow(ConfigError);
  });

  it("rejects a top-level scalar (not a mapping)", () => {
    write(".pettylintrc.yml", "this is not a mapping at all");
    expect(() => loadConfig(tmpDir)).toThrow(/must contain a YAML mapping/);
  });

  it("parses ignore patterns", () => {
    write(".pettylintrc.yml", ["ignore:", '  - "scripts/debug/**"', '  - "generated/**"'].join("\n"));
    const config = loadConfig(tmpDir);
    expect(config.ignore).toEqual(["scripts/debug/**", "generated/**"]);
  });

  it("parses flow-style YAML (now supported via js-yaml)", () => {
    write(".pettylintrc.yml", 'ignore: ["scripts/debug/**", "generated/**"]');
    const config = loadConfig(tmpDir);
    expect(config.ignore).toEqual(["scripts/debug/**", "generated/**"]);
  });

  it("parses overrides with nested files and rules", () => {
    write(
      ".pettylintrc.yml",
      [
        "overrides:",
        "  - files:",
        '      - "tests/**"',
        "    rules:",
        "      console-log: off",
      ].join("\n"),
    );
    const config = loadConfig(tmpDir);
    expect(config.overrides).toEqual([{ files: ["tests/**"], rules: { "console-log": "off" } }]);
  });
});

describe("resolveRulesForFile() / overrides precedence", () => {
  it("applies later, more specific overrides on top of earlier ones", () => {
    write(
      ".pettylintrc.yml",
      [
        "rules:",
        "  console-log: warning",
        "overrides:",
        "  - files:",
        '      - "**"',
        "    rules:",
        "      console-log: off",
        "  - files:",
        '      - "scripts/**"',
        "    rules:",
        "      console-log: notice",
      ].join("\n"),
    );
    const config = loadConfig(tmpDir);
    expect(resolveRulesForFile(config, "scripts/x.ts")["console-log"]).toBe("notice");
    expect(resolveRulesForFile(config, "src/x.ts")["console-log"]).toBe("off");
  });
});

describe("isIgnored()", () => {
  it("ignores default directories even with no config file", () => {
    const config = loadConfig(tmpDir);
    expect(isIgnored(config, "node_modules/x.ts")).toBe(true);
    expect(isIgnored(config, "dist/x.js")).toBe(true);
  });

  it("does not ignore ordinary source files", () => {
    const config = loadConfig(tmpDir);
    expect(isIgnored(config, "src/index.ts")).toBe(false);
  });
});

describe("nested default ignores", () => {
  it("ignores node_modules at any depth (monorepos)", () => {
    expect(isIgnored(DEFAULT_CONFIG, "packages/a/node_modules/x/index.js")).toBe(true);
    expect(isIgnored(DEFAULT_CONFIG, "src/nodemodules.ts")).toBe(false);
  });
});
