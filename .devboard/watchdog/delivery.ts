import {
  configuredGiteaToken,
  giteaBaseUrl,
} from "../lib/forge";
import {
  giteaCommentIssue,
  giteaCreateIssue,
  giteaIssue,
  giteaIssueNumber,
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
  /**
   * True when `url` names an issue this delivery's forge serves. The ledger
   * outlives a forge change, so an entry may name an issue filed elsewhere;
   * that URL can never be commented on from here and is skipped instead of
   * treated as a delivery failure.
   */
  owns(url: string): boolean;
  create(input: IssueInput): Promise<DeliveryResult>;
  comment(url: string, input: IssueInput): Promise<CommentResult>;
  /**
   * The issue's state, for open-only duplicate suppression. Undefined when the
   * read fails; the cycle then re-asks the deduplication agent instead of
   * assuming the match is still open.
   */
  state(url: string): Promise<"open" | "closed" | undefined>;
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

/**
 * Whether `url` names an issue on the GitHub host this delivery writes to.
 * `gh` resolves the URL itself, so the repository may differ from the origin's.
 */
function githubIssueOn(url: string, host: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (parsed.hostname.toLowerCase() !== host.toLowerCase()) return false;
  return /\/issues\/[0-9]+\/?$/.test(parsed.pathname);
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
      owns(url) {
        return giteaIssueNumber(target, url) !== undefined;
      },
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
        const number = giteaIssueNumber(target, url);
        if (number === undefined) {
          return {
            ok: false,
            reason: `the ledger URL is not an issue in ${target.baseUrl}/${target.project}: ${url}`,
          };
        }
        try {
          await giteaCommentIssue(target, number, watchdogComment(input), options.fetchImpl);
          return { ok: true };
        } catch (error) {
          return { ok: false, reason: firstLine(error) };
        }
      },
      async state(url) {
        const number = giteaIssueNumber(target, url);
        if (number === undefined) return undefined;
        try {
          const issue = await giteaIssue(target, number, options.fetchImpl);
          return issue.state;
        } catch {
          return undefined;
        }
      },
    };
  }
  return {
    repository: remote.project,
    owns(url) {
      return githubIssueOn(url, remote.host);
    },
    async create(input) {
      return createGithubIssue(options.gh, remote.project, input);
    },
    async comment(url, input) {
      return commentGithubIssue(options.gh, url, input);
    },
    async state(url) {
      const outcome = options.gh(["issue", "view", url, "--json", "state"], "");
      if (outcome.code !== 0) return undefined;
      try {
        const parsed: unknown = JSON.parse(outcome.stdout);
        if (typeof parsed !== "object" || parsed === null) return undefined;
        const state = (parsed as Record<string, unknown>).state;
        if (typeof state !== "string") return undefined;
        const normalized = state.toLowerCase();
        return normalized === "open" || normalized === "closed" ? normalized : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
