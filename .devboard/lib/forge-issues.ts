import { giteaBaseUrl } from "./forge";
import type { FetchLike } from "./gitea";
import {
  authEnvironment,
  isAuthFailure,
  resolveForgeAuth,
  type Exec,
  type ResolvedAuth,
} from "./forge-auth";
import {
  giteaCloseIssue,
  giteaCommentIssue,
  giteaCreateIssue,
  giteaEnsureLabel,
  giteaIssue,
  giteaIssueNumber,
  giteaLabels,
  giteaListIssues,
  type GiteaTarget,
  type GiteaIssueDocument,
} from "./gitea";
import { originForge } from "../issues/repository";

/**
 * The one forge issue client the Coach delivery and the Devboard MCP tools
 * share. It resolves the checkout's own origin and its authenticated account
 * through the harness forge-auth path, so a stale ambient token never decides
 * which identity writes.
 *
 * It supports GitHub and Gitea; a GitLab origin is refused rather than read
 * through an interface that cannot guarantee the same semantics.
 */

export type ForgeIssueState = "open" | "closed";

export interface ForgeIssueDocument {
  number: number;
  title: string;
  body: string;
  state: ForgeIssueState;
  labels: string[];
  url: string;
  createdAt: string | null;
}

export interface ForgeIssueSummary {
  number: number;
  title: string;
  state: ForgeIssueState;
  labels: string[];
  url: string;
  createdAt: string | null;
}

export interface CreateForgeIssueInput {
  title: string;
  body: string;
  labels?: string[];
}

export type CloseReason = "completed" | "not planned";

export interface ForgeIssues {
  readonly forge: "github" | "gitea";
  readonly repository: string;
  list(state: "open" | "closed" | "all", limit?: number): Promise<ForgeIssueSummary[]>;
  get(number: number): Promise<ForgeIssueDocument>;
  ensureLabel(name: string): Promise<void>;
  create(input: CreateForgeIssueInput): Promise<ForgeIssueDocument>;
  comment(target: number | string, body: string): Promise<void>;
  close(number: number, reason: CloseReason): Promise<ForgeIssueDocument>;
}

export interface ForgeCommandOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export type ForgeRunner = (
  argv: string[],
  stdin: string,
  environment: Record<string, string | undefined>,
) => Promise<ForgeCommandOutcome>;

export interface ForgeIssuesOptions {
  repoDir: string;
  environment?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  exec?: Exec;
  /** Test seam: replaces the forge CLI. */
  run?: ForgeRunner;
}

export class ForgeIssueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForgeIssueError";
  }
}

const bunExec: Exec = async (commandName, args, options) => {
  try {
    const child = Bun.spawn({
      cmd: [commandName, ...args],
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code, killed: false };
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      code: -1,
      killed: false,
    };
  }
};

const ghRunner: ForgeRunner = async (argv, stdin, environment) => {
  try {
    const child = Bun.spawn({
      cmd: ["gh", ...argv],
      stdin: Buffer.from(stdin),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...environment,
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        GIT_TERMINAL_PROMPT: "0",
        NO_COLOR: "1",
      },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  } catch (error) {
    return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
};

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

function labelsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const labels: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      labels.push(entry);
      continue;
    }
    if (typeof entry !== "object" || entry === null || !("name" in entry)) continue;
    if (typeof entry.name === "string") labels.push(entry.name);
  }
  return labels;
}

function stateOf(value: unknown): ForgeIssueState {
  return typeof value === "string" && value.toLowerCase() === "closed" ? "closed" : "open";
}

function githubDocument(value: unknown): ForgeIssueDocument {
  if (typeof value !== "object" || value === null) {
    throw new ForgeIssueError("the forge returned no issue document");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.number !== "number" || typeof record.title !== "string") {
    throw new ForgeIssueError("the forge returned an issue without a number or title");
  }
  return {
    number: record.number,
    title: record.title,
    body: typeof record.body === "string" ? record.body : "",
    state: stateOf(record.state),
    labels: labelsOf(record.labels),
    url: typeof record.url === "string" ? record.url : "",
    createdAt: typeof record.createdAt === "string" ? record.createdAt : null,
  };
}

function giteaDocument(document: GiteaIssueDocument): ForgeIssueDocument {
  return {
    number: document.number,
    title: document.title,
    body: document.body,
    state: document.state,
    labels: document.labels,
    url: document.url,
    createdAt: document.createdAt,
  };
}

function issueUrlNumber(url: string): number | undefined {
  const match = /\/issues\/(\d+)\/?$/.exec(url.trim());
  const number = match === null ? undefined : Number(match[1]);
  return number !== undefined && Number.isInteger(number) && number > 0 ? number : undefined;
}

/**
 * Resolves the origin, its authenticated account, and returns the shared
 * client. Throws `ForgeIssueError` naming the missing prerequisite.
 */
export function createForgeIssues(options: ForgeIssuesOptions): ForgeIssues {
  const environment = options.environment ?? process.env;
  const remote = originForge(options.repoDir, environment);
  if (remote === undefined) {
    throw new ForgeIssueError("the checkout's origin does not name a supported repository");
  }
  if (remote.forge === "gitlab") {
    throw new ForgeIssueError(`Issue tools support a GitHub or Gitea origin, not ${remote.host}`);
  }
  const forge = remote.forge;
  const run = options.run ?? ghRunner;
  const authCache = new Map<"read" | "write", Promise<ResolvedAuth>>();

  const auth = (required: "read" | "write"): Promise<ResolvedAuth> => {
    const cached = authCache.get(required);
    if (cached !== undefined) return cached;
    const pending = (async () => {
      const outcome = await resolveForgeAuth(options.exec ?? bunExec, {
        forge,
        host: remote.host,
        project: remote.project,
        cwd: options.repoDir,
        required,
        env: environment,
        ...(forge === "gitea"
          ? { baseUrl: giteaBaseUrl(remote, environment) ?? "" }
          : {}),
        ...(options.fetchImpl === undefined ? {} : { giteaFetch: options.fetchImpl }),
      });
      if (isAuthFailure(outcome)) {
        throw new ForgeIssueError(firstLine(outcome.error));
      }
      return outcome;
    })();
    authCache.set(required, pending);
    return pending;
  };

  const github = async (
    required: "read" | "write",
    argv: string[],
    stdin = "",
  ): Promise<ForgeCommandOutcome> => {
    const resolved = await auth(required);
    return run(argv, stdin, authEnvironment(resolved, environment));
  };

  const target = async (): Promise<GiteaTarget> => {
    const resolved = await auth("write");
    const baseUrl = resolved.baseUrl ?? giteaBaseUrl(remote, environment);
    if (baseUrl === undefined || baseUrl.length === 0) {
      throw new ForgeIssueError("the Gitea address is not configured");
    }
    return {
      baseUrl,
      project: remote.project,
      ...(resolved.token === undefined ? {} : { token: resolved.token }),
    };
  };

  const client: ForgeIssues = {
    forge,
    repository: remote.project,
    async list(state, limit = 100) {
      if (forge === "gitea") {
        const issues = await giteaListIssues(await target(), state, options.fetchImpl);
        return issues.slice(0, limit).map((issue) => ({
          number: issue.number,
          title: issue.title,
          state: issue.state,
          labels: issue.labels,
          url: issue.url,
          createdAt: issue.createdAt,
        }));
      }
      const states: Array<"open" | "closed"> =
        state === "all" ? ["open", "closed"] : [state];
      const rows: ForgeIssueSummary[] = [];
      for (const current of states) {
        const outcome = await github("read", [
          "issue",
          "list",
          "--repo",
          remote.project,
          "--state",
          current,
          "--limit",
          String(Math.max(1, Math.min(limit, 200))),
          "--json",
          "number,title,state,labels,url,createdAt",
        ]);
        if (outcome.code !== 0) {
          throw new ForgeIssueError(firstLine(outcome.stderr || outcome.stdout));
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(outcome.stdout);
        } catch {
          throw new ForgeIssueError("gh issue list returned invalid JSON");
        }
        if (!Array.isArray(parsed)) throw new ForgeIssueError("gh issue list returned no array");
        for (const entry of parsed) {
          if (typeof entry !== "object" || entry === null) continue;
          const record = entry as Record<string, unknown>;
          if (typeof record.number !== "number" || typeof record.title !== "string") continue;
          rows.push({
            number: record.number,
            title: record.title,
            state: stateOf(record.state),
            labels: labelsOf(record.labels),
            url: typeof record.url === "string" ? record.url : "",
            createdAt: typeof record.createdAt === "string" ? record.createdAt : null,
          });
        }
      }
      const seen = new Set<number>();
      return rows
        .filter((row) => {
          if (seen.has(row.number)) return false;
          seen.add(row.number);
          return true;
        })
        .slice(0, limit);
    },
    async get(number) {
      if (!Number.isInteger(number) || number <= 0) {
        throw new ForgeIssueError("An issue number must be a positive integer.");
      }
      if (forge === "gitea") {
        return giteaDocument(await giteaIssue(await target(), number, options.fetchImpl));
      }
      const outcome = await github("read", [
        "issue",
        "view",
        String(number),
        "--repo",
        remote.project,
        "--json",
        "number,title,body,state,labels,url,createdAt",
      ]);
      if (outcome.code !== 0) {
        throw new ForgeIssueError(firstLine(outcome.stderr || outcome.stdout));
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(outcome.stdout);
      } catch {
        throw new ForgeIssueError("gh issue view returned invalid JSON");
      }
      return githubDocument(parsed);
    },
    async ensureLabel(name) {
      if (forge === "gitea") {
        await giteaEnsureLabel(
          await target(),
          name,
          "1d76db",
          "Devboard goal specification",
          options.fetchImpl,
        );
        return;
      }
      const outcome = await github("write", [
        "label",
        "create",
        name,
        "--repo",
        remote.project,
        "--force",
        "--color",
        "1d76db",
        "--description",
        "Devboard goal specification",
      ]);
      if (outcome.code !== 0) {
        throw new ForgeIssueError(firstLine(outcome.stderr || outcome.stdout));
      }
    },
    async create(input) {
      if (forge === "gitea") {
        const gitea = await target();
        const labels =
          input.labels === undefined || input.labels.length === 0
            ? []
            : (await giteaLabels(gitea, options.fetchImpl))
                .filter((label) => input.labels?.includes(label.name))
                .map((label) => label.id);
        return giteaDocument(
          await giteaCreateIssue(
            gitea,
            { title: input.title, body: input.body, ...(labels.length === 0 ? {} : { labels }) },
            options.fetchImpl,
          ),
        );
      }
      const argv = [
        "issue",
        "create",
        "--repo",
        remote.project,
        "--title",
        input.title,
        "--body-file",
        "-",
      ];
      for (const label of input.labels ?? []) argv.push("--label", label);
      const outcome = await github("write", argv, input.body);
      if (outcome.code !== 0) {
        throw new ForgeIssueError(firstLine(outcome.stderr || outcome.stdout));
      }
      const url = outcome.stdout
        .split("\n")
        .map((line) => line.trim())
        .reverse()
        .find((line) => /^https?:\/\//.test(line));
      if (url === undefined) throw new ForgeIssueError("gh printed no issue URL");
      const number = issueUrlNumber(url);
      if (number === undefined) throw new ForgeIssueError("gh printed no issue number");
      return client.get(number);
    },
    async comment(targetValue, body) {
      const url = typeof targetValue === "string" ? targetValue : String(targetValue);
      if (forge === "gitea") {
        const gitea = await target();
        const number = giteaIssueNumber(gitea, url);
        if (number === undefined) {
          throw new ForgeIssueError(`not an issue in ${gitea.baseUrl}/${gitea.project}: ${url}`);
        }
        await giteaCommentIssue(gitea, number, body, options.fetchImpl);
        return;
      }
      const outcome = await github("write", [
        "issue",
        "comment",
        url,
        "--body-file",
        "-",
      ], body);
      if (outcome.code !== 0) {
        throw new ForgeIssueError(firstLine(outcome.stderr || outcome.stdout));
      }
    },
    async close(number, reason) {
      if (forge === "gitea") {
        await giteaCloseIssue(await target(), number, options.fetchImpl);
        return client.get(number);
      }
      const outcome = await github("write", [
        "issue",
        "close",
        String(number),
        "--repo",
        remote.project,
        "--reason",
        reason,
      ]);
      if (outcome.code !== 0) {
        throw new ForgeIssueError(firstLine(outcome.stderr || outcome.stdout));
      }
      return client.get(number);
    },
  };
  return client;
}
