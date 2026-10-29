#!/usr/bin/env bun
/**
 * The live loop, end to end. Starts a real dashboard on a free loopback port
 * with its STATE_DIR under `.devboard/.tmp`, writes one `server-error` carrying
 * a unique marker through the real journal writer, starts the watchdog through
 * the dashboard's Start control, and waits for a real cycle to file a real
 * issue in the checkout's origin repository.
 *
 * The cycle's deduplication gate is exercised with the configured ACP agent:
 * the first synthetic finding is unique and files one issue, the second is an
 * exact duplicate of an open test issue this script creates and files nothing
 * and comments on nothing. Every fixture issue is closed in `finally`, even
 * when a later check fails, so a failed verification never leaves a synthetic
 * finding open in the tracker.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import {
  giteaCloseIssue,
  giteaCreateIssue,
  giteaJson,
  giteaTarget,
  issueNumberFromUrl,
  repoPath,
} from "../lib/gitea";
import { originForge } from "../issues/repository";
import { openJournal } from "../server/journal";
import { findingFingerprint } from "../watchdog/findings";
import { readWorkerState } from "../watchdog/worker-state";
import {
  assertTrue,
  freePort,
  harnessRoot,
  makeHost,
  makeRoot,
  repoRoot,
  run,
  waitFor,
} from "./verification";

const CYCLE_WAIT_MS = 300_000;
const CYCLE_ATTEMPTS = 3;

const remote = originForge(repoRoot);
if (remote === undefined) {
  throw new Error("verify:watchdog-live: the checkout's origin does not name a repository");
}
const project = remote.project;
const gitea = remote.forge === "gitea" ? giteaTarget({ remote }) : undefined;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

interface FiledIssue {
  url: string;
  category: string;
  fingerprint: string;
  line: string;
}

function filedIssues(report: Record<string, unknown>): FiledIssue[] {
  if (!Array.isArray(report.issues)) return [];
  const issues: FiledIssue[] = [];
  for (const candidate of report.issues) {
    const issue = asRecord(candidate);
    if (issue === undefined) continue;
    if (
      typeof issue.url !== "string" ||
      typeof issue.category !== "string" ||
      typeof issue.fingerprint !== "string" ||
      typeof issue.line !== "string"
    ) {
      continue;
    }
    issues.push({
      url: issue.url,
      category: issue.category,
      fingerprint: issue.fingerprint,
      line: issue.line,
    });
  }
  return issues;
}

interface DedupDecision {
  fingerprint: string;
  decision: string;
  issue?: string;
  representative?: string;
  reason?: string;
}

function dedupDecisions(report: Record<string, unknown>): DedupDecision[] {
  const section = asRecord(report.deduplication);
  if (section === undefined || !Array.isArray(section.decisions)) return [];
  const decisions: DedupDecision[] = [];
  for (const candidate of section.decisions) {
    const decision = asRecord(candidate);
    if (decision === undefined || typeof decision.fingerprint !== "string") continue;
    if (typeof decision.decision !== "string") continue;
    decisions.push({
      fingerprint: decision.fingerprint,
      decision: decision.decision,
      ...(typeof decision.issue === "string" ? { issue: decision.issue } : {}),
      ...(typeof decision.representative === "string"
        ? { representative: decision.representative }
        : {}),
      ...(typeof decision.reason === "string" ? { reason: decision.reason } : {}),
    });
  }
  return decisions;
}

function dedupOpenIssuesRead(report: Record<string, unknown>): number {
  const section = asRecord(report.deduplication);
  return typeof section?.openIssuesRead === "number" ? section.openIssuesRead : 0;
}

/** Every run report written at or after `since`, newest first. */
async function reportsSince(directory: string, since: number): Promise<Record<string, unknown>[]> {
  let names: string[];
  try {
    names = (await readdir(join(directory, "runs"))).sort().reverse();
  } catch {
    return [];
  }
  const reports: Record<string, unknown>[] = [];
  for (const name of names) {
    const path = join(directory, "runs", name, "report.json");
    try {
      const info = await stat(path);
      if (info.mtimeMs < since) continue;
      const report = asRecord(JSON.parse(await readFile(path, "utf8")));
      if (report !== undefined) reports.push(report);
    } catch {
      continue;
    }
  }
  return reports;
}

async function ghJson(args: string[]): Promise<Record<string, unknown> | undefined> {
  const result = run("gh", args);
  if (result.code !== 0) {
    throw new Error(`verify:watchdog-live: gh ${args.join(" ")} failed: ${result.stderr}`);
  }
  try {
    return asRecord(JSON.parse(result.stdout));
  } catch {
    return undefined;
  }
}

interface IssueSnapshot {
  title: string;
  body: string;
  state: string;
  comments: number;
}

/** The issue as the checkout's own forge reports it. */
async function issueSnapshot(url: string): Promise<IssueSnapshot> {
  if (gitea !== undefined) {
    const number = issueNumberFromUrl(url);
    if (number === undefined) {
      throw new Error(`verify:watchdog-live: the issue URL has no number: ${url}`);
    }
    const document = asRecord(
      await giteaJson<unknown>(gitea, `${repoPath(gitea)}/issues/${number}`),
    );
    const comments = await giteaJson<unknown>(gitea, `${repoPath(gitea)}/issues/${number}/comments`);
    return {
      title: typeof document?.title === "string" ? document.title : "",
      body: typeof document?.body === "string" ? document.body : "",
      state: typeof document?.state === "string" ? document.state : "",
      comments: Array.isArray(comments) ? comments.length : 0,
    };
  }
  const view = await ghJson([
    "issue",
    "view",
    url,
    "--repo",
    project,
    "--json",
    "title,body,state,comments",
  ]);
  const comments = Array.isArray(view?.comments) ? view.comments.length : 0;
  return {
    title: typeof view?.title === "string" ? view.title : "",
    body: typeof view?.body === "string" ? view.body : "",
    state: typeof view?.state === "string" ? view.state : "",
    comments,
  };
}

/** Closes the filed issue as "not planned" on the checkout's forge. */
async function closeIssue(url: string): Promise<void> {
  if (gitea !== undefined) {
    const number = issueNumberFromUrl(url);
    if (number === undefined) {
      throw new Error(`verify:watchdog-live: the issue URL has no number: ${url}`);
    }
    await giteaCloseIssue(gitea, number);
    return;
  }
  const closed = run("gh", [
    "issue",
    "close",
    url,
    "--repo",
    project,
    "--reason",
    "not planned",
  ]);
  if (closed.code !== 0) {
    throw new Error(`verify:watchdog-live: gh issue close failed: ${closed.stderr}`);
  }
}

/**
 * The configured provider store. The live step needs a model credential; the
 * fixture's STATE_DIR starts empty, so the operator's store is copied in. The
 * canonical checkout is the source when this runs from a worktree.
 */
function providerCredentials(): string | undefined {
  const candidates = [join(repoRoot, ".devboard", ".tmp", "providers", "credentials.json")];
  const common = run("git", [
    "-C",
    repoRoot,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (common.code === 0) {
    candidates.push(
      join(resolve(common.stdout.trim(), ".."), ".devboard", ".tmp", "providers", "credentials.json"),
    );
  }
  return candidates.find((candidate) => existsSync(candidate));
}

const marker = `verify-watchdog-live-${randomUUID()}`;
const errorLine = `Synthetic error: ENOTFOUND the fixture endpoint ${marker}`;
const duplicateMarker = `dup-${randomUUID().slice(0, 8)}`;
const duplicateLine = `Synthetic error: ENOTFOUND fixture ${duplicateMarker}`;
const duplicateFingerprint = findingFingerprint("server-error", duplicateLine);
const root = await makeRoot("verify-watchdog-live");
let dashboardPid = 0;
let socket: WebSocket | undefined;
let watchdogDirectory = "";
let issueUrl = "";
let testIssueUrl = "";
let accidentalUrl = "";
const closedIssues = new Set<string>();

function rememberIssue(url: string): void {
  if (url.length === 0) return;
  if (issueUrl.length === 0) issueUrl = url;
  else if (testIssueUrl.length === 0) testIssueUrl = url;
  else accidentalUrl = url;
}

async function stopWorker(): Promise<void> {
  if (socket === undefined || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "stopAgent", id: "watchdog" }));
  await waitFor(
    () => (readWorkerState(watchdogDirectory)?.lifecycle === "stopped" ? true : undefined),
    "the watchdog worker to stop",
    30_000,
  ).catch(() => undefined);
}

interface CycleOutcome {
  report: Record<string, unknown>;
  reports: Record<string, unknown>[];
}

/** Starts the watchdog and waits for one cycle that mentions `fingerprint`. */
async function runCycleUntil(
  label: string,
  decide: (reports: Record<string, unknown>[]) => Record<string, unknown> | undefined,
): Promise<CycleOutcome> {
  let lastFailure = "";
  for (let attempt = 1; attempt <= CYCLE_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now();
    socket?.send(JSON.stringify({ type: "startAgent", id: "watchdog" }));
    let found: Record<string, unknown> | undefined;
    await waitFor(
      async () => {
        const reports = await reportsSince(watchdogDirectory, startedAt);
        found = decide(reports);
        return found === undefined ? undefined : reports;
      },
      `${label} cycle`,
      CYCLE_WAIT_MS,
    ).catch(() => undefined);
    const reports = await reportsSince(watchdogDirectory, startedAt);
    await stopWorker();
    if (found !== undefined) return { report: found, reports };
    const failed = reports.find((report) => report.action === "failed");
    lastFailure =
      failed === undefined
        ? `no cycle answered for ${label}`
        : String(failed.reason ?? "no reason");
    if (!/deduplication|agent/i.test(lastFailure)) break;
    console.log(`verify:watchdog-live: ${label} attempt ${attempt} failed closed: ${lastFailure}`);
  }
  throw new Error(`verify:watchdog-live: ${lastFailure}`);
}

try {
  if (Bun.file(join(harnessRoot, "dist", "index.html")).size === 0) {
    const build = run(process.execPath, ["run", "build"], { cwd: harnessRoot });
    assertTrue(build.code === 0, `verify:watchdog-live: bun run build failed: ${build.stderr}`);
  }
  const credentials = providerCredentials();
  assertTrue(
    credentials !== undefined,
    "verify:watchdog-live: no provider credentials found; the deduplication agent cannot start",
  );

  const host = await makeHost(root, "host");
  await mkdir(join(host.directory, ".devboard"), { recursive: true });
  const originUrl = run("git", ["-C", repoRoot, "remote", "get-url", "origin"]).stdout.trim();
  assertTrue(originUrl.length > 0, "verify:watchdog-live: the checkout has no origin URL");
  run("git", ["-C", host.directory, "remote", "add", "origin", originUrl]);
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const systemctl = join(binDir, "systemctl");
  await writeFile(
    systemctl,
    `#!/bin/sh
case "$2" in
  is-active) echo inactive ;;
  is-enabled) echo disabled ;;
esac
exit 0
`,
  );
  chmodSync(systemctl, 0o755);
  watchdogDirectory = join(host.directory, ".devboard", ".tmp", "watchdog");
  const stateDir = join(root, "state");
  const providerDir = join(stateDir, "providers");
  await mkdir(providerDir, { recursive: true, mode: 0o700 });
  copyFileSync(credentials as string, join(providerDir, "credentials.json"));
  chmodSync(join(providerDir, "credentials.json"), 0o600);
  const port = await freePort();
  const dashboard = spawn(process.execPath, [join(harnessRoot, "server", "index.ts")], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOST: "127.0.0.1",
      PORT: String(port),
      REPO_DIR: host.directory,
      ADRS_DIR: join(host.directory, "adrs"),
      GOAL_FILE: join(host.directory, "GOAL.md"),
      STATIC_DIR: join(harnessRoot, "dist"),
      STATE_DIR: stateDir,
      DEVBOARD_WATCHDOG_FIXTURE: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  dashboardPid = dashboard.pid ?? 0;

  await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(2000),
        });
        return response.ok ? true : undefined;
      } catch {
        return undefined;
      }
    },
    "the seeded dashboard",
    30_000,
  );

  socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const opened = Promise.withResolvers<void>();
  socket.onopen = () => opened.resolve();
  socket.onerror = () => opened.reject(new Error("verify:watchdog-live: websocket failed"));
  await opened.promise;

  /* ---------------------------------------------------------------- */
  /* 1. A unique finding files exactly one issue                       */
  /* ---------------------------------------------------------------- */
  const journal = openJournal({ stateDir, repoDir: host.directory, port });
  journal.write("server-error", errorLine);
  assertTrue(
    Bun.file(journal.path).size > 0,
    `verify:watchdog-live: the seeded journal recorded the marker at ${journal.path}`,
  );

  const unique = await runCycleUntil("the unique finding", (reports) =>
    reports.find((candidate) =>
      filedIssues(candidate).some((issue) => issue.line.includes(marker)),
    ),
  );
  const uniqueIssue = filedIssues(unique.report).find((issue) => issue.line.includes(marker));
  if (uniqueIssue === undefined) {
    throw new Error("verify:watchdog-live: the cycle filed no issue for the unique finding");
  }
  rememberIssue(uniqueIssue.url);
  assertTrue(
    unique.report.action === "filed",
    `verify:watchdog-live: the run report action is ${String(unique.report.action)}`,
  );
  assertTrue(
    uniqueIssue.category === "server-error",
    `verify:watchdog-live: the category is ${uniqueIssue.category}`,
  );
  const uniqueDecision = dedupDecisions(unique.report).find(
    (decision) => decision.fingerprint === uniqueIssue.fingerprint,
  );
  assertTrue(
    uniqueDecision?.decision === "unique",
    `the unique finding's decision is ${JSON.stringify(uniqueDecision)}`,
  );
  assertTrue(
    dedupOpenIssuesRead(unique.report) > 0,
    "the report does not prove the agent read the repository's open issues",
  );

  const ledger = JSON.parse(
    await readFile(join(watchdogDirectory, "state.json"), "utf8"),
  ) as Record<string, unknown>;
  const findings = asRecord(ledger.findings);
  const entry = asRecord(findings?.[uniqueIssue.fingerprint]);
  assertTrue(
    entry?.disposition === `filed:${uniqueIssue.url}`,
    `verify:watchdog-live: the ledger holds filed:${uniqueIssue.url}`,
  );
  const view = await issueSnapshot(uniqueIssue.url);
  assertTrue(
    view.title.startsWith("[watchdog] server-error:"),
    `the issue title starts with [watchdog] server-error: ${view.title}`,
  );
  assertTrue(view.body.includes(marker), "the issue body contains the unique marker");
  assertTrue(
    view.body.includes(uniqueIssue.fingerprint),
    "the issue body contains the fingerprint",
  );
  console.log(`verify:watchdog-live: filed ${uniqueIssue.url} (fingerprint ${uniqueIssue.fingerprint})`);

  /* ---------------------------------------------------------------- */
  /* 2. A finding duplicating an open test issue files nothing         */
  /* ---------------------------------------------------------------- */
  assertTrue(
    gitea !== undefined,
    "verify:watchdog-live: the duplicate fixture needs a Gitea origin",
  );
  const testIssue = await giteaCreateIssue(gitea, {
    title: `[watchdog] server-error: ${duplicateLine}`.slice(0, 80),
    body: [
      "## Watchdog finding",
      "",
      "- Category: `server-error`",
      `- Fingerprint: \`${duplicateFingerprint}\``,
      "",
      "### Quote",
      "",
      "```text",
      duplicateLine,
      "```",
      "",
      "Synthetic duplicate fixture created by verify:watchdog-live.",
      "",
    ].join("\n"),
  });
  testIssueUrl = testIssue.url;

  const duplicateJournal = openJournal({ stateDir, repoDir: host.directory, port });
  duplicateJournal.write("server-error", duplicateLine);

  const duplicate = await runCycleUntil("the duplicate finding", (reports) =>
    reports.find((candidate) =>
      dedupDecisions(candidate).some(
        (decision) => decision.fingerprint === duplicateFingerprint && decision.decision === "duplicate",
      ),
    ),
  );
  const duplicateDecision = dedupDecisions(duplicate.report).find(
    (decision) => decision.fingerprint === duplicateFingerprint,
  );
  assertTrue(
    duplicateDecision?.decision === "duplicate",
    `the duplicate finding's decision is ${JSON.stringify(duplicateDecision)}`,
  );
  assertTrue(
    (duplicateDecision?.issue ?? "").length > 0,
    "the duplicate decision names no matched issue",
  );
  assertTrue(
    filedIssues(duplicate.report).every((issue) => !issue.line.includes(duplicateMarker)),
    "the cycle filed the duplicate finding",
  );
  const duplicateLedger = JSON.parse(
    await readFile(join(watchdogDirectory, "state.json"), "utf8"),
  ) as Record<string, unknown>;
  const duplicateEntry = asRecord(asRecord(duplicateLedger.findings)?.[duplicateFingerprint]);
  assertTrue(
    typeof duplicateEntry?.disposition === "string" &&
      duplicateEntry.disposition.startsWith("duplicate:"),
    `the ledger does not record the duplicate match: ${JSON.stringify(duplicateEntry?.disposition)}`,
  );
  assertTrue(
    duplicateEntry?.disposition === `duplicate:${duplicateDecision?.issue as string}`,
    "the ledger records a different matched issue",
  );
  const testSnapshot = await issueSnapshot(testIssueUrl);
  assertTrue(
    testSnapshot.comments === 0,
    `the duplicate cycle commented ${testSnapshot.comments} time(s)`,
  );
  const uniqueSnapshot = await issueSnapshot(uniqueIssue.url);
  assertTrue(
    uniqueSnapshot.comments === 0,
    `the duplicate cycle commented on the filed issue ${uniqueSnapshot.comments} time(s)`,
  );
  assertTrue(
    dedupOpenIssuesRead(duplicate.report) > 0,
    "the duplicate cycle's report does not prove the agent read the open issues",
  );
  console.log(
    `verify:watchdog-live: suppressed ${duplicateFingerprint} as ${String(duplicateDecision?.issue)}`,
  );

  await closeIssue(uniqueIssue.url);
  closedIssues.add(uniqueIssue.url);
  await closeIssue(testIssueUrl);
  closedIssues.add(testIssueUrl);
  const after = await issueSnapshot(uniqueIssue.url);
  assertTrue(
    after.state.toUpperCase() === "CLOSED",
    `the issue is CLOSED: ${after.state}`,
  );
} finally {
  // A failed title, body, or state check must not leave a synthetic finding
  // open in the tracker.
  for (const url of [issueUrl, testIssueUrl, accidentalUrl]) {
    if (url.length === 0 || closedIssues.has(url)) continue;
    try {
      await closeIssue(url);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`verify:watchdog-live: could not close ${url}: ${detail}`);
    }
  }
  if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
    try {
      await stopWorker();
    } catch {
      // The dashboard may already be gone.
    }
    socket.close();
  }
  if (dashboardPid > 0) {
    try {
      process.kill(dashboardPid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  await rm(root, { recursive: true, force: true });
}

assertTrue(issueUrl.length > 0, "verify:watchdog-live: no issue URL was recorded");
console.log(issueUrl);
