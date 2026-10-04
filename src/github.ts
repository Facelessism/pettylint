import * as core from "@actions/core";
import * as github from "@actions/github";
import type { Finding } from "./core.js";
import type { ChangedRange } from "./diff.js";
import { parseUnifiedDiff } from "./diff.js";
import { formatGithubAnnotations, formatPrSummary, isPettyLintSummaryComment } from "./format.js";
import type { BaselineFinding } from "./baseline.js";

type Octokit = ReturnType<typeof github.getOctokit>;

export interface PullRequestInfo {
  owner: string;
  repo: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
}

export class GithubContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubContextError";
  }
}

/**
 * Reads the minimum GitHub Action context PettyLint needs. Deliberately
 * narrow: this is the only file in the project that knows about GitHub's
 * event payload shape.
 */
export function getPullRequestInfo(): PullRequestInfo {
  const { context } = github;
  const pr = context.payload.pull_request;
  if (!pr) {
    throw new GithubContextError(
      "PettyLint's changed-code analysis requires a pull_request event. No pull request was found in the workflow context.",
    );
  }
  return {
    owner: context.repo.owner,
    repo: context.repo.repo,
    prNumber: pr.number as number,
    baseSha: (pr.base as { sha: string }).sha,
    headSha: (pr.head as { sha: string }).sha,
  };
}

export function createOctokit(token: string): Octokit {
  return github.getOctokit(token);
}

/** Fetches the changed file list and per-file patches, and converts them into changed ranges. */
export async function getChangedRanges(
  octokit: Octokit,
  info: PullRequestInfo,
): Promise<{ changedFiles: string[]; ranges: ChangedRange[] }> {
  const changedFiles: string[] = [];
  const ranges: ChangedRange[] = [];

  const iterator = octokit.paginate.iterator(octokit.rest.pulls.listFiles, {
    owner: info.owner,
    repo: info.repo,
    pull_number: info.prNumber,
    per_page: 100,
  });

  for await (const { data: files } of iterator) {
    for (const file of files) {
      if (file.status === "removed") continue;
      changedFiles.push(file.filename);
      if (!file.patch) continue; // GitHub omits patches for very large diffs
      const fakeDiff = `diff --git a/${file.filename} b/${file.filename}\n+++ b/${file.filename}\n${file.patch}\n`;
      ranges.push(...parseUnifiedDiff(fakeDiff));
    }
  }

  return { changedFiles, ranges };
}

/**
 * Emits one GitHub workflow annotation per finding via workflow commands.
 * These render inline on the PR "Files changed" tab without any API calls.
 */
export function emitAnnotations(findings: Finding[]): void {
  for (const line of formatGithubAnnotations(findings)) {
    process.stdout.write(line + "\n");
  }
}

/** Creates or updates the single PettyLint summary comment on a PR (never one comment per finding). */
export async function upsertSummaryComment(
  octokit: Octokit,
  info: PullRequestInfo,
  newFindings: Finding[],
  resolvedFindings: BaselineFinding[] = [],
): Promise<void> {
  const body = formatPrSummary({ newFindings, resolvedFindings });

  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: info.owner,
    repo: info.repo,
    issue_number: info.prNumber,
    per_page: 100,
  });

  const existing = comments.find((c: { body?: string | null }) => c.body && isPettyLintSummaryComment(c.body));

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner: info.owner,
      repo: info.repo,
      comment_id: existing.id,
      body,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner: info.owner,
      repo: info.repo,
      issue_number: info.prNumber,
      body,
    });
  }
}

export { core };
