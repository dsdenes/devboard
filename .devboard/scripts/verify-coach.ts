#!/usr/bin/env bun
/**
 * The Coach gate. It builds the client, seeds ACP sessions and journal records
 * in a throwaway root under `.devboard/.tmp`, injects a stub forge, and runs
 * the manual CLI: one dry-run collection, one real cycle, a second cycle over
 * the same evidence, a recurrence after 24 hours, and both filing caps. No
 * test contacts a real forge, starts a peer, or writes outside `.devboard/.tmp`.
 */

import { chmodSync } from "node:fs";
import { createHash as hash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { journalFile } from "../server/journal";
import { coachDirectory } from "../coach/paths";
import { assertTrue, harnessRoot, makeRoot, run } from "./verification";

interface Call {
  op: "create" | "comment";
  title?: string;
  body: string;
  url?: string;
}

interface Report {
  cycle: string;
  window: { start: string; end: string };
  sessions: number;
  sessionFiles: number;
  truncated: boolean;
  skipped: number;
  malformed: number;
  journalRecords: number;
  findings: Array<{
    category: string;
    fingerprint: string;
    line: string;
    count: number;
    sessions: string[];
    scopes: string[];
  }>;
  action: string;
  issues: Array<{ url: string; category: string; fingerprint: string; line: string }>;
  pending: number;
  reason?: string;
}

const START = new Date("2026-02-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function instant(minutesAgo: number, from = START): string {
  return new Date(from.getTime() - minutesAgo * 60_000).toISOString();
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function directoryHash(directory: string): Promise<string> {
  const digest = hash("sha256");
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        digest.update(`d:${entry.name}\n`);
        await walk(path);
      } else {
        digest.update(`f:${entry.name}\n`);
        digest.update(await readFile(path));
      }
    }
  };
  if (existsSync(directory)) await walk(directory);
  return digest.digest("hex");
}

async function cloneEvidence(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const name of ["providers", "journal"]) {
    await cp(join(from, name), join(to, name), { recursive: true });
  }
}

async function writeSession(options: {
  stateDir: string;
  repoDir: string;
  id: string;
  startedAt: string;
  calls: number;
  malformed?: boolean;
}): Promise<void> {
  const directory = join(options.stateDir, "providers", "agents", "fixture", "sessions", "bucket");
  await mkdir(directory, { recursive: true });
  const records = [
    line({
      type: "session",
      version: 3,
      id: options.id,
      timestamp: options.startedAt,
      cwd: options.repoDir,
    }),
    line({ type: "title", v: 1, title: `session ${options.id}`, updatedAt: options.startedAt }),
  ];
  for (let index = 0; index < options.calls; index += 1) {
    records.push(
      line({
        type: "message",
        timestamp: options.startedAt,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: `call-${index}`,
              name: "bash",
              arguments: { command: "./scripts/verify-gap-command --flag" },
            },
          ],
          usage: {
            input: 100,
            output: 20,
            cacheRead: 10,
            cacheWrite: 0,
            totalTokens: 130,
            cost: { total: 0.02 },
          },
        },
      }),
    );
    records.push(
      line({
        type: "message",
        timestamp: options.startedAt,
        message: {
          role: "toolResult",
          toolCallId: `call-${index}`,
          toolName: "bash",
          content: [{ type: "text", text: "ERROR: cannot find module shared" }],
          isError: true,
        },
      }),
    );
  }
  if (options.malformed === true) records.push("{this is not json\n");
  await writeFile(join(directory, `${options.id}.jsonl`), records.join(""));
}

async function appendJournal(
  stateDir: string,
  repoDir: string,
  rows: Array<{ kind: string; text: string; scope: string; ts: string }>,
): Promise<void> {
  const path = journalFile(stateDir, repoDir);
  await mkdir(join(stateDir, "journal"), { recursive: true });
  await writeFile(
    path,
    rows
      .map((row) => line({ repo: repoDir, port: 1, pid: 1, ...row }))
      .join(""),
    { flag: "a" },
  );
}

const root = await makeRoot("verify-coach");
const repoDir = join(root, "checkout");
const stateDir = join(root, "state");
const stub = join(root, "stub-forge");
const marker = join(root, "peer-spawned");
const stubAgent = join(root, "stub-agent");
await mkdir(join(repoDir, ".devboard"), { recursive: true });
await mkdir(stateDir, { recursive: true });
await mkdir(stub, { recursive: true });
await writeFile(
  stubAgent,
  `#!/bin/sh\necho spawned > ${JSON.stringify(marker)}\nexit 1\n`,
);
chmodSync(stubAgent, 0o755);
Bun.spawnSync({
  cmd: ["git", "init", "-q", repoDir],
  stdout: "ignore",
  stderr: "ignore",
});
Bun.spawnSync({
  cmd: ["git", "-C", repoDir, "remote", "add", "origin", "https://github.com/acme/fixture.git"],
  stdout: "ignore",
  stderr: "ignore",
});

await writeSession({
  stateDir,
  repoDir,
  id: "session-a",
  startedAt: instant(120),
  calls: 3,
  malformed: true,
});
await writeSession({ stateDir, repoDir, id: "session-b", startedAt: instant(60), calls: 1 });
await writeSession({
  stateDir,
  repoDir,
  id: "session-late-a",
  startedAt: instant(60, new Date(START.getTime() + DAY)),
  calls: 1,
});
await writeSession({
  stateDir,
  repoDir,
  id: "session-late-b",
  startedAt: instant(50, new Date(START.getTime() + DAY)),
  calls: 1,
});
await appendJournal(stateDir, repoDir, [
  { kind: "question", text: "Should the parser be rewritten?", scope: "run-a", ts: instant(30) },
  { kind: "question", text: "Should the parser be rewritten?", scope: "run-b", ts: instant(20) },
  { kind: "acp-stderr", text: "fatal: provider exploded\nmore", scope: "run-a", ts: instant(30) },
  { kind: "acp-stderr", text: "fatal: provider exploded\nmore", scope: "run-b", ts: instant(20) },
  {
    kind: "question",
    text: "Should the parser be rewritten?",
    scope: "run-a",
    ts: instant(40, new Date(START.getTime() + DAY)),
  },
  {
    kind: "question",
    text: "Should the parser be rewritten?",
    scope: "run-b",
    ts: instant(30, new Date(START.getTime() + DAY)),
  },
  {
    kind: "acp-stderr",
    text: "fatal: provider exploded\nmore",
    scope: "run-a",
    ts: instant(40, new Date(START.getTime() + DAY)),
  },
  {
    kind: "acp-stderr",
    text: "fatal: provider exploded\nmore",
    scope: "run-b",
    ts: instant(30, new Date(START.getTime() + DAY)),
  },
]);
await mkdir(coachDirectory(stateDir), { recursive: true });
await writeFile(
  join(coachDirectory(stateDir), "projection.json"),
  `${JSON.stringify({
    version: 1,
    state: "ok",
    at: instant(1),
    error: null,
    issues: [],
  })}\n`,
);

const environment = {
  ...process.env,
  DEVBOARD_COACH_FORGE_STUB: stub,
  AGENT_COMMAND: stubAgent,
};

function coach(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Report {
  const result = run(
    process.execPath,
    [
      "run",
      "coach",
      "--",
      ...args,
      "--root",
      repoDir,
      "--state-dir",
      stateDir,
      "--json",
    ],
    { cwd: harnessRoot, env: { ...environment, ...extraEnv } },
  );
  if (result.code !== 0) {
    throw new Error(`coach ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as Report;
}

function calls(directory: string): Call[] {
  try {
    return readFileSync(join(directory, "calls.jsonl"), "utf8")
      .split("\n")
      .filter((entry) => entry.trim().length > 0)
      .map((entry) => JSON.parse(entry) as Call);
  } catch {
    return [];
  }
}

function categories(report: Report): string[] {
  return report.findings.map((finding) => finding.category).sort();
}

try {
  const build = run(process.execPath, ["run", "build"], { cwd: harnessRoot });
  assertTrue(build.code === 0, `verify:coach: bun run build failed: ${build.stderr}`);

  const sessionsBefore = await directoryHash(join(stateDir, "providers"));
  const journalBefore = await directoryHash(join(stateDir, "journal"));

  /* 1. The dry run finds every expected category and nothing else. */
  const dry = coach(["--collect", "--dry-run", "--now", START.toISOString()]);
  assertTrue(
    JSON.stringify(categories(dry)) ===
      JSON.stringify(["repeat-question", "retry-loop", "run-failure", "tool-failure", "tool-gap"]),
    `verify:coach: dry-run categories are ${JSON.stringify(categories(dry))}`,
  );
  assertTrue(dry.sessions === 4, `verify:coach: dry run read ${dry.sessions} sessions`);
  assertTrue(dry.malformed >= 1, "verify:coach: the malformed line was not counted");
  assertTrue(dry.truncated === false, "verify:coach: an untruncated selection reported truncated");
  assertTrue(calls(stub).length === 0, "verify:coach: the dry run filed an issue");
  console.log("PASS coach-dry-run");

  /* 2. One real cycle files one issue per fingerprint with the required body. */
  const first = coach(["--once", "--now", START.toISOString()]);
  assertTrue(first.action === "filed", `verify:coach: first cycle action ${first.action}`);
  const created = calls(stub).filter((call) => call.op === "create");
  assertTrue(
    created.length === first.findings.length,
    `verify:coach: filed ${created.length} of ${first.findings.length}`,
  );
  for (const finding of first.findings) {
    const match = created.find((call) => call.title?.includes(finding.line));
    assertTrue(match !== undefined, `verify:coach: no issue for ${finding.fingerprint}`);
    assertTrue(
      match.title?.startsWith(`[coach] ${finding.category}: `) === true,
      `verify:coach: wrong title for ${finding.fingerprint}: ${String(match.title)}`,
    );
    assertTrue((match.title?.length ?? 0) <= 80, "verify:coach: a title exceeds 80 characters");
    for (const section of ["## Finding", "## Evidence", "## Proposed change", "## Acceptance criteria"]) {
      assertTrue(
        (match.body.split(section).length - 1) === 1,
        `verify:coach: ${finding.fingerprint} has ${section} ${match.body.split(section).length - 1} times`,
      );
    }
    assertTrue(match.body.includes("- [ ]"), "verify:coach: no acceptance criterion");
    assertTrue(Buffer.byteLength(match.body, "utf8") <= 64 * 1024, "verify:coach: body over 64 KiB");
  }
  console.log("PASS coach-filing");

  /* 3. A second cycle over the same evidence files nothing and repeats the bytes. */
  const second = coach(["--once", "--now", START.toISOString()]);
  assertTrue(second.action === "duplicate", `verify:coach: second cycle action ${second.action}`);
  assertTrue(
    calls(stub).filter((call) => call.op === "create").length === created.length,
    "verify:coach: the second cycle filed another issue",
  );
  assertTrue(
    JSON.stringify(second.findings) === JSON.stringify(first.findings),
    "verify:coach: the second cycle's findings differ",
  );
  // The same evidence and clock in a fresh state directory produce the same
  // issue bytes.
  const twinState = join(root, "state-twin");
  const twinStub = join(root, "stub-twin");
  await mkdir(twinStub, { recursive: true });
  await cloneEvidence(stateDir, twinState);
  await mkdir(coachDirectory(twinState), { recursive: true });
  await writeFile(
    join(coachDirectory(twinState), "projection.json"),
    `${JSON.stringify({ version: 1, state: "ok", at: instant(1), error: null, issues: [] })}\n`,
  );
  const twin = run(
    process.execPath,
    [
      "run",
      "coach",
      "--",
      "--once",
      "--now",
      START.toISOString(),
      "--root",
      repoDir,
      "--state-dir",
      twinState,
      "--json",
    ],
    { cwd: harnessRoot, env: { ...environment, DEVBOARD_COACH_FORGE_STUB: twinStub } },
  );
  assertTrue(twin.code === 0, `verify:coach: the twin cycle failed: ${twin.stderr}`);
  assertTrue(
    readFileSync(join(stub, "calls.jsonl")).equals(readFileSync(join(twinStub, "calls.jsonl"))),
    "verify:coach: identical evidence produced different issue bytes",
  );
  console.log("PASS coach-deterministic");

  /* 4. A recurrence comments only after 24 hours. */
  const early = coach(["--once", "--now", new Date(START.getTime() + 12 * 60 * 60_000).toISOString()]);
  assertTrue(
    calls(stub).filter((call) => call.op === "comment").length === 0,
    "verify:coach: commented before 24 hours",
  );
  assertTrue(early.action === "duplicate", `verify:coach: early recurrence action ${early.action}`);
  const late = coach(["--once", "--now", new Date(START.getTime() + DAY + 60 * 60_000).toISOString()]);
  const comments = calls(stub).filter((call) => call.op === "comment");
  assertTrue(comments.length > 0, "verify:coach: no recurrence comment after 24 hours");
  assertTrue(
    comments.length === late.findings.length,
    `verify:coach: commented on ${comments.length} of ${late.findings.length} findings`,
  );
  assertTrue(
    calls(stub).filter((call) => call.op === "create").length === created.length,
    "verify:coach: the recurrence filed a second issue",
  );
  console.log("PASS coach-recurrence");

  /* 5. Both caps hold excess fingerprints pending. */
  const capState = join(root, "state-cap");
  const capStub = join(root, "stub-cap");
  await mkdir(capStub, { recursive: true });
  await cloneEvidence(stateDir, capState);
  await mkdir(coachDirectory(capState), { recursive: true });
  await writeFile(
    join(coachDirectory(capState), "settings.json"),
    `${JSON.stringify({ intervalMinutes: 60, maxPerHour: 1, maxPending: 1 })}\n`,
  );
  await writeFile(
    join(coachDirectory(capState), "projection.json"),
    `${JSON.stringify({ version: 1, state: "ok", at: instant(1), error: null, issues: [] })}\n`,
  );
  const capped = run(
    process.execPath,
    [
      "run",
      "coach",
      "--",
      "--once",
      "--now",
      START.toISOString(),
      "--root",
      repoDir,
      "--state-dir",
      capState,
      "--json",
    ],
    { cwd: harnessRoot, env: { ...environment, DEVBOARD_COACH_FORGE_STUB: capStub } },
  );
  assertTrue(capped.code === 0, `verify:coach: the capped cycle failed: ${capped.stderr}`);
  const capReport = JSON.parse(capped.stdout) as Report;
  assertTrue(capReport.action === "filed", `verify:coach: cap action ${capReport.action}`);
  assertTrue(
    calls(capStub).filter((call) => call.op === "create").length === 1,
    "verify:coach: the hourly cap filed more than one issue",
  );
  assertTrue(capReport.pending > 0, "verify:coach: the cap dropped pending fingerprints");

  const capAgain = run(
    process.execPath,
    [
      "run",
      "coach",
      "--",
      "--once",
      "--now",
      START.toISOString(),
      "--root",
      repoDir,
      "--state-dir",
      capState,
      "--json",
    ],
    { cwd: harnessRoot, env: { ...environment, DEVBOARD_COACH_FORGE_STUB: capStub } },
  );
  const capAgainReport = JSON.parse(capAgain.stdout) as Report;
  assertTrue(
    capAgainReport.action === "capped",
    `verify:coach: the second capped cycle action ${capAgainReport.action}`,
  );
  assertTrue(
    calls(capStub).filter((call) => call.op === "create").length === 1,
    "verify:coach: the second capped cycle filed another issue",
  );
  assertTrue(capAgainReport.pending >= capReport.pending, "verify:coach: pending shrank");

  const pendingState = join(root, "state-pending");
  const pendingStub = join(root, "stub-pending");
  await mkdir(pendingStub, { recursive: true });
  await cloneEvidence(stateDir, pendingState);
  await mkdir(coachDirectory(pendingState), { recursive: true });
  await writeFile(
    join(coachDirectory(pendingState), "settings.json"),
    `${JSON.stringify({ intervalMinutes: 60, maxPerHour: null, maxPending: 1 })}\n`,
  );
  await writeFile(
    join(coachDirectory(pendingState), "projection.json"),
    `${JSON.stringify({
      version: 1,
      state: "ok",
      at: instant(1),
      error: null,
      issues: [{ url: "https://forge.test/acme/fixture/issues/99", state: "pending", version: null }],
    })}\n`,
  );
  const pendingRun = run(
    process.execPath,
    [
      "run",
      "coach",
      "--",
      "--once",
      "--now",
      START.toISOString(),
      "--root",
      repoDir,
      "--state-dir",
      pendingState,
      "--json",
    ],
    { cwd: harnessRoot, env: { ...environment, DEVBOARD_COACH_FORGE_STUB: pendingStub } },
  );
  const pendingReport = JSON.parse(pendingRun.stdout) as Report;
  assertTrue(pendingRun.code === 0, `verify:coach: the pending cycle failed: ${pendingRun.stderr}`);
  assertTrue(
    calls(pendingStub).filter((call) => call.op === "create").length === 0,
    "verify:coach: the open-issue cap filed an issue",
  );
  assertTrue(pendingReport.pending > 0, "verify:coach: the open-issue cap dropped pending");
  console.log("PASS coach-caps");

  /* 6. Evidence stays byte-identical and no peer starts. */
  assertTrue(
    (await directoryHash(join(stateDir, "providers"))) === sessionsBefore,
    "verify:coach: a cycle changed the session files",
  );
  assertTrue(
    (await directoryHash(join(stateDir, "journal"))) === journalBefore,
    "verify:coach: a cycle changed the journal files",
  );
  assertTrue(!existsSync(marker), "verify:coach: a cycle spawned an ACP peer");
  console.log("PASS coach-read-only");

  console.log("verify:coach: OK");
} finally {
  // The throwaway root stays under `.devboard/.tmp` for inspection; a later
  // retention sweep removes it.
}
