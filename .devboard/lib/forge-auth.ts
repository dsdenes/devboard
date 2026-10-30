/**
 * Deterministic forge identity selection.
 *
 * The active `gh` account is not authoritative. A host can hold several
 * authenticated accounts, and `GH_TOKEN`/`GITHUB_TOKEN` (or the GitLab
 * equivalents) shadows all of them with a token that may be expired, belong to
 * another user, or lack access to the repository being worked on. Trusting
 * either one is how an agent ends up with a 401/403/404 on a tracker write.
 *
 * This module tests every reachable credential against the exact repository,
 * ranks the usable ones, and returns the strongest. Tokens are only ever
 * placed in a child process environment: they are never printed, never passed
 * as arguments, and never included in an error message.
 */

import { DEADLINE_EXPIRED, withinDeadline } from "./deadline";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export interface ExecOptions {
  /** Defaults to the caller's directory when omitted. */
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  /** Aborting kills the child; the probe then counts as failed. */
  signal?: AbortSignal;
  /** Written to the child's stdin, which is otherwise ignored. */
  stdin?: string;
}

/** Runs one command with an explicit environment; never throws for exit status. */
export type Exec = (
  command: string,
  args: string[],
  options: ExecOptions,
) => Promise<ExecResult>;

/** Default bound on one CLI child, used wherever a caller names none. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/**
 * One forge child or credential probe that outlived its deadline. The caller
 * reports the message and retries the operation; nothing was written.
 */
export class ForgeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForgeTimeoutError";
  }
}

/**
 * The handles a bounded child exposes. Bun's `Subprocess` satisfies it, so a
 * child spawned with or without stdin is terminated the same way.
 */
interface BoundedChild {
  readonly stdout: ReadableStream<Uint8Array<ArrayBuffer>>;
  readonly stderr: ReadableStream<Uint8Array<ArrayBuffer>>;
  readonly exited: Promise<number>;
  kill(exitCode?: number | NodeJS.Signals): void;
}

/** Kills a child; one that already exited is not an error. */
function terminate(child: Pick<BoundedChild, "kill">): void {
  try {
    child.kill("SIGKILL");
  } catch {
    // It exited between the guard and the signal.
  }
}

/**
 * Awaits one forge operation under a deadline. A promise that never settles —
 * a stalled child or credential helper — rejects with `ForgeTimeoutError`
 * instead of leaving its caller pending for the life of the process.
 */
export async function withForgeDeadline<T>(
  pending: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  const bound = Math.max(1, timeoutMs);
  const settled = await withinDeadline(pending, bound);
  if (settled === DEADLINE_EXPIRED) {
    throw new ForgeTimeoutError(`${operation} timed out after ${bound} ms; retry the request.`);
  }
  return settled;
}

/**
 * The one bounded `Exec` for the harness. It writes `stdin` when given, and
 * `timeout` and `signal` kill the child and settle at once with a killed
 * result: it never waits for pipes that a stalled peer or an inherited
 * grandchild could hold open after the child is gone.
 */
export const spawnExec: Exec = async (command, args, options) => {
  if (options.signal?.aborted) {
    return { stdout: "", stderr: "the command was aborted.", code: -1, killed: true };
  }
  let child: BoundedChild;
  try {
    child = Bun.spawn({
      cmd: [command, ...args],
      cwd: options.cwd,
      env: options.env,
      stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      code: -1,
      killed: false,
    };
  }

  let settled = false;
  const cancelled = Promise.withResolvers<ExecResult>();
  const stop = (message: string): void => {
    if (settled) return;
    settled = true;
    terminate(child);
    cancelled.resolve({ stdout: "", stderr: message, code: -1, killed: true });
  };
  const onAbort = (): void => stop("the command was aborted.");
  const timeoutMs = options.timeout === undefined ? undefined : Math.max(1, options.timeout);
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => stop(`the command timed out after ${timeoutMs} ms.`), timeoutMs);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const finished = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).then(([stdout, stderr, code]) => {
      settled = true;
      return { stdout, stderr, code, killed: code === 137 };
    });
    return await (timeoutMs === undefined && options.signal === undefined
      ? finished
      : Promise.race([finished, cancelled.promise]));
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      code: -1,
      killed: false,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
};

import {
  configuredGiteaUrl,
  GITEA_TOKEN_KEYS,
  type Forge as ForgeName,
} from "./forge";
import {
  giteaRepository,
  giteaUser,
  type FetchLike,
} from "./gitea";

export type Forge = ForgeName;
export type RequiredAccess = "read" | "write";
export type Permission = "admin" | "maintain" | "push" | "triage" | "pull" | "none";

export interface ResolvedAuth {
  forge: Forge;
  host: string;
  project: string;
  login: string;
  /**
   * Token to inject into the CLI child. Undefined means the CLI credential
   * store itself is authenticated and must be used without an override.
   */
  token?: string;
  /** Where the credential came from, for diagnostics. Never a token value. */
  source: string;
  /** Gitea HTTP origin, when the forge is Gitea. */
  baseUrl?: string;
  active: boolean;
  permission: Permission;
  canWrite: boolean;
}

export interface AuthFailure {
  error: string;
}

export type AuthOutcome = ResolvedAuth | AuthFailure;

export interface ResolveOptions {
  forge: Forge;
  host: string;
  project: string;
  cwd: string;
  required?: RequiredAccess;
  env?: Record<string, string | undefined>;
  /**
   * Absolute epoch deadline for the whole resolution. Every probe is bounded
   * by what remains, so one stalled credential helper cannot outlive it.
   */
  deadline?: number;
  /** Aborting kills the in-flight probe. */
  signal?: AbortSignal;
  /** Gitea HTTP origin; defaults to the environment or the origin remote. */
  baseUrl?: string;
  /** Injectable HTTP transport for the Gitea API. */
  giteaFetch?: FetchLike;
}

const GITHUB_TOKEN_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

const GITLAB_TOKEN_KEYS = [
  "GITLAB_TOKEN",
  "GITLAB_ACCESS_TOKEN",
  "OAUTH_TOKEN",
] as const;

const TOKEN_KEYS = [
  ...GITHUB_TOKEN_KEYS,
  ...GITLAB_TOKEN_KEYS,
  ...GITEA_TOKEN_KEYS,
] as const;

const CLI_ENV = {
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GIT_TERMINAL_PROMPT: "0",
  NO_COLOR: "1",
} as const;

interface Candidate {
  token: string;
  login?: string;
  source: string;
  active: boolean;
  fromEnvironment: boolean;
  order: number;
}

interface Inspected {
  login: string;
  token: string;
  source: string;
  active: boolean;
  fromEnvironment: boolean;
  order: number;
  permission: Permission;
  canWrite: boolean;
}

interface Diagnostic {
  label: string;
  detail: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The string-valued view of an environment, for a child's `env`. */
export function stringEnvironment(
  source: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source ?? process.env)) {
    if (typeof value === "string") environment[key] = value;
  }
  return environment;
}

function withoutTokens(base: Record<string, string>, forge: Forge): Record<string, string> {
  const environment = { ...base };
  const keys =
    forge === "github"
      ? GITHUB_TOKEN_KEYS
      : forge === "gitlab"
        ? GITLAB_TOKEN_KEYS
        : GITEA_TOKEN_KEYS;
  for (const key of keys) delete environment[key];
  return environment;
}

function firstLine(value: string): string {
  return (
    value
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

function probeOptions(
  options: ResolveOptions,
  env: Record<string, string>,
): ExecOptions {
  return {
    cwd: options.cwd,
    env,
    ...(options.deadline === undefined
      ? {}
      : { timeout: Math.max(1, options.deadline - Date.now()) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

async function attempt(
  exec: Exec,
  command: string,
  args: string[],
  options: ExecOptions,
): Promise<ExecResult> {
  try {
    return await exec(command, args, options);
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      code: -1,
      killed: false,
    };
  }
}

function parseObject(stdout: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function githubPermission(value: unknown): Permission {
  if (!isObject(value)) return "none";
  if (value.admin === true) return "admin";
  if (value.maintain === true) return "maintain";
  if (value.push === true) return "push";
  if (value.triage === true) return "triage";
  if (value.pull === true) return "pull";
  return "none";
}

function rank(permission: Permission): number {
  switch (permission) {
    case "admin":
      return 5;
    case "maintain":
      return 4;
    case "push":
      return 3;
    case "triage":
      return 2;
    case "pull":
      return 1;
    case "none":
      return 0;
  }
}

function selectBest(
  inspected: Inspected[],
  required: RequiredAccess,
  host: string,
  project: string,
  forge: Forge,
  diagnostics: Diagnostic[],
): AuthOutcome {
  for (const entry of inspected) {
    if (!entry.canWrite && required === "write") {
      diagnostics.push({
        label: `${entry.login} (${entry.source})`,
        detail: `${entry.permission} access only`,
      });
    }
  }
  const usable = inspected.filter((entry) =>
    required === "read" ? entry.permission !== "none" : entry.canWrite,
  );
  if (usable.length === 0) {
    const forgeName = forge === "github" ? "GitHub" : "GitLab";
    const lines = [
      `no authenticated ${forgeName} account has ${required} access to ${project} on ${host}`,
      ...diagnostics.map((entry) => `- ${entry.label}: ${entry.detail}`),
    ];
    if (forge === "github") {
      lines.push(
        `Run 'gh auth login --hostname ${host}' for an account with ${required} access to ${project}, ` +
          "or set GH_TOKEN to its token.",
      );
    } else {
      lines.push(
        `Run 'glab auth login --hostname ${host}' for an account with ${required} access to ${project}, ` +
          "or set GITLAB_TOKEN to its token.",
      );
    }
    return { error: lines.join("\n") };
  }

  usable.sort((left, right) => {
    const byPermission = rank(right.permission) - rank(left.permission);
    if (byPermission !== 0) return byPermission;
    const owner = project.split("/")[0]?.toLowerCase() ?? "";
    const byOwner =
      Number(right.login.toLowerCase() === owner) -
      Number(left.login.toLowerCase() === owner);
    if (byOwner !== 0) return byOwner;
    const byActive = Number(right.active) - Number(left.active);
    if (byActive !== 0) return byActive;
    const byEnvironment =
      Number(right.fromEnvironment) - Number(left.fromEnvironment);
    if (byEnvironment !== 0) return byEnvironment;
    return left.order - right.order;
  });

  const best = usable[0];
  if (best === undefined) {
    return { error: `no usable authenticated account for ${project} on ${host}` };
  }
  return {
    forge,
    host,
    project,
    login: best.login,
    token: best.token,
    source: best.source,
    active: best.active,
    permission: best.permission,
    canWrite: best.canWrite,
  };
}

function githubTokenEnvironment(
  base: Record<string, string>,
  host: string,
  token: string,
): Record<string, string> {
  const environment = withoutTokens(base, "github");
  if (host === "github.com") {
    environment.GH_TOKEN = token;
  } else {
    // Enterprise hosts read the enterprise variables; set GH_TOKEN too so an
    // ambient github.com token can never win the precedence check.
    environment.GH_ENTERPRISE_TOKEN = token;
    environment.GITHUB_ENTERPRISE_TOKEN = token;
    environment.GH_TOKEN = token;
  }
  environment.GH_HOST = host;
  return { ...environment, ...CLI_ENV };
}

interface GithubAccount {
  login: string;
  active: boolean;
  state: string;
  error: string;
}

function parseGithubAccounts(stdout: string, host: string): GithubAccount[] | undefined {
  const document = parseObject(stdout);
  if (document === undefined) return undefined;
  const hosts = document.hosts;
  if (!isObject(hosts)) return undefined;
  const entries = hosts[host] ?? hosts[host.toLowerCase()];
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) return undefined;
  const accounts: GithubAccount[] = [];
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    const login = typeof entry.login === "string" ? entry.login : "";
    const active = entry.active === true;
    const state = typeof entry.state === "string" ? entry.state : "";
    const error = typeof entry.error === "string" ? entry.error : "";
    accounts.push({ login, active, state, error });
  }
  return accounts;
}

function environmentCandidates(
  base: Record<string, string>,
  host: string,
  forge: "github" | "gitlab",
): Candidate[] {
  const names =
    forge === "github"
      ? host === "github.com"
        ? ["GH_TOKEN", "GITHUB_TOKEN"]
        : ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]
      : ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"];
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let order = 0;
  for (const name of names) {
    const token = base[name]?.trim();
    if (token === undefined || token.length === 0 || seen.has(token)) continue;
    seen.add(token);
    candidates.push({
      token,
      source: name,
      active: false,
      fromEnvironment: true,
      order: order++,
    });
  }
  return candidates;
}

async function inspectGithub(
  exec: Exec,
  options: ResolveOptions,
  base: Record<string, string>,
  candidate: Candidate,
): Promise<Inspected | Diagnostic> {
  const environment = githubTokenEnvironment(base, options.host, candidate.token);
  let login = candidate.login;
  if (login === undefined || login.length === 0) {
    const user = await attempt(
      exec,
      "gh",
      ["api", "--hostname", options.host, "user", "--jq", ".login"],
      probeOptions(options, environment),
    );
    if (user.code !== 0) {
      return {
        label: candidate.source,
        detail: `token rejected (${firstLine(user.stderr)})`,
      };
    }
    login = user.stdout.trim();
    if (login.length === 0) {
      return { label: candidate.source, detail: "token rejected (no user returned)" };
    }
  }

  const repository = await attempt(
    exec,
    "gh",
    [
      "api",
      "--hostname",
      options.host,
      `repos/${options.project}`,
      "--jq",
      ".permissions",
    ],
    probeOptions(options, environment),
  );
  if (repository.code !== 0) {
    const detail = firstLine(repository.stderr);
    const denied = /HTTP (403|404)/.test(detail) ? "no access" : "request failed";
    return { label: `${login} (${candidate.source})`, detail: `${denied} (${detail})` };
  }
  const parsed = parseObject(repository.stdout);
  if (parsed === undefined) {
    return {
      label: `${login} (${candidate.source})`,
      detail: "repository permission response was not JSON",
    };
  }
  const permission = githubPermission(parsed);
  if (permission === "none") {
    return { label: `${login} (${candidate.source})`, detail: "no repository access" };
  }
  return {
    login,
    token: candidate.token,
    source: candidate.source,
    active: candidate.active,
    fromEnvironment: candidate.fromEnvironment,
    order: candidate.order,
    permission,
    canWrite: permission !== "pull",
  };
}

async function resolveGithub(
  exec: Exec,
  options: ResolveOptions,
  base: Record<string, string>,
): Promise<AuthOutcome> {
  const required = options.required ?? "read";
  const diagnostics: Diagnostic[] = [];
  const candidates = environmentCandidates(base, options.host, "github");
  let order = candidates.length;

  const status = await attempt(
    exec,
    "gh",
    ["auth", "status", "--hostname", options.host, "--json", "hosts"],
    probeOptions(options, withoutTokens(base, "github")),
  );
  if (status.code !== 0 && status.stdout.trim().length === 0) {
    return { error: `gh is unavailable or failed: ${firstLine(status.stderr)}` };
  }
  const accounts = parseGithubAccounts(status.stdout, options.host);
  if (accounts === undefined) {
    return { error: "gh auth status returned an unexpected JSON shape" };
  }

  for (const account of accounts) {
    if (account.state !== "success" || account.login.length === 0) {
      const label = account.active ? "active account" : "gh account";
      const detail = account.error.length > 0 ? firstLine(account.error) : "authentication failed";
      diagnostics.push({ label, detail });
      continue;
    }
    const token = await attempt(
      exec,
      "gh",
      ["auth", "token", "--hostname", options.host, "--user", account.login],
      probeOptions(options, withoutTokens(base, "github")),
    );
    if (token.code !== 0 || token.stdout.trim().length === 0) {
      diagnostics.push({
        label: account.login,
        detail: `token unavailable (${firstLine(token.stderr) || "no token"})`,
      });
      continue;
    }
    candidates.push({
      token: token.stdout.trim(),
      login: account.login,
      source: "gh account",
      active: account.active,
      fromEnvironment: false,
      order: order++,
    });
  }

  if (candidates.length === 0) {
    const rationale =
      diagnostics.length > 0
        ? diagnostics.map((entry) => `- ${entry.label}: ${entry.detail}`)
        : ["- no authenticated account for the host"];
    return {
      error: [
        `no authenticated GitHub account is available for ${options.host}`,
        ...rationale,
        `Run 'gh auth login --hostname ${options.host}' for an account with access to ${options.project}.`,
      ].join("\n"),
    };
  }

  const inspected: Inspected[] = [];
  for (const candidate of candidates) {
    const result = await inspectGithub(exec, options, base, candidate);
    if ("permission" in result) {
      inspected.push(result);
    } else {
      diagnostics.push(result);
    }
  }

  return selectBest(
    inspected,
    required,
    options.host,
    options.project,
    "github",
    diagnostics,
  );
}

interface GitlabStatus {
  accounts: Candidate[];
  diagnostics: Diagnostic[];
}

function parseGitlabTokens(stdout: string): string[] {
  const tokens: string[] = [];
  for (const line of stdout.split("\n")) {
    const match = /(?:^|\s)Token:\s*(\S+)\s*$/.exec(line);
    const token = match?.[1]?.trim();
    if (token !== undefined && token.length > 0) tokens.push(token);
  }
  return [...new Set(tokens)];
}

async function gitlabStatus(
  exec: Exec,
  options: ResolveOptions,
  base: Record<string, string>,
): Promise<GitlabStatus> {
  const environment = withoutTokens(base, "gitlab");
  const status = await attempt(
    exec,
    "glab",
    ["auth", "status", "--hostname", options.host, "--show-token"],
    probeOptions(options, environment),
  );
  if (status.code !== 0 && status.stdout.trim().length === 0) {
    return {
      accounts: [],
      diagnostics: [
        { label: "glab", detail: firstLine(status.stderr) || "not authenticated" },
      ],
    };
  }
  const tokens = parseGitlabTokens(status.stdout);
  const accounts: Candidate[] = tokens.map((token, index) => ({
    token,
    source: "glab token",
    active: true,
    fromEnvironment: false,
    order: index,
  }));
  if (accounts.length === 0 && status.code === 0) {
    // The credential store is authenticated, but it did not expose a token.
    // Commands can still use it when no token override is present.
    accounts.push({
      token: "",
      source: "glab credential store",
      active: true,
      fromEnvironment: false,
      order: 0,
    });
  }
  return {
    accounts,
    diagnostics:
      status.code === 0
        ? []
        : [{ label: "glab", detail: firstLine(status.stderr) || "authentication failed" }],
  };
}

function gitlabPermission(value: unknown): Permission {
  if (!isObject(value)) return "none";
  const projectAccess = isObject(value.project_access)
    ? value.project_access.access_level
    : undefined;
  const groupAccess = isObject(value.group_access)
    ? value.group_access.access_level
    : undefined;
  const levels = [projectAccess, groupAccess].filter(
    (level): level is number => typeof level === "number",
  );
  const access = levels.length > 0 ? Math.max(...levels) : 0;
  if (access >= 50) return "admin";
  if (access >= 40) return "maintain";
  if (access >= 30) return "push";
  if (access >= 20) return "triage";
  if (access >= 10) return "pull";
  return "none";
}

function gitlabTokenEnvironment(
  base: Record<string, string>,
  host: string,
  token: string,
): Record<string, string> {
  const environment = withoutTokens(base, "gitlab");
  if (token.length > 0) environment.GITLAB_TOKEN = token;
  environment.GITLAB_HOST = host;
  return { ...environment, ...CLI_ENV };
}

async function inspectGitlab(
  exec: Exec,
  options: ResolveOptions,
  base: Record<string, string>,
  candidate: Candidate,
): Promise<Inspected | Diagnostic> {
  const environment = gitlabTokenEnvironment(base, options.host, candidate.token);
  const user = await attempt(
    exec,
    "glab",
    ["api", "--hostname", options.host, "user"],
    probeOptions(options, environment),
  );
  if (user.code !== 0) {
    return {
      label: candidate.source,
      detail: `token rejected (${firstLine(user.stderr)})`,
    };
  }
  const userDocument = parseObject(user.stdout);
  const login =
    userDocument !== undefined && typeof userDocument.username === "string"
      ? userDocument.username
      : "";
  if (login.length === 0) {
    return { label: candidate.source, detail: "token returned no username" };
  }

  const endpoint = `projects/${encodeURIComponent(options.project)}`;
  const project = await attempt(
    exec,
    "glab",
    ["api", "--hostname", options.host, endpoint],
    probeOptions(options, environment),
  );
  if (project.code !== 0) {
    const detail = firstLine(project.stderr);
    const denied = /(401|403|404)/.test(detail) ? "no access" : "request failed";
    return { label: `${login} (${candidate.source})`, detail: `${denied} (${detail})` };
  }
  const document = parseObject(project.stdout);
  if (document === undefined) {
    return {
      label: `${login} (${candidate.source})`,
      detail: "repository permission response was not JSON",
    };
  }
  let permission = gitlabPermission(document.permissions);
  if (permission === "none" && document.visibility === "public") {
    permission = "pull";
  }
  if (permission === "none") {
    return { label: `${login} (${candidate.source})`, detail: "no repository access" };
  }
  return {
    login,
    token: candidate.token,
    source: candidate.source,
    active: candidate.active,
    fromEnvironment: candidate.fromEnvironment,
    order: candidate.order,
    permission,
    canWrite: permission !== "pull",
  };
}

async function resolveGitlab(
  exec: Exec,
  options: ResolveOptions,
  base: Record<string, string>,
): Promise<AuthOutcome> {
  const required = options.required ?? "read";
  const diagnostics: Diagnostic[] = [];
  const candidates = environmentCandidates(base, options.host, "gitlab");
  const status = await gitlabStatus(exec, options, base);
  diagnostics.push(...status.diagnostics);
  let order = candidates.length;
  for (const account of status.accounts) {
    candidates.push({ ...account, order: order++ });
  }
  if (candidates.length === 0) {
    const rationale =
      diagnostics.length > 0
        ? diagnostics.map((entry) => `- ${entry.label}: ${entry.detail}`)
        : ["- no authenticated account for the host"];
    return {
      error: [
        `no authenticated GitLab account is available for ${options.host}`,
        ...rationale,
        `Run 'glab auth login --hostname ${options.host}' for an account with access to ${options.project}.`,
      ].join("\n"),
    };
  }

  const inspected: Inspected[] = [];
  for (const candidate of candidates) {
    const result = await inspectGitlab(exec, options, base, candidate);
    if ("permission" in result) {
      inspected.push(result);
    } else {
      diagnostics.push(result);
    }
  }

  return selectBest(
    inspected,
    required,
    options.host,
    options.project,
    "gitlab",
    diagnostics,
  );
}

function giteaPermission(value: unknown): Permission {
  if (!isObject(value)) return "none";
  if (value.admin === true) return "admin";
  if (value.push === true) return "push";
  if (value.pull === true) return "pull";
  return "none";
}

function giteaFailure(message: string): AuthFailure {
  return { error: message };
}

/**
 * Gitea is resolved through its public API: an anonymous read proves a public
 * repository, and a token proves the account, its repository access, and its
 * write permission. No CLI is required.
 */
async function resolveGitea(
  options: ResolveOptions,
  base: Record<string, string>,
): Promise<AuthOutcome> {
  const required = options.required ?? "read";
  const baseUrl = (
    options.baseUrl ??
    configuredGiteaUrl(base) ??
    ""
  ).replace(/\/+$/, "");
  if (baseUrl.length === 0) {
    return giteaFailure(
      `no Gitea address is configured for ${options.host}; set DEVBOARD_GITEA_URL`,
    );
  }
  const token =
    (options.env?.GITEA_TOKEN ?? options.env?.DEVBOARD_GITEA_TOKEN ?? "").trim();
  const target = {
    baseUrl,
    project: options.project,
    ...(token.length === 0 ? {} : { token }),
  };
  const fetchImpl = options.giteaFetch ?? fetch;

  try {
    const repository = await giteaRepository(target, fetchImpl);
    const permission = giteaPermission(repository.permissions);
    if (token.length === 0) {
      if (permission === "none") {
        return giteaFailure(
          `no Gitea credential is configured for ${options.project} on ${baseUrl}, ` +
            "and the repository is not public",
        );
      }
      if (required === "write") {
        return giteaFailure(
          `no Gitea credential is configured for ${options.project} on ${baseUrl}; ` +
            "writing needs GITEA_TOKEN",
        );
      }
      return {
        forge: "gitea",
        host: options.host,
        project: options.project,
        login: "anonymous",
        source: "public repository",
        active: true,
        permission,
        canWrite: false,
        baseUrl,
      };
    }
    const login = await giteaUser(target, fetchImpl);
    if (login.length === 0) {
      return giteaFailure(`the Gitea token returned no account for ${baseUrl}`);
    }
    if (permission === "none") {
      return giteaFailure(
        `the Gitea account ${login} has no access to ${options.project} on ${baseUrl}`,
      );
    }
    if (required === "write" && permission === "pull") {
      return giteaFailure(
        `the Gitea account ${login} cannot write to ${options.project} on ${baseUrl}`,
      );
    }
    return {
      forge: "gitea",
      host: options.host,
      project: options.project,
      login,
      token,
      source: "GITEA_TOKEN",
      active: true,
      permission,
      canWrite: permission !== "pull",
      baseUrl,
    };
  } catch (error) {
    return giteaFailure(
      `could not resolve Gitea access for ${options.project} on ${baseUrl}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

/**
 * Resolve the one credential the lifecycle should use for a project.
 *
 * Accounts are tested against the project itself, not against the host: a
 * token can be valid for the host and still have no access to this repository.
 * Candidates are ranked by capability first, then repository ownership, then
 * the `gh` active account, then explicit environment tokens.
 */
export async function resolveForgeAuth(
  exec: Exec,
  options: ResolveOptions,
): Promise<AuthOutcome> {
  const base = stringEnvironment(options.env);
  if (options.forge === "github") return resolveGithub(exec, options, base);
  if (options.forge === "gitlab") return resolveGitlab(exec, options, base);
  return resolveGitea(options, base);
}

export function isAuthFailure(value: AuthOutcome): value is AuthFailure {
  return "error" in value;
}

/**
 * Environment for one forge command. The selected credential wins over every
 * ambient token, and the host is pinned so `GH_HOST` cannot redirect it.
 */
export function authEnvironment(
  auth: ResolvedAuth,
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const environment = stringEnvironment(base);
  if (auth.forge === "github") {
    for (const key of GITHUB_TOKEN_KEYS) delete environment[key];
    if (auth.token === undefined) {
      throw new Error("GitHub auth resolution returned no token");
    }
    if (auth.host === "github.com") {
      environment.GH_TOKEN = auth.token;
    } else {
      environment.GH_ENTERPRISE_TOKEN = auth.token;
      environment.GITHUB_ENTERPRISE_TOKEN = auth.token;
      environment.GH_TOKEN = auth.token;
    }
    environment.GH_HOST = auth.host;
  } else if (auth.forge === "gitlab") {
    for (const key of GITLAB_TOKEN_KEYS) delete environment[key];
    if (auth.token !== undefined && auth.token.length > 0) {
      environment.GITLAB_TOKEN = auth.token;
    }
    environment.GITLAB_HOST = auth.host;
  } else {
    for (const key of GITEA_TOKEN_KEYS) delete environment[key];
    if (auth.token !== undefined && auth.token.length > 0) {
      environment.GITEA_TOKEN = auth.token;
    }
    if (auth.baseUrl !== undefined && auth.baseUrl.length > 0) {
      environment.DEVBOARD_GITEA_URL = auth.baseUrl;
    }
  }
  return { ...environment, ...CLI_ENV };
}

/**
 * Apply the selection to this process so every child (extension calls and the
 * agent's shell) sees the same identity. Pinning `GH_HOST` prevents an ambient
 * host override from sending the token to a different instance.
 */
export function applyAuthToProcess(auth: ResolvedAuth): void {
  const environment = authEnvironment(auth, process.env);
  for (const key of [
    ...TOKEN_KEYS,
    "GH_HOST",
    "GITLAB_HOST",
    "DEVBOARD_GITEA_URL",
  ] as const) {
    delete process.env[key];
  }
  for (const key of [
    ...TOKEN_KEYS,
    "GH_HOST",
    "GITLAB_HOST",
    "DEVBOARD_GITEA_URL",
    ...Object.keys(CLI_ENV),
  ] as const) {
    const value = environment[key];
    if (value !== undefined) process.env[key] = value;
  }
}
