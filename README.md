# PettyLint

Your code works.

PettyLint still has notes.

```
src/server.ts:42:5
PL001 console-log
warning
Your debugging statement has escaped containment.
```

PettyLint is a lightweight, deterministic static-analysis engine for
JavaScript and TypeScript. It looks for a small set of concrete,
review-worthy issues — debugging statements, disabled tests, empty catch
blocks, stale TODOs, obvious commented-out code — and reports them through
your pull requests, your terminal, or your editor.

It is not a linter replacement. It doesn't format code, type-check, resolve
dependencies, or scan for security vulnerabilities. ESLint, Biome,
TypeScript, Semgrep, and SonarQube already do those jobs well. PettyLint
does one narrow thing: it notices the small stuff developers leave behind
during normal development, and it says so — dryly, but never unkindly.

## Table of contents

1. [What it detects](#what-it-detects)
2. [GitHub Action installation](#github-action-installation)
3. [CLI installation and use](#cli-installation-and-use)
4. [Rule reference](#rule-reference)
5. [Configuration](#configuration)
6. [Inline suppression](#inline-suppression)
7. [Baselines](#baselines)
8. [Autofix](#autofix)
9. [SARIF](#sarif)
10. [Custom rules](#custom-rules)
11. [Supported languages](#supported-languages)
12. [Architecture](#architecture)
13. [Development](#development)
14. [Testing](#testing)
15. [Security](#security)
16. [Limitations](#limitations)
17. [Roadmap](#roadmap)

## What it detects

| ID | Name | What it catches |
|---|---|---|
| PL001 | `console-log` | `console.log/error/warn/info/debug/table/trace(...)` |
| PL002 | `debugger` | `debugger;` statements |
| PL003 | `empty-catch` | `catch` blocks with no statements |
| PL004 | `todo` | `TODO`/`FIXME` markers in comments |
| PL005 | `disabled-test` | `test.skip`, `it.skip`, `describe.skip`, `xit`, `xdescribe` |
| PL006 | `commented-code` | Comment blocks that look like disabled code |
| PL007 | `debug-pattern` | `alert(...)`, `prompt(...)`, `confirm(...)` |

Full detail, examples, and limitations for each rule live in
[`docs/rules/`](docs/rules/).

By default, PettyLint only reports findings on **changed lines** in a pull
request — it will not dump every historical issue in your repository on
you the first time you install it.

## GitHub Action installation

```yaml
name: PettyLint

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  pettylint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: Facelessism/pettylint@v1
```

(Replace `Facelessism/pettylint` with the published repository once released — see `CONTRIBUTING.md`'s release checklist for the one command that finds every instance.)

### Inputs

| Input | Default | Description |
|---|---|---|
| `github-token` | `${{ github.token }}` | Token used to read PR files and post the summary comment |
| `rules` | `""` | YAML fragment overriding rule severities |
| `config` | `""` | Path to a config file, relative to the repo root |
| `changed-only` | `"true"` | Only report findings on added/changed lines |
| `fail-on` | `"error"` | Minimum severity that fails the Action: `error`/`warning`/`notice`/`never` |
| `baseline` | `""` | Path to a baseline file |
| `format` | `"pretty"` | Additional log output format: `pretty`/`json`/`sarif` |
| `comment` | `"true"` | Whether to post/update the PR summary comment |
| `ignore` | `""` | Newline-separated glob patterns to exclude |

### Outputs

`findings` (JSON array), `errors`, `warnings`, `notices`, `failed`.

The Action never installs your dependencies and never executes your code —
see [Security](#security).

## CLI installation and use

```bash
pnpm add -D pettylint
pnpm pettylint            # analyze the whole repository
pnpm pettylint src/       # analyze a path
pnpm pettylint --changed  # analyze changed working-tree lines
pnpm pettylint --diff main
pnpm pettylint baseline   # create/update the baseline
pnpm pettylint --fix      # apply safe autofixes (PL001 and PL002); lists them first
pnpm pettylint --list-rules --format json   # machine-readable rule metadata
pnpm pettylint --lsp      # minimal LSP server over stdio (diagnostics only)
```

```
PettyLint

3 petty offenses found.

src/auth.ts:42:5
PL001 console-log
warning
Your debugging statement has escaped containment.

src/api.ts:81
PL003 empty-catch
warning
The error has been politely ignored.

tests/auth.test.ts:17
PL005 disabled-test
notice
Skipped test detected. PettyLint remains suspicious.

2 warnings · 1 notice
```

### Options

```
--config <path>        Path to a configuration file
--format <f>           pretty | json | sarif
--severity <s>         Minimum severity to report
--rule <rule-id>       Only run a single rule (repeatable)
--changed              Analyze only changed working-tree lines
--diff <base>          Analyze only lines changed since <base>
--baseline             Force-enable baseline comparison
--no-baseline          Disable baseline comparison
--list-rules           List available rules and exit
--verbose              Print timing information
--quiet                Suppress non-essential output
--version / --help
```

### Exit codes

- `0` — no findings at or above the fail threshold
- `1` — findings exist at or above the fail threshold
- `2` — configuration, invocation, or fatal runtime error

## Rule reference

See [`docs/rules/`](docs/rules/) — one file per rule, each with the
purpose, rationale, triggering/non-triggering examples, limitations, a
suppression example, and autofix availability. List installed rules and
their metadata at any time with:

```bash
pnpm pettylint --list-rules
```

## Configuration

PettyLint requires zero configuration. To customize it, add
`.pettylintrc.yml` or `pettylint.yml` (not both) to your repository root:

```yaml
rules:
  console-log: warning
  debugger: error
  empty-catch: warning
  todo: notice
  disabled-test: notice
  commented-code: notice
  debug-pattern: off

ignore:
  - "scripts/debug/**"
  - "generated/**"

fail-on: error

changed-only: true

format: pretty

overrides:
  - files:
      - "tests/**"
    rules:
      console-log: off

  - files:
      - "scripts/**"
    rules:
      debugger: notice
```

Severities are `error`, `warning`, `notice`, or `off`. Unknown rule IDs,
invalid severities, unknown top-level keys, and invalid glob patterns are
all rejected with a specific error message rather than silently ignored.

**Overrides** apply in declaration order; later, more specific matches win
for any given file/rule combination.

## Inline suppression

```ts
// pettylint-disable-next-line console-log
console.log("intentional");

// pettylint-disable console-log
console.log("still suppressed");
console.log("also suppressed");
// pettylint-enable console-log
console.log("reported again");
```

Rule tokens can be either the stable ID (`PL001`) or the rule name
(`console-log`). A suppression directive with no rule named is rejected —
PettyLint has no undocumented "disable everything" wildcard.

## Baselines

A baseline lets you adopt PettyLint in an existing codebase without being
confronted with every pre-existing finding at once:

```bash
pnpm pettylint baseline   # writes .pettylint-baseline.json
```

From then on, only *new* findings (not in the baseline) are reported by
default; findings that have since been fixed show up as "resolved" in PR
summaries. Baselines are plain JSON, versioned, and fingerprinted
deterministically (rule + relative path + source location — never
absolute paths or timestamps), so they survive unrelated changes elsewhere
in the repository.

## Autofix

```bash
pnpm pettylint --fix
pnpm pettylint --fix --changed   # only fix findings on changed lines
```

Autofix is opt-in per rule and only offered where the change is
mechanically safe. Currently **PL001 (`console-log`, constant arguments only)** and
**PL002 (`debugger`)** have one; each rule's doc page states exactly when
it applies and when it deliberately declines. All other rules are
report-only.
`--fix` prints every fix it is about to make (file, line, rule) before
writing anything, and never touches findings you suppressed inline.

## Editor integration (LSP)

`pettylint --lsp` starts a minimal Language Server Protocol server over
stdio. It publishes PettyLint findings as diagnostics on open/change/close
(full-document sync) using the same `analyze()` engine as the CLI and the
Action. It does not implement completions, hovers, or code actions.

## SARIF

```bash
pnpm pettylint --format sarif > pettylint.sarif
```

Produces a valid SARIF 2.1.0 document suitable for GitHub code scanning or
any other SARIF consumer.

## Custom rules

```ts
import type { Rule } from "pettylint";

const noLegacyApi: Rule = {
  id: "company/no-legacy-api",
  name: "no-legacy-api",
  description: "Flags calls into the deprecated internal API.",
  category: "maintainability",
  severity: "warning",
  confidence: "high",
  languages: ["typescript"],
  check(context) {
    // Inspect context.source.sourceFile (a ts.SourceFile) and return
    // Finding[] using context.lineAndColumnAt() for locations.
    return [];
  },
};
```

Custom rule IDs must be namespaced (`your-org/rule-name`) — unnamespaced
IDs are reserved for built-ins (`PL0XX`). Custom rules produce the same
`Finding` shape as built-ins, never touch GitHub, and are registered
alongside the built-in rules via the `analyze()` API's `customRules`
option.

## Supported languages

JavaScript, TypeScript, JSX, and TSX (`.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`,
`.cjs`), parsed with the TypeScript Compiler API. The architecture
separates language adapters from the core engine so that Python, Go, and
Rust adapters can be added later without changing the finding, diff,
configuration, or reporting infrastructure — none of those are implemented
yet, and none are implied by anything currently installed.

## Architecture

```
CLI ──┐
      ├──▶ Core (language-agnostic analyze()) ──▶ Findings
GitHub Action ──┘                                     │
                                          ┌────────────┼────────────┐
                                          ▼            ▼            ▼
                                        Diff       Baseline      Formatters
                                          │            │            │
                                          └────────────┼────────────┘
                                                       ▼
                                          CLI · GitHub · SARIF · Editors
```

- **Rules never import GitHub.** `src/rules.ts` has no dependency on
  `src/github.ts` or `@actions/github`.
- **The core engine works without GitHub.** `analyze()` in `src/core.ts`
  takes plain source text in and returns structured findings out.
- **The CLI and the Action share one engine.** Neither re-implements rule
  execution; both call `analyze()`.
- **Formatters never analyze.** `src/format.ts` only consumes `Finding[]`.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full file-by-file
responsibilities.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Everything here runs from a plain terminal — no Docker, no GUI IDE
required, and it works from Termux on Android. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the full workflow, including how
to add a rule.

## Testing

`--verbose` prints file counts and parse/rule/diff timings to stderr.
Analysis results are cached in memory (keyed by path, content, parser
version, and rule configuration) so long-lived processes such as the LSP
server don't re-analyze unchanged files.

Tests run on Vitest and cover the core engine, every built-in rule
(positive/negative/edge cases), diff filtering, configuration, baselines,
formatters, and CLI behavior. GitHub-specific logic is tested through
mocked interfaces; core tests never depend on GitHub.

```bash
pnpm test
```

## Security

Source code is treated as untrusted input. PettyLint never executes
repository code, never installs repository dependencies, and never runs
repository scripts. Full details, including the GitHub Action's permission
model and how to report a vulnerability, are in
[`SECURITY.md`](SECURITY.md).

## Limitations

- Detection is syntactic (AST-based), not type-aware. Only simple `const`
  aliases of `console` are resolved (see PL001); nothing is resolved
  across files, reassignments, or function boundaries.
- Baseline fingerprints use rule + file + the flagged line's text (+ an
  occurrence index), so unrelated edits elsewhere in the file don't
  invalidate them, but editing the flagged line itself does.
- Syntax errors are reported as warnings on stderr; the file is still
  analyzed on a best-effort basis using the parser's recovered tree.
- The `commented-code` heuristic is deliberately conservative; it will
  miss some commented-out code to avoid flagging ordinary prose.
- `--changed`/`--diff` require a git repository with the relevant history
  available; PettyLint will not silently fall back to whole-repository
  analysis.
- PettyLint is not a substitute for ESLint, Semgrep, SonarQube, or a type
  checker, and isn't trying to be.

## Roadmap

- Additional language adapters (Python, Go, Rust) as separately maintained
  rule packs, once the current JS/TS-family implementation has proven
  itself.
- Editor/LSP integration built as a thin adapter over the same `analyze()`
  engine used by the CLI and the Action.
- Autofix support for rules where a safe transformation can be clearly
  justified.

PettyLint does not replace your existing linter. It simply has opinions
about a few things.
