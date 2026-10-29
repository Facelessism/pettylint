import { renameSync, rmSync } from "node:fs";

renameSync("dist/index.js", "dist/index.mjs");
rmSync("dist/package.json", { force: true });
