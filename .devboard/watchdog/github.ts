import type { Window } from "./collect";
import type { LedgerInstance } from "./ledger";

/**
 * GitHub issue delivery for the watchdog. Every call goes through the
 * operator's authenticated `gh`; nothing here reads or prints an environment
 * value, and nothing closes an issue.
 */

/** The repository that receives every watchdog issue. */
export const WATCHDOG_REPOSITORY = "dsdenes/devboard";

/** GitHub's title limit for this watchdog; the line is truncated to fit. */
export const TITLE_MAX = 80;
/** Longest first stderr line kept as a failure reason. */
export const REASON_MAX = 300;

export interface GhOutcome {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/** Runs one `gh` invocation with a body on standard input. */
export type GhRun = (argv: string[], stdin: string) => GhOutcome;

export function runGh(argv: string[], stdin: string): GhOutcome {
  try {
    const result = Bun.spawnSync({
      cmd: ["gh", ...argv],
      stdin: Buffer.from(stdin),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    });
    return {
      code: result.exitCode ?? 1,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      ...(result.exitedDueToTimeout === true ? { timedOut: true } : {}),
    };
  } catch (error) {
    // A missing or unspawnable `gh` is a filing failure, not a crashed cycle.
    return {
      code: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function truncate(value: string, limit: number): string {
  const single = value.replace(/\s+/g, " ").trim();
  if (single.length <= limit) return single;
  return `${single.slice(0, limit - 1).trimEnd()}…`;
}

/** `[watchdog] <category>: <line>`, one line, never longer than 80 characters. */
export function watchdogTitle(category: string, line: string): string {
  const title = `[watchdog] ${category}: ${line.replace(/\s+/g, " ").trim()}`;
  if (title.length <= TITLE_MAX) return title;
  return `${title.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

/** The first diagnostic line of a failed `gh` call, bounded for a report. */
export function ghFailureReason(outcome: GhOutcome): string {
  const line = [...outcome.stderr.split("\n"), ...outcome.stdout.split("\n")]
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (line !== undefined) return truncate(line, REASON_MAX);
  return outcome.timedOut === true ? "gh timed out" : `gh exited with code ${outcome.code}`;
}

export interface IssueInput {
  category: string;
  fingerprint: string;
  line: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  window: Window;
  instances: LedgerInstance[];
  /** The cycle report that filed this issue. */
  reportPath: string;
}

function fence(text: string): string {
  const fenceText = text.includes("```") ? "````" : "```";
  return `${fenceText}text\n${text}\n${fenceText}`;
}

/** Category, identity, sightings, every contributing instance, and the report. */
export function watchdogBody(input: IssueInput): string {
  const instances =
    input.instances.length === 0
      ? ["No dashboard is recorded."]
      : input.instances.map(
          (instance) =>
            `- \`${instance.repoDir}\` on port ${instance.port} ` +
            `(pid ${instance.pid}, journal \`${instance.journal}\`)`,
        );
  return [
    "## Watchdog finding",
    "",
    `- Category: \`${input.category}\``,
    `- Fingerprint: \`${input.fingerprint}\``,
    `- First seen: ${input.firstSeen}`,
    `- Last seen: ${input.lastSeen}`,
    `- Count: ${input.count}`,
    `- Window: ${input.window.start.toISOString()} .. ${input.window.end.toISOString()}`,
    "",
    "### Quote",
    "",
    fence(input.line),
    "",
    "### Contributing instances",
    "",
    ...instances,
    "",
    "### Cycle report",
    "",
    `\`${input.reportPath}\``,
    "",
    "Filed by the Devboard watchdog from machine-checkable evidence. " +
      "It never fixes, merges, pushes, or publishes.",
    "",
  ].join("\n");
}

/** A recurrence: the new window, the latest sighting, and the running count. */
export function watchdogComment(input: IssueInput): string {
  return [
    `Another sighting of \`${input.fingerprint}\` (\`${input.category}\`).`,
    "",
    `- Last seen: ${input.lastSeen}`,
    `- Count: ${input.count}`,
    `- Window: ${input.window.start.toISOString()} .. ${input.window.end.toISOString()}`,
    "",
    "### Quote",
    "",
    fence(input.line),
    "",
    "Filed by the Devboard watchdog from machine-checkable evidence.",
    "",
  ].join("\n");
}

function printedUrl(outcome: GhOutcome): string | undefined {
  return outcome.stdout
    .split("\n")
    .map((line) => line.trim())
    .reverse()
    .find((line) => /^https?:\/\//.test(line));
}

/** Files one issue; a body can only fail through `gh`, never through the API. */
export function createIssue(
  gh: GhRun,
  input: IssueInput,
): { ok: true; url: string } | { ok: false; reason: string } {
  const outcome = gh(
    [
      "issue",
      "create",
      "--repo",
      WATCHDOG_REPOSITORY,
      "--title",
      watchdogTitle(input.category, input.line),
      "--body-file",
      "-",
    ],
    watchdogBody(input),
  );
  if (outcome.code !== 0) return { ok: false, reason: ghFailureReason(outcome) };
  const url = printedUrl(outcome);
  if (url === undefined) return { ok: false, reason: "gh printed no issue URL" };
  return { ok: true, url };
}

/** Comments on an existing issue. The URL is the only locator. */
export function commentIssue(
  gh: GhRun,
  url: string,
  input: IssueInput,
): { ok: true } | { ok: false; reason: string } {
  const outcome = gh(["issue", "comment", url, "--body-file", "-"], watchdogComment(input));
  if (outcome.code !== 0) return { ok: false, reason: ghFailureReason(outcome) };
  return { ok: true };
}
