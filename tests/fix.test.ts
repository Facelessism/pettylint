import { describe, it, expect } from "vitest";
import { applyFixes, analyze } from "../src/core.js";

function fix(text: string) {
  return applyFixes({ filePath: "a.ts", text });
}

describe("PL002 autofix (debugger removal)", () => {
  it("removes a debugger statement that owns its line, including the newline", () => {
    expect(fix("const a = 1;\n  debugger;\nconst b = 2;\n").text).toBe("const a = 1;\nconst b = 2;\n");
  });

  it("handles CRLF files without leaving stray carriage returns", () => {
    expect(fix("a();\r\ndebugger;\r\nb();\r\n").text).toBe("a();\r\nb();\r\n");
  });

  it("removes only the statement when other code shares the line", () => {
    expect(fix("a(); debugger; b();").text).toBe("a();  b();");
  });

  it("fixes several debugger statements in one pass", () => {
    const result = fix("debugger;\nfunction f() {\n  debugger;\n}\n");
    expect(result.text).toBe("function f() {\n}\n");
    expect(result.fixes).toHaveLength(2);
  });

  it("does not touch a debugger that is the body of an if (structure would change)", () => {
    const text = "if (x) debugger;\n";
    expect(fix(text).text).toBe(text);
  });

  it("does not touch a labeled debugger statement", () => {
    const text = "label: debugger;\n";
    expect(fix(text).text).toBe(text);
  });

  it("respects inline suppression", () => {
    const text = "// pettylint-disable-next-line debugger\ndebugger;\n";
    expect(fix(text).text).toBe(text);
  });

  it("respects a caller-supplied filter (used for changed-only fixing)", () => {
    const text = "debugger;\ndebugger;\n";
    const result = applyFixes({ filePath: "a.ts", text }, { filter: (f) => f.line === 2 });
    expect(result.text).toBe("debugger;\n");
  });

  it("produces source that no longer triggers the rule, and is idempotent", () => {
    const once = fix("debugger;\nfoo();\n").text;
    expect(analyze([{ filePath: "a.ts", text: once }]).findings).toHaveLength(0);
    expect(fix(once).text).toBe(once);
  });

  it("does not offer fixes for rules without one (empty catch stays)", () => {
    const text = "try { f(); } catch {}\n";
    expect(fix(text).text).toBe(text);
  });
});

describe("PL001 autofix (console call removal)", () => {
  it("removes a console call whose arguments are all inert literals", () => {
    expect(fix('a();\nconsole.log("here", 42, -1, true, null, `x`);\nb();\n').text).toBe("a();\nb();\n");
  });

  it("removes a call with no arguments", () => {
    expect(fix("console.trace();\n").text).toBe("");
  });

  it("does not remove a call whose arguments could throw or have side effects", () => {
    for (const text of ["console.log(x);\n", "console.log(getUser());\n", "console.log(a.b);\n", "console.log(`v: ${x}`);\n"]) {
      expect(fix(text).text).toBe(text);
    }
  });

  it("does not remove a console call used as an expression", () => {
    for (const text of ["cond && console.log('x');\n", "const r = console.log('x');\n", "const f = () => console.log('x');\n", "if (x) console.log('x');\n"]) {
      expect(fix(text).text).toBe(text);
    }
  });

  it("does not remove aliased console calls (medium confidence)", () => {
    const text = "const log = console.log;\nlog('x');\n";
    expect(fix(text).text).toBe(text);
  });

  it("does not remove a call when the file declares its own `console`", () => {
    const text = "import console from './my-logger';\nconsole.log('x');\n";
    expect(fix(text).text).toBe(text);
  });

  it("is idempotent and leaves no console finding behind", () => {
    const once = fix("console.log('a');\nkeep();\n").text;
    expect(once).toBe("keep();\n");
    expect(fix(once).text).toBe(once);
  });

  it("fixes PL001 and PL002 together in one pass", () => {
    const result = fix("debugger;\nconsole.log('a');\nkeep();\n");
    expect(result.text).toBe("keep();\n");
    expect(result.fixes).toHaveLength(2);
  });
});
