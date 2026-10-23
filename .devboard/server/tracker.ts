import type { Subprocess } from "bun";

export interface OpenEpic {
  number: number;
  title: string;
  url: string;
}

/**
 * Reads every open epic on the origin tracker. A lookup may return one epic or
 * `undefined` for the single-epic callers tests use; the lifecycle normalizes
 * both shapes with `normalizeEpics`.
 */
export type EpicLookup = (
  repoDir: string,
) => Promise<OpenEpic[] | OpenEpic | undefined>;

/** Normalizes a tracker answer to the list shape the lifecycle consumes. */
export function normalizeEpics(value: OpenEpic[] | OpenEpic | undefined): OpenEpic[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

interface Remote {
  forge: "github" | "gitlab";
  project: string;
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

const COMMAND_ENV = {
  ...process.env,
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "true",
  NO_COLOR: "1",
};

async function command(cwd: string, argv: string[]): Promise<CommandResult> {
  let process: Subprocess<"ignore", "pipe", "pipe">;
  try {
    process = Bun.spawn(argv, {
      cwd,
      env: COMMAND_ENV,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new Error(
      `Could not run ${argv[0]}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function commandJson<T>(cwd: string, argv: string[], description: string): Promise<T> {
  const result = await command(cwd, argv);
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
  const value = remote.trim();
  if (value.length === 0) return undefined;

  let hostname: string;
  let path: string;

  const scp = /^[^/@\s]+@([^:/\s]+):(.+)$/.exec(value);
  if (scp !== null) {
    hostname = scp[1] ?? "";
    path = scp[2] ?? "";
  } else {
    const withoutScheme = value.includes("://")
      ? value.slice(value.indexOf("://") + 3)
      : value;
    const slash = withoutScheme.indexOf("/");
    if (slash < 0) return undefined;
    const authority = withoutScheme.slice(0, slash);
    path = withoutScheme.slice(slash + 1);
    hostname = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d+$/, "");
  }

  const project = path.replace(/^\/+/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  if (hostname.length === 0 || project.length === 0) return undefined;

  if (hostname === "github.com") return { forge: "github", project };
  if (hostname.includes("gitlab")) return { forge: "gitlab", project };
  return undefined;
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

async function githubEpics(cwd: string, project: string): Promise<OpenEpic[]> {
  const labels = await commandJson<LabelEntry[]>(
    cwd,
    ["gh", "label", "list", "--search", "epic", "--limit", "100", "--json", "name"],
    "list tracker labels",
  );
  const label = labels.find(
    (entry) => typeof entry.name === "string" && entry.name.toLowerCase() === "epic",
  );

  if (label !== undefined && typeof label.name === "string") {
    const issues = await commandJson<unknown>(
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
    );
    return allEpics(issues);
  }

  const issues = await commandJson<unknown>(
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
  );
  return allEpics(issues);
}

async function gitlabEpics(cwd: string): Promise<OpenEpic[]> {
  const labels = await commandJson<LabelEntry[]>(
    cwd,
    ["glab", "label", "list", "--output", "json"],
    "list tracker labels",
  );
  const label = labels.find(
    (entry) => typeof entry.name === "string" && entry.name.toLowerCase() === "epic",
  );

  if (label !== undefined && typeof label.name === "string") {
    const issues = await commandJson<unknown>(
      cwd,
      ["glab", "issue", "list", "--label", label.name, "--output", "json"],
      "list open epics",
    );
    return allEpics(issues);
  }

  const issues = await commandJson<unknown>(
    cwd,
    ["glab", "issue", "list", "--search", "devboard-epic", "--in", "description", "--output", "json"],
    "search open epics",
  );
  return allEpics(issues);
}

/**
 * Finds every open epic on the origin tracker. An issue is an epic when it is
 * open and either carries the label `epic` ignoring case or contains the
 * `devboard-epic` marker in its body. Only read-only CLI queries run.
 */
export async function findOpenEpics(repoDir: string): Promise<OpenEpic[]> {
  const remote = await command(repoDir, ["git", "remote", "get-url", "origin"]);
  if (remote.exitCode !== 0) {
    const detail = remote.stderr.trim() || `exit code ${remote.exitCode}`;
    throw new Error(`Could not read the origin remote: ${detail}`);
  }

  const classified = classifyRemote(remote.stdout);
  if (classified === undefined) {
    throw new Error("The origin remote does not name a GitHub or GitLab repository.");
  }

  return classified.forge === "github"
    ? await githubEpics(repoDir, classified.project)
    : await gitlabEpics(repoDir);
}
