import ts from "typescript";
import type { Finding, Rule, RuleContext } from "./core.js";
import { collectComments, type CommentInfo } from "./languages/comments.js";

// ---------------------------------------------------------------------------
// Shared traversal helpers
// ---------------------------------------------------------------------------

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function locationOf(context: RuleContext, start: number, end: number) {
  const from = context.lineAndColumnAt(start);
  const to = context.lineAndColumnAt(end);
  return { line: from.line, column: from.column, endLine: to.line, endColumn: to.column };
}

/** True when `parent` is a node whose children are a plain statement list. */
function isStatementList(parent: ts.Node): boolean {
  return (
    ts.isBlock(parent) ||
    ts.isSourceFile(parent) ||
    ts.isModuleBlock(parent) ||
    ts.isCaseClause(parent) ||
    ts.isDefaultClause(parent)
  );
}

/**
 * Builds an edit that deletes a whole statement: the entire line (including
 * its newline) when the statement is the only thing on it, otherwise just
 * the statement's own text.
 */
function removeStatementEdit(text: string, sourceFile: ts.SourceFile, statement: ts.Node) {
  const start = statement.getStart(sourceFile);
  const end = statement.getEnd();
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  let lineEnd = text.indexOf("\n", end);
  if (lineEnd === -1) lineEnd = text.length;
  const onlyThingOnLine = text.slice(lineStart, start).trim() === "" && text.slice(end, lineEnd).trim() === "";
  return onlyThingOnLine
    ? { start: lineStart, end: Math.min(lineEnd + 1, text.length), text: "" }
    : { start, end, text: "" };
}

function findNodeAt(sourceFile: ts.SourceFile, offset: number, match: (node: ts.Node) => boolean): ts.Node | undefined {
  let found: ts.Node | undefined;
  walk(sourceFile, (node) => {
    if (!found && node.getStart(sourceFile) === offset && match(node)) found = node;
  });
  return found;
}

/** Literals whose evaluation cannot throw or have side effects. */
function isInertLiteral(node: ts.Node): boolean {
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  return (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  );
}

/** Does this file declare its own binding named `name` (which would shadow a global)? */
function declaresBinding(sourceFile: ts.SourceFile, name: string): boolean {
  let declared = false;
  walk(sourceFile, (node) => {
    if (declared) return;
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isImportSpecifier(node) ||
        ts.isImportClause(node) ||
        ts.isNamespaceImport(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      declared = true;
    }
  });
  return declared;
}

function makeFinding(
  context: RuleContext,
  rule: Pick<Rule, "id" | "category" | "confidence">,
  message: string,
  explanation: string,
  start: number,
  end: number,
): Finding {
  const loc = locationOf(context, start, end);
  return {
    ruleId: rule.id,
    message,
    explanation,
    severity: context.config.severity,
    confidence: rule.confidence,
    file: context.filePath,
    category: rule.category,
    ...loc,
  };
}

// ---------------------------------------------------------------------------
// PL001 console-log
// ---------------------------------------------------------------------------

const CONSOLE_METHODS = new Set(["log", "error", "warn", "info", "debug", "table", "trace"]);

/**
 * Collects two narrow, unambiguous console-aliasing patterns so PL001 can
 * catch the most common real-world evasions without ever executing code
 * or performing real scope/type resolution:
 *
 *   const c = console;         c.log(...)       -> object alias
 *   const log = console.log;   log(...)         -> method alias
 *   const { log } = console;   log(...)         -> method alias (destructured)
 *
 * Only `const` bindings are considered, specifically because a `const`
 * cannot be reassigned — that rules out the obvious false-positive case
 * (an alias identifier later repurposed for something else) without any
 * real dataflow analysis. This is still a syntactic pass over one file;
 * it does not follow imports, reassignments through `let`/`var`, or
 * anything requiring the code to actually run.
 */
function collectConsoleAliases(sourceFile: ts.SourceFile): {
  objectAliases: Set<string>;
  methodAliases: Map<string, string>;
} {
  const objectAliases = new Set<string>();
  const methodAliases = new Map<string, string>();

  walk(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !node.initializer) return;
    if (
      !node.parent ||
      !ts.isVariableDeclarationList(node.parent) ||
      !(node.parent.flags & ts.NodeFlags.Const)
    ) {
      return;
    }

    const init = node.initializer;

    // const c = console;
    if (ts.isIdentifier(node.name) && ts.isIdentifier(init) && init.text === "console") {
      objectAliases.add(node.name.text);
      return;
    }

    // const log = console.log;
    if (
      ts.isIdentifier(node.name) &&
      ts.isPropertyAccessExpression(init) &&
      ts.isIdentifier(init.expression) &&
      init.expression.text === "console" &&
      CONSOLE_METHODS.has(init.name.text)
    ) {
      methodAliases.set(node.name.text, init.name.text);
      return;
    }

    // const { log, error: myError } = console;
    if (ts.isObjectBindingPattern(node.name) && ts.isIdentifier(init) && init.text === "console") {
      for (const element of node.name.elements) {
        if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue;
        const sourceMethodName = element.propertyName
          ? ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : null
          : element.name.text;
        if (sourceMethodName && CONSOLE_METHODS.has(sourceMethodName)) {
          methodAliases.set(element.name.text, sourceMethodName);
        }
      }
    }
  });

  return { objectAliases, methodAliases };
}

const consoleLogRule: Rule = {
  id: "PL001",
  name: "console-log",
  description: "Detects console.* debugging calls left in source code, including a small set of simple const aliases.",
  category: "debugging",
  severity: "warning",
  confidence: "high",
  languages: ["javascript", "typescript"],
  documentation: "docs/rules/PL001.md",
  fix: {
    description: "Remove the console call (constant arguments only)",
    edits(context, finding) {
      // Aliased (medium-confidence) matches are never auto-fixed.
      if (finding.confidence !== "high") return null;
      const sf = context.source.sourceFile;
      // A local binding named `console` means this may not be the global one.
      if (declaresBinding(sf, "console")) return null;

      const offset = sf.getPositionOfLineAndCharacter(finding.line - 1, finding.column - 1);
      const call = findNodeAt(sf, offset, (n) => ts.isCallExpression(n));
      if (!call || !ts.isCallExpression(call)) return null;
      const callee = call.expression;
      if (
        !ts.isPropertyAccessExpression(callee) ||
        !ts.isIdentifier(callee.expression) ||
        callee.expression.text !== "console"
      ) {
        return null;
      }
      // Must be a bare expression statement in a statement list: not
      // `x && console.log()`, `return console.log()`, an arrow body, etc.
      const statement = call.parent;
      if (!ts.isExpressionStatement(statement) || statement.expression !== call) return null;
      if (!isStatementList(statement.parent)) return null;
      // Arguments must be inert literals: removing the call must not drop
      // an evaluation that could throw or have side effects.
      if (!call.arguments.every(isInertLiteral)) return null;
      return [removeStatementEdit(context.source.text, sf, statement)];
    },
  },
  check(context) {
    const findings: Finding[] = [];
    const { objectAliases, methodAliases } = collectConsoleAliases(context.source.sourceFile);

    walk(context.source.sourceFile, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = node.expression;

      // Direct console.method(...)
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "console" &&
        CONSOLE_METHODS.has(callee.name.text)
      ) {
        findings.push(
          makeFinding(
            context,
            consoleLogRule,
            "Your debugging statement has escaped containment.",
            `console.${callee.name.text}() calls are usually left over from local debugging and rarely belong in committed code.`,
            node.getStart(context.source.sourceFile),
            node.getEnd(),
          ),
        );
        return;
      }

      // Aliased object: const c = console; c.log(...)
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        objectAliases.has(callee.expression.text) &&
        CONSOLE_METHODS.has(callee.name.text)
      ) {
        findings.push({
          ...makeFinding(
            context,
            consoleLogRule,
            "Your debugging statement has escaped containment, wearing a thin disguise.",
            `${callee.expression.text}.${callee.name.text}() resolves to console.${callee.name.text}() via a local const alias.`,
            node.getStart(context.source.sourceFile),
            node.getEnd(),
          ),
          confidence: "medium",
        });
        return;
      }

      // Aliased method: const log = console.log; log(...)
      if (ts.isIdentifier(callee) && methodAliases.has(callee.text)) {
        const methodName = methodAliases.get(callee.text)!;
        findings.push({
          ...makeFinding(
            context,
            consoleLogRule,
            "Your debugging statement has escaped containment, wearing a thin disguise.",
            `${callee.text}() resolves to console.${methodName}() via a local const alias.`,
            node.getStart(context.source.sourceFile),
            node.getEnd(),
          ),
          confidence: "medium",
        });
      }
    });
    return findings;
  },
};

// ---------------------------------------------------------------------------
// PL002 debugger
// ---------------------------------------------------------------------------

const debuggerRule: Rule = {
  id: "PL002",
  name: "debugger",
  description: "Detects debugger statements.",
  category: "debugging",
  severity: "warning",
  confidence: "high",
  languages: ["javascript", "typescript"],
  documentation: "docs/rules/PL002.md",
  fix: {
    description: "Remove the debugger statement",
    edits(context, finding) {
      const sf = context.source.sourceFile;
      const offset = sf.getPositionOfLineAndCharacter(finding.line - 1, finding.column - 1);
      const target = findNodeAt(sf, offset, (n) => n.kind === ts.SyntaxKind.DebuggerStatement);
      // `if (x) debugger;` or `label: debugger;` would change program structure.
      if (!target || !isStatementList(target.parent)) return null;
      return [removeStatementEdit(context.source.text, sf, target)];
    },
  },
  check(context) {
    const findings: Finding[] = [];
    walk(context.source.sourceFile, (node) => {
      if (node.kind !== ts.SyntaxKind.DebuggerStatement) return;
      findings.push(
        makeFinding(
          context,
          debuggerRule,
          "Debugger statement detected. It has overstayed its welcome.",
          "A `debugger;` statement pauses execution in any environment with dev tools attached, including production.",
          node.getStart(context.source.sourceFile),
          node.getEnd(),
        ),
      );
    });
    return findings;
  },
};

// ---------------------------------------------------------------------------
// PL003 empty-catch
// ---------------------------------------------------------------------------

const emptyCatchRule: Rule = {
  id: "PL003",
  name: "empty-catch",
  description: "Detects catch blocks with no statements.",
  category: "error-handling",
  severity: "warning",
  confidence: "high",
  languages: ["javascript", "typescript"],
  documentation: "docs/rules/PL003.md",
  check(context) {
    const findings: Finding[] = [];
    walk(context.source.sourceFile, (node) => {
      if (!ts.isCatchClause(node)) return;
      if (node.block.statements.length !== 0) return;
      findings.push(
        makeFinding(
          context,
          emptyCatchRule,
          "Empty catch block. The error has been politely ignored.",
          "An empty catch block silently discards the error, making failures invisible.",
          node.getStart(context.source.sourceFile),
          node.block.getEnd(),
        ),
      );
    });
    return findings;
  },
};

// ---------------------------------------------------------------------------
// PL004 todo
// ---------------------------------------------------------------------------

const TODO_RE = /(^|[^A-Za-z])(TODO|FIXME)(\b|:)/;

function commentBody(comment: CommentInfo): string {
  if (comment.kind === ts.SyntaxKind.SingleLineCommentTrivia) {
    return comment.text.replace(/^\/\//, "");
  }
  return comment.text.replace(/^\/\*/, "").replace(/\*\/$/, "");
}

const todoRule: Rule = {
  id: "PL004",
  name: "todo",
  description: "Detects TODO and FIXME markers left in comments.",
  category: "documentation",
  severity: "notice",
  confidence: "high",
  languages: ["javascript", "typescript"],
  documentation: "docs/rules/PL004.md",
  check(context) {
    const findings: Finding[] = [];
    const comments = collectComments(context.source.text, context.source.sourceFile);
    for (const comment of comments) {
      const body = commentBody(comment);
      const match = TODO_RE.exec(body);
      if (!match) continue;
      const marker = match[2]!;
      const message =
        marker === "TODO"
          ? "TODO detected. Future You has been notified."
          : "FIXME detected. Someone left this for later.";
      findings.push(
        makeFinding(
          context,
          todoRule,
          message,
          `A ${marker} marker was found in a comment. These are worth tracking so they don't get lost.`,
          comment.pos,
          comment.end,
        ),
      );
    }
    return findings;
  },
};

// ---------------------------------------------------------------------------
// PL005 disabled-test
// ---------------------------------------------------------------------------

const SKIP_OBJECTS = new Set(["test", "it", "describe"]);
const SKIP_IDENTIFIERS = new Set(["xit", "xdescribe"]);

const disabledTestRule: Rule = {
  id: "PL005",
  name: "disabled-test",
  description: "Detects explicitly skipped tests (test.skip, it.skip, describe.skip, xit, xdescribe).",
  category: "testing",
  severity: "notice",
  confidence: "medium",
  languages: ["javascript", "typescript"],
  documentation: "docs/rules/PL005.md",
  check(context) {
    const findings: Finding[] = [];
    walk(context.source.sourceFile, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = node.expression;

      let matched = false;
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        SKIP_OBJECTS.has(callee.expression.text) &&
        callee.name.text === "skip"
      ) {
        matched = true;
      } else if (ts.isIdentifier(callee) && SKIP_IDENTIFIERS.has(callee.text)) {
        matched = true;
      }
      if (!matched) return;

      findings.push(
        makeFinding(
          context,
          disabledTestRule,
          "Skipped test detected. PettyLint remains suspicious.",
          "This test is explicitly disabled and will not run as part of the suite.",
          node.getStart(context.source.sourceFile),
          node.getEnd(),
        ),
      );
    });
    return findings;
  },
};

// ---------------------------------------------------------------------------
// PL006 commented-code
//
// A conservative heuristic: group consecutive single-line comments (and
// each multi-line comment) into blocks, score each line for code-like
// signals, and only flag blocks with enough combined signal to be
// reasonably confident this is disabled code rather than prose.
// ---------------------------------------------------------------------------

// CODE_KEYWORDS deliberately requires enough surrounding syntax that each
// keyword is unlikely to appear as an ordinary English word in prose:
// "new"/"class" require a following identifier (as in `new Foo(` or
// `class Foo`), and "else" requires the brace/if shape that always
// accompanies it in real code — otherwise "adding new fields" or
// "everything else" would themselves count as code-like signals.
const CODE_KEYWORDS =
  /\b(const|let|var|function|return|if\s*\(|for\s*\(|while\s*\(|import\b|export\b|require\(|new\s+[A-Za-z_$][\w$]*\s*\(|class\s+[A-Za-z_$]|\}\s*else\b|else\s*\{|else\s+if\b)/;

function codeSignalScore(line: string): number {
  let score = 0;
  if (/[{};]/.test(line)) score++;
  if (/[^=!<>]=(?!=)/.test(line)) score++;
  if (CODE_KEYWORDS.test(line)) score++;
  if (/\w+\([^)]*\)\s*;?\s*$/.test(line)) score++;
  if (/=>/.test(line)) score++;
  return score;
}

interface CommentBlock {
  comments: CommentInfo[];
}

function groupIntoBlocks(comments: CommentInfo[]): CommentBlock[] {
  const blocks: CommentBlock[] = [];
  let current: CommentInfo[] = [];

  for (const comment of comments) {
    if (comment.kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      if (current.length) blocks.push({ comments: current });
      current = [];
      blocks.push({ comments: [comment] });
      continue;
    }
    const prev = current[current.length - 1];
    if (prev && prev.kind === ts.SyntaxKind.SingleLineCommentTrivia && comment.line === prev.line + 1) {
      current.push(comment);
    } else {
      if (current.length) blocks.push({ comments: current });
      current = [comment];
    }
  }
  if (current.length) blocks.push({ comments: current });
  return blocks;
}

function blockLines(block: CommentBlock): string[] {
  if (block.comments.length === 1 && block.comments[0]!.kind === ts.SyntaxKind.MultiLineCommentTrivia) {
    return commentBody(block.comments[0]!)
      .split("\n")
      .map((l) => l.replace(/^\s*\*/, ""))
      .filter((l) => l.trim().length > 0);
  }
  return block.comments.map((c) => commentBody(c));
}

const commentedCodeRule: Rule = {
  id: "PL006",
  name: "commented-code",
  description: "Conservatively detects blocks of commented-out code.",
  category: "dead-code",
  severity: "notice",
  confidence: "medium",
  languages: ["javascript", "typescript"],
  documentation: "docs/rules/PL006.md",
  check(context) {
    const findings: Finding[] = [];
    const comments = collectComments(context.source.text, context.source.sourceFile);
    const blocks = groupIntoBlocks(comments);

    for (const block of blocks) {
      const lines = blockLines(block);
      if (lines.length === 0) continue;
      const codeLikeLineCount = lines.filter((l) => codeSignalScore(l) >= 1).length;
      const totalScore = lines.reduce((sum, l) => sum + codeSignalScore(l), 0);

      // Two lines that each show a single weak signal (e.g. two lines each
      // containing a bare "=") aren't enough on their own — that pattern
      // shows up in ordinary explanatory comments ("x = the input value").
      // Requiring a minimum combined score keeps the multi-line path from
      // firing on weak-but-widespread signals.
      const isMultiLineBlock = codeLikeLineCount >= 2 && totalScore >= 3;
      const isStrongSingleLine = lines.length === 1 && totalScore >= 3;
      if (!isMultiLineBlock && !isStrongSingleLine) continue;

      const first = block.comments[0]!;
      const last = block.comments[block.comments.length - 1]!;
      findings.push(
        makeFinding(
          context,
          {
            ...commentedCodeRule,
            confidence: isMultiLineBlock ? "medium" : "low",
          },
          "This comment looks suspiciously like real code taking an extended vacation.",
          "The text of this comment matches common patterns for commented-out code (statements, braces, assignments, or calls).",
          first.pos,
          last.end,
        ),
      );
    }
    return findings;
  },
};

// ---------------------------------------------------------------------------
// PL007 debug-pattern
// ---------------------------------------------------------------------------

const DEBUG_GLOBALS = new Set(["alert", "prompt", "confirm"]);

const debugPatternRule: Rule = {
  id: "PL007",
  name: "debug-pattern",
  description: "Detects a small, explicit set of browser debugging prompts (alert, prompt, confirm).",
  category: "debugging",
  severity: "notice",
  confidence: "medium",
  languages: ["javascript", "typescript"],
  documentation: "docs/rules/PL007.md",
  check(context) {
    const findings: Finding[] = [];
    walk(context.source.sourceFile, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = node.expression;
      if (!ts.isIdentifier(callee) || !DEBUG_GLOBALS.has(callee.text)) return;
      findings.push(
        makeFinding(
          context,
          debugPatternRule,
          `A stray ${callee.text}() is blocking the main thread somewhere it shouldn't be.`,
          `${callee.text}() is a synchronous browser dialog almost always used for debugging, not production UX.`,
          node.getStart(context.source.sourceFile),
          node.getEnd(),
        ),
      );
    });
    return findings;
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const builtinRules: Rule[] = [
  consoleLogRule,
  debuggerRule,
  emptyCatchRule,
  todoRule,
  disabledTestRule,
  commentedCodeRule,
  debugPatternRule,
];
