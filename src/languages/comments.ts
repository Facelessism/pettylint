import ts from "typescript";

/**
 * Comments are trivia in the TypeScript AST, not nodes, so anything that
 * needs comment text (the todo rule, the commented-code heuristic, inline
 * suppression directives) reads from a single scan of the raw source,
 * done once per file via collectComments().
 */
export interface CommentInfo {
  readonly kind: ts.SyntaxKind.SingleLineCommentTrivia | ts.SyntaxKind.MultiLineCommentTrivia;
  readonly pos: number;
  readonly end: number;
  readonly text: string;
  readonly line: number; // 1-based, start line of the comment
}

export function collectComments(fullText: string, sourceFile: ts.SourceFile): CommentInfo[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    sourceFile.languageVariant,
    fullText,
  );
  const comments: CommentInfo[] = [];
  let kind = scanner.scan();
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    if (
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const pos = scanner.getTokenStart();
      const end = scanner.getTokenEnd();
      const line = sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
      comments.push({ kind, pos, end, text: fullText.slice(pos, end), line });
    }
    kind = scanner.scan();
  }
  return comments;
}

export function toLineColumn(sourceFile: ts.SourceFile, pos: number): { line: number; column: number } {
  const lc = sourceFile.getLineAndCharacterOfPosition(pos);
  return { line: lc.line + 1, column: lc.character + 1 };
}
