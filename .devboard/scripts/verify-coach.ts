#!/usr/bin/env bun
/**
 * The Coach family pipeline. It builds the client, seeds three command
 * families under `.devboard/.tmp`, injects a deterministic synthesizer and a
 * stub forge, and runs the manual CLI: one cycle, a second cycle over the same
 * evidence, and a capped cycle holding a proposal pending. No test contacts a
 * real forge, starts a peer, or writes outside `.devboard/.tmp`.
 */

import { chmodSync } from "node:fs";
import { createHash as hash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { journalFile } from "../server/journal";
import { coachDirectory } from "../coach/paths";
import { familyTag } from "../coach/issue";
import { assertTrue, harnessRoot, makeRoot, run } from "./verification";

interface Call {
  op: "create";
  title?: string;
  body: string;
  url?: string;
}

interface FamilySummary {
  key: string;
  kind: string;
  score: number;
  calls: number;
  sessions: number;
  days: number;
}

interface Report {
  cycle: string;
  window: { start: string; end: string };
  sessions: number;
  journalRecords: number;
  families: number;
  selected: FamilySummary[];
  findings: FamilySummary[];
  omitted: number;
  ledgerReset: boolean;
  synthesis: Array<{ family: string; model: string; durationMs: number; ok: boolean }>;
  validations: Array<{ family: string; outcome: string; rule?: string }>;
  action: string;
  issues: Array<{ url: string; family: string; kind: string; title: string }>;
  duplicates: Array<{ family: string; url: string }>;
  dropped: number;
  pending: number;
  reason?: string;
}

const START = new Date("2026-02-01T12:00:00.000Z");

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
    if (!existsSync(join(from, name))) continue;
    await cp(join(from, name), join(to, name), { recursive: true });
  }
}

async function writeSession(options: {
  stateDir: string;
  repoDir: string;
  id: string;
  startedAt: string;
  commands: string[];
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
  options.commands.forEach((command, index) => {
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
              arguments: { command },
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
  });
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
    rows.map((row) => line({ repo: repoDir, port: 1, pid: 1, ...row })).join(""),
    { flag: "a" },
  );
}

const root = await makeRoot("verify-coach");
const repoDir = join(root, "checkout");
const stateDir = join(root, "state");
const stub = join(root, "stub-forge");
const marker = join(root, "peer-spawned");
const stubAgent = join(root, "stub-agent");
const synthesisStub = join(root, "synthesis.json");
await mkdir(join(repoDir, ".devboard"), { recursive: true });
await mkdir(stateDir, { recursive: true });
await mkdir(stub, { recursive: true });
await writeFile(stubAgent, `#!/bin/sh\necho spawned > ${JSON.stringify(marker)}\nexit 1\n`);
chmodSync(stubAgent, 0o755);

const FAMILIES = [
  "./scripts/verify-family-one",
  "./scripts/verify-family-two",
  "./scripts/verify-family-three",
];

await writeFile(
  synthesisStub,
  `${JSON.stringify({
    default: {
      family: "{{family}}",
      action: "tool",
      tool: {
        name: "coach_family_tool",
        title: "Run the recurring family command",
        description: "Replaces the recurring command with one named capability.",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        covers: ["{{family}}"],
      },
      rationale: "The family recurs, so one named capability removes the manual command.",
      acceptance: ["- [ ] The family command runs through the named tool."],
    },
  })}\n`,
);

Bun.spawnSync({ cmd: ["git", "init", "-q", repoDir], stdout: "ignore", stderr: "ignore" });
Bun.spawnSync({
  cmd: ["git", "-C", repoDir, "remote", "add", "origin", "https://github.com/acme/fixture.git"],
  stdout: "ignore",
  stderr: "ignore",
});

/* Exactly three command families, plus one single-scope journal line. */
await writeSession({
  stateDir,
  repoDir,
  id: "session-a",
  startedAt: instant(120),
  commands: [`${FAMILIES[0]} --flag`, `${FAMILIES[1]} --flag`],
  malformed: true,
});
await writeSession({
  stateDir,
  repoDir,
  id: "session-b",
  startedAt: instant(60),
  commands: [`${FAMILIES[1]} --other`, `${FAMILIES[2]} --flag`],
});
await appendJournal(stateDir, repoDir, [
  { kind: "question", text: "A single-scope note?", scope: "run-a", ts: instant(30) },
]);
const coachDir = coachDirectory(stateDir);
await mkdir(coachDir, { recursive: true });
await writeFile(
  join(coachDir, "settings.json"),
  `${JSON.stringify({
    intervalMinutes: 60,
    maxPerHour: null,
    maxPending: 20,
    maxIssuesPerCycle: 20,
    allowlist: ["./scripts/"],
  })}\n`,
);

const environment = {
  ...process.env,
  DEVBOARD_COACH_FORGE_STUB: stub,
  DEVBOARD_COACH_SYNTHESIS_STUB: synthesisStub,
  AGENT_COMMAND: stubAgent,
};

function coach(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Report {
  const result = run(
    process.execPath,
    ["run", "coach", "--", ...args, "--root", repoDir, "--state-dir", stateDir, "--json"],
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

try {
  const build = run(process.execPath, ["run", "build"], { cwd: harnessRoot });
  assertTrue(build.code === 0, `verify:coach: bun run build failed: ${build.stderr}`);

  const sessionsBefore = await directoryHash(join(stateDir, "providers"));
  const journalBefore = await directoryHash(join(stateDir, "journal"));

  /* 1. One cycle: three families, one synthesis call each, three filings. */
  const first = coach(["--once", "--now", START.toISOString()]);
  assertTrue(first.families === 3, `verify:coach: families is ${first.families}`);
  assertTrue(first.selected.length === 3, `verify:coach: selected is ${first.selected.length}`);
  assertTrue(first.synthesis.length === 3, `verify:coach: synthesis calls ${first.synthesis.length}`);
  assertTrue(
    JSON.stringify(first.synthesis.map((call) => call.family).sort()) ===
      JSON.stringify(FAMILIES.slice().sort()),
    `verify:coach: synthesis families are ${JSON.stringify(first.synthesis.map((call) => call.family))}`,
  );
  assertTrue(first.action === "filed", `verify:coach: first cycle action ${first.action}`);
  const created = calls(stub).filter((call) => call.op === "create");
  assertTrue(created.length === 3, `verify:coach: filed ${created.length} issue(s)`);

  for (const key of FAMILIES) {
    const match = created.find((call) => call.title === `[coach] ${key}`);
    assertTrue(match !== undefined, `verify:coach: no issue titled [coach] ${key}`);
    const tool = {
      name: "coach_family_tool",
      title: "Run the recurring family command",
      description: "Replaces the recurring command with one named capability.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      covers: [key],
    };
    for (const section of [
      "## Family",
      "## Evidence",
      "## Proposed tool",
      "## Acceptance",
      "## Rationale",
    ]) {
      assertTrue(
        match.body.split(section).length - 1 === 1,
        `verify:coach: ${key} has ${section} ${match.body.split(section).length - 1} times`,
      );
    }
    assertTrue(
      match.body.includes(JSON.stringify(tool, null, 2)),
      `verify:coach: ${key} lacks the exact tool definition`,
    );
    assertTrue(
      match.body.includes(`family:${familyTag(key)}`),
      `verify:coach: ${key} lacks its family tag`,
    );
    assertTrue(
      match.body.includes(JSON.stringify("./scripts/")),
      `verify:coach: ${key} lacks the exact allowlist entry`,
    );
    assertTrue(match.body.includes("- [ ]"), `verify:coach: ${key} has no acceptance criterion`);
    assertTrue(
      Buffer.byteLength(match.body, "utf8") < 64 * 1024,
      `verify:coach: ${key} body over 64 KiB`,
    );
  }
  console.log("PASS coach-families");

  /* 2. The same evidence files nothing a second time. */
  const second = coach(["--once", "--now", START.toISOString()]);
  assertTrue(second.action === "none", `verify:coach: second cycle action ${second.action}`);
  assertTrue(
    calls(stub).filter((call) => call.op === "create").length === 3,
    "verify:coach: the second cycle filed another issue",
  );
  assertTrue(second.duplicates.length === 3, `verify:coach: duplicates ${second.duplicates.length}`);
  assertTrue(
    JSON.stringify(second.findings) === JSON.stringify(first.findings),
    "verify:coach: the second cycle's families differ",
  );
  console.log("PASS coach-no-second-filing");

  /* 3. The cap holds two proposals pending with their bytes. */
  const capState = join(root, "state-cap");
  const capStub = join(root, "stub-cap");
  await mkdir(capStub, { recursive: true });
  await cloneEvidence(stateDir, capState);
  await mkdir(coachDirectory(capState), { recursive: true });
  await writeFile(
    join(coachDirectory(capState), "settings.json"),
    `${JSON.stringify({
      intervalMinutes: 60,
      maxPerHour: null,
      maxPending: 20,
      maxIssuesPerCycle: 1,
      allowlist: ["./scripts/"],
    })}\n`,
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
    "verify:coach: the per-cycle cap filed more than one issue",
  );
  assertTrue(capReport.pending === 2, `verify:coach: the cap kept ${capReport.pending} pending`);

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
  assertTrue(capAgain.code === 0, `verify:coach: the second capped cycle failed: ${capAgain.stderr}`);
  const capAgainReport = JSON.parse(capAgain.stdout) as Report;
  assertTrue(
    calls(capStub).filter((call) => call.op === "create").length === 2,
    "verify:coach: the pending proposal was not filed first",
  );
  assertTrue(capAgainReport.pending === 1, `verify:coach: pending is ${capAgainReport.pending}`);
  console.log("PASS coach-caps");

  /* 4. Evidence stays byte-identical and no peer starts. */
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
