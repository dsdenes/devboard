import { afterAll, describe, expect, test } from "bun:test";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "./app";
import type { EpicLookup, OpenEpic } from "./tracker";

// Every temporary checkout, remote, and hook lives inside the repository so a
// failed run leaves nothing outside the project.
const TEST_ROOT = join(import.meta.dir, "..", "..", ".reset-test-tmp");
const STUB_AGENT = join(import.meta.dir, "fixtures", "stub-agent.ts");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  await mkdir(TEST_ROOT, { recursive: true });
  const directory = await mkdtemp(join(TEST_ROOT, "case-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  await rm(TEST_ROOT, { recursive: true, force: true });
});

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(
  directory: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): GitResult {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", directory, ...args],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = {
    code: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
  if (options.allowFailure !== true && output.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${output.stderr || output.stdout}`);
  }
  return output;
}

function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

interface HostOptions {
  gitignore?: boolean;
  goal?: string | null;
  goalName?: string;
  origin?: boolean;
  baseCommit?: boolean;
  skills?: boolean;
}

interface Host {
  root: string;
  host: string;
  remote: string;
}

async function createHost(options: HostOptions = {}): Promise<Host> {
  const root = await temporaryDirectory();
  const host = join(root, "host");
  const remote = join(root, "origin.git");
  await mkdir(host, { recursive: true });

  git(host, ["init", "-q", "-b", "main"]);
  git(host, ["config", "user.name", "Devboard Test"]);
  git(host, ["config", "user.email", "devboard@example.invalid"]);
  git(host, ["config", "commit.gpgsign", "false"]);
  git(host, ["init", "-q", "--bare", remote]);

  if (options.gitignore !== false) {
    await writeFile(join(host, ".gitignore"), ".worktree/\nignored/\n");
  }
  const goalName = options.goalName ?? "GOAL.md";
  if (options.goal !== null) {
    await writeFile(join(host, goalName), options.goal ?? "# Goal\n\nKeep this.\n");
  }
  await writeFile(join(host, "AGENTS.md"), "contract\n");
  for (const directory of [
    ".devboard",
    ".omp",
    "packages",
    ".worktree",
    "ignored",
    "adrs",
  ]) {
    await mkdir(join(host, directory), { recursive: true });
  }
  await writeFile(join(host, ".devboard", "sentinel.txt"), "harness\n");
  await writeFile(join(host, ".omp", "sentinel.txt"), "wrappers\n");
  if (options.skills === true) {
    await mkdir(join(host, ".omp", "skills", "prepared-skill"), { recursive: true });
    await writeFile(
      join(host, ".omp", "skills", "prepared-skill", "SKILL.md"),
      [
        "---",
        "name: prepared-skill",
        "description: A prepared skill for the reset lifecycle case.",
        "metadata:",
        '  devboard-managed: "true"',
        "---",
        "",
        "# Prepared skill",
        "",
        "- Keep the lifecycle startable.",
        "",
      ].join("\n"),
    );
  }
  await writeFile(join(host, "packages", "code.ts"), "implementation\n");
  await writeFile(join(host, "untracked.ts"), "untracked\n");
  await writeFile(join(host, "ignored", "cache.bin"), "ignored\n");
  await writeFile(join(host, ".worktree", "sentinel.txt"), "alive\n");
  await writeFile(join(host, ".worktree", "victim.txt"), "victim\n");
  await writeFile(join(host, "adrs", "0001-old.md"), "# Old\n\n- Status: Accepted\n");
  await symlink(join(host, ".worktree", "victim.txt"), join(host, "linked-victim"));

  if (options.origin !== false) {
    git(host, ["remote", "add", "origin", remote]);
  }
  if (options.baseCommit !== false) {
    git(host, ["add", "-A"]);
    git(host, ["commit", "-qm", "base"]);
  }
  return { root, host, remote };
}

async function pushBase(host: Host) {
  git(host.host, ["push", "-q", "origin", "main"]);
}

interface ServerHandle {
  server: { stop(closeActiveConnections?: boolean): unknown };
  url: string;
}

async function startServer(
  host: Host,
  options: {
    repoDir?: string;
    adrDir?: string;
    goalFile?: string;
    agentCommand?: string;
    tracker?: EpicLookup;
    trackerSettle?: { attempts: number; delayMs: number };
  } = {},
): Promise<ServerHandle> {
  const staticDir = join(host.root, "static");
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>reset</title>");

  const server = createApp({
    adrDir: options.adrDir ?? join(host.host, "adrs"),
    staticDir,
    hostname: "127.0.0.1",
    port: 0,
    repoDir: options.repoDir ?? host.host,
    goalFile: options.goalFile ?? join(host.host, "GOAL.md"),
    agentCommand: options.agentCommand,
    ...(options.tracker === undefined ? {} : { tracker: options.tracker }),
    ...(options.trackerSettle === undefined ? {} : { trackerSettle: options.trackerSettle }),
  });
  return { server, url: `127.0.0.1:${server.port}` };
}

interface TestClient {
  events: { type?: unknown; [key: string]: unknown }[];
  send: (command: unknown) => void;
  waitFor: (
    type: string,
    predicate?: (event: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>;
  close: () => void;
}

async function connect(url: string): Promise<TestClient> {
  const events: { type?: unknown; [key: string]: unknown }[] = [];
  const consumed = new Set<number>();
  const waiters: {
    type: string;
    predicate: (event: Record<string, unknown>) => boolean;
    resolve: (event: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];

  const socket = new WebSocket(`ws://${url}/ws`);

  const tryConsume = (event: Record<string, unknown>, index: number) => {
    for (const waiter of [...waiters]) {
      if (consumed.has(index)) return;
      if (event.type !== waiter.type || !waiter.predicate(event)) continue;
      consumed.add(index);
      clearTimeout(waiter.timer);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  };

  socket.onmessage = (message) => {
    const event = JSON.parse(String(message.data)) as Record<string, unknown>;
    const index = events.push(event) - 1;
    tryConsume(event, index);
  };

  const opened = Promise.withResolvers<void>();
  socket.onopen = () => opened.resolve();
  socket.onerror = () => opened.reject(new Error("websocket failed"));
  await opened.promise;

  return {
    events,
    send(command) {
      socket.send(JSON.stringify(command));
    },
    waitFor(type, predicate = () => true, timeoutMs = 20000) {
      const existing = events.findIndex(
        (event, index) => !consumed.has(index) && event.type === type && predicate(event),
      );
      if (existing !== -1) {
        consumed.add(existing);
        return Promise.resolve(events[existing] as Record<string, unknown>);
      }

      const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
      const timer = setTimeout(() => {
        waiters.splice(
          waiters.findIndex((waiter) => waiter.timer === timer),
          1,
        );
        reject(new Error(`timed out waiting for ${type}`));
      }, timeoutMs);
      waiters.push({ type, predicate, resolve, reject, timer });
      return promise;
    },
    close() {
      socket.close();
    },
  };
}

function eventIndex(client: TestClient, event: Record<string, unknown>): number {
  return client.events.indexOf(event);
}

const FULL_SHA = /^[0-9a-f]{40}$/;

async function readMaybe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

describe("resetImplementation", () => {
  test("deletes the implementation, commits it, and pushes it", async () => {
    const host = await createHost();
    await pushBase(host);
    const keepBefore = new Map<string, string>();
    for (const name of ["GOAL.md", "AGENTS.md", ".gitignore"]) {
      const bytes = await readFile(join(host.host, name), "utf8");
      keepBefore.set(name, bytes);
    }
    const sentinelBefore = await readFile(join(host.host, ".worktree", "sentinel.txt"), "utf8");
    const baseSha = git(host.host, ["rev-parse", "main"]).stdout;
    const logPath = join(host.root, "agent.log");
    const { server, url } = await startServer(host, {
      agentCommand: `bun ${STUB_AGENT} --log=${logPath}`,
    });

    try {
      const client = await connect(url);
      client.send({ type: "resetImplementation" });

      const started = await client.waitFor("implementationResetStarted");
      expect(started).toEqual({ type: "implementationResetStarted" });

      const stopped = await client.waitFor("implementationResetStopped");
      expect(stopped).toMatchObject({ type: "implementationResetStopped", completed: true });
      expect(stopped.commit).toMatch(FULL_SHA);
      const commit = String(stopped.commit);

      const lifecycle = await client.waitFor("lifecycleState");
      expect(lifecycle).toEqual({
        type: "lifecycleState",
        stage: "goal",
        pass: 1,
        work: null,
        paused: false,
      });
      const records = await client.waitFor("records");
      expect(records).toEqual({ type: "records", records: [], next: null });
      const goal = await client.waitFor("goal");
      expect(goal).toEqual({ type: "goal", text: "# Goal\n\nKeep this.\n" });

      expect(eventIndex(client, stopped)).toBeLessThan(
        eventIndex(client, lifecycle),
      );
      expect(eventIndex(client, lifecycle)).toBeLessThan(eventIndex(client, records));
      expect(eventIndex(client, records)).toBeLessThan(eventIndex(client, goal));

      expect(client.events.map((event) => event.type)).not.toContain("runStarted");
      expect(client.events.map((event) => event.type)).not.toContain("activity");
      expect(client.events.map((event) => event.type)).not.toContain("question");
      expect(client.events.map((event) => event.type)).not.toContain("runStopped");
      expect(await exists(logPath)).toBe(false);

      expect(await exists(join(host.host, "packages"))).toBe(false);
      expect(await exists(join(host.host, "untracked.ts"))).toBe(false);
      expect(await exists(join(host.host, "ignored"))).toBe(false);
      expect(await exists(join(host.host, "adrs"))).toBe(false);
      expect(await exists(join(host.host, "linked-victim"))).toBe(false);
      expect(await exists(join(host.host, ".worktree", "victim.txt"))).toBe(true);
      expect(await readFile(join(host.host, ".worktree", "sentinel.txt"), "utf8")).toBe(
        sentinelBefore,
      );
      for (const [name, bytes] of keepBefore) {
        expect(await readFile(join(host.host, name), "utf8")).toBe(bytes);
      }

      expect(git(host.host, ["status", "--porcelain"]).stdout).toBe("");
      expect(git(host.host, ["log", "-1", "--pretty=%s"]).stdout).toBe(
        "chore: reset implementation",
      );
      expect(git(host.host, ["rev-parse", "main"]).stdout).toBe(commit);
      expect(git(host.host, ["rev-parse", "main"]).stdout).not.toBe(baseSha);
      expect(git(host.remote, ["rev-parse", "main"]).stdout).toBe(commit);
      expect(git(host.remote, ["ls-tree", "-r", "--name-only", "main"]).stdout).toBe(
        [
          ".devboard/sentinel.txt",
          ".gitignore",
          ".omp/sentinel.txt",
          "AGENTS.md",
          "GOAL.md",
        ].join("\n"),
      );
      client.close();
    } finally {
      server.stop(true);
    }
  });

  test("answers an empty record list and preserves goal editing afterwards", async () => {
    const host = await createHost();
    await pushBase(host);
    const { server, url } = await startServer(host);

    try {
      const first = await connect(url);
      first.send({ type: "resetImplementation" });
      await first.waitFor("implementationResetStarted");
      const stopped = await first.waitFor("implementationResetStopped");
      expect(stopped.completed).toBe(true);
      first.close();

      const client = await connect(url);
      client.send({ type: "listRecords" });
      expect(await client.waitFor("records")).toEqual({
        type: "records",
        records: [],
        next: null,
      });

      client.send({ type: "getGoal" });
      expect(await client.waitFor("goal")).toEqual({
        type: "goal",
        text: "# Goal\n\nKeep this.\n",
      });

      client.send({ type: "saveGoal", text: "Edited after reset\n" });
      expect(await client.waitFor("goal")).toEqual({
        type: "goal",
        text: "Edited after reset\n",
      });
      expect(await readFile(join(host.host, "GOAL.md"), "utf8")).toBe(
        "Edited after reset\n",
      );
      client.close();
    } finally {
      server.stop(true);
    }
  });

  test("reuses HEAD when the reset stages no change", async () => {
    const host = await createHost();
    await pushBase(host);
    const { server, url } = await startServer(host);

    try {
      const client = await connect(url);
      client.send({ type: "resetImplementation" });
      await client.waitFor("implementationResetStarted");
      const first = await client.waitFor("implementationResetStopped");
      expect(first.completed).toBe(true);

      client.send({ type: "resetImplementation" });
      await client.waitFor("implementationResetStarted");
      const second = await client.waitFor("implementationResetStopped");
      expect(second).toMatchObject({
        type: "implementationResetStopped",
        completed: true,
        commit: first.commit,
      });
      expect(git(host.host, ["rev-list", "--count", "main"]).stdout).toBe("2");
      expect(git(host.remote, ["rev-parse", "main"]).stdout).toBe(String(first.commit));
      client.close();
    } finally {
      server.stop(true);
    }
  });

  test("keeps a differently named top-level goal file", async () => {
    const host = await createHost({ goalName: "OBJECTIVE.md" });
    await pushBase(host);
    const { server, url } = await startServer(host, {
      goalFile: join(host.host, "OBJECTIVE.md"),
    });

    try {
      const client = await connect(url);
      client.send({ type: "resetImplementation" });
      await client.waitFor("implementationResetStarted");
      const stopped = await client.waitFor("implementationResetStopped");
      expect(stopped.completed).toBe(true);

      expect(await readFile(join(host.host, "OBJECTIVE.md"), "utf8")).toBe(
        "# Goal\n\nKeep this.\n",
      );
      expect(await exists(join(host.host, "GOAL.md"))).toBe(false);
      expect(await exists(join(host.host, "packages"))).toBe(false);
      expect(git(host.remote, ["ls-tree", "-r", "--name-only", "main"]).stdout).toContain(
        "OBJECTIVE.md",
      );

      const goal = await client.waitFor("goal");
      expect(goal).toEqual({ type: "goal", text: "# Goal\n\nKeep this.\n" });
      client.close();
    } finally {
      server.stop(true);
    }
  });

  test("never stages .worktree, node_modules, or dist without a .gitignore", async () => {
    const host = await createHost({ gitignore: false });
    await mkdir(join(host.host, ".devboard", "node_modules"), { recursive: true });
    await mkdir(join(host.host, ".devboard", "dist"), { recursive: true });
    await writeFile(join(host.host, ".devboard", "node_modules", "cache.js"), "cache\n");
    await writeFile(join(host.host, ".devboard", "dist", "app.js"), "built\n");
    await writeFile(join(host.host, ".worktree", "scratch.txt"), "scratch\n");
    await pushBase(host);
    const { server, url } = await startServer(host);

    try {
      const client = await connect(url);
      client.send({ type: "resetImplementation" });
      await client.waitFor("implementationResetStarted");
      const stopped = await client.waitFor("implementationResetStopped");
      expect(stopped.completed).toBe(true);

      const tree = git(host.remote, ["ls-tree", "-r", "--name-only", "main"]).stdout;
      expect(tree).toBe(
        [".devboard/sentinel.txt", ".omp/sentinel.txt", "AGENTS.md", "GOAL.md"].join("\n"),
      );
      expect(tree).not.toContain("node_modules");
      expect(tree).not.toContain(".devboard/dist");
      expect(tree).not.toContain(".worktree");
      expect(await exists(join(host.host, ".devboard", "node_modules", "cache.js"))).toBe(
        true,
      );
      expect(await exists(join(host.host, ".worktree", "sentinel.txt"))).toBe(true);
      client.close();
    } finally {
      server.stop(true);
    }
  });

  test("bypasses a failing pre-commit hook", async () => {
    const host = await createHost();
    await pushBase(host);
    const hook = join(host.host, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\necho pre-commit-refused >&2\nexit 1\n");
    await chmod(hook, 0o755);
    const { server, url } = await startServer(host);

    try {
      const client = await connect(url);
      client.send({ type: "resetImplementation" });
      await client.waitFor("implementationResetStarted");
      const stopped = await client.waitFor("implementationResetStopped");
      expect(stopped.completed).toBe(true);
      expect(stopped.commit).toMatch(FULL_SHA);
      expect(git(host.remote, ["log", "-1", "--pretty=%s", "main"]).stdout).toBe(
        "chore: reset implementation",
      );
      client.close();
    } finally {
      server.stop(true);
    }
  });

  test("refuses off main, without origin, outside the top level, and without HEAD", async () => {
    const offMain = await createHost();
    await pushBase(offMain);
    const branch = await startServer(offMain);
    git(offMain.host, ["checkout", "-q", "-b", "feature"]);

    const noOrigin = await createHost();
    git(noOrigin.host, ["remote", "remove", "origin"]);

    const nested = await createHost();
    await pushBase(nested);

    const unborn = await createHost({ baseCommit: false, origin: false });
    git(unborn.host, ["remote", "add", "origin", unborn.remote]);

    const cases: {
      name: string;
      host: Host;
      handle: ServerHandle;
    }[] = [
      { name: "off main", host: offMain, handle: branch },
      { name: "no origin", host: noOrigin, handle: await startServer(noOrigin) },
      {
        name: "nested REPO_DIR",
        host: nested,
        handle: await startServer(nested, { repoDir: join(nested.host, "packages") }),
      },
      { name: "unborn HEAD", host: unborn, handle: await startServer(unborn) },
    ];

    try {
      for (const { name, host, handle } of cases) {
        const before = await readFile(join(host.host, "packages", "code.ts"), "utf8");
        const goalBefore = await readMaybe(join(host.host, "GOAL.md"));
        const client = await connect(handle.url);
        client.send({ type: "resetImplementation" });

        const error = await client.waitFor("error");
        expect(error.message).toEqual(expect.any(String));
        const stopped = await client.waitFor("implementationResetStopped");
        expect(stopped).toMatchObject({
          type: "implementationResetStopped",
          completed: false,
        });
        expect("commit" in stopped).toBe(false);
        expect(await readFile(join(host.host, "packages", "code.ts"), "utf8")).toBe(
          before,
        );
        expect(await readMaybe(join(host.host, "GOAL.md"))).toEqual(goalBefore);
        expect(await exists(join(host.host, "untracked.ts"))).toBe(true);
        expect(
          client.events.filter((event) => event.type === "error").length,
          `${name}: exactly one error`,
        ).toBe(1);
        client.close();
      }
    } finally {
      branch.server.stop(true);
      for (const { handle } of cases.slice(1)) handle.server.stop(true);
    }
  });

  test(
    "stops an active run and resets",
    async () => {
      const host = await createHost();
      await pushBase(host);
      await writeFile(
        join(host.host, "adrs", "0002-pending.md"),
        "# Pending\n\n- Status: Proposed\n",
      );
      const { server, url } = await startServer(host, {
        agentCommand: `bun ${STUB_AGENT} --delay-ms=5000`,
      });

      try {
        const client = await connect(url);
        client.send({ type: "startRun" });
        await client.waitFor("runStarted");

        client.send({ type: "resetImplementation" });
        await client.waitFor("implementationResetStarted");
        expect(await client.waitFor("runStopped")).toMatchObject({
          type: "runStopped",
          file: "0002-pending.md",
          resolved: false,
        });
        const stopped = await client.waitFor("implementationResetStopped");
        expect(stopped).toMatchObject({
          type: "implementationResetStopped",
          completed: true,
        });
        expect(stopped.commit).toMatch(FULL_SHA);
        expect(client.events.filter((event) => event.type === "error")).toHaveLength(0);
        expect(await exists(join(host.host, "packages", "code.ts"))).toBe(false);
        expect(await exists(join(host.host, "untracked.ts"))).toBe(false);
        expect(await exists(join(host.host, "adrs", "0001-old.md"))).toBe(false);
        client.close();
      } finally {
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "cancels a skills preparation, restores the skills, and resets",
    async () => {
      const host = await createHost({ skills: true });
      await pushBase(host);
      const skill = join(host.host, ".omp", "skills", "prepared-skill", "SKILL.md");
      const skillBefore = await readFile(skill, "utf8");
      const { server, url } = await startServer(host, {
        agentCommand: `bun ${STUB_AGENT} --prepare-skills --delay-ms=10000`,
      });

      try {
        const client = await connect(url);
        client.send({ type: "prepareSkills" });
        await client.waitFor("skillsPreparationStarted");

        client.send({ type: "resetImplementation" });
        await client.waitFor("implementationResetStarted");
        expect(await client.waitFor("skillsPreparationStopped")).toEqual({
          type: "skillsPreparationStopped",
          completed: false,
        });
        const stopped = await client.waitFor("implementationResetStopped");
        expect(stopped).toMatchObject({
          type: "implementationResetStopped",
          completed: true,
        });
        expect(await readFile(skill, "utf8")).toBe(skillBefore);
        expect(await exists(join(host.host, "packages"))).toBe(false);
        expect(await exists(join(host.host, "adrs"))).toBe(false);
        client.close();
      } finally {
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "stops a running lifecycle and resets",
    async () => {
      const host = await createHost({ skills: true });
      await pushBase(host);
      const epic: OpenEpic = {
        number: 7,
        title: "Reset the running lifecycle",
        url: "https://example.test/issues/7",
      };
      const { server, url } = await startServer(host, {
        agentCommand: `bun ${STUB_AGENT} --delay-ms=5000`,
        tracker: async () => epic,
        trackerSettle: { attempts: 1, delayMs: 0 },
      });

      try {
        const client = await connect(url);
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          "lifecycleState",
          (event) => event.stage === "implementation",
        );
        await client.waitFor("runStarted");

        client.send({ type: "resetImplementation" });
        await client.waitFor("implementationResetStarted");
        await client.waitFor("runStopped");
        const stopped = await client.waitFor("implementationResetStopped");
        expect(stopped).toMatchObject({
          type: "implementationResetStopped",
          completed: true,
        });
        expect(client.events.filter((event) => event.type === "error")).toHaveLength(0);
        expect(await exists(join(host.host, "packages"))).toBe(false);
        expect(await exists(join(host.host, "adrs"))).toBe(false);
        expect(await exists(join(host.host, ".omp", "skills", "prepared-skill"))).toBe(true);
        client.close();
      } finally {
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "stops a paused lifecycle and resets",
    async () => {
      const host = await createHost({ skills: true });
      await pushBase(host);
      const epic: OpenEpic = {
        number: 8,
        title: "Reset the paused lifecycle",
        url: "https://example.test/issues/8",
      };
      const { server, url } = await startServer(host, {
        agentCommand: `bun ${STUB_AGENT} --delay-ms=5000`,
        tracker: async () => epic,
        trackerSettle: { attempts: 1, delayMs: 0 },
      });

      try {
        const client = await connect(url);
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          "lifecycleState",
          (event) => event.stage === "implementation",
        );
        await client.waitFor("runStarted");
        client.send({ type: "pauseLifecycle" });
        await client.waitFor("lifecycleState", (event) => event.paused === true);

        client.send({ type: "resetImplementation" });
        await client.waitFor("implementationResetStarted");
        await client.waitFor("runStopped");
        const stopped = await client.waitFor("implementationResetStopped");
        expect(stopped).toMatchObject({
          type: "implementationResetStopped",
          completed: true,
        });
        expect(client.events.filter((event) => event.type === "error")).toHaveLength(0);
        expect(await exists(join(host.host, "packages"))).toBe(false);
        expect(await exists(join(host.host, "adrs"))).toBe(false);
        client.close();
      } finally {
        server.stop(true);
      }
    },
    20000,
  );

  test("keeps the local commit and remote unchanged when the push is rejected", async () => {
    const host = await createHost();
    await pushBase(host);
    const baseSha = git(host.remote, ["rev-parse", "main"]).stdout;
    const baseTree = git(host.remote, ["ls-tree", "-r", "--name-only", "main"]).stdout;
    const hook = join(host.remote, "hooks", "pre-receive");
    await writeFile(
      hook,
      "#!/bin/sh\necho 'remote rejected the reset' >&2\nexit 1\n",
    );
    await chmod(hook, 0o755);
    const { server, url } = await startServer(host);

    try {
      const client = await connect(url);
      client.send({ type: "resetImplementation" });
      await client.waitFor("implementationResetStarted");
      const error = await client.waitFor("error");
      expect(String(error.message)).toContain("remote rejected the reset");
      const stopped = await client.waitFor("implementationResetStopped");
      expect(stopped).toMatchObject({
        type: "implementationResetStopped",
        completed: false,
      });
      expect(stopped.commit).toMatch(FULL_SHA);

      expect(await exists(join(host.host, "packages"))).toBe(false);
      expect(await exists(join(host.host, "untracked.ts"))).toBe(false);
      expect(git(host.host, ["status", "--porcelain"]).stdout).toBe("");
      expect(git(host.host, ["log", "-1", "--pretty=%s"]).stdout).toBe(
        "chore: reset implementation",
      );
      expect(git(host.host, ["rev-parse", "main"]).stdout).toBe(String(stopped.commit));
      expect(git(host.remote, ["rev-parse", "main"]).stdout).toBe(baseSha);
      expect(git(host.remote, ["ls-tree", "-r", "--name-only", "main"]).stdout).toBe(
        baseTree,
      );
      client.close();
    } finally {
      server.stop(true);
    }
  });

  test("reports a commit failure with the staged deletion left in place", async () => {
    const host = await createHost();
    await pushBase(host);
    const baseSha = git(host.remote, ["rev-parse", "main"]).stdout;
    const hook = join(host.host, ".git", "hooks", "prepare-commit-msg");
    await writeFile(hook, "#!/bin/sh\necho 'commit refused by hook' >&2\nexit 1\n");
    await chmod(hook, 0o755);
    const { server, url } = await startServer(host);

    try {
      const client = await connect(url);
      client.send({ type: "resetImplementation" });
      await client.waitFor("implementationResetStarted");
      const error = await client.waitFor("error");
      expect(String(error.message)).toContain("commit refused by hook");
      const stopped = await client.waitFor("implementationResetStopped");
      expect(stopped).toMatchObject({
        type: "implementationResetStopped",
        completed: false,
      });
      expect("commit" in stopped).toBe(false);

      expect(await exists(join(host.host, "packages"))).toBe(false);
      expect(await exists(join(host.host, "untracked.ts"))).toBe(false);
      const status = git(host.host, ["status", "--porcelain"]).stdout;
      expect(status).toContain("D  packages/code.ts");
      expect(status).toContain("D  untracked.ts");
      expect(git(host.host, ["rev-parse", "main"]).stdout).toBe(baseSha);
      expect(git(host.remote, ["rev-parse", "main"]).stdout).toBe(baseSha);
      client.close();
    } finally {
      server.stop(true);
    }
  });

  test("refuses a second reset and every mutating command while one runs", async () => {
    const host = await createHost();
    await pushBase(host);
    const hook = join(host.remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nsleep 1.2\nexit 0\n");
    await chmod(hook, 0o755);
    const { server, url } = await startServer(host);

    try {
      const client = await connect(url);
      client.send({ type: "resetImplementation" });
      await client.waitFor("implementationResetStarted");

      const refused: unknown[] = [
        { type: "resetImplementation" },
        { type: "saveGoal", text: "blocked" },
        { type: "startRun" },
        { type: "startLifecycle" },
        { type: "pauseLifecycle" },
        { type: "resumeLifecycle" },
        { type: "reviseGoal", request: "blocked" },
        { type: "createGoal" },
        { type: "prepareSkills" },
        { type: "answer", id: 1, value: "blocked" },
      ];
      for (const command of refused) {
        client.send(command);
        const error = await client.waitFor("error");
        expect(String(error.message)).toBe("An implementation reset is active.");
      }
      expect(
        client.events.filter((event) => event.type === "implementationResetStarted"),
      ).toHaveLength(1);

      client.send({ type: "getGoal" });
      expect(await client.waitFor("goal")).toEqual({
        type: "goal",
        text: "# Goal\n\nKeep this.\n",
      });
      client.send({ type: "getSkills" });
      expect(await client.waitFor("skillsState")).toEqual({
        type: "skillsState",
        skills: [],
        contradictions: [],
      });

      const stopped = await client.waitFor("implementationResetStopped");
      expect(stopped.completed).toBe(true);

      client.send({ type: "listRecords" });
      expect(await client.waitFor("records")).toEqual({
        type: "records",
        records: [],
        next: null,
      });
      client.close();
    } finally {
      server.stop(true);
    }
  });

  test("replays the started event to a client that connects mid-reset", async () => {
    const host = await createHost();
    await pushBase(host);
    const hook = join(host.remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nsleep 1\nexit 0\n");
    await chmod(hook, 0o755);
    const { server, url } = await startServer(host);

    try {
      const first = await connect(url);
      first.send({ type: "resetImplementation" });
      await first.waitFor("implementationResetStarted");

      const late = await connect(url);
      late.send({ type: "getGoal" });
      const started = await late.waitFor("implementationResetStarted");
      const goal = await late.waitFor("goal");
      expect(eventIndex(late, started)).toBeLessThan(eventIndex(late, goal));
      expect(late.events[0]).toEqual({ type: "implementationResetStarted" });

      const stopped = await first.waitFor("implementationResetStopped");
      expect(stopped.completed).toBe(true);
      first.close();
      late.close();
    } finally {
      server.stop(true);
    }
  });

  test("allows reset with an absent, empty, or whitespace-only goal", async () => {
    const goals = [
      { name: "absent", content: null, eventText: "" },
      { name: "empty", content: "", eventText: "" },
      { name: "whitespace", content: " \n\t\n", eventText: " \n\t\n" },
    ];

    for (const goal of goals) {
      const host = await createHost({ goal: goal.content });
      await pushBase(host);
      const goalBytes = await readMaybe(join(host.host, "GOAL.md"));
      const { server, url } = await startServer(host);

      try {
        const client = await connect(url);
        client.send({ type: "resetImplementation" });
        await client.waitFor("implementationResetStarted");
        const stopped = await client.waitFor("implementationResetStopped");
        expect(stopped.completed, goal.name).toBe(true);

        const goalEvent = await client.waitFor("goal");
        expect(goalEvent).toEqual({ type: "goal", text: goal.eventText });
        expect(await readMaybe(join(host.host, "GOAL.md"))).toEqual(goalBytes);
        expect(await exists(join(host.host, "packages"))).toBe(false);
        client.close();
      } finally {
        server.stop(true);
      }
    }
  });

  test("removes a symlink without following it", async () => {
    const host = await createHost();
    await pushBase(host);
    const external = join(host.root, "outside-victim.txt");
    await writeFile(external, "outside bytes\n");
    await symlink(external, join(host.host, "outside-link"));
    const { server, url } = await startServer(host);

    try {
      const client = await connect(url);
      client.send({ type: "resetImplementation" });
      await client.waitFor("implementationResetStarted");
      const stopped = await client.waitFor("implementationResetStopped");
      expect(stopped.completed).toBe(true);

      expect(await exists(join(host.host, "outside-link"))).toBe(false);
      expect(await readFile(external, "utf8")).toBe("outside bytes\n");
      client.close();
    } finally {
      server.stop(true);
    }
  });
});
