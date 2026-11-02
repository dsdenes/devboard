#!/usr/bin/env bun
/**
 * The deterministic Dead Code gate. It runs the real detached worker against a
 * fixture checkout, a stub ACP peer, and a stub `gh`, then proves that one
 * cycle ran from a seeded entry point, recorded it in the request and the
 * activity, and filed exactly one `dead-code` issue whose body carries the
 * detection category and the evidence path.
 *
 * Every fixture, state directory, and log lives under `.devboard/.tmp`. It
 * never contacts a real forge and never starts a real agent.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pickEntryPoint } from "../lib/entry-point";
import { readState, type DeadCodeState } from "../issues/dead-code/state";
import {
  cyclesDirectory,
  statePath,
  workerStateDirectories,
} from "../issues/dead-code/paths";
import { seedVerificationProvider, verificationProviderUsageEnv } from "./provider-fixture";

const harnessRoot = resolve(import.meta.dir, "..");
const root = join(harnessRoot, ".tmp", `verify-dead-code-${Date.now()}`);
const stubGh = join(harnessRoot, "tests", "fixtures", "dead-code-stub-gh.ts");
const stubAcp = join(harnessRoot, "tests", "fixtures", "dead-code-stub-acp.ts");

function check(condition: boolean, message: string, evidence?: unknown): asserts condition {
  if (!condition) {
    const detail = evidence === undefined ? "" : `\n${JSON.stringify(evidence, null, 2)}`;
    throw new Error(`verify:dead-code: ${message}${detail}`);
  }
}

function run(command: string, args: string[], cwd?: string): void {
  const child = Bun.spawnSync({
    cmd: [command, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (child.exitCode !== 0) {
    throw new Error(`verify:dead-code: ${command} ${args.join(" ")}: ${child.stderr.toString()}`);
  }
}

async function waitFor<T>(
  predicate: () => T | undefined,
  description: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new Error(`verify:dead-code: timed out waiting for ${description}`);
    }
    await Bun.sleep(100);
  }
}

function stateOf(repo: string, stateDir: string): DeadCodeState | undefined {
  const states: DeadCodeState[] = [];
  const legacy = readState(statePath(stateDir, repo));
  if (legacy !== undefined) states.push(legacy);
  for (const directory of workerStateDirectories(stateDir, repo)) {
    const state = readState(join(directory, "state.json"));
    if (state !== undefined) states.push(state);
  }
  return states.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

interface StubIssue {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  createdAt: string;
  body: string;
  labels: string[];
}

interface StubStore {
  nextNumber: number;
  issues: StubIssue[];
  openTitles: string[];
  releases: Array<{ tag: string; publishedAt: string }>;
}

const repo = join(root, "repo");
const stateDir = join(repo, ".devboard", ".tmp", "state");
const home = join(root, "home");
const bin = join(root, "bin");
const storePath = join(root, "gh-store.json");
const acpLog = join(root, "acp.log");
const ghLog = join(root, "gh.log");

try {
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, ".devboard", ".tmp"), { recursive: true });
  await mkdir(join(repo, ".omp", "commands"), { recursive: true });
  await mkdir(join(home, ".omp", "commands"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(repo, "GOAL.md"), "# Fixture goal\n");
  await writeFile(
    join(repo, "src", "fixture.ts"),
    ["export const fixtureConstant = 1;", "export const live = 2;", ""].join("\n"),
  );
  await writeFile(
    join(repo, ".omp", "commands", "dead-code-removal.md"),
    "# dead code removal\n",
  );
  await writeFile(
    join(home, ".omp", "commands", "dead-code-removal.md"),
    "# dead code removal\n",
  );
  await writeFile(
    storePath,
    `${JSON.stringify(
      { nextNumber: 1, issues: [], openTitles: [], releases: [] } satisfies StubStore,
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(bin, "gh"),
    `#!/bin/sh\nexec ${process.execPath} ${stubGh} "$@"\n`,
  );
  await writeFile(join(bin, "omp"), "#!/bin/sh\nexit 0\n");
  run("chmod", ["+x", join(bin, "gh")]);
  run("chmod", ["+x", join(bin, "omp")]);
  run("git", ["init", "-q"], repo);
  run("git", ["-C", repo, "config", "user.email", "devboard@example.test"]);
  run("git", ["-C", repo, "config", "user.name", "Devboard Verify"]);
  run("git", ["-C", repo, "add", "-A"]);
  run("git", ["-C", repo, "commit", "-q", "-m", "fixture"]);
  run("git", [
    "-C",
    repo,
    "remote",
    "add",
    "origin",
    "https://github.com/acme/fixture-dead-code.git",
  ]);
  seedVerificationProvider(stateDir);

  const worker = spawn(
    process.execPath,
    [
      join(harnessRoot, "issues", "dead-code", "worker.ts"),
      "--repo",
      repo,
      "--state-dir",
      stateDir,
    ],
    {
      cwd: harnessRoot,
      env: {
        ...process.env,
        ...verificationProviderUsageEnv(),
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        AGENT_COMMAND: `${process.execPath} ${stubAcp}`,
        DEAD_CODE_SYNC_MS: "1000",
        DEAD_CODE_STUB_STATE: storePath,
        DEAD_CODE_STUB_ACP_LOG: acpLog,
        DEAD_CODE_STUB_GH_LOG: ghLog,
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );

  try {
    const settled = await waitFor(
      () => {
        const state = stateOf(repo, stateDir);
        if (state === undefined || state.issues.length === 0) return undefined;
        if (state.lifecycle === "detecting") return undefined;
        return state;
      },
      "one filed dead-code issue",
      90_000,
    );
    check(settled.issues.length === 1, "the cycle filed another number of issues", settled.issues);
    const row = settled.issues[0]!;
    check(row.category === "unreferenced-symbol", "the row lost its category", row);
    check(row.state === "pending", "the filed issue is not pending", row);

    const store = JSON.parse(readFileSync(storePath, "utf8")) as StubStore;
    check(store.issues.length === 1, "the forge holds another number of issues", store.issues);
    const issue = store.issues[0]!;
    check(
      issue.number === row.number && issue.title === row.title,
      "the forge issue and the row differ",
      { issue, row },
    );
    check(
      JSON.stringify(issue.labels) === JSON.stringify(["dead-code"]),
      "the issue label is not exactly dead-code",
      issue.labels,
    );
    check(issue.title.length <= 200, "the title exceeds 200 characters", issue.title);
    for (const section of [
      "## Category",
      "unreferenced-symbol",
      "## Evidence",
      "## Reference search",
      "## Removal",
      "## Acceptance criteria",
    ]) {
      check(issue.body.includes(section), `the body omits ${section}`, issue.body);
    }

    const cycleIds = readdirSync(cyclesDirectory(repo)).sort();
    const cycleId = cycleIds.at(-1);
    check(cycleId !== undefined, "the cycle wrote no directory");
    const cycleDir = join(cyclesDirectory(repo), cycleId!);
    const request = JSON.parse(readFileSync(join(cycleDir, "request.json"), "utf8")) as {
      cycleId: string;
      surface: string;
      seed: string;
      entryPoint: { path: string; line: number };
      issueRoom: number;
      maxPerHour: number | null;
      maxPending: number | null;
      createdAt: string;
    };
    check(request.cycleId === cycleId, "the request names another cycle", request);
    check(request.surface === "dead-code", "the request surface is wrong", request.surface);
    check(typeof request.seed === "string" && request.seed.length > 0, "the request seed is empty");
    check(request.issueRoom >= 1, "the request carries no filing room", request.issueRoom);
    check(
      request.maxPerHour === 10 && request.maxPending === 5,
      "the request caps are not the defaults",
      request,
    );
    check(
      existsSync(join(repo, request.entryPoint.path)),
      "the entry point is not a repository file",
      request.entryPoint,
    );
    check(
      issue.body.includes(`${request.entryPoint.path}:${request.entryPoint.line}`),
      "the evidence path is not the recorded entry point",
      { entryPoint: request.entryPoint, body: issue.body },
    );
    const replay = pickEntryPoint({
      repoDir: repo,
      surface: "dead-code",
      seed: request.seed,
    });
    check(
      replay.path === request.entryPoint.path && replay.line === request.entryPoint.line,
      "the recorded seed does not replay its entry point",
      { recorded: request.entryPoint, replay },
    );
    const activity = readFileSync(join(cycleDir, "activity.json"), "utf8");
    check(
      activity.includes(request.entryPoint.path) && activity.includes(request.seed),
      "the activity does not name the entry point and seed",
    );
    check(activity.includes("filed #"), "the activity does not record the filing", activity);

    console.log(
      `verify:dead-code: filed #${issue.number} category unreferenced-symbol ` +
        `evidence ${request.entryPoint.path}:${request.entryPoint.line} ` +
        `entry point ${request.entryPoint.path}:${request.entryPoint.line} seed ${request.seed}`,
    );
    console.log(
      `verify:dead-code: issue ${issue.url} title ${JSON.stringify(issue.title)} label dead-code`,
    );
    console.log("verify:dead-code: OK");
  } finally {
    worker.kill("SIGTERM");
    await waitFor(
      () => (worker.exitCode !== null || worker.signalCode !== null ? true : undefined),
      "the worker to exit",
      10_000,
    ).catch(() => undefined);
  }
} finally {
  if (process.env.DEVBOARD_KEEP_FIXTURES === "1") {
    console.error(`verify:dead-code: kept ${root}`);
  } else {
    await rm(root, { recursive: true, force: true });
  }
}
