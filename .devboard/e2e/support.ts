/**
 * Shared facts for the operator suite.
 *
 * The suite drives one real dashboard process: the built binary serving the
 * built client bundle against a throwaway fixture repository and the live
 * Gitea. Nothing here points a harness path at the checkout under test.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const harnessDir = path.resolve(here, "..");
export const repoRoot = path.resolve(harnessDir, "..");
export const binary =
  process.env.E2E_DEVBOARD_BIN ?? path.join(harnessDir, "target", "debug", "devboard");
export const staticDir = path.join(harnessDir, "dist");
export const fixturesDir = path.join(here, "fixtures");
export const tmpDir = path.join(harnessDir, ".tmp", "e2e");
export const scratchRoot = path.join(harnessDir, ".test-tmp", "e2e");
export const statePath = path.join(tmpDir, "state.json");

/** The nine background agent families, in the dashboard's registry order. */
export const FAMILIES = [
  "scout",
  "watchdog",
  "design",
  "dead-code",
  "mcp-optimizer",
  "api-standards",
  "single-responsibility",
  "consistent-naming",
  "release-train",
] as const;

export type Family = (typeof FAMILIES)[number];

/** The family page's human label, as the sidebar renders it. */
export const FAMILY_LABELS: Record<Family, string> = {
  scout: "Auto Scout",
  watchdog: "Watchdog",
  design: "Design System",
  "dead-code": "Dead Code",
  "mcp-optimizer": "MCP optimizer",
  "api-standards": "API Standards",
  "single-responsibility": "Single Responsibility",
  "consistent-naming": "Consistent Naming",
  "release-train": "Release Train",
};

/**
 * The families the suite starts.
 *
 * The Release Train is left out: each tick fetches the fixture's `origin` —
 * the live Gitea repository — and starts a release agent for its unreleased
 * commits, so a warm-up or a Start would run a real release from a test
 * fixture (and its stub peer's failure would reach the page and the board).
 * Its Start and Stop controls are covered by the Rust adapter tests.
 */
export const SUITE_FAMILIES: Family[] = FAMILIES.filter((family) => family !== "release-train");

export interface SuiteState {
  baseUrl: string;
  port: number;
  repository: string;
  repoDir: string;
  stateDir: string;
  adrsDir: string;
  goalFile: string;
  harnessVersion: string;
  pid: number;
}

/** The state directory one family publishes and reads its controls under. */
export function familyRuntimeRoot(
  family: string,
  state: Pick<SuiteState, "repoDir" | "stateDir">,
): string {
  if (family === "watchdog") {
    return path.join(state.repoDir, ".devboard", ".tmp", "watchdog");
  }
  if (family === "mcp-optimizer") {
    return path.join(state.stateDir, "coach");
  }
  if (family === "release-train") {
    return path.join(state.stateDir, "release-train");
  }
  return path.join(state.stateDir, family);
}

function removeRuntimeEntries(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "control") rmSync(candidate, { recursive: true, force: true });
      else removeRuntimeEntries(candidate);
      continue;
    }
    if (entry.name.startsWith("lock")) rmSync(candidate, { force: true });
  }
}

/**
 * Clears a family's leftovers before a Start: a Stop command a previously
 * signalled worker never consumed would stop the next worker, and a killed
 * worker's lock can name a recycled pid.
 */
export function clearFamilyRuntime(
  family: string,
  state: Pick<SuiteState, "repoDir" | "stateDir">,
): void {
  const root = familyRuntimeRoot(family, state);
  if (existsSync(root)) removeRuntimeEntries(root);
  const work = path.join(state.repoDir, ".devboard", ".tmp", family);
  if (existsSync(work)) removeRuntimeEntries(work);
}

export function readState(): SuiteState {
  return JSON.parse(readFileSync(statePath, "utf8")) as SuiteState;
}

export function writeState(state: SuiteState): void {
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Loads the nearest `.env` above the harness for the keys the suite needs,
 * without overriding a value the caller already set. A worktree's own root
 * often has none; the checkout that spawned it holds the same file.
 */
export function loadDotEnv(): void {
  let directory = harnessDir;
  let file = path.join(directory, ".env");
  for (let depth = 0; depth < 4 && !existsSync(file); depth += 1) {
    directory = path.dirname(directory);
    file = path.join(directory, ".env");
  }
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match === null) continue;
    const [, key, raw] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^(['"])(.*)\1$/, "$2");
  }
}

export function giteaUrl(): string {
  const value = process.env.DEVBOARD_GITEA_URL;
  if (value === undefined || value.trim() === "") {
    throw new Error("the suite needs DEVBOARD_GITEA_URL");
  }
  return value.trim().replace(/\/+$/, "");
}

export function giteaToken(): string {
  const value = process.env.GITEA_TOKEN ?? process.env.DEVBOARD_GITEA_TOKEN;
  if (value === undefined || value.trim() === "") {
    throw new Error("the suite needs GITEA_TOKEN");
  }
  return value.trim();
}

export function repository(): string {
  return process.env.DEVBOARD_SUITE_REPOSITORY?.trim() || "dsdenes/devboard";
}

/** The recorder directory the fixture puts ahead of `PATH`. */
export const forgeRecorderDir = path.join(scratchRoot, "bin");
export const ghRecorderLog = path.join(scratchRoot, "forge-gh.log");
export const glabRecorderLog = path.join(scratchRoot, "forge-glab.log");

/** Every recorded `gh`/`glab` invocation, oldest first. */
export function forgeRecorderLines(): string[] {
  const lines: string[] = [];
  for (const log of [ghRecorderLog, glabRecorderLog]) {
    if (!existsSync(log)) continue;
    lines.push(
      ...readFileSync(log, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    );
  }
  return lines;
}

/** The recorder lines that are a forge operation, not a release-artifact read. */
export function forgeRecorderForgeLines(): string[] {
  return forgeRecorderLines().filter((line) => !line.startsWith("auth token"));
}

export async function waitFor<T>(
  label: string,
  produce: () => T | Promise<T>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<T> {
  const started = Date.now();
  let last: unknown = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await produce();
      if (value !== null && value !== undefined && value !== false) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `${label} did not settle within ${timeoutMs} ms${last === null ? "" : `: ${String(last)}`}`,
  );
}

export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Runs one command and returns its trimmed stdout. */
export function run(command: string, args: string[], cwd = harnessDir): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export interface ProcessMatch {
  pid: number;
  command: string;
}

/** Every process whose full command line matches the regular expression. */
export function processesMatching(pattern: string): ProcessMatch[] {
  // A pattern that starts with `-` would be read as a pgrep option.
  const safe = pattern.startsWith("-") ? `.*${pattern}` : pattern;
  let output = "";
  try {
    output = execFileSync("pgrep", ["-af", safe], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const split = line.indexOf(" ");
      return {
        pid: Number.parseInt(line.slice(0, split), 10),
        command: line.slice(split + 1),
      };
    })
    .filter((match) => Number.isFinite(match.pid) && match.pid !== process.pid);
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every JSON file under a directory, in a deterministic order. */
export function jsonFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory).sort()) {
      const candidate = path.join(directory, entry);
      const stat = statSync(candidate);
      if (stat.isDirectory()) {
        visit(candidate);
      } else if (entry.endsWith(".json")) {
        found.push(candidate);
      }
    }
  };
  visit(root);
  return found;
}

/** A URL-safe regular expression for one literal process argument. */
export function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface GiteaIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  html_url: string;
}

async function gitea(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${giteaUrl()}/api/v1${pathname}`, {
    ...init,
    headers: {
      Authorization: `token ${giteaToken()}`,
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

/** Every open issue on the board the harness reports to. */
export async function openIssues(): Promise<GiteaIssue[]> {
  const response = await gitea(
    `/repos/${repository()}/issues?state=open&type=issues&limit=200`,
  );
  if (!response.ok) {
    throw new Error(`the board read failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as GiteaIssue[];
}

export async function readIssue(number: number): Promise<GiteaIssue> {
  const response = await gitea(`/repos/${repository()}/issues/${number}`);
  if (!response.ok) {
    throw new Error(`issue ${number} could not be read (${response.status})`);
  }
  return (await response.json()) as GiteaIssue;
}

export async function closeIssue(number: number): Promise<void> {
  const response = await gitea(`/repos/${repository()}/issues/${number}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed" }),
  });
  if (!response.ok) {
    throw new Error(`issue ${number} could not be closed (${response.status})`);
  }
}

/** The issue number a Gitea issue URL names. */
export function issueNumber(href: string): number {
  const match = /\/(\d+)(?:[?#].*)?$/.exec(href);
  if (match === null) throw new Error(`no issue number in ${href}`);
  return Number.parseInt(match[1], 10);
}
