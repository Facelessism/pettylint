import { describe, it, expect } from "vitest";
import { analyze, type Finding } from "../src/core.js";

function findingsFor(text: string, filePath = "a.ts"): Finding[] {
  return analyze([{ filePath, text }]).findings;
}

function ruleFindings(text: string, ruleId: string, filePath = "a.ts"): Finding[] {
  return findingsFor(text, filePath).filter((f) => f.ruleId === ruleId);
}

describe("PL001 console-log", () => {
  it("detects all supported console methods", () => {
    const text = [
      "console.log(1);",
      "console.error(1);",
      "console.warn(1);",
      "console.info(1);",
      "console.debug(1);",
      "console.table(1);",
      "console.trace(1);",
    ].join("\n");
    expect(ruleFindings(text, "PL001")).toHaveLength(7);
  });

  it("detects console calls nested inside other expressions", () => {
    const text = "if (true) { doThing(console.log(1)); }";
    expect(ruleFindings(text, "PL001")).toHaveLength(1);
  });

  it("does not detect console.log inside a comment", () => {
    expect(ruleFindings("// console.log('debug')", "PL001")).toHaveLength(0);
  });

  it("does not detect console.log inside a string literal", () => {
    expect(ruleFindings('const text = "console.log()";', "PL001")).toHaveLength(0);
  });

  it("does not detect console.log inside a block comment", () => {
    expect(ruleFindings("/*\nconsole.log()\n*/", "PL001")).toHaveLength(0);
  });

  it("does not detect an unrelated method named log", () => {
    expect(ruleFindings("myLogger.log('hi');", "PL001")).toHaveLength(0);
  });

  it("does not crash on malformed source", () => {
    expect(() => ruleFindings("console.log(", "PL001")).not.toThrow();
  });

  it("reports an accurate location", () => {
    const [finding] = ruleFindings("const x = 1;\nconsole.log(x);", "PL001");
    expect(finding).toMatchObject({ line: 2, column: 1 });
  });

  it("detects a const object alias (const c = console; c.log(...))", () => {
    const [finding] = ruleFindings("const c = console;\nc.log('x');", "PL001");
    expect(finding).toMatchObject({ confidence: "medium" });
  });

  it("detects a const method alias (const log = console.log; log(...))", () => {
    const [finding] = ruleFindings("const log = console.log;\nlog('x');", "PL001");
    expect(finding).toMatchObject({ confidence: "medium" });
  });

  it("detects a destructured const method alias (const { log } = console;)", () => {
    expect(ruleFindings("const { log } = console;\nlog('x');", "PL001")).toHaveLength(1);
  });

  it("detects a renamed destructured alias (const { log: myLog } = console;)", () => {
    expect(ruleFindings("const { log: myLog } = console;\nmyLog('x');", "PL001")).toHaveLength(1);
  });

  it("does not track a let/var alias, since it could be reassigned", () => {
    expect(ruleFindings("let c = console;\nc.log('x');", "PL001")).toHaveLength(0);
    expect(ruleFindings("var log = console.log;\nlog('x');", "PL001")).toHaveLength(0);
  });

  it("does not flag an unrelated object that merely has a 'log' property", () => {
    expect(ruleFindings("const notConsole = { log: () => {} };\nnotConsole.log('x');", "PL001")).toHaveLength(0);
  });
});

describe("PL002 debugger", () => {
  it("detects a top-level debugger statement", () => {
    expect(ruleFindings("debugger;", "PL002")).toHaveLength(1);
  });

  it("detects debugger nested inside a function", () => {
    const text = "function f() {\n  if (true) {\n    debugger;\n  }\n}";
    const [finding] = ruleFindings(text, "PL002");
    expect(finding).toMatchObject({ line: 3 });
  });

  it("does not detect debugger inside a comment", () => {
    expect(ruleFindings("// debugger;", "PL002")).toHaveLength(0);
  });

  it("does not detect the string 'debugger'", () => {
    expect(ruleFindings('const x = "debugger";', "PL002")).toHaveLength(0);
  });
});

describe("PL003 empty-catch", () => {
  it("detects a catch block with no binding", () => {
    expect(ruleFindings("try { f(); } catch {}", "PL003")).toHaveLength(1);
  });

  it("detects a catch block with a binding but no statements", () => {
    expect(ruleFindings("try { f(); } catch (e) {\n}", "PL003")).toHaveLength(1);
  });

  it("does not detect a catch block that logs the error", () => {
    expect(ruleFindings("try { f(); } catch (e) { console.error(e); }", "PL003")).toHaveLength(0);
  });

  it("does not detect a catch block that rethrows", () => {
    expect(ruleFindings("try { f(); } catch (e) { throw e; }", "PL003")).toHaveLength(0);
  });

  it("does not detect a catch block with a single statement", () => {
    expect(ruleFindings("try { f(); } catch (e) { handle(e); }", "PL003")).toHaveLength(0);
  });
});

describe("PL004 todo", () => {
  it("detects a TODO line comment", () => {
    expect(ruleFindings("// TODO: refactor this", "PL004")).toHaveLength(1);
  });

  it("detects a FIXME line comment", () => {
    expect(ruleFindings("// FIXME: broken authentication", "PL004")).toHaveLength(1);
  });

  it("detects TODO inside a block comment", () => {
    expect(ruleFindings("/* TODO: remove later */", "PL004")).toHaveLength(1);
  });

  it("does not detect TODO inside a string literal", () => {
    expect(ruleFindings('const x = "TODO";', "PL004")).toHaveLength(0);
  });

  it("does not detect FIXME inside a string literal", () => {
    expect(ruleFindings('const x = "FIXME";', "PL004")).toHaveLength(0);
  });

  it("does not treat todo-like prose without the marker as a finding", () => {
    expect(ruleFindings("// things we still need to do eventually", "PL004")).toHaveLength(0);
  });
});

describe("PL005 disabled-test", () => {
  it.each(["test.skip", "it.skip", "describe.skip"])("detects %s(...)", (form) => {
    expect(ruleFindings(`${form}("x", () => {});`, "PL005")).toHaveLength(1);
  });

  it.each(["xit", "xdescribe"])("detects %s(...)", (form) => {
    expect(ruleFindings(`${form}("x", () => {});`, "PL005")).toHaveLength(1);
  });

  it("does not detect a normal test", () => {
    expect(ruleFindings('test("x", () => {});', "PL005")).toHaveLength(0);
  });

  it("does not detect a conditionally selected skip", () => {
    expect(ruleFindings("(cond ? test.skip : test)('x', () => {});", "PL005")).toHaveLength(0);
  });
});

describe("PL006 commented-code", () => {
  it("detects an obvious multi-line commented-out block", () => {
    const text = ["// const user = getUser();", "// if (user) {", "//   return user;", "// }"].join("\n");
    expect(ruleFindings(text, "PL006")).toHaveLength(1);
  });

  it("does not flag ordinary prose", () => {
    expect(ruleFindings("// This handles authenticated users.", "PL006")).toHaveLength(0);
  });

  it("does not flag a documentation example sentence", () => {
    expect(ruleFindings("// See the README for usage examples.", "PL006")).toHaveLength(0);
  });

  it("stays below threshold for a single mild comment", () => {
    expect(ruleFindings("// uses x", "PL006")).toHaveLength(0);
  });

  it("does not flag 'new'/'else' as bare English words in prose", () => {
    const text = [
      "// The config object looks like {env, port} but we don't validate it here.",
      "// Keep that in mind when adding new fields.",
    ].join("\n");
    expect(ruleFindings(text, "PL006")).toHaveLength(0);
  });

  it("does not flag two lines that each show only one weak signal", () => {
    const text = ["// x = the input value", "// y = the output value"].join("\n");
    expect(ruleFindings(text, "PL006")).toHaveLength(0);
  });
});

describe("PL007 debug-pattern", () => {
  it.each(["alert", "prompt", "confirm"])("detects %s(...)", (fn) => {
    expect(ruleFindings(`${fn}("hi");`, "PL007")).toHaveLength(1);
  });

  it("does not detect alert inside a comment", () => {
    expect(ruleFindings("// alert('hi')", "PL007")).toHaveLength(0);
  });

  it("does not detect an unrelated call named alert on an object", () => {
    expect(ruleFindings("pager.alert('hi');", "PL007")).toHaveLength(0);
  });
});
