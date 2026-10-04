import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

declare const __dirname: string | undefined;

/**
 * Resolves this file's own directory in both of the module systems it
 * actually runs under: real ESM (dev via tsx, and the compiled dist-lib/
 * used by the CLI) and a single bundled CommonJS file (the GitHub Action
 * build, via @vercel/ncc). `import.meta.url` is the correct answer in the
 * former; bundlers that target CJS replace it with an empty string rather
 * than leaving it valid, so fileURLToPath() on it throws there and we fall
 * back to `__dirname`, which is natively available in real CommonJS
 * (including ncc's bundled output) and is never reached — so never
 * evaluated — under real ESM.
 */
function thisDir(): string {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    if (typeof __dirname === "string") return __dirname;
    throw new Error("Unable to resolve module directory in either ESM or CommonJS mode.");
  }
}

// createRequire is given an absolute path (not import.meta.url a second
// time — that would reintroduce the same empty-string failure under a CJS
// bundle) so it works identically whether package.json is read from disk
// (src/dev, dist-lib) or inlined at build time (ncc statically resolves
// and bundles require()'d JSON).
const dir = thisDir();
const pkg = createRequire(path.join(dir, "version.js"))(path.join(dir, "../package.json")) as { version: string };

export const PACKAGE_VERSION: string = pkg.version;
