import {
  configuredGiteaToken,
  giteaBaseUrl,
} from "../lib/forge";
import {
  giteaCommentIssue,
  giteaCreateIssue,
  issueNumberFromUrl,
} from "../lib/gitea";
import { originForge } from "../issues/repository";
import {
  commentIssue as commentGithubIssue,
  createIssue as createGithubIssue,
  watchdogBody,
  watchdogComment,
  watchdogTitle,
  type GhRun,
  type IssueInput,
} from "./github";

/**
 * Watchdog issue delivery for the checkout's own forge. Every URL it returns
 * is linked in the cycle history; no issue is ever closed and no repository is
 * named in source. GitHub uses the operator's `gh`; Gitea uses its public API
 * and the configured token.
 */

export type DeliveryResult = { ok: true; url: string } | { ok: false; reason: string };
export type CommentResult = { ok: true } | { ok: false; reason: string };

export interface WatchdogDelivery {
  /** `owner/name` that receives the issue, for diagnostics. */
  repository: string;
  create(input: IssueInput): Promise<DeliveryResult>;
  comment(url: string, input: IssueInput): Promise<CommentResult>;
}

export interface DeliveryOptions {
  root: string;
  environment?: Record<string, string | undefined>;
  /** The GitHub command; ignored for a Gitea origin. */
  gh: GhRun;
  /** Injectable Gitea transport. */
  fetchImpl?: typeof fetch;
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

/** The delivery for the checkout's origin, or an explicit refusal. */
export function createWatchdogDelivery(options: DeliveryOptions): WatchdogDelivery {
  const environment = options.environment ?? process.env;
  const remote = originForge(options.root, environment);
  if (remote === undefined) {
    throw new Error("the checkout's origin does not name a supported repository");
  }
  if (remote.forge === "gitea") {
    const baseUrl = giteaBaseUrl(remote, environment);
    if (baseUrl === undefined || baseUrl.length === 0) {
      throw new Error("the watchdog needs DEVBOARD_GITEA_URL for a Gitea origin");
    }
    const token = configuredGiteaToken(environment);
    if (token === undefined) throw new Error("the watchdog needs GITEA_TOKEN for a Gitea origin");
    const target = { baseUrl, project: remote.project, token };
    return {
      repository: remote.project,
      async create(input) {
        try {
          const issue = await giteaCreateIssue(
            target,
            { title: watchdogTitle(input.category, input.line), body: watchdogBody(input) },
            options.fetchImpl,
          );
          return { ok: true, url: issue.url };
        } catch (error) {
          return { ok: false, reason: firstLine(error) };
        }
      },
      async comment(url, input) {
        const number = issueNumberFromUrl(url);
        if (number === undefined) return { ok: false, reason: "the issue URL has no number" };
        try {
          await giteaCommentIssue(target, number, watchdogComment(input), options.fetchImpl);
          return { ok: true };
        } catch (error) {
          return { ok: false, reason: firstLine(error) };
        }
      },
    };
  }
  return {
    repository: remote.project,
    async create(input) {
      return createGithubIssue(options.gh, remote.project, input);
    },
    async comment(url, input) {
      return commentGithubIssue(options.gh, url, input);
    },
  };
}
