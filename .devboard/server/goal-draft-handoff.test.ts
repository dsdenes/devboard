import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { projectLabel } from "./app";
import { saveSubscriptions } from "./providers";

/**
 * The detached elaboration owner against a real dashboard process: the reload
 * control's replacement adopts the same agent, prompt, activity, and question;
 * an abrupt or non-reload exit ends that agent and leaves one interrupted
 * failure with the draft startable.
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
const temporaryDirectories: string[] = [];
const startedRepos: string[] = [];

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
    const socket = new WebSocket(`ws://${fixture.url}/ws`);
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

function peerPids(log: string): number[] {
  return logLines(log)
    .filter((line) => line.startsWith("spawn "))
    .map((line) => Number(line.slice("spawn ".length)));
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
  read: () => T | undefined,
  description: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
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
      const socket = new WebSocket(`ws://${url}/ws`);
      const opened = Promise.withResolvers<void>();
      socket.onopen = () => opened.resolve();
      socket.onerror = () => opened.reject(new Error("websocket error"));
      await opened.promise;
      const events: Record<string, unknown>[] = [];
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
        events.push(message);
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

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
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

function draftState(message: Record<string, unknown>): Record<string, unknown> | undefined {
  return message.type === "issuesDraftState" ? recordOf(message.draft) : undefined;
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
    "adopts the same peer, prompt, activity, and question, then answers and stops it",
    async () => {
      const fixture = await createFixture();
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
      let firstPid = 0;
      let activity: string[] = [];
      let question: Record<string, unknown> | null = null;
      try {
        client.send({ type: "getGoalDrafts" });
        await client.waitFor(
          (message) => draftState(message)?.status === "idle",
          "the idle draft state",
        );
        client.send({
          type: "startGoalDraft",
          path: ".devboard/goal-proposals/question.md",
        });
        const running = await client.waitFor(
          (message) => (draftState(message)?.status === "running" ? true : false),
          "the running elaboration",
        );
        expect(draftState(running)?.path).toBe(".devboard/goal-proposals/question.md");
        firstPid = await waitFor(() => startPids(fixture.log)[0], "the stub peer's start line");
        const questioned = await client.waitFor(
          (message) => (draftState(message)?.question ? true : false),
          "the pending question",
        );
        const asked = draftState(questioned);
        activity = stringList(asked?.activity);
        question = recordOf(asked?.question) ?? null;
        expect(activity.length).toBeGreaterThan(0);
        expect(question?.message).toBe("Choose an answer");

        client.send({ type: "restartServer" });
        await client.waitClosed();
        client.close();
        const replacement = await waitForReplacement(fixture, dashboard.pid);
        expect(replacement.port).toBe(fixture.port);

        client = await connect(fixture.url);
        client.send({ type: "getGoalDrafts" });
        const adopted = await client.waitFor(
          (message) => (draftState(message)?.status === "running" ? true : false),
          "the adopted running elaboration",
        );
        const run = draftState(adopted)!;
        expect(run.path).toBe(".devboard/goal-proposals/question.md");
        expect(run.startedAt).toBe(asked?.startedAt);
        expect(stringList(run.activity).slice(0, activity.length)).toEqual(activity);
        expect(recordOf(run.question)).toEqual(question ?? undefined);
        expect(alive(firstPid)).toBe(true);
        expect(startPids(fixture.log)).toEqual([firstPid]);
        expect(logLines(fixture.log).filter((line) => line.startsWith("goal-draft "))).toEqual([
          "goal-draft .devboard/goal-proposals/question.md",
        ]);
        expect(ownerPids(fixture.repo).length).toBe(1);

        if (question === null || !("id" in question)) throw new Error("the question has no id");
        client.send({
          type: "answerGoalDraft",
          id: question.id,
          value: "Alpha",
        });
        await waitFor(
          () => (logLines(fixture.log).includes("answer Alpha") ? true : undefined),
          "the answer reaching the original peer",
        );
        await waitFor(
          () => (logLines(fixture.log).filter((line) => line === "answer Alpha").length === 1 ? true : undefined),
          "exactly one answer line",
        );
        const succeeded = await client.waitFor(
          (message) => (draftState(message)?.status === "succeeded" ? true : false),
          "the completed elaboration",
        );
        expect(draftState(succeeded)?.question).toBeNull();
        expect(existsSync(join(fixture.drafts, "question.md"))).toBe(false);
        expect(existsSync(join(fixture.repo, ".devboard", "goals", "question.md"))).toBe(true);
        expect(startPids(fixture.log)).toEqual([firstPid]);
        await waitFor(() => (alive(firstPid) ? undefined : true), "the completed peer to exit");
        await waitFor(
          () => (ownerPids(fixture.repo).length === 0 ? true : undefined),
          "the completed owner to exit",
        );

        // The second draft reloads at a pending state, then Stop ends its peer.
        client.send({ type: "startGoalDraft", path: ".devboard/goal-proposals/hang.md" });
        await client.waitFor(
          (message) =>
            draftState(message)?.status === "running" &&
            stringList(draftState(message)?.activity).length > 0,
          "the hanging elaboration activity",
        );
        const hangPid = await waitFor(
          () => startPids(fixture.log)[1],
          "the hanging peer's start line",
        );
        const beforeReload = dashboards(fixture.repo)[0]!;
        client.send({ type: "restartServer" });
        await client.waitClosed();
        client.close();
        const secondReplacement = await waitForReplacement(fixture, beforeReload.pid);
        expect(secondReplacement.port).toBe(fixture.port);
        client = await connect(fixture.url);
        client.send({ type: "getGoalDrafts" });
        const hanging = await client.waitFor(
          (message) =>
            draftState(message)?.status === "running" &&
            draftState(message)?.path === ".devboard/goal-proposals/hang.md",
          "the adopted hanging elaboration",
        );
        expect(stringList(draftState(hanging)?.activity).length).toBeGreaterThan(0);
        expect(alive(hangPid)).toBe(true);
        client.send({ type: "stopGoalDraft" });
        const stopped = await client.waitFor(
          (message) => (draftState(message)?.status === "stopped" ? true : false),
          "the stopped elaboration",
        );
        expect(draftState(stopped)?.path).toBe(".devboard/goal-proposals/hang.md");
        expect(existsSync(join(fixture.drafts, "hang.md"))).toBe(true);
        await waitFor(() => (alive(hangPid) ? undefined : true), "the stopped peer to exit");
        await waitFor(
          () => (ownerPids(fixture.repo).length === 0 ? true : undefined),
          "the stopped owner to exit",
        );
        expect(startPids(fixture.log)).toHaveLength(2);
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
        client.send({ type: "getGoalDrafts" });
        const drafts = await client.waitFor(
          (message) => (message.type === "issuesDrafts" ? true : false),
          "the draft list",
        );
        expect(draftPaths(drafts)).toEqual([".devboard/goal-proposals/idle.md"]);
        const state = await client.waitFor(
          (message) => (draftState(message)?.status === "idle" ? true : false),
          "the idle state",
        );
        expect(draftState(state)?.activity).toEqual([]);
        client.send({ type: "restartServer" });
        await client.waitClosed();
        client.close();
        const replacement = await waitForReplacement(fixture, dashboard.pid);
        expect(replacement.port).toBe(fixture.port);
        expect(ownerPids(fixture.repo)).toEqual([]);

        client = await connect(fixture.url);
        client.send({ type: "getGoalDrafts" });
        const replayed = await client.waitFor(
          (message) => (draftState(message)?.status === "idle" ? true : false),
          "the idle state after the reload",
        );
        expect(draftState(replayed)?.path).toBeNull();
        expect(draftState(replayed)?.activity).toEqual([]);
        expect(ownerPids(fixture.repo)).toEqual([]);
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
});

describe("interrupted elaborations", () => {
  test(
    "SIGKILL ends the peer and the replacement reports one interrupted failure",
    async () => {
      const fixture = await createFixture();
      await writeFile(
        join(fixture.drafts, "killed.md"),
        "# Killed draft\n\n> Unprocessed draft. STUB-QUESTION\n",
      );
      const dashboard = await startServer(fixture);
      let client = await connect(fixture.url);
      let peerPid = 0;
      try {
        client.send({ type: "startGoalDraft", path: ".devboard/goal-proposals/killed.md" });
        await client.waitFor(
          (message) => (draftState(message)?.question ? true : false),
          "the pending question before the kill",
        );
        peerPid = await waitFor(() => startPids(fixture.log)[0], "the peer before the kill");
        expect(ownerPids(fixture.repo)).toHaveLength(1);
      } finally {
        client.close();
      }

      dashboard.kill("SIGKILL");
      await dashboard.exited;
      await waitFor(() => (alive(peerPid) ? undefined : true), "the peer after SIGKILL", 10_000);
      await waitFor(
        () => (ownerPids(fixture.repo).length === 0 ? true : undefined),
        "the owner after SIGKILL",
        10_000,
      );

      const startsBefore = startPids(fixture.log).length;
      const replacement = await startServer(fixture);
      client = await connect(fixture.url);
      try {
        client.send({ type: "getGoalDrafts" });
        const failed = await client.waitFor(
          (message) => (draftState(message)?.status === "failed" ? true : false),
          "the interrupted failure",
        );
        const run = draftState(failed)!;
        expect(run.path).toBe(".devboard/goal-proposals/killed.md");
        expect(String(run.error)).toContain("server exit interrupted the elaboration");
        const list = await client.waitFor(
          (message) => (message.type === "issuesDrafts" ? true : false),
          "the draft list after the interruption",
        );
        expect(draftPaths(list)).toEqual([".devboard/goal-proposals/killed.md"]);
        expect(startPids(fixture.log)).toHaveLength(startsBefore);

        client.send({ type: "startGoalDraft", path: ".devboard/goal-proposals/killed.md" });
        await client.waitFor(
          (message) => (draftState(message)?.status === "running" ? true : false),
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
    "SIGTERM without a replacement ends the peer and the next dashboard reports the failure",
    async () => {
      const fixture = await createFixture();
      await writeFile(
        join(fixture.drafts, "terminated.md"),
        "# Terminated draft\n\n> Unprocessed draft. STUB-HANG\n",
      );
      const dashboard = await startServer(fixture);
      let client = await connect(fixture.url);
      let peerPid = 0;
      try {
        client.send({ type: "startGoalDraft", path: ".devboard/goal-proposals/terminated.md" });
        await client.waitFor(
          (message) =>
            draftState(message)?.status === "running" &&
            ((draftState(message)?.activity as string[] | undefined)?.length ?? 0) > 0,
          "the running elaboration before SIGTERM",
        );
        peerPid = await waitFor(() => startPids(fixture.log)[0], "the peer before SIGTERM");
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
        client.send({ type: "getGoalDrafts" });
        const failed = await client.waitFor(
          (message) => (draftState(message)?.status === "failed" ? true : false),
          "the interrupted failure after SIGTERM",
        );
        expect(draftState(failed)?.path).toBe(".devboard/goal-proposals/terminated.md");
        expect(String(draftState(failed)?.error)).toContain(
          "server exit interrupted the elaboration",
        );
        expect(startPids(fixture.log)).toHaveLength(startsBefore);
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
    expect(peerPids(fixture.log)).toEqual([]);
  });
});
