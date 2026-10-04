#!/usr/bin/env node
import { runCli } from "../dist-lib/cli.js";
process.exit(runCli(process.argv.slice(2)));
