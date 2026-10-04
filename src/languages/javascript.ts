import ts from "typescript";
import type { LanguageAdapter, ParsedSource } from "./types.js";

function scriptKindFor(fileName: string): ts.ScriptKind {
  return fileName.endsWith(".jsx") || fileName.endsWith(".mjs") || fileName.endsWith(".cjs")
    ? ts.ScriptKind.JSX
    : ts.ScriptKind.JS;
}

/**
 * Parses JavaScript (including JSX, .mjs, .cjs) using the TypeScript
 * Compiler API in permissive JS mode. We never type-check; we only need
 * a syntax tree with accurate source positions.
 */
export const javascriptAdapter: LanguageAdapter = {
  id: "javascript",
  extensions: [".js", ".jsx", ".mjs", ".cjs"],
  parse(source: string, fileName: string): ParsedSource {
    const sourceFile = ts.createSourceFile(
      fileName,
      source,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      scriptKindFor(fileName),
    );
    return { language: "javascript", fileName, text: source, sourceFile };
  },
};
