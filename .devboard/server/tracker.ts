import type { Subprocess } from "bun";
import {
  authEnvironment,
  isAuthFailure,
  resolveForgeAuth,
  type Exec,
  type Forge,
  type ResolvedAuth,
} from "../lib/forge-auth.ts";
import { configuredGiteaToken, giteaBaseUrl, parseForgeRemote } from "../lib/forge";
import { giteaListIssues } from "../lib/gitea";

export interface OpenEpic {
  number: number;
  title: string;
  url: string;
}

/** Default wall-clock bound for one whole tracker read. */
export const TRACKER_READ_TIMEOUT_MS = 30_000;

/**
 * A tracker read that ran past its deadline. The read left no state behind, so
 * the caller may run it again.
 */
export class TrackerTimeoutError extends Error {
  readonly retryable = true;

  constructor(readonly timeoutMs: number) {
    super(`The tracker did not answer within ${timeoutMs} ms; retry the read.`);
    this.name = "TrackerTimeoutError";
  }
}

/** A tracker read cancelled by its owner: a stop, a reset, or a shutdown. */
export class TrackerAbortedError extends Error {
  readonly retryable = true;

  constructor() {
    super("The tracker read was stopped.");
    this.name = "TrackerAbortedError";
  }
}

export interface TrackerReadOptions {
  /** Whole-read deadline in milliseconds; defaults to `TRACKER_READ_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Aborting kills every in-flight child and rejects the read. */
  signal?: AbortSignal;
}

/**
 * Reads every open epic on the origin tracker. A lookup may return one epic or
 * `undefined` for the single-epic callers tests use; the lifecycle normalizes
 * both shapes with `normalizeEpics`.
 */
export type EpicLookup = (
  repoDir: string,
  options?: TrackerReadOptions,
) => Promise<OpenEpic[] | OpenEpic | undefined>;

/** Normalizes a tracker answer to the list shape the lifecycle consumes. */
export function normalizeEpics(value: OpenEpic[] | OpenEpic | undefined): OpenEpic[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

interface Remote {
  forge: Forge;
  host: string;
  project: string;
  baseUrl?: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface LabelEntry {
  name?: unknown;
}

interface IssueEntry {
  number?: unknown;
  iid?: unknown;
  title?: unknown;
  url?: unknown;
  web_url?: unknown;
}

function baseEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") environment[key] = value;
  }
  return {
    ...environment,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
    NO_COLOR: "1",
  };
}

/** The error an aborted read should surface; the controller carries the cause. */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new TrackerAbortedError();
}

/** Rejects with the read's abort reason as soon as its controller aborts. */
function whenAborted(signal: AbortSignal): Promise<never> {
  const aborted = Promise.withResolvers<never>();
  if (signal.aborted) {
    aborted.reject(abortReason(signal));
  } else {
    signal.addEventListener("abort", () => aborted.reject(abortReason(signal)), { once: true });
  }
  return aborted.promise;
}

/** Kills a tracker child; a child that already exited is not an error. */
function terminate(process: Pick<Subprocess, "kill">): void {
  try {
    process.kill("SIGKILL");
  } catch {
    // It exited between the abort and the signal.
  }
}

const bunExec: Exec = async (commandName, args, options) => {
  try {
    if (options.signal?.aborted) return { stdout: "", stderr: "", code: -1, killed: true };
    const process = Bun.spawn({
      cmd: [commandName, ...args],
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const kill = () => terminate(process);
    options.signal?.addEventListener("abort", kill, { once: true });
    let timer: Timer | undefined;
    const guards: Promise<never>[] = [];
    if (options.timeout !== undefined) {
      const timeoutMs = Math.max(1, options.timeout);
      const timed = Promise.withResolvers<never>();
      guards.push(timed.promise);
      timer = setTimeout(() => {
        kill();
        timed.reject(new TrackerTimeoutError(timeoutMs));
      }, timeoutMs);
    }
    if (options.signal !== undefined) guards.push(whenAborted(options.signal));
    try {
      const finished = Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]).then(([stdout, stderr, code]) => ({ stdout, stderr, code, killed: code === 137 }));
      return await (guards.length === 0 ? finished : Promise.race([finished, ...guards]));
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
    }
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      code: -1,
      killed: true,
    };
  }
};

async function command(
  cwd: string,
  argv: string[],
  env: Record<string, string> = baseEnvironment(),
  signal?: AbortSignal,
): Promise<CommandResult> {
  if (signal?.aborted) throw abortReason(signal);
  let process: Subprocess<"ignore", "pipe", "pipe">;
  try {
    process = Bun.spawn(argv, {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new Error(
      `Could not run ${argv[0]}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const kill = () => terminate(process);
  signal?.addEventListener("abort", kill, { once: true });
  try {
    const finished = Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }));
    return await (signal === undefined ? finished : Promise.race([finished, whenAborted(signal)]));
  } finally {
    signal?.removeEventListener("abort", kill);
  }
}

async function commandJson<T>(
  cwd: string,
  argv: string[],
  description: string,
  env?: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const result = await command(cwd, argv, env, signal);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`Could not ${description}: ${detail}`);
  }

  const source = result.stdout.trim();
  if (source.length === 0) return [] as T;
  try {
    return JSON.parse(source) as T;
  } catch {
    throw new Error(`Could not ${description}: unexpected CLI output.`);
  }
}

/**
 * Reads the origin remote from the repository and classifies it. The forge is
 * decided by the hostname, and the project path keeps any GitLab subgroup.
 */
export function classifyRemote(remote: string): Remote | undefined {
  const parsed = parseForgeRemote(remote);
  if (parsed === undefined) return undefined;
  return {
    forge: parsed.forge,
    host: parsed.host,
    project: parsed.project,
    ...(parsed.forge === "gitea"
      ? { baseUrl: giteaBaseUrl(parsed) }
      : {}),
  };
}

function toEpic(entry: IssueEntry): OpenEpic | undefined {
  const number =
    typeof entry.number === "number"
      ? entry.number
      : typeof entry.iid === "number"
        ? entry.iid
        : undefined;
  const title = typeof entry.title === "string" ? entry.title : undefined;
  const url =
    typeof entry.url === "string"
      ? entry.url
      : typeof entry.web_url === "string"
        ? entry.web_url
        : undefined;
  if (number === undefined || title === undefined) return undefined;
  return { number, title, url: url ?? "" };
}

function allEpics(entries: unknown): OpenEpic[] {
  if (!Array.isArray(entries)) return [];
  const epics: OpenEpic[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const epic = toEpic(entry as IssueEntry);
    if (epic !== undefined) epics.push(epic);
  }
  return epics;
}

/**
 * Merges the rows of several epic queries into one list, keeping the first row
 * per issue number. An issue that is both labelled and body-marked appears once.
 */
function unionEpics(...groups: OpenEpic[][]): OpenEpic[] {
  const merged = new Map<number, OpenEpic>();
  for (const group of groups) {
    for (const epic of group) {
      if (!merged.has(epic.number)) merged.set(epic.number, epic);
    }
  }
  return [...merged.values()];
}

async function githubEpics(
  cwd: string,
  project: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<OpenEpic[]> {
  const labels = await commandJson<LabelEntry[]>(
    cwd,
    ["gh", "label", "list", "--search", "epic", "--limit", "100", "--json", "name"],
    "list tracker labels",
    env,
    signal,
  );
  const label = labels.find(
    (entry) => typeof entry.name === "string" && entry.name.toLowerCase() === "epic",
  );

  const bodyEpics = allEpics(
    await commandJson<unknown>(
      cwd,
      [
        "gh",
        "search",
        "issues",
        "--repo",
        project,
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
      "search open epics",
      env,
      signal,
    ),
  );
  if (label === undefined || typeof label.name !== "string") return bodyEpics;

  const labelledEpics = allEpics(
    await commandJson<unknown>(
      cwd,
      [
        "gh",
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
      "list open epics",
      env,
      signal,
    ),
  );
  return unionEpics(labelledEpics, bodyEpics);
}

async function gitlabEpics(
  cwd: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<OpenEpic[]> {
  const labels = await commandJson<LabelEntry[]>(
    cwd,
    ["glab", "label", "list", "--output", "json"],
    "list tracker labels",
    env,
    signal,
  );
  const label = labels.find(
    (entry) => typeof entry.name === "string" && entry.name.toLowerCase() === "epic",
  );

  const bodyEpics = allEpics(
    await commandJson<unknown>(
      cwd,
      ["glab", "issue", "list", "--search", "devboard-epic", "--in", "description", "--output", "json"],
      "search open epics",
      env,
      signal,
    ),
  );
  if (label === undefined || typeof label.name !== "string") return bodyEpics;

  const labelledEpics = allEpics(
    await commandJson<unknown>(
      cwd,
      ["glab", "issue", "list", "--label", label.name, "--output", "json"],
      "list open epics",
      env,
      signal,
    ),
  );
  return unionEpics(labelledEpics, bodyEpics);
}

async function giteaEpics(remote: Remote, signal: AbortSignal): Promise<OpenEpic[]> {
  if (remote.baseUrl === undefined || remote.baseUrl.length === 0) {
    throw new Error("The Gitea address is not configured; set DEVBOARD_GITEA_URL.");
  }
  const token = configuredGiteaToken(process.env);
  const issues = await giteaListIssues(
    {
      baseUrl: remote.baseUrl,
      project: remote.project,
      ...(token === undefined ? {} : { token }),
    },
    "open",
    (input, init) => fetch(input, { ...init, signal }),
  );
  return issues
    .filter(
      (issue) =>
        issue.labels.some((label) => label.toLowerCase() === "epic") ||
        issue.body.includes("devboard-epic"),
    )
    .map((issue) => ({ number: issue.number, title: issue.title, url: issue.url }));
}

const AUTH_CACHE_MS = 60_000;
const authCache = new Map<string, { auth: ResolvedAuth; expires: number }>();

/**
 * The lifecycle re-reads the tracker on every lane transition and settle
 * attempt. Re-probing every account on each read would add seconds and several
 * API calls, so a successful selection is reused for a short window.
 */
async function resolveTrackerAuth(
  host: string,
  project: string,
  forge: Forge,
  repoDir: string,
  deadline: number,
  signal: AbortSignal,
): Promise<ResolvedAuth> {
  const key = `${forge}:${host}:${project}`;
  const cached = authCache.get(key);
  if (cached !== undefined && cached.expires > Date.now()) return cached.auth;

  const auth = await resolveForgeAuth(bunExec, {
    forge,
    host,
    project,
    cwd: repoDir,
    required: "read",
    env: process.env,
    deadline,
    signal,
  });
  if (isAuthFailure(auth)) throw new Error(auth.error);
  authCache.set(key, { auth, expires: Date.now() + AUTH_CACHE_MS });
  return auth;
}

/** Runs the origin read under one controller that owns every child it spawns. */
async function readOpenEpics(
  repoDir: string,
  deadline: number,
  signal: AbortSignal,
): Promise<OpenEpic[]> {
  const remote = await command(repoDir, ["git", "remote", "get-url", "origin"], undefined, signal);
  if (remote.exitCode !== 0) {
    const detail = remote.stderr.trim() || `exit code ${remote.exitCode}`;
    throw new Error(`Could not read the origin remote: ${detail}`);
  }

  const classified = classifyRemote(remote.stdout);
  if (classified === undefined) {
    throw new Error("The origin remote does not name a supported repository.");
  }

  if (classified.forge === "gitea") return await giteaEpics(classified, signal);

  const auth = await resolveTrackerAuth(
    classified.host,
    classified.project,
    classified.forge,
    repoDir,
    deadline,
    signal,
  );
  const env = authEnvironment(auth);

  return classified.forge === "github"
    ? await githubEpics(repoDir, classified.project, env, signal)
    : await gitlabEpics(repoDir, env, signal);
}

/**
 * Finds every open epic on the origin tracker. An issue is an epic when it is
 * open and either carries the label `epic` ignoring case or contains the
 * `devboard-epic` marker in its body. Only read-only CLI queries run. The whole
 * read is bounded: past `timeoutMs`, or when the caller aborts, every child is
 * killed and the promise rejects instead of outliving the caller.
 */
export async function findOpenEpics(
  repoDir: string,
  options: TrackerReadOptions = {},
): Promise<OpenEpic[]> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? TRACKER_READ_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new TrackerTimeoutError(timeoutMs)),
    timeoutMs,
  );
  const onAbort = () => controller.abort(new TrackerAbortedError());
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([
      readOpenEpics(repoDir, deadline, controller.signal),
      whenAborted(controller.signal),
    ]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
