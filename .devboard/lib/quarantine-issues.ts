/**
 * The durable record a quarantine leaves: one issue per skipped test.
 *
 * Filing is best effort and never blocks the release. A missing forge, a
 * refused token, or an unreachable instance is reported on one line and the
 * step still ends successfully; the quarantine still applied to the run. A
 * test that already has an open issue is named by one comment instead of a
 * second issue, so repeated flakiness accumulates on one record.
 */

import { configuredGiteaToken, giteaBaseUrl, parseForgeRemote } from "./forge";
import {
  giteaCommentIssue,
  giteaCreateIssue,
  giteaListIssues,
  type GiteaTarget,
} from "./gitea";
import { git } from "../issues/repository";
import type { QuarantineReport } from "./test-quarantine";

/** What one run contributes to an issue. */
export interface QuarantineContext {
  /** The commit the release was cut from. */
  commit: string;
  /** The workflow run, when the runner exposes one. */
  runUrl: string | undefined;
}

export interface OpenIssue {
  number: number;
  title: string;
}

/** The forge reads and writes filing needs; the tests inject their own. */
export interface IssueForge {
  listOpenIssues(): Promise<OpenIssue[]>;
  createIssue(input: { title: string; body: string }): Promise<{ number: number }>;
  commentIssue(number: number, body: string): Promise<void>;
}

const TITLE_PREFIX = "quarantine(test): ";
const TITLE_LIMIT = 200;
const BODY_LIMIT = 60_000;
const FENCE = "````";

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function firstLine(value: string): string {
  return (
    value
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A one-line title that contains the exact test name. The suite chain is
 * dropped before the name, and a name that cannot fit is left for the body:
 * the title never shortens the name it reports.
 */
export function quarantineIssueTitle(report: QuarantineReport): string | undefined {
  const candidates = [report.fullName, report.name].map(oneLine);
  for (const candidate of candidates) {
    const title = `${TITLE_PREFIX}${candidate}`;
    if (candidate.length > 0 && title.length <= TITLE_LIMIT) return title;
  }
  return undefined;
}

function attemptsSection(report: QuarantineReport): string {
  return report.attempts
    .map(
      (attempt) =>
        `### attempt ${attempt.index}\n\n${FENCE}text\n${attempt.output.trim()}\n${FENCE}`,
    )
    .join("\n\n");
}

function contextSection(context: QuarantineContext): string {
  return [
    `- commit: \`${context.commit}\``,
    `- workflow run: ${context.runUrl === undefined ? "unavailable" : context.runUrl}`,
  ].join("\n");
}

/** The body of the issue a first quarantine files. */
export function quarantineIssueBody(report: QuarantineReport, context: QuarantineContext): string {
  const body = [
    `The release suite's test \`${oneLine(report.fullName)}\` failed three consecutive attempts,`,
    "so it was skipped for the rest of that run. The checkout was restored afterwards: no",
    "tracked file, commit, or tag carries the skip, and this issue is the durable record.",
    "",
    `- test: \`${oneLine(report.fullName)}\``,
    `- file: \`${report.file}\``,
    contextSection(context),
    "",
    attemptsSection(report),
  ].join("\n");
  return body.length <= BODY_LIMIT ? body : `${body.slice(0, BODY_LIMIT)}\n… (truncated)`;
}

/** The comment a later quarantine appends to the existing issue. */
export function quarantineCommentBody(
  report: QuarantineReport,
  context: QuarantineContext,
): string {
  const body = [
    `Quarantined again: ${context.runUrl === undefined ? "a release suite run" : context.runUrl}`,
    `skipped \`${oneLine(report.fullName)}\` in \`${report.file}\`.`,
    "",
    contextSection(context),
    "",
    attemptsSection(report),
  ].join("\n");
  return body.length <= BODY_LIMIT ? body : `${body.slice(0, BODY_LIMIT)}\n… (truncated)`;
}

/**
 * Files one issue per report, or appends one comment to the open issue whose
 * title already names the test. Every failure is reported on its own line and
 * swallowed: filing never changes the suite step's exit code.
 */
export async function fileQuarantineReports(
  reports: QuarantineReport[],
  forge: IssueForge,
  context: QuarantineContext,
  log: (line: string) => void,
): Promise<void> {
  if (reports.length === 0) return;
  let open: OpenIssue[] | undefined;
  let listFailure: string | undefined;
  try {
    open = await forge.listOpenIssues();
  } catch (error) {
    listFailure = reasonOf(error);
  }
  for (const report of reports) {
    const title = quarantineIssueTitle(report);
    if (title === undefined) {
      log(`filing failed: ${report.file} :: ${report.fullName}: the name does not fit a title`);
      continue;
    }
    if (open === undefined) {
      const reason = firstLine(listFailure ?? "the open issues could not be read");
      log(`filing failed: open issue list: ${reason}`);
    } else {
      const existing = open.find((issue) => issue.title.includes(oneLine(report.name)));
      if (existing !== undefined) {
        try {
          await forge.commentIssue(existing.number, quarantineCommentBody(report, context));
          log(`commented on issue #${existing.number}: ${title}`);
        } catch (error) {
          const reason = firstLine(reasonOf(error));
          log(`filing failed: comment on issue #${existing.number}: ${reason}`);
        }
        continue;
      }
    }
    try {
      const created = await forge.createIssue({
        title,
        body: quarantineIssueBody(report, context),
      });
      open?.push({ number: created.number, title });
      log(`filed issue #${created.number}: ${title}`);
    } catch (error) {
      log(`filing failed: create issue "${title}": ${firstLine(reasonOf(error))}`);
    }
  }
}

/**
 * The origin repository's Gitea API. The project always comes from the
 * checkout's `origin` remote; the address and token come from the environment
 * the workflow supplies, falling back to an HTTP origin remote. Every method
 * throws a named reason when that cannot be resolved, which the filing loop
 * reports without failing the step.
 */
export function giteaIssueForge(
  repoDir: string,
  environment: Record<string, string | undefined> = process.env,
): IssueForge {
  let target: GiteaTarget | undefined;
  const resolveTarget = (): GiteaTarget => {
    if (target !== undefined) return target;
    const origin = git(repoDir, "remote", "get-url", "origin");
    const remote = origin.code === 0 ? parseForgeRemote(origin.stdout, environment) : undefined;
    if (remote === undefined) {
      throw new Error("the checkout's origin remote names no repository");
    }
    const baseUrl = giteaBaseUrl(remote, environment);
    if (baseUrl === undefined) {
      throw new Error("the Gitea address is not configured; set DEVBOARD_GITEA_URL");
    }
    const token = configuredGiteaToken(environment);
    target = {
      baseUrl: baseUrl.replace(/\/+$/, ""),
      project: remote.project,
      ...(token === undefined ? {} : { token }),
    };
    return target;
  };
  return {
    async listOpenIssues() {
      const issues = await giteaListIssues(resolveTarget(), "open");
      return issues.map((issue) => ({ number: issue.number, title: issue.title }));
    },
    async createIssue(input) {
      const issue = await giteaCreateIssue(resolveTarget(), input);
      return { number: issue.number };
    },
    async commentIssue(number, body) {
      await giteaCommentIssue(resolveTarget(), number, body);
    },
  };
}
