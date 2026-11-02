#!/usr/bin/env bun
/**
 * The Coach family pipeline, tool-driven. It builds the client, seeds three
 * command families under `.devboard/.tmp`, injects a deterministic synthesis
 * stub and a stub forge, and runs the manual CLI: one cycle, a second cycle
 * over the same evidence with the filed issues visible to the dedup read, and
 * a capped cycle whose synthesis stub obeys the per-cycle filing room.
 *
 * The synthesis stub performs the writes a real peer would: an `issue_create`
 * record in the family's tool-log for a tool or prompt answer, or a
 * `coach_proposal_skip` record in its skips log for `none`. The stub never
 * contacts the forge, so after the first cycle the script mirrors the recorded
 * issues into the forge stub: that is the open-issue list the second cycle's
 * dedup read would see had the peer filed them for real. No test contacts a
 * real forge, starts a peer, or writes outside `.devboard/.tmp`.
 */

import { chmodSync } from "node:fs";
import { createHash as hash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CoachReport } from "../coach/coordinator";
import type { CoachFamily } from "../coach/families";
import { familyTag } from "../coach/issue";
import { coachDirectory } from "../coach/paths";
import { readCoachSettings, type CoachSettings } from "../coach/settings";
import { synthesisPrompt } from "../coach/synthesize";
import { journalFile } from "../server/journal";
import { assertTrue, harnessRoot, makeRoot, run } from "./verification";

interface StubAnswer {
  action: "tool" | "prompt" | "none";
  title?: string;
  body?: string;
  number?: number;
  url?: string;
  reason?: string;
}

interface ToolRecordLine {
  tool?: unknown;
  ok?: unknown;
  value?: Record<string, unknown>;
}

interface LedgerEntry {
  lastAction?: string;
  lastIssueUrl?: string;
  lastTitle?: string;
  lastFiledAt?: string;
}

interface LedgerDocument {
  version?: number;
  families?: Record<string, LedgerEntry>;
}

const START = new Date("2026-02-01T12:00:00.000Z");

const FAMILIES = [
  "./scripts/verify-family-one",
  "./scripts/verify-family-two",
  "./scripts/verify-family-three",
];

function primaryIssue(title: string, number: number): { title: string; number: number; url: string } {
  return { title, number, url: `https://forge.test/fixture/fixture/issues/${number}` };
}

/** Titles and forge numbers the primary stub promises per family. */
const PRIMARY = new Map([
  [FAMILIES[0], primaryIssue(`[coach] prompt: ${FAMILIES[0]}`, 1)],
  [FAMILIES[1], primaryIssue(`[coach] ${FAMILIES[1]}`, 2)],
  [FAMILIES[2], primaryIssue(`[coach] ${FAMILIES[2]}`, 3)],
]);

function instant(minutesAgo: number, from = START): string {
  return new Date(from.getTime() - minutesAgo * 60_000).toISOString();
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function records(path: string): ToolRecordLine[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((entry) => entry.trim().length > 0)
      .map((entry) => JSON.parse(entry) as ToolRecordLine);
  } catch {
    return [];
  }
}

function familyDirectory(report: CoachReport, key: string): string {
  return join(
    dirname(report.reportPath),
    "families",
    key.replace(/[^a-zA-Z0-9._-]+/g, "-"),
  );
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

async function writeStub(
  path: string,
  families: Record<string, StubAnswer>,
): Promise<void> {
  await writeFile(path, `${JSON.stringify({ families })}\n`);
}

function toolAnswer(key: string, number: number): StubAnswer {
  return {
    action: "tool",
    title: `[coach] ${key}`,
    body: `## Family\n\n\`${key}\` recurs. The tool \`coach_family_tool\` must be added with the\nallowlist entry "./scripts/".\n`,
    number,
    url: `https://forge.test/fixture/fixture/issues/${number}`,
  };
}

function promptAnswer(key: string, number: number): StubAnswer {
  return {
    action: "prompt",
    title: `[coach] prompt: ${key}`,
    body: `## Family\n\n\`${key}\` recurs. One instruction replaces it.\n`,
    number,
    url: `https://forge.test/fixture/fixture/issues/${number}`,
  };
}

function skipAnswer(reason: string): StubAnswer {
  return { action: "none", reason };
}

async function settingsFile(directory: string, settings: CoachSettings): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "settings.json"),
    `${JSON.stringify(settings)}\n`,
  );
}

/**
 * Recreates the forge state a real `issue_create` would leave behind: the
 * dedup read lists these issues on the next cycle. Two carry the exact filed
 * title; the third carries another title and only the family tag, so both
 * dedup paths are exercised.
 */
async function mirrorIssues(
  directory: string,
  issues: CoachReport["issues"],
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const [first, second, third] = issues;
  const rows = [
    first === undefined
      ? undefined
      : { op: "create", title: first.title, body: "## Family", url: first.url },
    second === undefined
      ? undefined
      : { op: "create", title: second.title, body: "## Family", url: second.url },
    third === undefined
      ? undefined
      : {
          op: "create",
          title: "[coach] an earlier title",
          body: `## Family\n\nfamily:${familyTag(third.family)}`,
          url: third.url,
        },
  ].filter((row) => row !== undefined);
  await appendFile(join(directory, "calls.jsonl"), rows.map((row) => line(row)).join(""));
}

function promptFamily(key: string): CoachFamily {
  return {
    key,
    kind: "command",
    calls: 2,
    sessions: ["session-a", "session-b"],
    days: 1,
    firstAt: instant(120),
    lastAt: instant(60),
    score: 4,
    fragments: [{ text: `${key} --flag`, count: 2 }],
    excerpts: [
      {
        command: `${key} --flag`,
        status: "error",
        output: "ERROR: cannot find module shared",
        sessionTitle: "session session-a",
      },
    ],
  };
}

function promptFor(key: string, settings: CoachSettings, filingRoom: number): string {
  return synthesisPrompt({
    family: promptFamily(key),
    settings,
    openIssues: [],
    filingRoom,
  });
}

async function readLedger(stateDir: string): Promise<LedgerDocument> {
  return JSON.parse(
    await readFile(join(coachDirectory(stateDir), "state.json"), "utf8"),
  ) as LedgerDocument;
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

await writeStub(synthesisStub, {
  [FAMILIES[0]]: promptAnswer(FAMILIES[0], PRIMARY.get(FAMILIES[0])!.number),
  [FAMILIES[1]]: toolAnswer(FAMILIES[1], PRIMARY.get(FAMILIES[1])!.number),
  [FAMILIES[2]]: toolAnswer(FAMILIES[2], PRIMARY.get(FAMILIES[2])!.number),
});

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
const PRIMARY_SETTINGS: CoachSettings = {
  intervalMinutes: 60,
  maxPerHour: null,
  maxPending: 20,
  maxIssuesPerCycle: 20,
  allowlist: ["./scripts/"],
};
await settingsFile(coachDirectory(stateDir), PRIMARY_SETTINGS);

const environment = {
  ...process.env,
  DEVBOARD_COACH_FORGE_STUB: stub,
  DEVBOARD_COACH_SYNTHESIS_STUB: synthesisStub,
  AGENT_COMMAND: stubAgent,
};

function coach(args: string[], extraEnv: NodeJS.ProcessEnv = {}): CoachReport {
  const result = run(
    process.execPath,
    ["run", "coach", "--", ...args, "--root", repoDir, "--state-dir", stateDir, "--json"],
    { cwd: harnessRoot, env: { ...environment, ...extraEnv } },
  );
  if (result.code !== 0) {
    throw new Error(`coach ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as CoachReport;
}

function coachIn(
  rootStateDir: string,
  forgeStub: string,
  synthesis: string,
  args: string[],
): CoachReport {
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
      rootStateDir,
      "--json",
    ],
    {
      cwd: harnessRoot,
      env: {
        ...environment,
        DEVBOARD_COACH_FORGE_STUB: forgeStub,
        DEVBOARD_COACH_SYNTHESIS_STUB: synthesis,
      },
    },
  );
  if (result.code !== 0) {
    throw new Error(`coach ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as CoachReport;
}

try {
  const build = run(process.execPath, ["run", "build"], { cwd: harnessRoot });
  assertTrue(build.code === 0, `verify:coach: bun run build failed: ${build.stderr}`);

  const sessionsBefore = await directoryHash(join(stateDir, "providers"));
  const journalBefore = await directoryHash(join(stateDir, "journal"));

  /* 0. The synthesis prompt carries the settings, allowlist, catalog, and room. */
  const promptSettings = readCoachSettings(coachDirectory(stateDir));
  assertTrue(
    JSON.stringify(promptSettings.allowlist) === JSON.stringify(["./scripts/"]),
    `verify:coach: settings allowlist is ${JSON.stringify(promptSettings.allowlist)}`,
  );
  const roomy = promptFor(FAMILIES[0], promptSettings, 1);
  assertTrue(
    roomy.includes(JSON.stringify("./scripts/")),
    "verify:coach: the synthesis prompt omits the allowlist entry",
  );
  assertTrue(
    roomy.includes(`family:${familyTag(FAMILIES[0])}`),
    "verify:coach: the synthesis prompt omits the family tag",
  );
  for (const tool of ["issue_create", "coach_proposal_skip", "issues_list", "issue_get"]) {
    assertTrue(
      roomy.includes(tool),
      `verify:coach: the synthesis prompt omits ${tool}`,
    );
  }
  assertTrue(
    roomy.includes('"filingRoom": 1'),
    "verify:coach: the synthesis prompt omits the filing room",
  );
  assertTrue(
    promptFor(FAMILIES[0], promptSettings, 0).includes('"filingRoom": 0'),
    "verify:coach: the exhausted filing room is not rendered",
  );
  assertTrue(
    promptFor(FAMILIES[0], promptSettings, 0) ===
      promptFor(FAMILIES[0], promptSettings, 0),
    "verify:coach: the synthesis prompt is not deterministic",
  );
  console.log("PASS coach-prompt");

  /* 1. One cycle: three families, three synthesis calls, three tool records. */
  const first = coach(["--once", "--now", START.toISOString()]);
  assertTrue(first.families === 3, `verify:coach: families is ${first.families}`);
  assertTrue(first.selected.length === 3, `verify:coach: selected is ${first.selected.length}`);
  assertTrue(first.synthesis.length === 3, `verify:coach: synthesis calls ${first.synthesis.length}`);
  assertTrue(
    first.synthesis.every((call) => call.ok),
    `verify:coach: a synthesis call failed: ${JSON.stringify(first.synthesis)}`,
  );
  assertTrue(
    JSON.stringify(first.synthesis.map((call) => call.family).sort()) ===
      JSON.stringify(FAMILIES.slice().sort()),
    `verify:coach: synthesis families are ${JSON.stringify(first.synthesis.map((call) => call.family))}`,
  );
  assertTrue(first.action === "filed", `verify:coach: first cycle action ${first.action}`);
  assertTrue(first.issues.length === 3, `verify:coach: filed ${first.issues.length} issue(s)`);
  assertTrue(first.duplicates.length === 0, `verify:coach: first cycle recorded duplicates`);

  for (const issue of first.issues) {
    const expected = PRIMARY.get(issue.family);
    assertTrue(expected !== undefined, `verify:coach: unknown family ${issue.family}`);
    assertTrue(
      issue.title === expected!.title,
      `verify:coach: ${issue.family} title is ${issue.title}`,
    );
    assertTrue(
      issue.url === expected!.url,
      `verify:coach: ${issue.family} url is ${issue.url}`,
    );
    assertTrue(issue.kind === "command", `verify:coach: ${issue.family} kind is ${issue.kind}`);

    /* A tool or prompt answer is one `issue_create` tool record. */
    const directory = familyDirectory(first, issue.family);
    const toolLog = records(join(directory, "tool-log.jsonl"));
    assertTrue(
      toolLog.length === 1,
      `verify:coach: ${issue.family} has ${toolLog.length} tool record(s)`,
    );
    assertTrue(
      toolLog[0]?.tool === "issue_create" && toolLog[0]?.ok === true,
      `verify:coach: ${issue.family} tool record is ${JSON.stringify(toolLog[0])}`,
    );
    assertTrue(
      toolLog[0]?.value?.title === expected!.title &&
        toolLog[0]?.value?.number === expected!.number &&
        toolLog[0]?.value?.url === expected!.url,
      `verify:coach: ${issue.family} tool record value is ${JSON.stringify(toolLog[0]?.value)}`,
    );
    assertTrue(
      !existsSync(join(directory, "skips.jsonl")),
      `verify:coach: ${issue.family} wrote a skips log beside its filing`,
    );
  }

  /* The ledger and the dashboard projection read the same cycle. */
  const firstLedger = await readLedger(stateDir);
  assertTrue(firstLedger.version === 3, `verify:coach: ledger version ${firstLedger.version}`);
  for (const issue of first.issues) {
    const entry = firstLedger.families?.[issue.family];
    assertTrue(entry !== undefined, `verify:coach: the ledger lacks ${issue.family}`);
    assertTrue(
      entry.lastAction === "filed",
      `verify:coach: ${issue.family} ledger action is ${entry.lastAction}`,
    );
    assertTrue(
      entry.lastIssueUrl === issue.url && entry.lastTitle === issue.title,
      `verify:coach: ${issue.family} ledger issue is ${JSON.stringify(entry)}`,
    );
    assertTrue(
      entry.lastFiledAt === START.toISOString(),
      `verify:coach: ${issue.family} lastFiledAt is ${entry.lastFiledAt}`,
    );
  }
  const latest = JSON.parse(
    await readFile(join(coachDirectory(stateDir), "latest.json"), "utf8"),
  ) as CoachReport;
  assertTrue(latest.action === first.action, `verify:coach: latest action ${latest.action}`);
  assertTrue(
    JSON.stringify(latest.issues.map((issue) => issue.title)) ===
      JSON.stringify(first.issues.map((issue) => issue.title)),
    "verify:coach: latest.json titles differ from the report",
  );
  console.log("PASS coach-families");

  /* 2. The same evidence files nothing when the dedup read shows the issues. */
  await mirrorIssues(stub, first.issues);
  assertTrue(
    records(join(stub, "calls.jsonl")).length === 3,
    "verify:coach: the forge stub does not hold the three issues",
  );
  const second = coach(["--once", "--now", START.toISOString()]);
  assertTrue(second.action === "none", `verify:coach: second cycle action ${second.action}`);
  assertTrue(second.issues.length === 0, `verify:coach: the second cycle filed an issue`);
  assertTrue(second.duplicates.length === 3, `verify:coach: duplicates ${second.duplicates.length}`);
  for (const issue of first.issues) {
    const duplicate = second.duplicates.find((entry) => entry.family === issue.family);
    assertTrue(
      duplicate !== undefined,
      `verify:coach: the second cycle did not duplicate ${issue.family}`,
    );
    assertTrue(
      duplicate!.url === issue.url,
      `verify:coach: ${issue.family} duplicate url is ${duplicate!.url}`,
    );
  }
  assertTrue(
    JSON.stringify(second.findings) === JSON.stringify(first.findings),
    "verify:coach: the second cycle's families differ",
  );
  assertTrue(
    records(join(stub, "calls.jsonl")).length === 3,
    "verify:coach: the second cycle wrote to the forge stub",
  );
  const secondLedger = await readLedger(stateDir);
  for (const key of FAMILIES) {
    assertTrue(
      secondLedger.families?.[key]?.lastAction === "duplicate",
      `verify:coach: ${key} ledger action is ${secondLedger.families?.[key]?.lastAction}`,
    );
  }
  console.log("PASS coach-no-second-filing");

  /* 3. The per-cycle cap leaves room for the highest-scoring family only. */
  const capState = join(root, "state-cap");
  const capStub = join(root, "stub-cap");
  const capSynthesis = join(root, "synthesis-cap.json");
  const capReason = "the per-cycle cap has no filing room";
  await mkdir(capStub, { recursive: true });
  await cloneEvidence(stateDir, capState);
  await settingsFile(coachDirectory(capState), {
    intervalMinutes: 60,
    maxPerHour: null,
    maxPending: 20,
    maxIssuesPerCycle: 1,
    allowlist: ["./scripts/"],
  });
  await writeStub(capSynthesis, {
    [FAMILIES[0]]: skipAnswer(capReason),
    [FAMILIES[1]]: toolAnswer(FAMILIES[1], 7),
    [FAMILIES[2]]: skipAnswer(capReason),
  });
  const capReport = coachIn(capState, capStub, capSynthesis, [
    "--once",
    "--now",
    START.toISOString(),
  ]);
  assertTrue(capReport.action === "filed", `verify:coach: cap action ${capReport.action}`);
  assertTrue(capReport.synthesis.length === 3, `verify:coach: cap synthesis ${capReport.synthesis.length}`);
  assertTrue(
    capReport.issues.length === 1,
    `verify:coach: the per-cycle cap filed ${capReport.issues.length} issue(s)`,
  );
  const capIssue = capReport.issues[0]!;
  assertTrue(
    capIssue.family === FAMILIES[1],
    `verify:coach: the cap filed ${capIssue.family} instead of the highest score`,
  );
  assertTrue(capIssue.url.endsWith("/7"), `verify:coach: cap issue url is ${capIssue.url}`);
  assertTrue(capReport.duplicates.length === 0, "verify:coach: the cap cycle saw duplicates");

  const capToolLog = records(join(familyDirectory(capReport, FAMILIES[1]), "tool-log.jsonl"));
  assertTrue(capToolLog.length === 1, `verify:coach: cap tool records ${capToolLog.length}`);
  assertTrue(
    capToolLog[0]?.value?.url === capIssue.url,
    `verify:coach: cap tool record url is ${String(capToolLog[0]?.value?.url)}`,
  );
  for (const key of [FAMILIES[0], FAMILIES[2]]) {
    const directory = familyDirectory(capReport, key);
    assertTrue(
      !existsSync(join(directory, "tool-log.jsonl")),
      `verify:coach: the capped family ${key} wrote a tool log`,
    );
    const skips = records(join(directory, "skips.jsonl"));
    assertTrue(skips.length === 1, `verify:coach: ${key} skip records ${skips.length}`);
    assertTrue(
      skips[0]?.tool === "coach_proposal_skip" && skips[0]?.ok === true,
      `verify:coach: ${key} skip record is ${JSON.stringify(skips[0])}`,
    );
    assertTrue(
      skips[0]?.value?.family === key && skips[0]?.value?.reason === capReason,
      `verify:coach: ${key} skip value is ${JSON.stringify(skips[0]?.value)}`,
    );
  }
  const capLedger = await readLedger(capState);
  assertTrue(
    capLedger.families?.[FAMILIES[1]]?.lastAction === "filed",
    "verify:coach: the cap ledger did not record the filing",
  );
  for (const key of [FAMILIES[0], FAMILIES[2]]) {
    assertTrue(
      capLedger.families?.[key]?.lastAction === "none",
      `verify:coach: the cap ledger action for ${key} is ${capLedger.families?.[key]?.lastAction}`,
    );
  }
  const capSettings = readCoachSettings(coachDirectory(capState));
  const cappedPrompt = promptFor(FAMILIES[0], capSettings, 0);
  assertTrue(
    cappedPrompt.includes('"maxIssuesPerCycle": 1') &&
      cappedPrompt.includes('"filingRoom": 0'),
    "verify:coach: the capped prompt omits the cap or the empty room",
  );
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
