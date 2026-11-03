/**
 * `/implement-next-epic [ref]` — read one open epic created by `/epic-next`
 * and start it as an omp goal in the current session.
 *
 * The server gives every implementation lane exactly one epic reference, so a
 * lane never selects a different epic. With no reference the command accepts
 * the single open epic and refuses (listing the URLs) when several are open.
 *
 * Goal mode's `goal` tool is not part of the default tool set. A file-based
 * slash command cannot add it, so this command is registered by a small
 * project-local extension instead: it selects the epic, prepares the
 * worktree, activates the `goal` tool, and hands the objective to the model
 * with an instruction to create the goal before implementing.
 *
 * This file is deliberately self-contained. The harness runtime is moving to
 * the Rust binary, so an omp extension may only use the globals the host
 * provides (`fetch`, `URL`, timers, the ambient process) and the exec seam the
 * host injects. It therefore carries its own copies of forge remote parsing,
 * credential selection, Gitea reads, and worktree planning instead of
 * importing the harness runtime modules.
 *
 * Harness rules: this file lives under `.devboard/`; the only host-side file
 * is the thin wrapper at `.omp/extensions/implement-next-epic.ts`.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

/** Runs one command; the host injects it and tests replace it. */
export type Exec = (command: string, args: string[], options: ExecOptions) => Promise<ExecResult>;

export interface ExtensionAPI {
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    },
  ): void;
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  getActiveTools(): string[];
  getAllTools(): Array<{ name: string }>;
  setActiveTools(names: string[]): Promise<void>;
  sendUserMessage(content: string): void;
}

export interface ModeChangeEntry {
  type: string;
  mode?: string;
  data?: Record<string, unknown> | null;
}

export interface ExtensionCommandContext {
  cwd: string;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
  sessionManager: {
    getBranch(): ModeChangeEntry[];
  };
  waitForIdle?(): Promise<void>;
}

interface ProcessLike {
  env: Record<string, string | undefined>;
  stderr?: { write(chunk: string): unknown };
}

/**
 * The host's process object, read through `globalThis` so this file
 * type-checks and runs without Node or Bun type declarations. The cast names
 * the one field used; nothing else from Node's process is assumed.
 */
const hostGlobal = globalThis as unknown as { process?: ProcessLike };

function processHandle(): ProcessLike | undefined {
  return hostGlobal.process;
}

/** The ambient environment, or an empty map when the host exposes none. */
export function processEnvironment(): Record<string, string | undefined> {
  return processHandle()?.env ?? {};
}

/** Best-effort diagnostic write; a closed stderr never changes an outcome. */
export function writeStderr(message: string): void {
  try {
    processHandle()?.stderr?.write(message);
  } catch {
    // A closed stderr must not change the command's outcome.
  }
}

export type Forge = "github" | "gitlab" | "gitea";

export interface ForgeRemote {
  forge: Forge;
  /** Hostname only; no credentials and no port. */
  host: string;
  /** Repository path without a leading slash or a trailing `.git`. */
  project: string;
  /** Instance address for an HTTP(S) remote, without a trailing slash. */
  originUrl?: string;
}

export interface RemoteInfo {
  host: string;
  project: string;
  forge: Forge;
  /** The authenticated account selected for this repository. */
  login?: string;
  /** Gitea HTTP origin, when the forge is Gitea. */
  baseUrl?: string;
}

export interface EpicSummary {
  ref: number;
  title: string;
  url: string;
}

export interface Epic extends EpicSummary {
  body: string;
}

export interface RunResult {
  ok: boolean;
  message: string;
  epic?: Epic;
  objective?: string;
  worktree?: string;
  branch?: string;
  prompt?: string;
}

export interface Failure {
  error: string;
}

export type Outcome<T> = T | Failure;

export function isFailure<T>(value: Outcome<T>): value is Failure {
  return typeof value === "object" && value !== null && "error" in value;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function firstLine(value: string): string {
  return value.trim().split("\n")[0]?.trim() ?? "";
}

/** Every credential diagnostic falls back to the same text. */
function diagnosticLine(value: string): string {
  return firstLine(value) || "no diagnostic";
}

function parseJsonArray(stdout: string): unknown[] | null {
  try {
    const value: unknown = JSON.parse(stdout);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function parseJsonObject(stdout: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stdout);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** Composes an absolute path without the Node path module. */
function joinPath(base: string, ...parts: string[]): string {
  const root = base.replace(/\/+$/, "");
  return [root, ...parts].join("/");
}

export async function run(
  pi: ExtensionAPI,
  command: string,
  args: string[],
  cwd: string,
): Promise<ExecResult> {
  try {
    return await pi.exec(command, args, { cwd, timeout: 120_000 });
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      code: -1,
      killed: false,
    };
  }
}

const GITHUB_TOKEN_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

const GITLAB_TOKEN_KEYS = ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"] as const;

const GITEA_TOKEN_KEYS = ["GITEA_TOKEN", "DEVBOARD_GITEA_TOKEN"] as const;

const GITEA_URL_KEYS = ["DEVBOARD_GITEA_URL", "GITEA_URL"] as const;

const TOKEN_KEYS = [...GITHUB_TOKEN_KEYS, ...GITLAB_TOKEN_KEYS, ...GITEA_TOKEN_KEYS] as const;

const CLI_ENV = {
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GIT_TERMINAL_PROMPT: "0",
  NO_COLOR: "1",
} as const;

/**
 * The keys a credential probe may add, change, or remove. The host's exec seam
 * cannot take an environment, so a probe borrows the ambient process
 * environment for the duration of one child; only these keys ever differ.
 */
const PROBE_ENV_KEYS = [
  ...TOKEN_KEYS,
  "GH_HOST",
  "GITLAB_HOST",
  "DEVBOARD_GITEA_URL",
  "GH_PROMPT_DISABLED",
  "GH_NO_UPDATE_NOTIFIER",
  "GIT_TERMINAL_PROMPT",
  "NO_COLOR",
] as const;

/**
 * Binds the host's exec seam to an `Exec` that honours `options.env` by
 * swapping only the credential keys around the child, restoring them after.
 */
export function environmentExec(pi: ExtensionAPI): Exec {
  return async (command, args, options) => {
    const handle = processHandle();
    if (options.env === undefined || handle === undefined) {
      return await run(pi, command, args, options.cwd ?? "");
    }
    const saved = new Map<string, string | undefined>();
    for (const key of PROBE_ENV_KEYS) {
      saved.set(key, handle.env[key]);
      const value = options.env[key];
      if (value === undefined) delete handle.env[key];
      else handle.env[key] = value;
    }
    try {
      return await run(pi, command, args, options.cwd ?? "");
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete handle.env[key];
        else handle.env[key] = value;
      }
    }
  };
}

function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const result = value.trim().replace(/\/+$/, "");
  return result.length > 0 ? result : undefined;
}

/** The Gitea HTTP origin the environment configures, if any. */
export function configuredGiteaUrl(
  environment: Record<string, string | undefined> = processEnvironment(),
): string | undefined {
  for (const key of GITEA_URL_KEYS) {
    const value = trimmed(environment[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** The Gitea token the environment configures, if any. */
export function configuredGiteaToken(
  environment: Record<string, string | undefined> = processEnvironment(),
): string | undefined {
  for (const key of GITEA_TOKEN_KEYS) {
    const value = trimmed(environment[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

const PROJECT_SEGMENT = /^[A-Za-z0-9_.-]+$/;

function pathSegments(path: string): string[] {
  return path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter((segment) => segment.length > 0);
}

/**
 * The repository path a forge addresses. GitHub and Gitea name exactly
 * `owner/name`, so only the final two segments count. A GitLab project lives
 * under a namespace that may carry subgroups, so every segment is the path.
 */
export function projectFromPath(path: string, forge: Forge): string | undefined {
  const segments = pathSegments(path);
  if (segments.length < 2) return undefined;
  const kept = forge === "gitlab" ? segments : segments.slice(-2);
  if (!kept.every((segment) => PROJECT_SEGMENT.test(segment))) return undefined;
  return kept.join("/");
}

/** The path prefix an HTTP(S) repository path sits under. */
function instancePrefix(path: string, forge: Forge): string {
  const segments = pathSegments(path);
  const kept = forge === "gitlab" ? segments.length : 2;
  const prefix = segments.slice(0, segments.length - kept);
  return prefix.length === 0 ? "" : `/${prefix.join("/")}`;
}

/** The forge a hostname names. An explicit `DEVBOARD_FORGE` always wins. */
function forgeFromHost(
  host: string,
  environment: Record<string, string | undefined>,
): Forge {
  const lower = host.toLowerCase();
  const forced = trimmed(environment.DEVBOARD_FORGE)?.toLowerCase();
  if (forced === "github" || forced === "gitlab" || forced === "gitea") return forced;
  if (lower === "github.com") return "github";
  return lower.includes("gitlab") ? "gitlab" : "gitea";
}

/**
 * Classifies a git remote. `undefined` for a local path or a remote without a
 * repository path. An explicit `DEVBOARD_FORGE` pins a self-hosted forge.
 */
export function parseForgeRemote(
  remote: string,
  environment: Record<string, string | undefined> = processEnvironment(),
): ForgeRemote | undefined {
  const value = remote.trim();
  if (value.length === 0 || value.startsWith("/") || value.startsWith(".")) return undefined;

  let host = "";
  let path = "";
  let httpOrigin: string | undefined;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value);
  if (scp !== null && !value.includes("://")) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return undefined;
    }
    if (!["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) return undefined;
    host = parsed.hostname;
    path = parsed.pathname;
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      httpOrigin = parsed.origin;
    }
  }

  if (host.length === 0) return undefined;
  const forge = forgeFromHost(host, environment);
  const project = projectFromPath(path, forge);
  if (project === undefined) return undefined;

  return {
    forge,
    host: host.toLowerCase(),
    project,
    ...(httpOrigin === undefined
      ? {}
      : { originUrl: `${httpOrigin}${instancePrefix(path, forge)}` }),
  };
}

/** The Gitea instance address for a resolved remote, configuration first. */
export function giteaBaseUrl(
  remote: ForgeRemote | undefined,
  environment: Record<string, string | undefined> = processEnvironment(),
): string | undefined {
  const configured = configuredGiteaUrl(environment);
  if (configured !== undefined) return configured;
  if (remote !== undefined && remote.forge === "gitea") return remote.originUrl;
  return undefined;
}

export type RequiredAccess = "read" | "write";
export type Permission = "admin" | "maintain" | "push" | "triage" | "pull" | "none";

export interface ResolvedAuth {
  forge: Forge;
  host: string;
  project: string;
  login: string;
  /** Token to inject into the CLI child; undefined means the CLI store wins. */
  token?: string;
  /** Where the credential came from, for diagnostics. Never a token value. */
  source: string;
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
  /** Gitea HTTP origin; defaults to the environment or the origin remote. */
  baseUrl?: string;
  /** Injectable HTTP transport for the Gitea API. */
  giteaFetch?: FetchLike;
}

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

/** The string-valued view of an environment, for a child's `env`. */
function stringEnvironment(
  source: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source ?? processEnvironment())) {
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

function probeOptions(options: ResolveOptions, env: Record<string, string>): ExecOptions {
  return { cwd: options.cwd, env };
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

/**
 * Ranks every credential that could reach the repository and returns the
 * strongest one, or the diagnostics explaining why none qualifies.
 */
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
      Number(right.login.toLowerCase() === owner) - Number(left.login.toLowerCase() === owner);
    if (byOwner !== 0) return byOwner;
    const byActive = Number(right.active) - Number(left.active);
    if (byActive !== 0) return byActive;
    const byEnvironment = Number(right.fromEnvironment) - Number(left.fromEnvironment);
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
    // Enterprise hosts read the enterprise variables; GH_TOKEN is pinned too
    // so an ambient github.com token can never win the precedence check.
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
  const document = parseJsonObject(stdout);
  if (document === null) return undefined;
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
        detail: `token rejected (${diagnosticLine(user.stderr)})`,
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
    ["api", "--hostname", options.host, `repos/${options.project}`, "--jq", ".permissions"],
    probeOptions(options, environment),
  );
  if (repository.code !== 0) {
    const detail = diagnosticLine(repository.stderr);
    const denied = /HTTP (403|404)/.test(detail) ? "no access" : "request failed";
    return { label: `${login} (${candidate.source})`, detail: `${denied} (${detail})` };
  }
  const parsed = parseJsonObject(repository.stdout);
  if (parsed === null) {
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
    return { error: `gh is unavailable or failed: ${diagnosticLine(status.stderr)}` };
  }
  const accounts = parseGithubAccounts(status.stdout, options.host);
  if (accounts === undefined) {
    return { error: "gh auth status returned an unexpected JSON shape" };
  }

  for (const account of accounts) {
    if (account.state !== "success" || account.login.length === 0) {
      const label = account.active ? "active account" : "gh account";
      const detail = account.error.length > 0 ? firstLine(account.error) : "authentication failed";
      diagnostics.push({ label, detail: detail || "authentication failed" });
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

  return selectBest(inspected, required, options.host, options.project, "github", diagnostics);
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
  const status = await attempt(
    exec,
    "glab",
    ["auth", "status", "--hostname", options.host, "--show-token"],
    probeOptions(options, withoutTokens(base, "gitlab")),
  );
  if (status.code !== 0 && status.stdout.trim().length === 0) {
    return {
      accounts: [],
      diagnostics: [{ label: "glab", detail: diagnosticLine(status.stderr) }],
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
    // The credential store is authenticated but exposed no token. Commands can
    // still use it when no token override is present.
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
      status.code === 0 ? [] : [{ label: "glab", detail: diagnosticLine(status.stderr) }],
  };
}

function gitlabPermission(value: unknown): Permission {
  if (!isObject(value)) return "none";
  const projectAccess = isObject(value.project_access)
    ? value.project_access.access_level
    : undefined;
  const groupAccess = isObject(value.group_access) ? value.group_access.access_level : undefined;
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
    return { label: candidate.source, detail: `token rejected (${diagnosticLine(user.stderr)})` };
  }
  const userDocument = parseJsonObject(user.stdout);
  const login =
    userDocument !== null && typeof userDocument.username === "string"
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
    const detail = diagnosticLine(project.stderr);
    const denied = /(401|403|404)/.test(detail) ? "no access" : "request failed";
    return { label: `${login} (${candidate.source})`, detail: `${denied} (${detail})` };
  }
  const document = parseJsonObject(project.stdout);
  if (document === null) {
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

  return selectBest(inspected, required, options.host, options.project, "gitlab", diagnostics);
}

function giteaPermission(value: unknown): Permission {
  if (!isObject(value)) return "none";
  if (value.admin === true) return "admin";
  if (value.push === true) return "push";
  if (value.pull === true) return "pull";
  return "none";
}

/**
 * Gitea is resolved through its public API: an anonymous read proves a public
 * repository, and a token proves the account, its access, and its write bit.
 * No CLI is required.
 */
async function resolveGitea(
  options: ResolveOptions,
  base: Record<string, string>,
): Promise<AuthOutcome> {
  const required = options.required ?? "read";
  const baseUrl = (options.baseUrl ?? configuredGiteaUrl(base) ?? "").replace(/\/+$/, "");
  if (baseUrl.length === 0) {
    return {
      error: `no Gitea address is configured for ${options.host}; set DEVBOARD_GITEA_URL`,
    };
  }
  const token = (base.GITEA_TOKEN ?? base.DEVBOARD_GITEA_TOKEN ?? "").trim();
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
        return {
          error:
            `no Gitea credential is configured for ${options.project} on ${baseUrl}, ` +
            "and the repository is not public",
        };
      }
      if (required === "write") {
        return {
          error:
            `no Gitea credential is configured for ${options.project} on ${baseUrl}; ` +
            "writing needs GITEA_TOKEN",
        };
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
      return { error: `the Gitea token returned no account for ${baseUrl}` };
    }
    if (permission === "none") {
      return {
        error: `the Gitea account ${login} has no access to ${options.project} on ${baseUrl}`,
      };
    }
    if (required === "write" && permission === "pull") {
      return {
        error: `the Gitea account ${login} cannot write to ${options.project} on ${baseUrl}`,
      };
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
    return {
      error:
        `could not resolve Gitea access for ${options.project} on ${baseUrl}: ` +
        (error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * Resolve the one credential the lifecycle should use for a project.
 * Accounts are tested against the project itself, not against the host.
 */
export async function resolveForgeAuth(
  exec: Exec,
  options: ResolveOptions,
): Promise<AuthOutcome> {
  const base = stringEnvironment(options.env ?? processEnvironment());
  if (options.forge === "github") return await resolveGithub(exec, options, base);
  if (options.forge === "gitlab") return await resolveGitlab(exec, options, base);
  return await resolveGitea(options, base);
}

export function isAuthFailure(value: AuthOutcome): value is AuthFailure {
  return "error" in value;
}

/**
 * Environment for one forge command. The selected credential wins over every
 * ambient token, and the host is pinned so `GH_HOST` cannot redirect it.
 */
function authEnvironment(
  auth: ResolvedAuth,
  base: Record<string, string | undefined>,
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
  const handle = processHandle();
  if (handle === undefined) return;
  const environment = authEnvironment(auth, handle.env);
  for (const key of [...TOKEN_KEYS, "GH_HOST", "GITLAB_HOST", "DEVBOARD_GITEA_URL"] as const) {
    delete handle.env[key];
  }
  for (const key of [
    ...TOKEN_KEYS,
    "GH_HOST",
    "GITLAB_HOST",
    "DEVBOARD_GITEA_URL",
    ...Object.keys(CLI_ENV),
  ] as const) {
    const value = environment[key];
    if (value !== undefined) handle.env[key] = value;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GiteaTarget {
  /** HTTP origin, without a trailing slash. */
  baseUrl: string;
  /** `owner/name`. */
  project: string;
  token?: string;
}

export interface GiteaIssueDocument {
  number: number;
  title: string;
  url: string;
  body: string;
  labels: string[];
}

/** Gitea caps one response at 50 items unless the server is configured higher. */
const GITEA_PAGE_SIZE = 50;
const GITEA_MAX_PAGES = 100;
const GITEA_REQUEST_TIMEOUT_MS = 30_000;

export class GiteaError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GiteaError";
    this.status = status;
  }
}

/** Resolves the API target from explicit arguments and the environment. */
export function giteaTarget(options: {
  project?: string;
  baseUrl?: string;
  token?: string;
  environment?: Record<string, string | undefined>;
}): GiteaTarget | undefined {
  const environment = options.environment ?? processEnvironment();
  const project = (options.project ?? "").trim();
  const baseUrl = (options.baseUrl ?? configuredGiteaUrl(environment) ?? "").replace(/\/+$/, "");
  if (project.length === 0 || baseUrl.length === 0) return undefined;
  const token = options.token ?? configuredGiteaToken(environment);
  return {
    baseUrl,
    project,
    ...(token === undefined ? {} : { token }),
  };
}

/** `/api/v1` under the configured origin. */
export function apiUrl(target: GiteaTarget, path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${target.baseUrl}/api/v1${suffix}`;
}

/** `/repos/<owner>/<name>` with each path segment encoded. */
export function repoPath(target: GiteaTarget): string {
  const segments = target.project.split("/").map(encodeURIComponent);
  return `/repos/${segments.join("/")}`;
}

function messageFromBody(body: string): string {
  const first = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (first === undefined) return "no response body";
  try {
    const parsed: unknown = JSON.parse(first);
    if (isObject(parsed) && typeof parsed.message === "string") return parsed.message;
  } catch {
    // The body is not JSON; the bounded first line is the diagnostic.
  }
  return first.length > 300 ? `${first.slice(0, 300)}…` : first;
}

/** One API call; a non-2xx status becomes a GiteaError with the server message. */
async function giteaRequest(
  target: GiteaTarget,
  path: string,
  init: RequestInit | undefined,
  fetchImpl: FetchLike,
  accept = "application/json",
): Promise<Response> {
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  headers.set("Accept", accept);
  if (target.token !== undefined && target.token.length > 0) {
    headers.set("Authorization", `token ${target.token}`);
  }
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITEA_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(apiUrl(target, path), {
      ...init,
      method,
      headers,
      signal: controller.signal,
    });
    if (response.ok) return response;
    const body = await response.text().catch(() => "");
    throw new GiteaError(
      `${method} ${path} failed (HTTP ${response.status}): ${messageFromBody(body)}`,
      response.status,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** One JSON API call. */
async function giteaJson<T>(
  target: GiteaTarget,
  path: string,
  init: RequestInit | undefined,
  fetchImpl: FetchLike,
): Promise<T> {
  const response = await giteaRequest(target, path, init, fetchImpl);
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const first = text.trim().split("\n")[0]?.trim() ?? "";
    const snippet = first.length === 0 ? "no output" : first.length > 300 ? `${first.slice(0, 300)}…` : first;
    throw new GiteaError(`${init?.method ?? "GET"} ${path} returned invalid JSON: ${snippet}`);
  }
}

/** The repository document, whose `permissions` object the auth probe reads. */
export async function giteaRepository(
  target: GiteaTarget,
  fetchImpl: FetchLike = fetch,
): Promise<{ permissions?: unknown }> {
  return await giteaJson<{ permissions?: unknown }>(target, repoPath(target), undefined, fetchImpl);
}

/** The account a token belongs to. */
export async function giteaUser(
  target: GiteaTarget,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const document = await giteaJson<{ login?: unknown }>(target, "/user", undefined, fetchImpl);
  return typeof document.login === "string" ? document.login : "";
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const label of value) {
    if (typeof label === "string") names.push(label);
    else if (isObject(label) && typeof label.name === "string") names.push(label.name);
  }
  return names;
}

function issueFromDocument(value: unknown): GiteaIssueDocument | undefined {
  if (!isObject(value)) return undefined;
  if (
    typeof value.number !== "number" ||
    !Number.isInteger(value.number) ||
    typeof value.title !== "string" ||
    typeof value.html_url !== "string"
  ) {
    return undefined;
  }
  return {
    number: value.number,
    title: value.title,
    url: value.html_url,
    body: typeof value.body === "string" ? value.body : "",
    labels: labelNames(value.labels),
  };
}

/** One issue by number, with its labels and body. */
export async function giteaIssue(
  target: GiteaTarget,
  number: number,
  fetchImpl: FetchLike = fetch,
): Promise<GiteaIssueDocument> {
  const document = await giteaJson<unknown>(
    target,
    `${repoPath(target)}/issues/${number}`,
    undefined,
    fetchImpl,
  );
  const issue = issueFromDocument(document);
  if (issue === undefined) throw new GiteaError("the issue has no number, title, or URL");
  return issue;
}

/** Every issue in the requested state, pull requests excluded, ascending by number. */
export async function giteaListIssues(
  target: GiteaTarget,
  state: "open" | "closed" | "all",
  fetchImpl: FetchLike = fetch,
): Promise<GiteaIssueDocument[]> {
  const issues: GiteaIssueDocument[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= GITEA_MAX_PAGES; page += 1) {
    const document = await giteaJson<unknown>(
      target,
      `${repoPath(target)}/issues?state=${state}&type=issues&limit=${GITEA_PAGE_SIZE}&page=${page}`,
      undefined,
      fetchImpl,
    );
    if (!Array.isArray(document) || document.length === 0) break;
    let added = 0;
    for (const entry of document) {
      const issue = issueFromDocument(entry);
      if (issue === undefined || seen.has(issue.number)) continue;
      seen.add(issue.number);
      issues.push(issue);
      added += 1;
    }
    // A server that ignores the page parameter repeats the first response;
    // treating a page without new issues as the end keeps this loop finite.
    if (added === 0) break;
  }
  return issues.sort((left, right) => left.number - right.number);
}

export interface GiteaLabel {
  id: number;
  name: string;
}

export async function giteaLabels(
  target: GiteaTarget,
  fetchImpl: FetchLike = fetch,
): Promise<GiteaLabel[]> {
  const labels: GiteaLabel[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= GITEA_MAX_PAGES; page += 1) {
    const document = await giteaJson<unknown>(
      target,
      `${repoPath(target)}/labels?limit=${GITEA_PAGE_SIZE}&page=${page}`,
      undefined,
      fetchImpl,
    );
    if (!Array.isArray(document) || document.length === 0) break;
    let added = 0;
    for (const entry of document) {
      if (!isObject(entry)) continue;
      if (typeof entry.id !== "number" || typeof entry.name !== "string") continue;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      labels.push({ id: entry.id, name: entry.name });
      added += 1;
    }
    if (added === 0) break;
  }
  return labels;
}

/**
 * Detect an existing goal from the session's persisted mode changes.
 *
 * Active tools are not goal state: `goal` is an ordinary active tool whenever
 * goal mode is enabled, even when no goal exists. The newest `mode_change` on
 * the active branch is authoritative — `goal`/`goal_paused` with a goal record
 * means a goal exists; `none` (or no mode change) means none.
 */
export function goalModeFromBranch(
  entries: readonly ModeChangeEntry[],
): "active" | "paused" | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (entry.type !== "mode_change") continue;
    if (entry.mode !== "goal" && entry.mode !== "goal_paused") return null;
    if (!entry.data?.goal) return null;
    return entry.mode === "goal_paused" ? "paused" : "active";
  }
  return null;
}

/**
 * Resolve the credential for this checkout's origin and pin it in the process
 * environment so every later `gh`/`glab` child reads the same identity.
 */
export async function detectForge(
  remote: ForgeRemote,
  cwd: string,
  authExec: Exec,
  giteaFetch?: FetchLike,
): Promise<Outcome<RemoteInfo>> {
  const environment = processEnvironment();
  const auth = await resolveForgeAuth(authExec, {
    forge: remote.forge,
    host: remote.host,
    project: remote.project,
    cwd,
    required: "write",
    env: environment,
    ...(remote.forge === "gitea" ? { baseUrl: giteaBaseUrl(remote, environment) } : {}),
    ...(giteaFetch === undefined ? {} : { giteaFetch }),
  });
  if (isAuthFailure(auth)) return { error: auth.error };
  applyAuthToProcess(auth);
  return {
    host: remote.host,
    project: remote.project,
    forge: remote.forge,
    login: auth.login,
    ...(auth.baseUrl === undefined ? {} : { baseUrl: auth.baseUrl }),
  };
}

function normalizeSummary(forge: Forge, raw: unknown): EpicSummary | null {
  if (!isObject(raw)) return null;
  const ref = forge === "gitlab" ? (raw.iid ?? raw.number) : raw.number;
  const url = forge === "gitlab" ? (raw.web_url ?? raw.url) : (raw.html_url ?? raw.url);
  const title = raw.title;
  if (typeof ref !== "number" || typeof title !== "string" || typeof url !== "string") {
    return null;
  }
  return { ref, title, url };
}

function giteaTargetFor(info: RemoteInfo): Outcome<GiteaTarget> {
  const target = giteaTarget({
    project: info.project,
    ...(info.baseUrl === undefined ? {} : { baseUrl: info.baseUrl }),
  });
  if (target === undefined) {
    return { error: "the Gitea address is not configured; set DEVBOARD_GITEA_URL" };
  }
  return target;
}

export async function listOpenEpics(
  pi: ExtensionAPI,
  info: RemoteInfo,
  cwd: string,
  giteaFetch?: FetchLike,
): Promise<Outcome<{ epics: EpicSummary[]; matchedByLabel: boolean }>> {
  if (info.forge === "gitea") {
    const target = giteaTargetFor(info);
    if (isFailure(target)) return target;
    try {
      const labels = await giteaLabels(target, giteaFetch);
      const label = labels.find((entry) => entry.name.toLowerCase() === "epic");
      const issues = await giteaListIssues(target, "open", giteaFetch);
      const rows = label
        ? issues.filter((issue) => issue.labels.includes(label.name))
        : issues.filter((issue) => issue.body.includes("<!-- devboard-epic -->"));
      return {
        epics: rows.map((issue) => ({
          ref: issue.number,
          title: issue.title,
          url: issue.url,
        })),
        matchedByLabel: Boolean(label),
      };
    } catch (error) {
      return {
        error: `gitea issue listing failed: ${
          error instanceof Error ? firstLine(error.message) : String(error)
        }`,
      };
    }
  }
  if (info.forge === "github") {
    const labelsResult = await run(
      pi,
      "gh",
      ["label", "list", "--search", "epic", "--limit", "100", "--json", "name"],
      cwd,
    );
    if (labelsResult.code !== 0) {
      return { error: `gh label list failed: ${firstLine(labelsResult.stderr) || "unknown error"}` };
    }
    const labels = parseJsonArray(labelsResult.stdout);
    if (!labels) return { error: "gh label list returned invalid JSON" };
    const label = labels.find((raw): raw is { name: string } => {
      if (!isObject(raw)) return false;
      return typeof raw.name === "string" && raw.name.toLowerCase() === "epic";
    });

    const result = label
      ? await run(
          pi,
          "gh",
          [
            "issue",
            "list",
            "--label",
            label.name,
            "--state",
            "open",
            "--json",
            "number,title,url",
            "--limit",
            "100",
          ],
          cwd,
        )
      : await run(
          pi,
          "gh",
          [
            "search",
            "issues",
            "--repo",
            info.project,
            "--match",
            "body",
            "--state",
            "open",
            "devboard-epic",
            "--json",
            "number,title,url",
            "--limit",
            "100",
          ],
          cwd,
        );
    if (result.code !== 0) {
      return { error: `gh issue listing failed: ${firstLine(result.stderr) || "unknown error"}` };
    }
    const rows = parseJsonArray(result.stdout);
    if (!rows) return { error: "gh issue listing returned invalid JSON" };
    return {
      epics: rows
        .map((row) => normalizeSummary("github", row))
        .filter((row): row is EpicSummary => row !== null),
      matchedByLabel: Boolean(label),
    };
  }

  const labelsResult = await run(pi, "glab", ["label", "list", "--output", "json"], cwd);
  if (labelsResult.code !== 0) {
    return { error: `glab label list failed: ${firstLine(labelsResult.stderr) || "unknown error"}` };
  }
  const labels = parseJsonArray(labelsResult.stdout);
  if (!labels) return { error: "glab label list returned invalid JSON" };
  const label = labels.find((raw): raw is { name: string } => {
    if (!isObject(raw)) return false;
    return typeof raw.name === "string" && raw.name.toLowerCase() === "epic";
  });

  const result = label
    ? await run(pi, "glab", ["issue", "list", "--label", label.name, "--output", "json"], cwd)
    : await run(
        pi,
        "glab",
        ["issue", "list", "--search", "devboard-epic", "--in", "description", "--output", "json"],
        cwd,
      );
  if (result.code !== 0) {
    return { error: `glab issue listing failed: ${firstLine(result.stderr) || "unknown error"}` };
  }
  const rows = parseJsonArray(result.stdout);
  if (!rows) return { error: "glab issue listing returned invalid JSON" };
  return {
    epics: rows
      .map((row) => normalizeSummary("gitlab", row))
      .filter((row): row is EpicSummary => row !== null),
    matchedByLabel: Boolean(label),
  };
}

export async function fetchEpic(
  pi: ExtensionAPI,
  info: RemoteInfo,
  ref: number,
  cwd: string,
  giteaFetch?: FetchLike,
): Promise<Outcome<Epic>> {
  if (info.forge === "gitea") {
    const target = giteaTargetFor(info);
    if (isFailure(target)) return target;
    try {
      const issue = await giteaIssue(target, ref, giteaFetch);
      return {
        ref: issue.number,
        title: issue.title,
        url: issue.url,
        body: issue.body,
      };
    } catch (error) {
      return {
        error: `gitea issue view failed: ${
          error instanceof Error ? firstLine(error.message) : String(error)
        }`,
      };
    }
  }
  const result =
    info.forge === "github"
      ? await run(
          pi,
          "gh",
          ["issue", "view", String(ref), "--json", "number,title,body,url"],
          cwd,
        )
      : await run(pi, "glab", ["issue", "view", String(ref), "--output", "json"], cwd);

  if (result.code !== 0) {
    return {
      error: `${info.forge} issue view failed: ${firstLine(result.stderr) || "unknown error"}`,
    };
  }

  const raw = parseJsonObject(result.stdout);
  if (!raw) return { error: `${info.forge} issue view returned invalid JSON` };

  const summary = normalizeSummary(info.forge, raw);
  const body = info.forge === "github" ? raw.body : (raw.description ?? raw.body);
  if (!summary || typeof body !== "string") {
    return { error: `${info.forge} issue view returned an unexpected shape` };
  }
  return { ...summary, body };
}

const REQUIRED_SECTIONS = [
  "Objective",
  "Success criteria",
  "Verification",
  "Boundaries",
] as const;

/**
 * Keep the epic's title and the sections a goal needs to execute and verify.
 * The tracker marker and other HTML comments are dropped. When the body has
 * none of the expected sections, keep the whole (comment-stripped) body.
 *
 * Only level-1 and level-2 headings delimit a required section, so a `###`
 * subheading stays inside its section. Fenced blocks are tracked and kept
 * verbatim: a `#` line inside one is a shell comment, never a heading.
 */
export function distillObjective(title: string, body: string): string {
  const clean = body.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  const lines = clean.split("\n");
  const sections: Record<string, string[]> = {};
  let current: string | null = null;
  let fence: string | null = null;

  for (const line of lines) {
    const fenceRun = /^\s*(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
    if (fence) {
      if (current) sections[current]?.push(line);
      const closing =
        fenceRun !== null && fenceRun[0] === fence[0] && fenceRun.length >= fence.length;
      if (closing && line.trim() === fenceRun) fence = null;
      continue;
    }
    if (fenceRun) {
      fence = fenceRun;
      if (current) sections[current]?.push(line);
      continue;
    }
    const heading = /^#{1,2}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const name = (heading[1] ?? "").trim();
      current =
        REQUIRED_SECTIONS.find(
          (candidate) => candidate.toLowerCase() === name.toLowerCase(),
        ) ?? null;
      if (current) sections[current] = [];
      continue;
    }
    if (current) sections[current]?.push(line);
  }

  const parts: string[] = [title.trim()];
  for (const section of REQUIRED_SECTIONS) {
    const content = sections[section]?.join("\n").trim();
    if (content) parts.push(`## ${section}\n${content}`);
  }

  if (parts.length === 1) {
    const fallback = clean.trim();
    if (fallback) parts.push(fallback);
  }

  return parts.filter(Boolean).join("\n\n").trim();
}

export function slugify(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  const slug = words.join("-").slice(0, 48).replace(/-+$/, "");
  return slug || "epic";
}

export async function planWorktree(
  pi: ExtensionAPI,
  repo: string,
  slug: string,
): Promise<Outcome<{ path: string; branch: string }>> {
  const worktrees = await run(pi, "git", ["worktree", "list", "--porcelain"], repo);
  if (worktrees.code !== 0) {
    return { error: `git worktree list failed: ${firstLine(worktrees.stderr) || "unknown error"}` };
  }
  const existingPaths = new Set(
    worktrees.stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim()),
  );

  for (let index = 1; index <= 100; index += 1) {
    const candidate = index === 1 ? slug : `${slug}-${index}`;
    const path = joinPath(repo, ".worktree", candidate);
    const branch = `devboard/${candidate}`;
    if (existingPaths.has(path)) continue;
    const branchExists = await run(
      pi,
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      repo,
    );
    if (branchExists.code === 0) continue;
    return { path, branch };
  }

  return { error: `no free worktree name for slug "${slug}"` };
}

export async function createWorktree(
  pi: ExtensionAPI,
  repo: string,
  path: string,
  branch: string,
): Promise<Outcome<{ path: string; branch: string }>> {
  const main = await run(pi, "git", ["rev-parse", "--verify", "main"], repo);
  if (main.code !== 0) {
    return { error: "main branch not found; cannot create the epic worktree" };
  }
  const result = await run(pi, "git", ["worktree", "add", path, "-b", branch, "main"], repo);
  if (result.code !== 0) {
    return {
      error: `git worktree add failed: ${firstLine(result.stderr) || firstLine(result.stdout) || "unknown error"}`,
    };
  }
  return { path, branch };
}

function shellArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The exact wrapper every tracker command in the lane prompt must use. `exec`
 * runs `gh`/`glab` with the selected token; a Gitea origin resolves the
 * identity with `check` instead, because `forge-auth` refuses to `exec` a
 * Gitea write and its API call reads the ambient token itself.
 */
export function forgeAuthCommand(repo: string, info: RemoteInfo): string {
  const script = joinPath(repo, ".devboard", "scripts", "forge-auth.ts");
  const target = [
    "--host",
    shellArgument(info.host),
    "--project",
    shellArgument(info.project),
    "--forge",
    info.forge,
    "--required",
    "write",
  ];
  return info.forge === "gitea"
    ? ["bun", shellArgument(script), "check", ...target].join(" ")
    : ["bun", shellArgument(script), "exec", ...target, "--"].join(" ");
}

export function buildGoalPrompt(
  epic: Epic,
  objective: string,
  repo: string,
  worktree: string,
  branch: string,
  forge: RemoteInfo["forge"],
  project: string,
  authCommand: string,
): string {
  const closeCommand =
    forge === "github"
      ? `${authCommand} gh issue close ${epic.ref}`
      : forge === "gitlab"
        ? `${authCommand} glab issue close ${epic.ref}`
        : `${authCommand} && curl -sS -X PATCH -H "Authorization: token $GITEA_TOKEN" ` +
          `-H "Content-Type: application/json" -d '{"state":"closed"}' ` +
          `"$DEVBOARD_GITEA_URL/api/v1/repos/${project}/issues/${epic.ref}"`;
  return `Implement the next epic from the tracker. This run is fully autonomous.

Autonomy contract:
- Do not ask the user anything. Never call the \`ask\` tool.
- Do not wait for confirmation, approval, sign-off, or review. Never request permission to proceed.
- Do not stop for a plan, a choice, or a progress check. Never offer the user options.
- Decide from the epic, the repository, its tests, its documentation, and its ADRs. Where those are silent, choose the smallest reversible option, record the assumption in the final report, and continue.
- Continue until every success criterion is verified, the branch is merged, the worktree is removed, and the epic is closed.

Epic: ${epic.title}
URL: ${epic.url}
Repository: ${repo}
Worktree: ${worktree}
Branch: ${branch}

Before doing any work:
1. Call the \`goal\` tool with {"op":"get"}.
2. If it returns any goal (active, paused, budget-limited, complete, or dropped), end the run immediately with that conflict as the result. Do not drop, resume, or replace it, and do not ask the user what to do.
3. Otherwise call the \`goal\` tool with {"op":"create","objective": <the objective below>}. Pass the objective exactly as written.

Objective:
<<<OBJECTIVE
${objective}
OBJECTIVE>>>

After the goal tool succeeds, implement the epic end to end:
- Work only inside the worktree path above. Never edit, write, or run mutating commands in ${repo}; that checkout is for the final merge only.
- Use absolute paths under the worktree for every tool, and pass the worktree as \`cwd\` to \`bash\`.
- Read the epic URL for the full body, including any detail omitted from the objective.
- Follow every success criterion and verification scenario. Perform each check through the product's user-visible surface in the worktree, observe the actual result, and use the repository's documented build and test commands only as supporting evidence.
- Never end a turn while a background job you started is still running: when a \`wait\` returns a
  still-running snapshot, call \`wait\` again. Leave the turn only once the work is finished or
  the exact blocker is known.
- Keep the goal active until every criterion is verified. Call the \`goal\` tool with {"op":"complete"} only then.
- When complete, merge ${branch} into main from ${repo}. First fetch the latest main and integrate
  it into ${branch}; then merge. If the merge fails, fetch the latest main again, integrate it,
  and retry. Never force-push. After the merge succeeds, push main to origin and remove the
  worktree and branch, per AGENTS.md. If the push is rejected, fetch and integrate the new main
  and push again.
- Never call \`gh\`, \`glab\`, or the Gitea API directly. Route every tracker command through the harness auth wrapper, which selects the authenticated account with write access to this repository and overrides any stale ambient token; on Gitea, resolve the identity with \`check\` and call the API with \`GITEA_TOKEN\`:
  \`${closeCommand}\`
- When complete, close the epic issue ${epic.ref} in ${repo} with \`${closeCommand}\`. Close it only after the merge succeeded, main was pushed, and the worktree was removed. If closing fails, report that failure once as the run's blocker.
- If a hard blocker makes completion impossible (a missing prerequisite that cannot be created, an unavailable external dependency, or an operation that would destroy uncommitted user work), end the run and report the exact blocker once on a line beginning \`DEVBOARD-BLOCKED:\`. Do not ask for permission or guidance.`;
}

function notify(
  ctx: ExtensionCommandContext,
  message: string,
  type: "info" | "warning" | "error",
): void {
  try {
    ctx.ui.notify(`implement-next-epic: ${message}`, type);
  } catch {
    // Notification is best-effort; the command still returns its result.
  }
}

async function fail(ctx: ExtensionCommandContext, message: string): Promise<RunResult> {
  notify(ctx, message, "error");
  return { ok: false, message };
}

export async function runImplementNextEpic(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args = "",
  authExec?: Exec,
  giteaFetch?: FetchLike,
): Promise<RunResult> {
  const requested = args.trim();
  if (requested.length > 0 && !/^\d+$/.test(requested)) {
    return fail(
      ctx,
      "takes an optional epic reference; with no reference it implements the single open epic",
    );
  }
  const reference = requested.length > 0 ? Number(requested) : undefined;

  const top = await run(pi, "git", ["rev-parse", "--show-toplevel"], ctx.cwd);
  if (top.code !== 0) {
    return fail(
      ctx,
      `not a git repository: ${firstLine(top.stderr) || "git rev-parse failed"}`,
    );
  }
  const repo = top.stdout.trim();

  const goalMode = goalModeFromBranch(ctx.sessionManager.getBranch());
  if (goalMode) {
    return fail(
      ctx,
      `a goal is already ${goalMode}; finish or drop it before starting another epic`,
    );
  }

  const origin = await run(pi, "git", ["remote", "get-url", "origin"], repo);
  if (origin.code !== 0 || !origin.stdout.trim()) {
    return fail(ctx, "origin remote is not configured; /epic-next cannot have filed an epic");
  }

  const remote = parseForgeRemote(origin.stdout);
  if (!remote) {
    return fail(ctx, `cannot parse origin remote: ${origin.stdout.trim()}`);
  }

  const exec = authExec ?? environmentExec(pi);
  const info = await detectForge(remote, repo, exec, giteaFetch);
  if (isFailure(info)) return fail(ctx, info.error);

  const listed = await listOpenEpics(pi, info, repo, giteaFetch);
  if (isFailure(listed)) return fail(ctx, listed.error);

  let epics = listed.epics;
  if (!listed.matchedByLabel) {
    // The marker search is a candidate fetch; confirm the marker in the body.
    const confirmed: EpicSummary[] = [];
    for (const candidate of epics) {
      const full = await fetchEpic(pi, info, candidate.ref, repo, giteaFetch);
      if (isFailure(full)) return fail(ctx, full.error);
      if (full.body.includes("<!-- devboard-epic -->")) confirmed.push(candidate);
    }
    epics = confirmed;
  }

  if (epics.length === 0) {
    return fail(ctx, "no open epic found; run /epic-next first");
  }

  let selected: EpicSummary | undefined;
  if (reference !== undefined) {
    selected = epics.find((epic) => epic.ref === reference);
    if (selected === undefined) {
      return fail(
        ctx,
        `epic ${reference} is not open, found ${epics.length}:\n${epics
          .map((epic) => `${epic.url}`)
          .join("\n")}`,
      );
    }
  } else {
    if (epics.length > 1) {
      return fail(
        ctx,
        `expected exactly one open epic, found ${epics.length}:\n${epics
          .map((epic) => `${epic.url}`)
          .join("\n")}`,
      );
    }
    selected = epics[0];
  }
  if (selected === undefined) {
    return fail(ctx, "no open epic found; run /epic-next first");
  }

  const fetched = await fetchEpic(pi, info, selected.ref, repo, giteaFetch);
  if (isFailure(fetched)) return fail(ctx, fetched.error);
  const epic = fetched;

  const objective = distillObjective(epic.title, epic.body);
  if (!objective) {
    return fail(ctx, `epic ${epic.url} has no objective text`);
  }

  const slug = slugify(epic.title);
  const planned = await planWorktree(pi, repo, slug);
  if (isFailure(planned)) return fail(ctx, planned.error);

  const worktree = await createWorktree(pi, repo, planned.path, planned.branch);
  if (isFailure(worktree)) return fail(ctx, worktree.error);

  const active = pi.getActiveTools();
  try {
    await pi.setActiveTools([...active, "goal"]);
  } catch (error) {
    return fail(
      ctx,
      `could not activate the goal tool: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const goalAvailable =
    pi.getActiveTools().includes("goal") && pi.getAllTools().some((tool) => tool.name === "goal");
  if (!goalAvailable) {
    return fail(ctx, "goal mode is unavailable; enable goal.enabled in omp settings");
  }

  await ctx.waitForIdle?.();

  const prompt = buildGoalPrompt(
    epic,
    objective,
    repo,
    worktree.path,
    worktree.branch,
    info.forge,
    info.project,
    forgeAuthCommand(repo, info),
  );
  try {
    pi.sendUserMessage(prompt);
  } catch (error) {
    return fail(
      ctx,
      `could not send the goal prompt: ${error instanceof Error ? error.message : String(error)}. Worktree ${worktree.path} was created.`,
    );
  }

  notify(
    ctx,
    `queued goal for ${epic.url}; worktree ${worktree.path} on ${worktree.branch}`,
    "info",
  );
  return {
    ok: true,
    message: `queued goal for ${epic.url}`,
    epic,
    objective,
    worktree: worktree.path,
    branch: worktree.branch,
    prompt,
  };
}

export default function implementNextEpicExtension(pi: ExtensionAPI): void {
  pi.registerCommand("implement-next-epic", {
    description:
      "Implement the open epic given by reference, or the single open epic created by /epic-next",
    handler: async (args, ctx) => {
      try {
        await runImplementNextEpic(pi, ctx, args);
      } catch (error) {
        notify(
          ctx,
          `unexpected failure: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
