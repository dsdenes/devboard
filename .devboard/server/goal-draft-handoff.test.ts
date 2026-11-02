import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { projectLabel } from "./app";
import { saveSubscriptions } from "./providers";
import { readGoalDraftLease, readGoalDraftOwnerState } from "./goal-draft-owner";

/**
 * The detached elaboration owners against a real dashboard process: the reload
 * control's replacement adopts every running agent, prompt, activity, and
 * question; an abrupt or non-reload exit ends those agents and leaves one
 * interrupted failure per draft, each still startable.
 *
 * Every file lives under `.devboard/.tmp`. The stub agent stands in for
 * `omp acp`, and the release directory is an offline fixture, so no test
 * reaches GitHub or spawns a real agent.
 */

const harnessRoot = resolve(import.meta.dir, "..");
const testRoot = join(harnessRoot, ".tmp");
const SERVER = join(import.meta.dir, "index.ts");
const STUB_AGENT = join(import.meta.dir, "fixtures", "stub-agent.ts");
const UPDATE_VERSION = "0.0.0";
/** The credential the spawned dashboard requires, and the test presents. */
const DASHBOARD_TOKEN = "handoff-test-token";
const temporaryDirectories: string[] = [];
const startedRepos: string[] = [];

/** Opens one socket with the credential the spawned dashboard requires. */
function dashboardSocket(url: string): WebSocket {
  return new WebSocket(url, {
    headers: { authorization: `Bearer ${DASHBOARD_TOKEN}` },
  } as unknown as string[]);
}

afterAll(async () => {
  for (const repo of startedRepos) {
    for (const dashboard of dashboards(repo)) {
      try {
        process.kill(dashboard.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    for (const pid of ownerPids(repo)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface Fixture {
  root: string;
  repo: string;
  drafts: string;
  stateDir: string;
  log: string;
  port: number;
  url: string;
}

async function createFixture(): Promise<Fixture> {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "goal-draft-handoff-"));
  temporaryDirectories.push(root);
  const repo = join(root, "repo");
  const drafts = join(repo, ".devboard", "goal-proposals");
  const stateDir = join(root, "state");
  await mkdir(join(repo, "adrs"), { recursive: true });
  await mkdir(drafts, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const staticDir = join(root, "dist");
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Fixture</title>");
  await writeFile(join(repo, "GOAL.md"), "# Goal\n\nFixture.\n");
  await writeFile(join(repo, ".gitignore"), "state/\n.tmp/\n");
  // Every ACP peer resolves a provider first; this fixture's usage endpoints
  // are closed ports, so the seeded key stays eligible with unknown headroom.
  const stamp = new Date().toISOString();
  saveSubscriptions(stateDir, [
    {
      id: "fixture-go",
      provider: "opencode-go",
      label: "Fixture Go",
      key: "fixture-key",
      enabled: true,
      createdAt: stamp,
      updatedAt: stamp,
    },
  ]);
  const releaseDir = join(root, "releases");
  await mkdir(releaseDir, { recursive: true });
  const tarball = Buffer.from("fixture release\n");
  const tarballName = `devboard-${UPDATE_VERSION}.tgz`;
  await writeFile(join(releaseDir, tarballName), tarball);
  await writeFile(
    join(releaseDir, `${tarballName}.sha256`),
    `${createHash("sha256").update(tarball).digest("hex")}  ${tarballName}\n`,
  );
  startedRepos.push(repo);
  const port = freePort();
  return {
    root,
    repo,
    drafts,
    stateDir,
    log: join(root, "agent.log"),
    port,
    url: `127.0.0.1:${port}`,
  };
}

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  return port ?? 0;
}

async function startServer(
  fixture: Fixture,
): Promise<Bun.Subprocess<"ignore", "ignore", "ignore">> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    // Another test may claim the probed port between the probe and the bind;
    // prove the endpoint answers for this repository before trusting it.
    fixture.port = freePort();
    fixture.url = `127.0.0.1:${fixture.port}`;
    const child = spawnDashboard(fixture);
    const started = await waitForEndpoint(fixture);
    if (started) return child;
    child.kill("SIGKILL");
    await child.exited;
  }
  throw new Error("the dashboard did not start on a port of its own");
}

function spawnDashboard(
  fixture: Fixture,
): Bun.Subprocess<"ignore", "ignore", "ignore"> {
  return Bun.spawn({
    cmd: [process.execPath, SERVER],
    cwd: harnessRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(fixture.port),
      ADRS_DIR: join(fixture.repo, "adrs"),
      REPO_DIR: fixture.repo,
      GOAL_FILE: join(fixture.repo, "GOAL.md"),
      STATIC_DIR: join(fixture.root, "dist"),
      STATE_DIR: fixture.stateDir,
      DEVBOARD_DASHBOARD_TOKEN: DASHBOARD_TOKEN,
      AGENT_COMMAND: `bun ${STUB_AGENT} --log=${fixture.log} --goal-draft`,
      DEVBOARD_RELEASE_DIR: join(fixture.root, "releases"),
      DEVBOARD_UPDATE_INTERVAL_MS: "3600000",
      DEVBOARD_OPENCODE_GO_USAGE_BASE_URL: "http://127.0.0.1:1/zen/go",
      DEVBOARD_OPENROUTER_USAGE_BASE_URL: "http://127.0.0.1:1/api",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "true",
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

/** True only when the dashboard on the probed port serves this repository. */
async function waitForEndpoint(fixture: Fixture, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const socket = dashboardSocket(`ws://${fixture.url}/ws`);
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      resolve(false);
    }, 1_500);
    socket.onopen = () => socket.send(JSON.stringify({ type: "getProject" }));
    socket.onmessage = (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null || !("type" in message)) return;
      if (message.type !== "project") return;
      clearTimeout(timer);
      socket.close();
      resolve("path" in message && message.path === projectLabel(fixture.repo));
    };
    socket.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    if (await promise) return true;
    if (Date.now() > deadline) return false;
    await Bun.sleep(50);
  }
}

interface Dashboard {
  pid: number;
  port: number;
}

function dashboards(repo: string): Dashboard[] {
  const found: Dashboard[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const pid = Number(entry);
    let cmdline = "";
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    } catch {
      continue;
    }
    if (!cmdline.includes("server/index.ts")) continue;
    let environ = "";
    try {
      environ = readFileSync(`/proc/${pid}/environ`, "utf8");
    } catch {
      continue;
    }
    const values = new Map(
      environ
        .split("\0")
        .filter((entry) => entry.includes("="))
        .map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]),
    );
    if (values.get("REPO_DIR") !== repo) continue;
    found.push({ pid, port: Number(values.get("PORT") ?? "0") });
  }
  return found;
}

function ownerPids(repo: string): number[] {
  const found: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const pid = Number(entry);
    let argv: string[];
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    } catch {
      continue;
    }
    if (!argv.some((argument) => argument.endsWith("goal-draft-owner.ts"))) continue;
    if (!argv.includes(repo)) continue;
    found.push(pid);
  }
  return found;
}

function logLines(log: string): string[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

function startPids(log: string): number[] {
  return logLines(log)
    .filter((line) => line.startsWith("goal-draft-start "))
    .map((line) => Number(line.slice("goal-draft-start ".length)));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  description: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await Bun.sleep(25);
  }
}

interface Client {
  send(command: unknown): void;
  waitFor(
    predicate: (message: Record<string, unknown>) => boolean,
    description: string,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  waitClosed(timeoutMs?: number): Promise<void>;
  close(): void;
}

async function connect(url: string): Promise<Client> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const socket = dashboardSocket(`ws://${url}/ws`);
      const opened = Promise.withResolvers<void>();
      socket.onopen = () => opened.resolve();
      socket.onerror = () => opened.reject(new Error("websocket error"));
      await opened.promise;
      const buffered: Record<string, unknown>[] = [];
      const waiters: Array<{
        predicate: (message: Record<string, unknown>) => boolean;
        resolve: (message: Record<string, unknown>) => void;
        timer: Timer;
      }> = [];
      const closed = Promise.withResolvers<void>();
      socket.onclose = () => closed.resolve();
      socket.onmessage = (event) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(String(event.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        const index = waiters.findIndex((waiter) => waiter.predicate(message));
        if (index >= 0) {
          const waiter = waiters.splice(index, 1)[0];
          if (waiter !== undefined) {
            clearTimeout(waiter.timer);
            waiter.resolve(message);
          }
        } else {
          buffered.push(message);
        }
      };
      return {
        send(command) {
          socket.send(JSON.stringify(command));
        },
        waitFor(predicate, description, timeoutMs = 15_000) {
          const index = buffered.findIndex(predicate);
          if (index >= 0) {
            return Promise.resolve(buffered.splice(index, 1)[0]!);
          }
          const { promise, resolve: ready } = Promise.withResolvers<Record<string, unknown>>();
          const entry = {
            predicate,
            resolve: ready,
            timer: setTimeout(() => {
              const at = waiters.indexOf(entry);
              if (at >= 0) waiters.splice(at, 1);
              ready(Promise.reject(new Error(`timed out waiting for ${description}`)) as never);
            }, timeoutMs),
          };
          entry.timer.unref?.();
          waiters.push(entry);
          return promise;
        },
        waitClosed(timeoutMs = 15_000) {
          const timer = setTimeout(
            () => closed.reject(new Error("the socket did not close")),
            timeoutMs,
          );
          timer.unref?.();
          void closed.promise.finally(() => clearTimeout(timer));
          return closed.promise;
        },
        close() {
          socket.close();
        },
      };
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await Bun.sleep(50);
    }
  }
}

/** One fresh `getGoalDrafts` replay; never a broadcast buffered earlier. */
async function readRuns(fixture: Fixture, timeoutMs = 15_000): Promise<Record<string, unknown>[]> {
  const { promise, resolve: settle, reject } = Promise.withResolvers<Record<string, unknown>[]>();
  const socket = dashboardSocket(`ws://${fixture.url}/ws`);
  const timer = setTimeout(() => {
    try {
      socket.close();
    } catch {
      // Already closed.
    }
    reject(new Error("timed out waiting for the draft runs"));
  }, timeoutMs);
  socket.onopen = () => socket.send(JSON.stringify({ type: "getGoalDrafts" }));
  socket.onerror = () => {
    clearTimeout(timer);
    reject(new Error("websocket error"));
  };
  socket.onmessage = (event) => {
    let message: unknown;
    try {
      message = JSON.parse(String(event.data)) as unknown;
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    if (!("type" in message) || message.type !== "issuesDrafts") return;
    clearTimeout(timer);
    socket.close();
    settle(runsOf(message as Record<string, unknown>));
  };
  return promise;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function runsOf(message: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(message.runs)) return [];
  return message.runs
    .map(recordOf)
    .filter((run): run is Record<string, unknown> => run !== undefined);
}

function runAt(
  runs: Record<string, unknown>[],
  path: string,
): Record<string, unknown> | undefined {
  return runs.find((run) => run.path === path);
}

function draftPaths(message: Record<string, unknown>): string[] {
  const drafts = message.drafts;
  if (!Array.isArray(drafts)) return [];
  const paths: string[] = [];
  for (const entry of drafts) {
    const record = recordOf(entry);
    if (record !== undefined && typeof record.path === "string") paths.push(record.path);
  }
  return paths;
}

async function waitForRun(
  fixture: Fixture,
  path: string,
  predicate: (run: Record<string, unknown>) => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  return waitFor(
    async () => {
      const run = runAt(await readRuns(fixture), path);
      return run !== undefined && predicate(run) ? run : undefined;
    },
    description,
    timeoutMs,
  );
}

async function waitForReplacement(
  fixture: Fixture,
  previous: number,
): Promise<Dashboard> {
  return waitFor(
    () => {
      const current = dashboards(fixture.repo).find((entry) => entry.pid !== previous);
      return current;
    },
    "the replacement dashboard",
    30_000,
  );
}

describe("graceful reload handoff", () => {
  test(
    "adopts every running peer, its prompt, activity, and question, then answers and stops them",
    async () => {
      const fixture = await createFixture();
      const questionPath = ".devboard/goal-proposals/question.md";
      const hangPath = ".devboard/goal-proposals/hang.md";
      await writeFile(
        join(fixture.drafts, "question.md"),
        "# Question draft\n\n> Unprocessed draft. STUB-QUESTION\n",
      );
      await writeFile(
        join(fixture.drafts, "hang.md"),
        "# Hang draft\n\n> Unprocessed draft. STUB-HANG\n",
      );
      const dashboard = await startServer(fixture);
      let client = await connect(fixture.url);
      try {
        client.send({ type: "startGoalDraft", path: questionPath });
        client.send({ type: "startGoalDraft", path: hangPath });
        const questionRun = await waitForRun(
          fixture,
          questionPath,
          (run) => run.status === "running" && run.question !== null && stringList(run.activity).length > 0,
          "the question draft's pending question",
        );
        const hangRun = await waitForRun(
          fixture,
          hangPath,
          (run) => run.status === "running" && stringList(run.activity).length > 0,
          "the hang draft's activity",
        );
        const questionState = await waitFor(
          () => readGoalDraftOwnerState(fixture.stateDir, fixture.repo, questionPath),
          "the question owner state",
        );
        const hangState = await waitFor(
          () => readGoalDraftOwnerState(fixture.stateDir, fixture.repo, hangPath),
          "the hang owner state",
        );
        const questionPeer = questionState.peer?.pid ?? 0;
        const hangPeer = hangState.peer?.pid ?? 0;
        expect(questionPeer).toBeGreaterThan(0);
        expect(hangPeer).toBeGreaterThan(0);
        expect(alive(questionPeer)).toBe(true);
        expect(alive(hangPeer)).toBe(true);
        const startedAt = questionRun.startedAt;
        const hangStartedAt = hangRun.startedAt;
        const question = recordOf(questionRun.question);
        expect(question).not.toBeUndefined();
        const activity = stringList(questionRun.activity);
        const hangActivity = stringList(hangRun.activity);

        client.send({ type: "restartServer" });
        await client.waitClosed();
        client.close();
        const replacement = await waitForReplacement(fixture, dashboard.pid);
        expect(replacement.port).toBe(fixture.port);

        client = await connect(fixture.url);
        const adoptedQuestion = await waitForRun(
          fixture,
          questionPath,
          (run) =>
            run.status === "running" &&
            run.startedAt === startedAt &&
            recordOf(run.question) !== undefined &&
            stringList(run.activity).join("\n").startsWith(activity.join("\n")),
          "the adopted question run",
          20_000,
        );
        const adoptedHang = await waitForRun(
          fixture,
          hangPath,
          (run) =>
            run.status === "running" &&
            run.startedAt === hangStartedAt &&
            stringList(run.activity).join("\n").startsWith(hangActivity.join("\n")),
          "the adopted hang run",
          20_000,
        );
        expect(recordOf(adoptedQuestion.question)).toEqual(question);
        expect(alive(questionPeer)).toBe(true);
        expect(alive(hangPeer)).toBe(true);
        expect(startPids(fixture.log)).toHaveLength(2);
        expect(
          logLines(fixture.log).filter((line) => line === `goal-draft ${questionPath}`),
        ).toHaveLength(1);
        expect(
          logLines(fixture.log).filter((line) => line === `goal-draft ${hangPath}`),
        ).toHaveLength(1);
        expect(ownerPids(fixture.repo)).toHaveLength(2);
        expect(adoptedHang.path).toBe(hangPath);

        client.send({
          type: "answerGoalDraft",
          path: questionPath,
          id: question?.id,
          value: "Alpha",
        });
        await waitFor(
          () => (logLines(fixture.log).includes("answer Alpha") ? true : undefined),
          "the answer reaching the original peer",
        );
        expect(logLines(fixture.log).filter((line) => line === "answer Alpha")).toHaveLength(1);
        await waitFor(
          () =>
            !existsSync(join(fixture.drafts, "question.md")) ? true : undefined,
          "the answered draft to leave the list",
          10_000,
        );
        expect(existsSync(join(fixture.repo, ".devboard", "goals", "question.md"))).toBe(true);
        const stillHanging = await waitForRun(
          fixture,
          hangPath,
          (run) => run.status === "running",
          "the other elaboration to stay running",
        );
        expect(stillHanging.startedAt).toBe(hangStartedAt);
        expect(alive(hangPeer)).toBe(true);

        client.send({ type: "stopGoalDraft", path: hangPath });
        const stopped = await waitForRun(
          fixture,
          hangPath,
          (run) => run.status === "stopped",
          "the stopped elaboration",
        );
        expect(stopped.path).toBe(hangPath);
        expect(existsSync(join(fixture.drafts, "hang.md"))).toBe(true);
        await waitFor(() => (alive(hangPeer) ? undefined : true), "the stopped peer to exit");
        await waitFor(
          () => (alive(questionPeer) ? undefined : true),
          "the completed question peer to exit",
        );
        await waitFor(
          () => (ownerPids(fixture.repo).length === 0 ? true : undefined),
          "every owner to exit",
        );
      } finally {
        client.close();
        for (const entry of dashboards(fixture.repo)) {
          try {
            process.kill(entry.pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
        for (const pid of ownerPids(fixture.repo)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
    },
    120_000,
  );

  test(
    "an idle reload adopts nothing and starts no peer",
    async () => {
      const fixture = await createFixture();
      await writeFile(
        join(fixture.drafts, "idle.md"),
        "# Idle draft\n\n> Unprocessed draft.\n",
      );
      const dashboard = await startServer(fixture);
      let client = await connect(fixture.url);
      try {
        const runs = await readRuns(fixture);
        expect(runs).toEqual([]);
        client.send({ type: "restartServer" });
        await client.waitClosed();
        client.close();
        const replacement = await waitForReplacement(fixture, dashboard.pid);
        expect(replacement.port).toBe(fixture.port);
        expect(ownerPids(fixture.repo)).toEqual([]);

        client = await connect(fixture.url);
        const adopted = await readRuns(fixture);
        expect(adopted).toEqual([]);
        expect(ownerPids(fixture.repo)).toEqual([]);
        expect(startPids(fixture.log)).toEqual([]);
      } finally {
        client.close();
        for (const entry of dashboards(fixture.repo)) {
          try {
            process.kill(entry.pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
    },
    120_000,
  );
  test(
    "two reloads in a row adopt one running elaboration without interrupting it",
    async () => {
      const fixture = await createFixture();
      const path = ".devboard/goal-proposals/twice.md";
      await writeFile(
        join(fixture.drafts, "twice.md"),
        "# Twice draft\n\n> Unprocessed draft. STUB-HANG\n",
      );
      const dashboard = await startServer(fixture);
      let client = await connect(fixture.url);
      try {
        client.send({ type: "startGoalDraft", path });
        const running = await waitForRun(
          fixture,
          path,
          (run) => run.status === "running" && stringList(run.activity).length > 0,
          "the running elaboration before the first reload",
        );
        const startedAt = running.startedAt;
        const state = await waitFor(
          () => readGoalDraftOwnerState(fixture.stateDir, fixture.repo, path),
          "the owner state before the first reload",
        );
        const peer = state.peer?.pid ?? 0;
        expect(peer).toBeGreaterThan(0);
        expect(alive(peer)).toBe(true);
        const firstLease = await waitFor(
          () => readGoalDraftLease(fixture.stateDir, fixture.repo) ?? undefined,
          "the first dashboard's lease",
        );

        // The documented restart path starts the replacement before the old
        // listener stops, so the replacement's first bind fails and the
        // manager of the attempt that finally binds must be the supervisor.
        let previous = dashboard.pid;
        for (const index of [1, 2]) {
          client.send({ type: "restartServer" });
          await client.waitClosed();
          client.close();
          const replacement = await waitForReplacement(fixture, previous);
          expect(replacement.port).toBe(fixture.port);
          previous = replacement.pid;
          client = await connect(fixture.url);
          const adopted = await waitForRun(
            fixture,
            path,
            (run) =>
              run.status === "running" &&
              run.startedAt === startedAt &&
              run.error === null &&
              stringList(run.activity).length > 0,
            `the elaboration adopted by reload ${index}`,
            20_000,
          );
          expect(adopted.startedAt).toBe(startedAt);
          expect(alive(peer)).toBe(true);
          const lease = await waitFor(
            () => readGoalDraftLease(fixture.stateDir, fixture.repo) ?? undefined,
            `the lease after reload ${index}`,
          );
          expect(lease.instance).toBeDefined();
          expect(lease.instance).not.toBe(firstLease.instance);
        }

        expect(startPids(fixture.log)).toHaveLength(1);
        expect(ownerPids(fixture.repo)).toHaveLength(1);
        client.send({ type: "stopGoalDraft", path });
        await waitForRun(fixture, path, (run) => run.status === "stopped", "the stopped elaboration");
      } finally {
        client.close();
        for (const entry of dashboards(fixture.repo)) {
          try {
            process.kill(entry.pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
        for (const pid of ownerPids(fixture.repo)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
    },
    120_000,
  );
});

describe("interrupted elaborations", () => {
  test(
    "SIGKILL ends every peer and the replacement reports one interrupted failure each",
    async () => {
      const fixture = await createFixture();
      const paths = [
        ".devboard/goal-proposals/killed-question.md",
        ".devboard/goal-proposals/killed-hang.md",
      ];
      await writeFile(
        join(fixture.drafts, "killed-question.md"),
        "# Killed question\n\n> Unprocessed draft. STUB-QUESTION\n",
      );
      await writeFile(
        join(fixture.drafts, "killed-hang.md"),
        "# Killed hang\n\n> Unprocessed draft. STUB-HANG\n",
      );
      const dashboard = await startServer(fixture);
      let client = await connect(fixture.url);
      const peers: number[] = [];
      try {
        for (const path of paths) client.send({ type: "startGoalDraft", path });
        await waitForRun(
          fixture,
          paths[0]!,
          (run) => run.question !== null,
          "the pending question before the kill",
        );
        for (const path of paths) {
          const state = await waitFor(
            () => readGoalDraftOwnerState(fixture.stateDir, fixture.repo, path),
            `the owner state for ${path}`,
          );
          if (state.peer !== null) peers.push(state.peer.pid);
        }
        expect(peers).toHaveLength(2);
        expect(ownerPids(fixture.repo)).toHaveLength(2);
      } finally {
        client.close();
      }

      dashboard.kill("SIGKILL");
      await dashboard.exited;
      for (const pid of peers) {
        await waitFor(() => (alive(pid) ? undefined : true), `peer ${pid} after SIGKILL`, 10_000);
      }
      await waitFor(
        () => (ownerPids(fixture.repo).length === 0 ? true : undefined),
        "every owner after SIGKILL",
        10_000,
      );

      const startsBefore = startPids(fixture.log).length;
      const replacement = await startServer(fixture);
      client = await connect(fixture.url);
      try {
        const runs = await waitFor(
          async () => {
            const listed = await readRuns(fixture);
            return paths.every((path) => runAt(listed, path)?.status === "failed") ? listed : undefined;
          },
          "both interrupted failures",
        );
        for (const path of paths) {
          expect(String(runAt(runs, path)?.error)).toContain(
            "server exit interrupted the elaboration",
          );
        }
        client.send({ type: "getGoalDrafts" });
        const list = await client.waitFor(
          (message) => message.type === "issuesDrafts",
          "the draft list after the interruption",
        );
        expect(draftPaths(list).sort()).toEqual([...paths].sort());
        expect(startPids(fixture.log)).toHaveLength(startsBefore);

        client.send({ type: "startGoalDraft", path: paths[0]! });
        await waitForRun(
          fixture,
          paths[0]!,
          (run) => run.status === "running",
          "the restarted elaboration",
        );
        await waitFor(
          () => (startPids(fixture.log).length === startsBefore + 1 ? true : undefined),
          "the operator's new peer",
        );
      } finally {
        client.close();
        for (const entry of dashboards(fixture.repo)) {
          try {
            process.kill(entry.pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
        for (const pid of ownerPids(fixture.repo)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
        replacement.kill("SIGKILL");
        await replacement.exited;
      }
    },
    120_000,
  );

  test(
    "SIGTERM without a replacement ends its peer and the next dashboard reports the failure",
    async () => {
      const fixture = await createFixture();
      const path = ".devboard/goal-proposals/terminated.md";
      await writeFile(
        join(fixture.drafts, "terminated.md"),
        "# Terminated draft\n\n> Unprocessed draft. STUB-HANG\n",
      );
      const dashboard = await startServer(fixture);
      let client = await connect(fixture.url);
      let peerPid = 0;
      try {
        client.send({ type: "startGoalDraft", path });
        await waitForRun(
          fixture,
          path,
          (run) => run.status === "running" && stringList(run.activity).length > 0,
          "the running elaboration before SIGTERM",
        );
        const state = await waitFor(
          () => readGoalDraftOwnerState(fixture.stateDir, fixture.repo, path),
          "the owner state before SIGTERM",
        );
        peerPid = state.peer?.pid ?? 0;
        expect(peerPid).toBeGreaterThan(0);
      } finally {
        client.close();
      }

      dashboard.kill("SIGTERM");
      await dashboard.exited;
      await waitFor(() => (alive(peerPid) ? undefined : true), "the peer after SIGTERM", 10_000);
      await waitFor(
        () => (ownerPids(fixture.repo).length === 0 ? true : undefined),
        "the owner after SIGTERM",
        10_000,
      );

      const startsBefore = startPids(fixture.log).length;
      const replacement = await startServer(fixture);
      client = await connect(fixture.url);
      try {
        const failed = await waitForRun(
          fixture,
          path,
          (run) => run.status === "failed",
          "the interrupted failure after SIGTERM",
        );
        expect(String(failed.error)).toContain("server exit interrupted the elaboration");
        expect(startPids(fixture.log)).toHaveLength(startsBefore);
        client.send({ type: "startGoalDraft", path });
        await waitForRun(
          fixture,
          path,
          (run) => run.status === "running",
          "the restarted elaboration after SIGTERM",
        );
      } finally {
        client.close();
        replacement.kill("SIGKILL");
        await replacement.exited;
        for (const pid of ownerPids(fixture.repo)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
    },
    120_000,
  );

  test("the owner state is keyed under the dashboard state directory", async () => {
    const fixture = await createFixture();
    expect(existsSync(join(fixture.stateDir, "goal-drafts"))).toBe(false);
    expect(startPids(fixture.log)).toEqual([]);
  });
});
