import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Server } from "bun";
import { createApp } from "./app";
import type { EpicLookup } from "./tracker";

const STUB_AGENT = join(import.meta.dir, "fixtures", "stub-agent.ts");
const QUESTION_OPTIONS = [
  { label: "Alpha", description: "Alpha leads to the first outcome.", recommended: true },
  { label: "Beta", description: "Beta leads to the second outcome.", recommended: false },
];
const TEST_ROOT = join(import.meta.dir, "..", ".test-tmp");
const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  await mkdir(TEST_ROOT, { recursive: true });
  const directory = await mkdtemp(join(TEST_ROOT, "skills-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  await rm(TEST_ROOT, { recursive: true, force: true });
});

interface TestServer {
  server: Server<unknown>;
  root: string;
  adrDir: string;
  goalFile: string;
  skillsDir: string;
  logPath: string;
  url: string;
}

interface ServerOptions {
  root?: string;
  goalText?: string | null;
  pendingAdr?: boolean;
  files?: Record<string, string>;
  agentArguments?: string;
  tracker?: EpicLookup;
}

const GOAL_TEXT = "# Goal\n\nShip a documented HTTP API.\n";

async function startServer(options: ServerOptions = {}): Promise<TestServer> {
  const root = options.root ?? (await temporaryDirectory());
  const adrDir = join(root, "adrs");
  const staticDir = join(root, "static");
  const goalFile = join(root, "GOAL.md");
  const skillsDir = join(root, ".omp", "skills");
  await mkdir(adrDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>ADR overview</title>");

  const goalText = options.goalText === undefined ? GOAL_TEXT : options.goalText;
  if (goalText !== null) await writeFile(goalFile, goalText);
  if (options.pendingAdr === true) {
    await writeFile(join(adrDir, "0001-decision.md"), "# A decision\n\n- Status: Proposed\n");
  }
  for (const [relative, source] of Object.entries(options.files ?? {})) {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
  }

  const logPath = join(root, "agent.log");
  const command = [`bun ${STUB_AGENT}`, `--log=${logPath}`, options.agentArguments ?? ""]
    .filter((part) => part.length > 0)
    .join(" ");

  const server = createApp({
    adrDir,
    staticDir,
    hostname: "127.0.0.1",
    port: 0,
    repoDir: root,
    goalFile,
    agentCommand: command,
    tracker: options.tracker ?? (async () => undefined),
  });

  return { server, root, adrDir, goalFile, skillsDir, logPath, url: `127.0.0.1:${server.port}` };
}

interface TestClient {
  socket: WebSocket;
  events: Record<string, unknown>[];
  send(command: unknown): void;
  waitFor(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  close(): void;
}

function connect(url: string): Promise<TestClient> {
  const { promise, resolve, reject } = Promise.withResolvers<TestClient>();
  const socket = new WebSocket(`ws://${url}/ws`);
  const events: Record<string, unknown>[] = [];
  const buffered: Record<string, unknown>[] = [];
  const waiters: {
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }[] = [];

  socket.onopen = () => {
    resolve({
      socket,
      events,
      send(command) {
        socket.send(JSON.stringify(command));
      },
      waitFor(predicate) {
        const index = buffered.findIndex(predicate);
        if (index >= 0) {
          const message = buffered.splice(index, 1)[0];
          if (message !== undefined) return Promise.resolve(message);
        }
        const { promise: waiting, resolve: settle, reject: fail } =
          Promise.withResolvers<Record<string, unknown>>();
        waiters.push({ predicate, resolve: settle, reject: fail });
        return waiting;
      },
      close() {
        socket.close();
      },
    });
  };

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
      if (waiter !== undefined) waiter.resolve(message);
    } else {
      buffered.push(message);
    }
  };

  socket.onerror = () => reject(new Error("websocket failed"));
  socket.onclose = () => {
    for (const waiter of waiters.splice(0)) {
      waiter.reject(new Error("websocket closed"));
    }
  };

  return promise;
}

function logLines(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter((line) => line.length > 0);
}

function spawnCount(logPath: string): number {
  return logLines(logPath).filter((line) => line.startsWith("spawn ")).length;
}

function prompts(logPath: string): string[] {
  return logLines(logPath)
    .filter((line) => line.startsWith("prompt "))
    .map((line) => line.slice("prompt ".length));
}

function errors(client: TestClient): Record<string, unknown>[] {
  return client.events.filter((message) => message.type === "error");
}

async function waitUntil(predicate: () => boolean, label: string, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
  if (!predicate()) throw new Error(label);
}

function managedSkill(name: string, category: string, directive: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: Guidance for ${name}.`,
    "metadata:",
    '  devboard-managed: "true"',
    `  devboard-category: ${category}`,
    "---",
    "",
    `# ${name}`,
    "",
    `- ${directive}`,
    "",
  ].join("\n");
}

function unmanagedSkill(name: string, directive: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: Hand-authored guidance for ${name}.`,
    "---",
    "",
    `# ${name}`,
    "",
    `- ${directive}`,
    "",
  ].join("\n");
}

function skillDirectories(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function directoryBytes(root: string): Map<string, string> {
  const files = new Map<string, string>();
  if (!existsSync(root)) return files;
  const walk = (relative: string) => {
    const directory = relative.length === 0 ? root : join(root, relative);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const next = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(next);
      } else if (entry.isFile()) {
        files.set(next, readFileSync(join(root, next), "utf8"));
      }
    }
  };
  walk("");
  return files;
}

function frontmatter(source: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (match === null) return {};
  const fields: Record<string, string> = {};
  let section: string | undefined;
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    const pair = /^([^:]+):\s*(.*)$/.exec(trimmed);
    if (pair === null) continue;
    const key = pair[1]?.trim() ?? "";
    const value = (pair[2] ?? "").trim().replace(/^"(.*)"$/, "$1");
    if (/^\s/.test(line) && section !== undefined) {
      fields[`${section}.${key}`] = value;
    } else if (value.length === 0) {
      section = key;
    } else {
      section = undefined;
      fields[key] = value;
    }
  }
  return fields;
}

function skillNames(message: Record<string, unknown>): string[] {
  const skills = Array.isArray(message.skills) ? message.skills : [];
  return skills
    .map((skill) =>
      typeof skill === "object" && skill !== null && "name" in skill
        ? String(skill.name)
        : "",
    )
    .sort();
}

function skillCategories(message: Record<string, unknown>): string[] {
  const skills = Array.isArray(message.skills) ? message.skills : [];
  return skills
    .map((skill) =>
      typeof skill === "object" && skill !== null && "category" in skill
        ? String(skill.category)
        : "",
    )
    .sort();
}

describe("skills preparation", () => {
  test(
    "starts one peer with /prepare-skills, relays activity and questions, and reports the prepared set",
    async () => {
      const { server, root, adrDir, goalFile, skillsDir, logPath, url } = await startServer({
        agentArguments: "--prepare-skills --questions=1",
      });
      const client = await connect(url);
      const goalBefore = await readFile(goalFile, "utf8");
      const adrBefore = directoryBytes(adrDir);

      try {
        client.send({ type: "prepareSkills" });

        expect(await client.waitFor((message) => message.type === "skillsPreparationStarted")).toMatchObject(
          { type: "skillsPreparationStarted" },
        );
        expect(
          await client.waitFor(
            (message) =>
              message.type === "activity" &&
              String(message.text).includes("Researching current architecture"),
          ),
        ).toBeDefined();
        const question = await client.waitFor((message) => message.type === "question");
        expect(question).toMatchObject({ message: "Choose an answer", options: QUESTION_OPTIONS });

        client.send({ type: "answer", id: question.id, value: "Alpha" });
        expect(
          await client.waitFor(
            (message) =>
              message.type === "activity" &&
              String(message.text).includes("Answer received: Alpha"),
          ),
        ).toBeDefined();

        const stopped = await client.waitFor(
          (message) => message.type === "skillsPreparationStopped",
        );
        expect(stopped).toMatchObject({ completed: true, contradictions: [] });
        expect(skillCategories(stopped).sort()).toEqual([
          "architecture",
          "code-organization",
          "testing",
        ]);

        expect(spawnCount(logPath)).toBe(1);
        expect(prompts(logPath)).toEqual(["/prepare-skills"]);
        expect(client.events.some((message) => message.type === "runStarted")).toBe(false);
        expect(client.events.some((message) => message.type === "runStopped")).toBe(false);

        const directories = skillDirectories(skillsDir);
        expect(directories.length).toBeGreaterThanOrEqual(3);
        for (const name of directories) {
          const source = await readFile(join(skillsDir, name, "SKILL.md"), "utf8");
          const fields = frontmatter(source);
          expect(fields.name).toBe(name);
          expect(name.length).toBeGreaterThan(0);
          expect(name.length).toBeLessThanOrEqual(64);
          expect(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)).toBe(true);
          expect(fields.description?.trim().length ?? 0).toBeGreaterThan(0);
          expect((fields.description ?? "").length).toBeLessThanOrEqual(1024);
          expect(fields["metadata.devboard-managed"]).toBe("true");
          expect(["architecture", "code-organization", "testing"]).toContain(
            fields["metadata.devboard-category"],
          );
        }
        expect(skillNames(stopped).sort()).toEqual(directories);

        expect(await readFile(goalFile, "utf8")).toBe(goalBefore);
        expect(directoryBytes(adrDir)).toEqual(adrBefore);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    15000,
  );

  test(
    "refuses without a non-whitespace goal and never starts on load",
    async () => {
      for (const goalText of [null, "", "   \n\t"]) {
        const { server, logPath, url } = await startServer({
          goalText,
          agentArguments: "--prepare-skills",
        });
        const client = await connect(url);
        try {
          client.send({ type: "getSkills" });
          expect(await client.waitFor((message) => message.type === "skillsState")).toBeDefined();
          client.send({ type: "getGoal" });
          await client.waitFor(
            (message) => message.type === "goal" && String(message.text).trim().length === 0,
          );
          expect(spawnCount(logPath)).toBe(0);

          client.send({ type: "prepareSkills" });
          const failure = await client.waitFor((message) => message.type === "error");
          expect(String(failure.message)).toMatch(/goal is not set/i);
          expect(
            client.events.some((message) => message.type === "skillsPreparationStarted"),
          ).toBe(false);
          expect(spawnCount(logPath)).toBe(0);
        } finally {
          client.close();
          server.stop(true);
        }
      }
    },
    15000,
  );

  test(
    "refuses every other command while skills preparation is active",
    async () => {
      const { server, logPath, url } = await startServer({
        agentArguments: "--prepare-skills --questions=1",
      });
      const client = await connect(url);

      try {
        client.send({ type: "prepareSkills" });
        await client.waitFor((message) => message.type === "skillsPreparationStarted");

        const commands = [
          { type: "startRun" },
          { type: "startLifecycle" },
          { type: "resumeLifecycle" },
          { type: "reviseGoal" },
          { type: "saveGoal", text: "A different goal" },
          { type: "createGoal" },
          { type: "prepareSkills" },
        ];
        for (const command of commands) client.send(command);
        await waitUntil(() => errors(client).length === commands.length, "refusal errors");

        for (const failure of errors(client)) {
          expect(String(failure.message)).toMatch(/skills preparation/i);
        }
        expect(spawnCount(logPath)).toBe(1);
        expect(
          client.events.some((message) => message.type === "lifecycleState"),
        ).toBe(false);

        await client.waitFor((message) => message.type === "question");
        client.send({ type: "answer", id: 1, value: "Alpha" });
        const stopped = await client.waitFor(
          (message) => message.type === "skillsPreparationStopped",
        );
        expect(stopped.completed).toBe(true);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    15000,
  );

  test(
    "accepts only one of two commands sent back to back",
    async () => {
      const { server, logPath, url } = await startServer({
        agentArguments: "--prepare-skills",
      });
      const client = await connect(url);

      try {
        client.send({ type: "prepareSkills" });
        client.send({ type: "prepareSkills" });

        const stopped = await client.waitFor(
          (message) => message.type === "skillsPreparationStopped",
        );
        expect(stopped.completed).toBe(true);
        expect(
          client.events.filter((message) => message.type === "skillsPreparationStarted").length,
        ).toBe(1);
        expect(errors(client)).toHaveLength(1);
        expect(String(errors(client)[0]?.message)).toMatch(/skills preparation/i);
        expect(spawnCount(logPath)).toBe(1);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    15000,
  );

  test(
    "refuses preparation during a run",
    async () => {
      const { server, logPath, url } = await startServer({
        pendingAdr: true,
        agentArguments: "--prepare-skills --delay-ms=600 --questions=0",
      });
      const client = await connect(url);
      try {
        client.send({ type: "startRun" });
        await client.waitFor((message) => message.type === "runStarted");
        client.send({ type: "prepareSkills" });
        const failure = await client.waitFor((message) => message.type === "error");
        expect(String(failure.message)).toMatch(/run is already active/i);
        await waitUntil(() => spawnCount(logPath) === 1, "run peer spawned");
        expect(spawnCount(logPath)).toBe(1);
        await client.waitFor((message) => message.type === "runStopped");
      } finally {
        client.close();
        server.stop(true);
      }
    },
    15000,
  );

  test(
    "refuses preparation during a paused lifecycle",
    async () => {
      const { server, logPath, url } = await startServer({
        agentArguments: "--prepare-skills --delay-ms=500",
      });
      const client = await connect(url);
      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "epic",
        );
        client.send({ type: "pauseLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.paused === true,
        );
        const spawned = spawnCount(logPath);
        client.send({ type: "prepareSkills" });
        const failure = await client.waitFor((message) => message.type === "error");
        expect(String(failure.message)).toMatch(/lifecycle run is active/i);
        expect(spawnCount(logPath)).toBe(spawned);
        client.send({ type: "resumeLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "finished",
        );
      } finally {
        client.close();
        server.stop(true);
      }
    },
    15000,
  );

  test(
    "refuses preparation during a goal creation",
    async () => {
      const root = await temporaryDirectory();
      const goalFile = join(root, "GOAL.md");
      const { server, logPath, url } = await startServer({
        root,
        goalText: null,
        agentArguments: `--prepare-skills --create-goal --goal=${goalFile}`,
      });
      const client = await connect(url);
      try {
        client.send({ type: "createGoal" });
        await client.waitFor((message) => message.type === "goalCreationStarted");
        client.send({ type: "prepareSkills" });
        const failure = await client.waitFor((message) => message.type === "error");
        expect(String(failure.message)).toMatch(/goal creation is active/i);
        await waitUntil(() => spawnCount(logPath) === 1, "creation peer spawned");
        expect(spawnCount(logPath)).toBe(1);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    15000,
  );

  test(
    "refuses preparation during a goal revision",
    async () => {
      const root = await temporaryDirectory();
      const goalFile = join(root, "GOAL.md");
      const { server, logPath, url } = await startServer({
        root,
        goalFile,
        agentArguments: `--prepare-skills --revise-goal --goal=${goalFile}`,
      });
      const client = await connect(url);
      try {
        client.send({ type: "reviseGoal" });
        await client.waitFor((message) => message.type === "goalRevisionStarted");
        client.send({ type: "prepareSkills" });
        const failure = await client.waitFor((message) => message.type === "error");
        expect(String(failure.message)).toMatch(/goal revision is active/i);
        await waitUntil(() => spawnCount(logPath) === 1, "revision peer spawned");
        expect(spawnCount(logPath)).toBe(1);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    15000,
  );

  test(
    "replays preparation on reconnect and the prepared set across restarts",
    async () => {
      const first = await startServer({
        agentArguments: "--prepare-skills --questions=1",
      });
      const leader = await connect(first.url);
      const follower = await connect(first.url);

      try {
        leader.send({ type: "prepareSkills" });
        await leader.waitFor((message) => message.type === "skillsPreparationStarted");
        await leader.waitFor(
          (message) =>
            message.type === "activity" && String(message.text).includes("Researching"),
        );

        const replayedStart = await follower.waitFor(
          (message) => message.type === "skillsPreparationStarted",
        );
        expect(replayedStart).toBeDefined();
        const replayedQuestion = await follower.waitFor(
          (message) => message.type === "question",
        );
        expect(replayedQuestion.id).toBe(1);
        await follower.waitFor(
          (message) =>
            message.type === "activity" && String(message.text).includes("Researching"),
        );

        follower.send({ type: "answer", id: replayedQuestion.id, value: "Beta" });
        const stopped = await leader.waitFor(
          (message) => message.type === "skillsPreparationStopped",
        );
        expect(stopped.completed).toBe(true);
        const preparedNames = skillNames(stopped);

        const reloaded = await connect(first.url);
        reloaded.send({ type: "getSkills" });
        const state = await reloaded.waitFor((message) => message.type === "skillsState");
        expect(skillNames(state)).toEqual(preparedNames);
        expect(state.contradictions).toEqual([]);
        reloaded.close();

        follower.close();
        leader.close();
        first.server.stop(true);

        const restarted = await startServer({ root: first.root });
        const afterRestart = await connect(restarted.url);
        try {
          afterRestart.send({ type: "getSkills" });
          const replay = await afterRestart.waitFor((message) => message.type === "skillsState");
          expect(skillNames(replay)).toEqual(preparedNames);
          expect(replay.contradictions).toEqual([]);
        } finally {
          afterRestart.close();
          restarted.server.stop(true);
        }
      } finally {
        leader.close();
        follower.close();
        first.server.stop(true);
      }
    },
    20000,
  );

  test(
    "a second run replaces managed skills and preserves hand-authored skills byte for byte",
    async () => {
      const { server, skillsDir, logPath, url } = await startServer({
        agentArguments: "--prepare-skills",
      });
      const client = await connect(url);
      const unmanagedSource = unmanagedSkill("house-style", "Prefer one response shape.");
      const unmanagedPath = join(skillsDir, "house-style", "SKILL.md");

      try {
        client.send({ type: "prepareSkills" });
        const first = await client.waitFor(
          (message) => message.type === "skillsPreparationStopped",
        );
        expect(first.completed).toBe(true);
        const firstNames = skillNames(first);

        await mkdir(dirname(unmanagedPath), { recursive: true });
        await writeFile(unmanagedPath, unmanagedSource);
        await mkdir(join(skillsDir, "legacy-managed"), { recursive: true });
        await writeFile(
          join(skillsDir, "legacy-managed", "SKILL.md"),
          managedSkill("legacy-managed", "architecture", "Keep the legacy policy."),
        );

        client.send({ type: "prepareSkills" });
        const second = await client.waitFor(
          (message) => message.type === "skillsPreparationStopped",
        );
        expect(second.completed).toBe(true);
        expect(skillNames(second)).toEqual(firstNames);
        expect(skillDirectories(skillsDir)).toEqual(
          [...firstNames, "house-style"].sort(),
        );
        expect(await readFile(unmanagedPath, "utf8")).toBe(unmanagedSource);
        expect(spawnCount(logPath)).toBe(2);

        const reloaded = await connect(url);
        try {
          reloaded.send({ type: "getSkills" });
        const state = await reloaded.waitFor((message) => message.type === "skillsState");
          expect(skillNames(state)).toEqual(firstNames);
        } finally {
          reloaded.close();
        }
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "fails on a contradiction with an unmanaged skill, names it, and preserves every file",
    async () => {
      const managedBefore = {
        "architecture-boundaries": managedSkill(
          "architecture-boundaries",
          "architecture",
          "Keep transport and domain separate.",
        ),
        "code-organization-modules": managedSkill(
          "code-organization-modules",
          "code-organization",
          "Prefer one responsibility per module.",
        ),
        "testing-strategy": managedSkill(
          "testing-strategy",
          "testing",
          "Test the published API behavior.",
        ),
      };
      const files: Record<string, string> = {};
      for (const [name, source] of Object.entries(managedBefore)) {
        files[`.omp/skills/${name}/SKILL.md`] = source;
      }
      files[".omp/skills/house-style/SKILL.md"] = unmanagedSkill(
        "house-style",
        "Never use dependency injection.",
      );

      const { server, skillsDir, goalFile, adrDir, url } = await startServer({
        files,
        agentArguments: "--prepare-skills --prepare-skills-conflict",
      });
      const client = await connect(url);
      const goalBefore = await readFile(goalFile, "utf8");
      const adrBefore = directoryBytes(adrDir);

      try {
        client.send({ type: "prepareSkills" });
        const failure = await client.waitFor(
          (message) => message.type === "error" && /contradiction/i.test(String(message.message)),
        );
        expect(String(failure.message)).toContain("house-style");

        const stopped = await client.waitFor(
          (message) => message.type === "skillsPreparationStopped",
        );
        expect(stopped.completed).toBe(false);
        expect(stopped.skills).toBeUndefined();

        expect(await readFile(join(skillsDir, "house-style", "SKILL.md"), "utf8")).toBe(
          files[".omp/skills/house-style/SKILL.md"],
        );
        for (const [name, source] of Object.entries(managedBefore)) {
          expect(await readFile(join(skillsDir, name, "SKILL.md"), "utf8")).toBe(source);
        }
        expect(skillDirectories(skillsDir)).toEqual(
          [...Object.keys(managedBefore), "house-style"].sort(),
        );

        const reloaded = await connect(url);
        try {
          reloaded.send({ type: "getSkills" });
        const state = await reloaded.waitFor((message) => message.type === "skillsState");
          expect(skillNames(state)).toEqual(Object.keys(managedBefore).sort());
        } finally {
          reloaded.close();
        }

        expect(await readFile(goalFile, "utf8")).toBe(goalBefore);
        expect(directoryBytes(adrDir)).toEqual(adrBefore);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "fails on a managed name colliding with an unmanaged skill and preserves the unmanaged file",
    async () => {
      const unmanagedSource = unmanagedSkill("custom-skill", "Keep the local convention.");
      const managedBefore = managedSkill(
        "testing-strategy",
        "testing",
        "Test observable behavior.",
      );
      const { server, skillsDir, url } = await startServer({
        files: {
          ".omp/skills/custom-skill/SKILL.md": unmanagedSource,
          ".omp/skills/testing-strategy/SKILL.md": managedBefore,
        },
        agentArguments: "--prepare-skills --prepare-skills-collision",
      });
      const client = await connect(url);

      try {
        client.send({ type: "prepareSkills" });
        const failure = await client.waitFor(
          (message) => message.type === "error" && /custom-skill/.test(String(message.message)),
        );
        expect(String(failure.message)).toMatch(/collid|unmanaged/i);
        const stopped = await client.waitFor(
          (message) => message.type === "skillsPreparationStopped",
        );
        expect(stopped.completed).toBe(false);

        expect(await readFile(join(skillsDir, "custom-skill", "SKILL.md"), "utf8")).toBe(
          unmanagedSource,
        );
        expect(await readFile(join(skillsDir, "testing-strategy", "SKILL.md"), "utf8")).toBe(
          managedBefore,
        );
      } finally {
        client.close();
        server.stop(true);
      }
    },
    15000,
  );

  test(
    "fails on invalid skill output and leaves the previous managed set unchanged",
    async () => {
      const managedBefore = managedSkill("testing-strategy", "testing", "Test behavior.");
      const { server, skillsDir, url } = await startServer({
        files: { ".omp/skills/testing-strategy/SKILL.md": managedBefore },
        agentArguments: "--prepare-skills --prepare-skills-invalid",
      });
      const client = await connect(url);

      try {
        client.send({ type: "prepareSkills" });
        const failure = await client.waitFor(
          (message) => message.type === "error" && /invalid-skill/.test(String(message.message)),
        );
        expect(String(failure.message)).toMatch(/description|name|category/i);
        const stopped = await client.waitFor(
          (message) => message.type === "skillsPreparationStopped",
        );
        expect(stopped.completed).toBe(false);

        expect(await readFile(join(skillsDir, "testing-strategy", "SKILL.md"), "utf8")).toBe(
          managedBefore,
        );
        expect(skillDirectories(skillsDir)).toEqual(["testing-strategy"]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    15000,
  );

  test(
    "fails when the peer exits without completing and restores the previous managed set",
    async () => {
      const managedBefore = managedSkill("testing-strategy", "testing", "Test behavior.");
      const { server, skillsDir, url } = await startServer({
        files: { ".omp/skills/testing-strategy/SKILL.md": managedBefore },
        agentArguments: "--prepare-skills --prepare-skills-error",
      });
      const client = await connect(url);

      try {
        client.send({ type: "prepareSkills" });
        const failure = await client.waitFor((message) => message.type === "error");
        expect(String(failure.message)).toMatch(/exited/i);
        const stopped = await client.waitFor(
          (message) => message.type === "skillsPreparationStopped",
        );
        expect(stopped.completed).toBe(false);
        expect(await readFile(join(skillsDir, "testing-strategy", "SKILL.md"), "utf8")).toBe(
          managedBefore,
        );
        expect(skillDirectories(skillsDir)).toEqual(["testing-strategy"]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    15000,
  );

  test(
    "ends an unreadable goal with an error and a failed stop without spawning a peer",
    async () => {
      const { server, goalFile, logPath, url } = await startServer({
        goalText: null,
        agentArguments: "--prepare-skills",
      });
      await mkdir(goalFile, { recursive: true });
      const client = await connect(url);

      try {
        client.send({ type: "prepareSkills" });
        const failure = await client.waitFor((message) => message.type === "error");
        expect(String(failure.message)).toMatch(/could not read the goal/i);
        const stopped = await client.waitFor(
          (message) => message.type === "skillsPreparationStopped",
        );
        expect(stopped).toMatchObject({ completed: false });
        expect(spawnCount(logPath)).toBe(0);
        expect(
          client.events.some((message) => message.type === "skillsPreparationStarted"),
        ).toBe(false);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    15000,
  );

  test("the installed command reads the harness prompt", async () => {
    const prompt = await readFile(join(import.meta.dir, "..", "prompts", "prepare-skills.md"), "utf8");
    const command = await readFile(
      join(import.meta.dir, "..", "omp", "commands", "prepare-skills.md"),
      "utf8",
    );

    expect(prompt).toContain("GOAL.md` is the only project-specific input");
    expect(prompt).toContain("Research");
    expect(prompt).toContain(".omp/skills/");
    expect(command.trim().split("\n").at(-1)).toContain(
      "Read `.devboard/prompts/prepare-skills.md`",
    );
  });
});
