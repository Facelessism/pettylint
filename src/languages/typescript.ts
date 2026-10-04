import ts from "typescript";
import type { LanguageAdapter, ParsedSource } from "./types.js";

function scriptKindFor(fileName: string): ts.ScriptKind {
  return fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/**
 * Parses TypeScript (including TSX) using the TypeScript Compiler API.
 * Like the JavaScript adapter, this performs syntactic parsing only —
 * PettyLint is not a type checker and never invokes the type-checking
 * pipeline.
 */
export const typescriptAdapter: LanguageAdapter = {
  id: "typescript",
  extensions: [".ts", ".tsx"],
  parse(source: string, fileName: string): ParsedSource {
    const sourceFile = ts.createSourceFile(
      fileName,
      source,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      scriptKindFor(fileName),
    );
    return { language: "typescript", fileName, text: source, sourceFile };
  },
};
