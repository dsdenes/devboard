import { configuredGiteaToken, giteaBaseUrl, type ForgeRemote } from "../../lib/forge";
import {
  giteaJson,
  giteaListReleases,
  giteaOrigin,
  repoPath,
  type FetchLike,
  type GiteaTarget,
} from "../../lib/gitea";
import { createGiteaVersionClient } from "../../lib/gitea-release";
import { originForge } from "../../issues/repository";
import {
  createRepositoryGitHub,
  shippedVersion,
  type GitHubCommandRunner,
  type GitHubRelease,
  type RepositoryGitHub,
} from "../../lib/github-release";
import { ghCommand } from "../command";

/**
 * The one forge read behind every background agent's filed-issues table. It
 * answers each issue's current state and, for a closed one, the earliest
 * published release that shipped it. GitHub uses the operator's `gh`; Gitea
 * uses its public API and the configured token. It never writes.
 */

export type ForgeIssueState = "pending" | "implemented";

/**
 * What one requested URL's read answered. `unreadable` marks a URL another
 * forge serves: this reader cannot answer it, so its row keeps no state.
 */
export type ForgeIssueOutcome = ForgeIssueState | "unreadable";

export interface ForgeIssueFact {
  url: string;
  /** `pending` is open, `implemented` closed, `unreadable` served by another forge. */
  state: ForgeIssueOutcome;
  /** The earliest published release that shipped it, or null. */
  version: string | null;
}

/**
 * Reads every issue's forge facts. Every requested URL is answered — a URL
 * this reader cannot serve is `unreadable` — and rejection means the read
 * failed.
 */
export interface ForgeIssueReader {
  project(urls: string[]): Promise<ForgeIssueFact[]>;
}

/** One issue URL, split into the repository it belongs to and its number. */
export function issueLocator(url: string): { repository: string; number: number } | null {
  const match =
    /^https?:\/\/([^/?#]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([0-9]+)(?:[/?#].*)?$/.exec(
      url.trim(),
    );
  if (match === null) return null;
  const host = (match[1] ?? "").toLowerCase();
  if (host.includes("gitlab")) return null;
  const number = Number(match[4]);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { repository: `${match[2]}/${match[3]}`, number };
}

/**
 * Whether a filed URL belongs to the issues the Gitea reader can serve:
 * another forge's URL is skipped instead of read by number.
 */
function servedBy(value: string, baseUrl: string): boolean {
  const issue = giteaOrigin(value);
  return issue !== undefined && issue === giteaOrigin(baseUrl);
}

export interface ForgeIssueReaderOptions {
  /** The checkout that resolves commits and release containment locally. */
  repoDir: string;
  environment?: Record<string, string | undefined>;
  /** Injectable forge command; defaults to the operator's `gh`. */
  run?: GitHubCommandRunner;
  /** Injectable transport for the Gitea API. */
  fetchImpl?: FetchLike;
}

function createGiteaIssueReader(
  options: ForgeIssueReaderOptions,
  remote: ForgeRemote,
): ForgeIssueReader {
  const environment = options.environment ?? process.env;
  const baseUrl = giteaBaseUrl(remote, environment);
  const token = configuredGiteaToken(environment);

  return {
    async project(urls: string[]): Promise<ForgeIssueFact[]> {
      if (baseUrl === undefined || baseUrl.length === 0) {
        throw new Error("the agent activity needs DEVBOARD_GITEA_URL for a Gitea origin");
      }
      const facts: ForgeIssueFact[] = [];
      // Releases are a per-repository read: one scan serves every closed issue
      // of that repository, and a second repository gets its own scan.
      const releases = new Map<string, GitHubRelease[]>();
      for (const url of urls) {
        // An issue filed through another forge cannot be read here; the read
        // still answers it, so the row stays listed without a state instead of
        // failing the whole projection.
        if (!servedBy(url, baseUrl)) {
          facts.push({ url, state: "unreadable", version: null });
          continue;
        }
        const locator = issueLocator(url);
        if (locator === null) throw new Error(`not a supported issue URL: ${url}`);
        const target: GiteaTarget = {
          baseUrl,
          project: locator.repository,
          ...(token === undefined ? {} : { token }),
        };
        const issue = await giteaJson<unknown>(
          target,
          `${repoPath(target)}/issues/${locator.number}`,
          undefined,
          options.fetchImpl,
        );
        const record = (typeof issue === "object" && issue !== null ? issue : {}) as Record<
          string,
          unknown
        >;
        const createdAt =
          typeof record.created_at === "string" && record.created_at.length > 0
            ? record.created_at
            : null;
        const closedAt =
          typeof record.closed_at === "string" && record.closed_at.length > 0
            ? record.closed_at
            : null;
        if (record.state !== "closed") {
          facts.push({ url, state: "pending", version: null });
          continue;
        }
        let published = releases.get(locator.repository);
        if (published === undefined) {
          published = await giteaListReleases(target, options.fetchImpl);
          releases.set(locator.repository, published);
        }
        const version = await shippedVersion(
          { number: locator.number, state: "closed", createdAt, closedAt },
          createGiteaVersionClient(target, options.repoDir, options.fetchImpl),
          published,
        );
        facts.push({ url, state: "implemented", version });
      }
      return facts;
    },
  };
}

/**
 * The live reader. Each issue's repository is taken from its own URL, so a
 * page stays correct when its table names issues outside the host origin.
 */
export function createForgeIssueReader(options: ForgeIssueReaderOptions): ForgeIssueReader {
  const remote = originForge(options.repoDir, options.environment);
  if (remote?.forge === "gitea") return createGiteaIssueReader(options, remote);
  const run = options.run ?? ((argv, environment) => ghCommand(argv, environment));
  const clients = new Map<string, RepositoryGitHub>();

  function client(repository: string): RepositoryGitHub {
    const existing = clients.get(repository);
    if (existing !== undefined) return existing;
    const created = createRepositoryGitHub({
      repository,
      repoDir: options.repoDir,
      run,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
    });
    clients.set(repository, created);
    return created;
  }

  return {
    async project(urls: string[]): Promise<ForgeIssueFact[]> {
      const releases = new Map<string, GitHubRelease[]>();
      const facts: ForgeIssueFact[] = [];
      for (const url of urls) {
        const locator = issueLocator(url);
        if (locator === null) {
          throw new Error(`not a GitHub issue URL: ${url}`);
        }
        const github = client(locator.repository);
        const { state, createdAt, closedAt } = await github.issueTimes(locator.number);
        if (state === "open") {
          facts.push({ url, state: "pending", version: null });
          continue;
        }
        let published = releases.get(locator.repository);
        if (published === undefined) {
          published = await github.listReleases();
          releases.set(locator.repository, published);
        }
        const version = await shippedVersion(
          { number: locator.number, state: "closed", createdAt, closedAt },
          github,
          published,
        );
        facts.push({ url, state: "implemented", version });
      }
      return facts;
    },
  };
}
