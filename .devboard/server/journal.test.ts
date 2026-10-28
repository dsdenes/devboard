import { pendingRecord } from "./fixtures/adr-source";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Server } from "bun";
import { createApp } from "./app";
import {
  JOURNAL_MAX_BYTES,
  openJournal,
  pruneJournal,
  type Journal,
  type JournalRecord,
} from "./journal";
import { testProviderService } from "./fixtures/test-providers";

/**
 * New tests keep their temporary directories inside the repository. The app
 * fixture proves the journal is written by a real run; the rest prove rotation,
 * pruning, and the size bound against a fixture clock.
 */

const harnessRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(harnessRoot, "..");
const testRoot = join(repositoryRoot, ".devboard", ".tmp");
const STUB_AGENT = join(import.meta.dir, "fixtures", "stub-agent.ts");
const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, `test-journal-${randomUUID()}-`));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function journalRecords(stateDir: string, repoDir: string): JournalRecord[] {
  const path = join(stateDir, "journal", `${createKey(repoDir)}.jsonl`);
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JournalRecord);
}

function createKey(repoDir: string): string {
  return createHash("sha256").update(repoDir).digest("hex").slice(0, 24);
}

interface TestClient {
  socket: WebSocket;
  send(command: unknown): void;
  waitFor(
    predicate: (message: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>>;
}

function connect(url: string): Promise<TestClient> {
  const { promise, resolve: settle, reject } = Promise.withResolvers<TestClient>();
  const socket = new WebSocket(`ws://${url}/ws`);
  const buffered: Record<string, unknown>[] = [];
  const waiters: {
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
  }[] = [];

  socket.onopen = () => {
    settle({
      socket,
      send(command) {
        socket.send(JSON.stringify(command));
      },
      waitFor(predicate) {
        const index = buffered.findIndex(predicate);
        if (index >= 0) {
          const message = buffered.splice(index, 1)[0];
          if (message !== undefined) return Promise.resolve(message);
        }
        const { promise: waiting, resolve: next } =
          Promise.withResolvers<Record<string, unknown>>();
        waiters.push({ predicate, resolve: next });
        return waiting;
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
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const waiter = waiters.splice(index, 1)[0];
      if (waiter !== undefined) waiter.resolve(message);
    } else {
      buffered.push(message);
    }
  };
  socket.onerror = () => reject(new Error("websocket failed"));
  return promise;
}

const PENDING = pendingRecord("0001-first.md", "First decision", "First.", "Choose the first.");

async function startServer(options: {
  stateDir: string;
  journal?: Journal;
  agentCommand: string;
}): Promise<{ server: Server<unknown>; url: string; repoDir: string }> {
  const root = options.stateDir;
  const adrDir = join(root, "adrs");
  const staticDir = join(root, "static");
  await mkdir(adrDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(adrDir, "0001-first.md"), PENDING);
  const server = createApp({
    adrDir,
    staticDir,
    hostname: "127.0.0.1",
    port: 0,
    repoDir: root,
    stateDir: join(root, "state"),
    providers: testProviderService(join(root, "state")),
    agentCommand: options.agentCommand,
    ...(options.journal === undefined ? {} : { journal: options.journal }),
  });
  return { server, url: `127.0.0.1:${server.port}`, repoDir: root };
}

describe("journal", () => {
  test(
    "records a run's activity, question, start, and stop",
    async () => {
      const stateDir = await temporaryDirectory();
      const logPath = join(stateDir, "agent.log");
      const { server, url, repoDir } = await startServer({
        stateDir,
        agentCommand: `bun ${STUB_AGENT} --log=${logPath} --questions=1`,
      });
      const client = await connect(url);
      try {
        client.send({ type: "startRun" });
        await client.waitFor((message) => message.type === "runStarted");
        const question = await client.waitFor((message) => message.type === "question");
        client.send({ type: "answer", id: question.id, value: "Alpha" });
        await client.waitFor((message) => message.type === "activity");
        await client.waitFor((message) => message.type === "runStopped");
      } finally {
        client.socket.close();
        server.stop(true);
      }

      const records = journalRecords(join(stateDir, "state"), repoDir);
      const kinds = new Set(records.map((record) => record.kind));
      expect(kinds.has("activity")).toBe(true);
      expect(kinds.has("question")).toBe(true);
      expect(kinds.has("run-start")).toBe(true);
      expect(kinds.has("run-stop")).toBe(true);
      expect(records.find((record) => record.kind === "question")?.scope).toBe(
        "run:0001-first.md",
      );
      for (const record of records) {
        expect(record.repo).toBe(repoDir);
        expect(record.pid).toBe(process.pid);
        expect(typeof record.port).toBe("number");
        expect(Number.isFinite(Date.parse(record.ts))).toBe(true);
      }
    },
    20000,
  );

  test(
    "reports a write failure and still finishes the run",
    async () => {
      const stateDir = await temporaryDirectory();
      const failures: string[] = [];
      const journal = openJournal({
        stateDir: join(stateDir, "state"),
        repoDir: stateDir,
        port: 0,
        append() {
          throw new Error("disk full");
        },
        reportError(message) {
          failures.push(message);
        },
      });
      const logPath = join(stateDir, "agent.log");
      const { server, url } = await startServer({
        stateDir,
        journal,
        agentCommand: `bun ${STUB_AGENT} --log=${logPath} --questions=0`,
      });
      const client = await connect(url);
      try {
        client.send({ type: "startRun" });
        await client.waitFor((message) => message.type === "runStarted");
        expect(await client.waitFor((message) => message.type === "runStopped")).toMatchObject({
          resolved: true,
        });
      } finally {
        client.socket.close();
        server.stop(true);
      }
      expect(failures.length).toBe(1);
      expect(failures[0]).toContain("journal: could not write");
    },
    20000,
  );

  test("rotates the live file instead of truncating it", async () => {
    const stateDir = await temporaryDirectory();
    const journal = openJournal({
      stateDir,
      repoDir: "/fixture/project",
      port: 8080,
      rotateBytes: 200,
    });
    for (let index = 0; index < 6; index += 1) {
      journal.write("activity", `line ${index} ${"x".repeat(40)}`);
    }
    const files = readdirSync(join(stateDir, "journal")).sort();
    expect(files.length).toBeGreaterThan(1);
    expect(files.some((name) => name.endsWith(".jsonl"))).toBe(true);
    const rotated = files.filter((name) => !name.endsWith(".jsonl"));
    expect(rotated.length).toBeGreaterThan(0);
    const content = rotated
      .map((name) => readFileSync(join(stateDir, "journal", name), "utf8"))
      .join("");
    expect(content).toContain("line 0");
    const live = files.find((name) => /^[0-9a-f]{24}\.jsonl$/.test(name)) as string;
    expect(readFileSync(join(stateDir, "journal", live), "utf8")).toContain("line 5");
  });

  test("prunes journals rotated by the live writer past seven days", async () => {
    const stateDir = await temporaryDirectory();
    const journal = openJournal({
      stateDir,
      repoDir: "/fixture/project",
      port: 8080,
      rotateBytes: 200,
    });
    for (let index = 0; index < 3; index += 1) {
      journal.write("activity", `line ${index} ${"x".repeat(80)}`);
    }
    const directory = join(stateDir, "journal");
    const rotated = readdirSync(directory)
      .filter((name) => name !== basename(journal.path))
      .sort();
    const [oldName, freshName] = rotated;
    if (oldName === undefined || freshName === undefined) {
      throw new Error("rotation did not produce two journals");
    }
    const now = new Date("2026-10-24T12:00:00.000Z");
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const old = join(directory, oldName);
    const fresh = join(directory, freshName);
    utimesSync(old, eightDaysAgo, eightDaysAgo);
    utimesSync(fresh, oneDayAgo, oneDayAgo);

    const removed = pruneJournal(stateDir, {
      now,
      windowStart: new Date(now.getTime() - 10 * 60 * 1000),
    });

    expect(removed).toEqual([oldName]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("keeps an old live journal in retention and restores it after deletion", async () => {
    const stateDir = await temporaryDirectory();
    const failures: string[] = [];
    const journal = openJournal({
      stateDir,
      repoDir: "/fixture/project",
      port: 8080,
      rotateBytes: 200,
      reportError: (message) => failures.push(message),
    });
    journal.write("activity", `line 0 ${"z".repeat(120)}`);
    const now = new Date("2026-10-24T12:00:00.000Z");
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(journal.path, eightDaysAgo, eightDaysAgo);

    const removed = pruneJournal(stateDir, {
      now,
      windowStart: new Date(now.getTime() - 10 * 60 * 1000),
    });

    expect(removed).toEqual([]);
    expect(existsSync(journal.path)).toBe(true);

    // The writer keeps its stale size; the next write crosses rotateBytes.
    unlinkSync(journal.path);
    journal.write("activity", `line 1 ${"z".repeat(120)}`);

    expect(failures).toEqual([]);
    expect(readFileSync(journal.path, "utf8")).toContain("line 1");
  });

  test("counts rotated journals toward the size bound outside the live window", async () => {
    const stateDir = await temporaryDirectory();
    const journal = openJournal({
      stateDir,
      repoDir: "/fixture/project",
      port: 8080,
      rotateBytes: 200,
    });
    for (let index = 0; index < 4; index += 1) {
      journal.write("activity", `line ${index} ${"y".repeat(80)}`);
    }
    const directory = join(stateDir, "journal");
    const names = readdirSync(directory);
    const rotated = names.filter((name) => name !== basename(journal.path)).sort();
    const [coldName, ...inside] = rotated;
    if (coldName === undefined || inside.length === 0) {
      throw new Error("rotation did not produce enough journals");
    }
    const now = new Date("2026-10-24T12:00:00.000Z");
    const windowStart = new Date(now.getTime() - 10 * 60 * 1000);
    const cold = join(directory, coldName);
    const coldTime = new Date(now.getTime() - 60 * 60 * 1000);
    utimesSync(cold, coldTime, coldTime);
    for (const name of [...inside, basename(journal.path)]) {
      utimesSync(join(directory, name), now, now);
    }
    const total = names.reduce((sum, name) => sum + statSync(join(directory, name)).size, 0);
    const coldSize = statSync(cold).size;
    expect(coldSize).toBeGreaterThan(1);

    const removed = pruneJournal(stateDir, {
      now,
      windowStart,
      maxBytes: total - coldSize + 1,
    });

    expect(removed).toEqual([coldName]);
    expect(existsSync(cold)).toBe(false);
    for (const name of inside) expect(existsSync(join(directory, name))).toBe(true);
    expect(existsSync(journal.path)).toBe(true);
    expect(JOURNAL_MAX_BYTES).toBe(1024 * 1024 * 1024);
  });
});
