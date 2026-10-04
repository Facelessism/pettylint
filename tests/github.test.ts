import { describe, it, expect } from "vitest";
import { getChangedRanges, upsertSummaryComment, type PullRequestInfo } from "../src/github.js";
import type { Finding } from "../src/core.js";

const info: PullRequestInfo = { owner: "o", repo: "r", prNumber: 7, baseSha: "b", headSha: "h" };

interface Call {
  kind: "create" | "update";
  params: Record<string, unknown>;
}

/** A hand-rolled fake of the small slice of Octokit that github.ts uses. */
function fakeOctokit(opts: { files?: unknown[]; comments?: unknown[] } = {}) {
  const calls: Call[] = [];
  const octokit = {
    paginate: Object.assign(async () => opts.comments ?? [], {
      iterator: () =>
        (async function* () {
          yield { data: opts.files ?? [] };
        })(),
    }),
    rest: {
      pulls: { listFiles: {} },
      issues: {
        listComments: {},
        createComment: async (params: Record<string, unknown>) => void calls.push({ kind: "create", params }),
        updateComment: async (params: Record<string, unknown>) => void calls.push({ kind: "update", params }),
      },
    },
  };
  // The real type is Octokit; the fake only implements what the code under test calls.
  return { octokit: octokit as unknown as Parameters<typeof upsertSummaryComment>[0], calls };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: "PL001",
    message: "Your debugging statement has escaped containment.",
    severity: "warning",
    confidence: "high",
    file: "src/a.ts",
    line: 3,
    column: 1,
    category: "debugging",
    ...overrides,
  };
}

describe("getChangedRanges()", () => {
  it("turns GitHub patches into changed ranges and skips removed files", async () => {
    const { octokit } = fakeOctokit({
      files: [
        { filename: "src/a.ts", status: "modified", patch: "@@ -1,2 +1,3 @@\n keep\n+added\n keep2" },
        { filename: "src/gone.ts", status: "removed", patch: "@@ -1 +0,0 @@\n-x" },
        { filename: "src/renamed.ts", status: "renamed" }, // no patch: nothing changed by line
      ],
    });
    const { changedFiles, ranges } = await getChangedRanges(octokit, info);
    expect(changedFiles).toEqual(["src/a.ts", "src/renamed.ts"]);
    expect(ranges).toEqual([{ file: "src/a.ts", startLine: 2, endLine: 2 }]);
  });
});

describe("upsertSummaryComment()", () => {
  it("creates one summary comment when none exists", async () => {
    const { octokit, calls } = fakeOctokit({ comments: [{ id: 1, body: "unrelated comment" }] });
    await upsertSummaryComment(octokit, info, [finding(), finding({ line: 4 })]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "create", params: { issue_number: 7 } });
  });

  it("updates the existing PettyLint comment instead of creating a duplicate", async () => {
    const { octokit, calls } = fakeOctokit({
      comments: [{ id: 1, body: "unrelated" }, { id: 42, body: "<!-- pettylint-summary -->\n## PettyLint\nold" }],
    });
    await upsertSummaryComment(octokit, info, [finding()]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "update", params: { comment_id: 42 } });
  });

  it("posts a single comment regardless of finding count (never one per finding)", async () => {
    const { octokit, calls } = fakeOctokit();
    await upsertSummaryComment(octokit, info, Array.from({ length: 25 }, (_, i) => finding({ line: i + 1 })));
    expect(calls).toHaveLength(1);
  });
});
