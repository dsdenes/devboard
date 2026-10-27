#!/usr/bin/env bun
/**
 * The live loop, end to end. Starts a real dashboard on a free loopback port
 * with its STATE_DIR under `.devboard/.tmp`, writes one `server-error` carrying
 * a unique marker through the real journal writer, starts the installed
 * `devboard-watchdog.service`, and waits for that cycle to file a real issue in
 * `dsdenes/devboard`. It then proves the issue's title and body, closes it as
 * "not planned", and removes every fixture it created.
 */

import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { openJournal } from "../server/journal";
import {
  assertTrue,
  freePort,
  harnessRoot,
  makeHost,
  makeRoot,
  run,
  waitFor,
} from "./verification";

const WATCHDOG_DIR = join(harnessRoot, ".tmp", "watchdog");
const ATTEMPTS = 3;
const CYCLE_WAIT_MS = 120_000;

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

/** The newest run report that started at or after `since`, if it exists. */
async function newestReport(since: number): Promise<Record<string, unknown> | undefined> {
  let names: string[];
  try {
    names = (await readdir(join(WATCHDOG_DIR, "runs"))).sort().reverse();
  } catch {
    return undefined;
  }
  for (const name of names) {
    const path = join(WATCHDOG_DIR, "runs", name, "report.json");
    try {
      const info = await stat(path);
      if (info.mtimeMs < since) continue;
      return asRecord(JSON.parse(await readFile(path, "utf8")));
    } catch {
      continue;
    }
  }
  return undefined;
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

const marker = `verify-watchdog-live-${randomUUID()}`;
const errorLine = `Synthetic error: ENOTFOUND the fixture endpoint ${marker}`;
const root = await makeRoot("verify-watchdog-live");
let dashboardPid = 0;
let issueUrl = "";

try {
  if (Bun.file(join(harnessRoot, "dist", "index.html")).size === 0) {
    const build = run(process.execPath, ["run", "build"], { cwd: harnessRoot });
    assertTrue(build.code === 0, `verify:watchdog-live: bun run build failed: ${build.stderr}`);
  }

  const host = await makeHost(root, "host");
  const stateDir = join(root, "state");
  const port = await freePort();
  const dashboard = spawn(process.execPath, [join(harnessRoot, "server", "index.ts")], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      REPO_DIR: host.directory,
      ADRS_DIR: join(host.directory, "adrs"),
      GOAL_FILE: join(host.directory, "GOAL.md"),
      STATIC_DIR: join(harnessRoot, "dist"),
      STATE_DIR: stateDir,
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

  const journal = openJournal({ stateDir, repoDir: host.directory, port });
  journal.write("server-error", errorLine);
  assertTrue(
    Bun.file(journal.path).size > 0,
    `verify:watchdog-live: the seeded journal recorded the marker at ${journal.path}`,
  );

  let report: Record<string, unknown> | undefined;
  let issues: FiledIssue[] = [];
  let failure: string | undefined;
  for (let attempt = 0; attempt < ATTEMPTS && issues.length === 0; attempt += 1) {
    const startedAt = Date.now();
    const service = run("systemctl", ["--user", "start", "devboard-watchdog.service"]);
    assertTrue(
      service.code === 0,
      `verify:watchdog-live: starting devboard-watchdog.service failed: ${service.stderr}`,
    );
    await waitFor(
      async () => {
        const candidate = await newestReport(startedAt);
        if (candidate === undefined) return undefined;
        const matching = filedIssues(candidate).filter((issue) => issue.line.includes(marker));
        if (matching.length > 0) {
          report = candidate;
          issues = matching;
          return true;
        }
        if (candidate.action === "failed") {
          failure = String(candidate.reason ?? "no reason");
          return true;
        }
        return undefined;
      },
      "a cycle that files the seeded server-error",
      CYCLE_WAIT_MS,
    ).catch(() => undefined);
  }
  if (issues.length === 0 || report === undefined) {
    throw new Error(
      failure === undefined
        ? `verify:watchdog-live: no cycle filed the seeded marker ${marker}`
        : `verify:watchdog-live: the cycle failed: ${failure}`,
    );
  }
  if (report.action !== "filed") {
    throw new Error(`verify:watchdog-live: the run report action is ${String(report.action)}`);
  }
  const issue = issues[0];
  if (issue === undefined) throw new Error("verify:watchdog-live: the report lists no issue");
  if (issue.category !== "server-error") {
    throw new Error(`verify:watchdog-live: the category is ${issue.category}`);
  }
  issueUrl = issue.url;

  const ledger = JSON.parse(
    await readFile(join(WATCHDOG_DIR, "state.json"), "utf8"),
  ) as Record<string, unknown>;
  const findings = asRecord(ledger.findings);
  const entry = asRecord(findings?.[issue.fingerprint]);
  assertTrue(
    entry?.disposition === `filed:${issueUrl}`,
    `verify:watchdog-live: the ledger holds filed:${issueUrl}`,
  );

  const view = await ghJson([
    "issue",
    "view",
    issueUrl,
    "--repo",
    "dsdenes/devboard",
    "--json",
    "title,body,state",
  ]);
  const title = typeof view?.title === "string" ? view.title : "";
  const body = typeof view?.body === "string" ? view.body : "";
  assertTrue(
    title.startsWith("[watchdog] server-error:"),
    `the issue title starts with [watchdog] server-error: ${title}`,
  );
  assertTrue(body.includes(marker), "the issue body contains the unique marker");
  assertTrue(body.includes(issue.fingerprint), "the issue body contains the fingerprint");

  const closed = run("gh", [
    "issue",
    "close",
    issueUrl,
    "--repo",
    "dsdenes/devboard",
    "--reason",
    "not planned",
  ]);
  assertTrue(closed.code === 0, `gh issue close failed: ${closed.stderr}`);
  const after = await ghJson([
    "issue",
    "view",
    issueUrl,
    "--repo",
    "dsdenes/devboard",
    "--json",
    "state",
  ]);
  assertTrue(after?.state === "CLOSED", `the issue is CLOSED: ${String(after?.state)}`);

  console.log(`verify:watchdog-live: filed ${issueUrl} (fingerprint ${issue.fingerprint})`);
} finally {
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
