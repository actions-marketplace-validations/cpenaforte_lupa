import { context, getOctokit } from "@actions/github";
import type { InlineComment, ReviewPayload } from "./review.js";

export type Octokit = ReturnType<typeof getOctokit>;

/**
 * Token cannot write reviews (fork PR with read-only token). The caller degrades to
 * summary + artifact and does not treat this as a failed run.
 */
export class ReadonlyTokenError extends Error {}

export interface PostReviewResult {
  /** True when inline comments were folded into the review body after an off-diff 422. */
  degraded: boolean;
  /** True when a stale commit_id 422 triggered a head_sha re-resolve and retry. */
  retriedWithNewSha: boolean;
}

const OFF_DIFF = /could not be resolved|part of the diff|line.*(diff|resolve)/i;
const STALE_SHA = /commit_id|head commit|sha/i;

interface HttpLikeError {
  status?: unknown;
  message?: unknown;
  response?: { data?: unknown };
}

function statusOf(e: unknown): number | undefined {
  const s = (e as HttpLikeError | null)?.status;
  return typeof s === "number" ? s : undefined;
}

/** Text used only for classifying a 422. Never copied into thrown errors. */
function detailOf(e: unknown): string {
  const err = e as HttpLikeError | null;
  let data = "";
  try {
    data = JSON.stringify(err?.response?.data ?? "");
  } catch {
    data = "";
  }
  const msg = typeof err?.message === "string" ? err.message : "";
  return `${msg} ${data}`;
}

function repoOf(): { owner: string; repo: string } {
  return context.repo;
}

/**
 * Off-diff fallback: inline comments move into the review body as a plain list, so the
 * retry posts a general-only review. Fences inside the bodies are kept as-is.
 */
function foldComments(body: string, comments: InlineComment[]): string {
  if (comments.length === 0) return body;
  const items = comments.map((c) => `- ${c.path}:${c.line}\n  ${c.body.replace(/\n/g, "\n  ")}`);
  return `${body}\n\n**Findings not placed inline:**\n${items.join("\n")}`;
}

/**
 * Posts one consolidated review to `pulls/{pr}/reviews`.
 * - 422 line off-diff: inline comments are folded into the body and the POST is retried once.
 * - 422 stale commit_id: head_sha is re-resolved and the POST is retried once.
 * - 403 (read-only token): throws ReadonlyTokenError.
 * - Any other failure throws a sanitized Error; the upstream message is never copied,
 *   so tokens or keys echoed by the API cannot leak into logs.
 */
export async function postReview(
  octokit: Octokit,
  pr: number,
  payload: ReviewPayload,
): Promise<PostReviewResult> {
  const { owner, repo } = repoOf();
  let commitId = payload.commit_id;
  let body = payload.body;
  let comments = payload.comments;
  let degraded = false;
  let retriedWithNewSha = false;

  for (;;) {
    try {
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pr,
        commit_id: commitId,
        body,
        event: payload.event,
        comments,
      });
      return { degraded, retriedWithNewSha };
    } catch (e) {
      const status = statusOf(e);
      if (status === 403 && !/rate limit/i.test(detailOf(e))) {
        throw new ReadonlyTokenError("review post refused: token cannot write reviews (HTTP 403)");
      }
      if (status !== 422) {
        throw new Error(`review post failed${status === undefined ? "" : ` (HTTP ${status})`}`);
      }
      const detail = detailOf(e);
      if (!degraded && comments.length > 0 && OFF_DIFF.test(detail)) {
        body = foldComments(body, comments);
        comments = [];
        degraded = true;
        continue;
      }
      if (!retriedWithNewSha && STALE_SHA.test(detail)) {
        const pull = await octokit.rest.pulls.get({ owner, repo, pull_number: pr });
        commitId = pull.data.head.sha;
        retriedWithNewSha = true;
        continue;
      }
      throw new Error("review post rejected (HTTP 422)");
    }
  }
}

/**
 * Fallback summary comment on the PR conversation. Only when the caller enabled it AND the
 * token has issues:write; otherwise throws and nothing is posted.
 */
export async function postIssueFallback(
  octokit: Octokit,
  opts: { enabled: boolean; issuesWrite: boolean; pr: number; body: string },
): Promise<void> {
  if (!opts.enabled) throw new Error("issue fallback disabled");
  if (!opts.issuesWrite) throw new Error("issue fallback requires issues: write");
  const { owner, repo } = repoOf();
  await octokit.rest.issues.createComment({ owner, repo, issue_number: opts.pr, body: opts.body });
}

function positiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * PR number for the event, or null when the event is not about a pull request
 * (e.g. a comment on a bare issue, or a dispatch without pr_number).
 */
export function resolvePrNumber(
  event: string,
  payload: {
    issue?: { number: number; pull_request?: unknown };
    pull_request?: { number: number };
    inputs?: { pr_number?: number };
  },
): number | null {
  switch (event) {
    case "pull_request":
    case "pull_request_review": {
      const n = payload.pull_request?.number;
      return positiveInt(n) ? n : null;
    }
    case "issue_comment": {
      const issue = payload.issue;
      if (issue === undefined || issue.pull_request === undefined) return null;
      return positiveInt(issue.number) ? issue.number : null;
    }
    case "workflow_dispatch": {
      const n = payload.inputs?.pr_number;
      return positiveInt(n) ? n : null;
    }
    default:
      return null;
  }
}

const TRIGGER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

/**
 * Whether this event should run a review. workflow_run is always false: Fluxo B dispatches
 * on `github.event_name` in the workflow file, not through this function.
 */
export function shouldTrigger(
  event: string,
  payload: {
    action?: string;
    commentBody?: string;
    reviewBody?: string;
    authorAssociation?: string;
    issueHasPR?: boolean;
    prNumber?: number | null;
  },
): boolean {
  const trusted = TRIGGER_ASSOCIATIONS.has(payload.authorAssociation ?? "");
  switch (event) {
    case "pull_request":
      return PR_ACTIONS.has(payload.action ?? "");
    case "issue_comment":
      return (
        payload.action === "created" &&
        payload.issueHasPR === true &&
        (payload.commentBody ?? "").includes("/review") &&
        trusted
      );
    case "pull_request_review":
      return (
        payload.action === "submitted" &&
        (payload.reviewBody ?? "").trim() !== "" &&
        trusted
      );
    case "workflow_dispatch":
      return payload.prNumber !== null && payload.prNumber !== undefined;
    default:
      return false;
  }
}
