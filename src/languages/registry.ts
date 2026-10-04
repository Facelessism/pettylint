import * as path from "node:path";
import type { LanguageAdapter } from "./types.js";
import { javascriptAdapter } from "./javascript.js";
import { typescriptAdapter } from "./typescript.js";

const adapters: readonly LanguageAdapter[] = [javascriptAdapter, typescriptAdapter];

const extensionMap = new Map<string, LanguageAdapter>();
for (const adapter of adapters) {
  for (const ext of adapter.extensions) {
    extensionMap.set(ext, adapter);
  }
}

/** All extensions PettyLint currently knows how to analyze. */
export const SUPPORTED_EXTENSIONS: readonly string[] = Array.from(extensionMap.keys());

/**
 * Resolves the language adapter for a file based on its extension.
 * Returns undefined for unsupported file types; callers must treat
 * that as "skip this file", never as an error.
 */
export function detectLanguage(fileName: string): LanguageAdapter | undefined {
  const ext = path.extname(fileName).toLowerCase();
  return extensionMap.get(ext);
}

export { javascriptAdapter, typescriptAdapter };
export type { LanguageAdapter } from "./types.js";
