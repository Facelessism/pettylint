# Security

PettyLint is a static-analysis tool. It reads source code as data; it never
executes it. This document explains the security model in detail.

## Threat model

Repository source code — the pull request being analyzed — is treated as
**untrusted input**. PettyLint's job is to read that input safely, not to
trust it.

## What PettyLint never does

- **Never executes target repository code.** No `eval`, `Function`, `vm`,
  dynamic `import()` of repository modules, or subprocess execution of
  anything the repository provides.
- **Never installs target repository dependencies.** PettyLint does not run
  `npm install`, `pnpm install`, `yarn install`, or any package manager
  command against the repository under analysis.
- **Never runs target repository scripts.** No `npm test`, `npm run build`,
  or arbitrary `package.json` scripts.
- **Never uploads source code anywhere.** Analysis happens locally (CLI) or
  on the GitHub-hosted runner (Action). Findings are reported through GitHub
  annotations/comments or local output; nothing is sent to a third-party
  service.
- **Never collects telemetry.** No analytics, no tracking, no usage
  reporting.

## What PettyLint does execute

- **The `git` binary**, to read diff text for `--changed` and `--diff`
  modes (CLI) or via the GitHub API (Action). This is a fixed, trusted
  development tool invoked with fixed arguments — it is not "repository
  code" in the sense above.
- **PettyLint's own bundled runtime** (`dist/index.js` in the Action).

## File handling

- All reported paths are repository-relative; PettyLint refuses to read or
  report paths that resolve outside the repository root.
- Symbolic links are not followed during file discovery.
- Files above a size threshold, and files that look like binary data (they
  contain a NUL byte), are skipped rather than parsed.
- `node_modules/`, `dist/`, `build/`, and `coverage/` are ignored by default;
  additional generated-output directories can be excluded via configuration.
- Parser failures on a single file are isolated: a malformed or adversarial
  file causes that file to be skipped with a clear diagnostic, not a crash
  of the whole run.

## Configuration files are untrusted input too

In the GitHub Action, `.pettylintrc.yml`/`pettylint.yml` is read from the
repository being analyzed — in a pull-request context, that means a
malicious PR can control its contents. PettyLint treats this the same way
it treats source files:

- The raw file is capped at 256 KB before parsing is attempted at all.
- Ignore/override glob lists are capped in both count and per-pattern
  length, so a crafted config can't force unbounded work out of the
  per-file glob matching done during analysis.
- Parsing uses js-yaml's default schema, which never executes arbitrary
  tags or custom types (this is what rules out the more severe class of
  YAML vulnerability — arbitrary code execution via deserialization).

One risk this does **not** fully close: YAML's anchor/alias mechanism lets
a small document expand into a very large in-memory structure (a "billion
laughs" style payload) entirely inside the parser's own parsing step,
before any size check in this codebase gets a chance to run. js-yaml has
shipped fixes for several concrete instances of this class of issue in its
merge-key and `!!omap` handling; keeping the `js-yaml` dependency current
(see `CONTRIBUTING.md`'s release checklist) is the primary mitigation.
GitHub-hosted runners' own CPU/time limits are a practical backstop.

## GitHub Action permissions

The Action requests the minimum permissions it needs:

```yaml
permissions:
  contents: read
  pull-requests: write
```

It does not request `contents: write`, does not push commits, and does not
modify the pull request's branch.

## Custom rules and rule packs

Custom rules run with the same trust level as the rest of PettyLint's own
code: they must be explicitly installed/configured by the repository owner.
PettyLint does not download or execute a remote rule package based on
configuration found inside the repository being analyzed — that would turn
configuration into arbitrary code execution, which this project explicitly
avoids (see the project specification's extension-safety requirements).

## Reporting a vulnerability

If you believe you've found a security issue in PettyLint, please open a
private security advisory on the repository (GitHub Security Advisories)
rather than a public issue. Include:

- A description of the issue and its impact
- Steps to reproduce, ideally with a minimal example
- The version of PettyLint affected

We aim to acknowledge reports within a few business days.
