import ts from "typescript";

/**
 * Identifiers for the languages PettyLint currently understands.
 * Additional adapters (Python, Go, Rust, ...) can extend this union
 * in the future without changing core/diff/config/reporting code.
 */
export type LanguageId = "javascript" | "typescript";

/**
 * The result of parsing a single source file. Rules receive this
 * rather than a raw file path so that parsing only ever happens once
 * per file, regardless of how many rules run against it.
 */
export interface ParsedSource {
  readonly language: LanguageId;
  readonly fileName: string;
  readonly text: string;
  readonly sourceFile: ts.SourceFile;
}

/**
 * A language adapter knows how to turn source text into a ParsedSource.
 * It intentionally exposes nothing beyond parsing: rule execution,
 * diffing, and reporting are all language-agnostic core concerns.
 */
export interface LanguageAdapter {
  readonly id: LanguageId;
  readonly extensions: readonly string[];
  parse(source: string, fileName: string): ParsedSource;
}
