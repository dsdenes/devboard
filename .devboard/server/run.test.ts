import { fixtureRecord, frontmatterStatus, pendingRecord } from "./fixtures/adr-source";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { createApp } from "./app";

const temporaryDirectories: string[] = [];
const STUB_AGENT = join(import.meta.dir, "fixtures", "stub-agent.ts");
const QUESTION_OPTIONS = [
  { label: "Alpha", description: "Alpha leads to the first outcome.", recommended: true },
  { label: "Beta", description: "Beta leads to the second outcome.", recommended: false },
];

interface TestServer {
  server: Server<unknown>;
  adrDir: string;
  logPath: string;
  url: string;
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "devboard-run-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function startServer(
  files: Record<string, string>,
  agentArguments = "",
  options: { restart?: () => void } = {},
): Promise<TestServer> {
  const root = await temporaryDirectory();
  const adrDir = join(root, "adrs");
  const staticDir = join(root, "static");
  await mkdir(adrDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await Bun.write(join(adrDir, ".keep"), "");
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>ADR overview</title>");
  for (const [file, source] of Object.entries(files)) {
    await writeFile(join(adrDir, file), source);
  }

  const logPath = join(root, "agent.log");
  const server = createApp({
    adrDir,
    staticDir,
    hostname: "127.0.0.1",
    port: 0,
    repoDir: root,
    stateDir: join(root, "state"),
    agentCommand: `bun ${STUB_AGENT} --log=${logPath} ${agentArguments}`.trim(),
    restart: options.restart,
  });

  return { server, adrDir, logPath, url: `127.0.0.1:${server.port}` };
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

function spawnCount(logPath: string): number {
  if (!existsSync(logPath)) return 0;
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("spawn ")).length;
}

async function waitForStop(client: TestClient) {
  return await client.waitFor((message) => message.type === "runStopped");
}

function runSequence(client: TestClient): string[] {
  return client.events
    .filter(
      (message) =>
        message.type === "runStarted" ||
        message.type === "runStopped" ||
        message.type === "records",
    )
    .map((message) =>
      message.type === "records"
        ? `records:${String(message.next)}`
        : `${String(message.type)}:${String(message.file)}:${String(message.resolved ?? "")}`,
    );
}

function starts(client: TestClient): unknown[] {
  return client.events.filter((message) => message.type === "runStarted").map((message) => message.file);
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const PENDING_ONE = pendingRecord("0001-first.md", "First decision", "First.", "Choose the first.");
const PENDING_TWO = pendingRecord("0002-second.md", "Second decision", "Second.", "Choose the second.");
const PENDING_THREE = pendingRecord("0003-third.md", "Third decision", "Third.", "Choose the third.");

describe("agent runs", () => {
  test(
    "resolves every pending ADR in file-name order from one start",
    async () => {
      const { server, adrDir, logPath, url } = await startServer(
        {
          "0001-first.md": PENDING_ONE,
          "0002-second.md": PENDING_TWO,
          "0003-third.md": PENDING_THREE,
        },
        "--questions=0",
      );
      const client = await connect(url);

      try {
        client.send({ type: "startRun" });
        expect(
          await client.waitFor(
            (message) => message.type === "records" && message.next === null,
          ),
        ).toMatchObject({
          next: null,
          records: [
            { file: "0001-first.md", pending: false },
            { file: "0002-second.md", pending: false },
            { file: "0003-third.md", pending: false },
          ],
        });

        expect(runSequence(client)).toEqual([
          "runStarted:0001-first.md:",
          "runStopped:0001-first.md:true",
          "records:0002-second.md",
          "runStarted:0002-second.md:",
          "runStopped:0002-second.md:true",
          "records:0003-third.md",
          "runStarted:0003-third.md:",
          "runStopped:0003-third.md:true",
          "records:null",
        ]);

        expect(
          client.events
            .filter((message) => message.type === "runStopped")
            .map((message) => message.status),
        ).toEqual(["Accepted", "Accepted", "Accepted"]);
        expect(
          client.events
            .filter((message) => message.type === "activity")
            .map((message) => message.text),
        ).toEqual([
          "Inspecting 0001-first.md",
          "Updated 0001-first.md",
          "Inspecting 0002-second.md",
          "Updated 0002-second.md",
          "Inspecting 0003-third.md",
          "Updated 0003-third.md",
        ]);
        expect(spawnCount(logPath)).toBe(3);

        for (const file of ["0001-first.md", "0002-second.md", "0003-third.md"]) {
          expect(frontmatterStatus(await readFile(join(adrDir, file), "utf8"))).toBe("accepted");
        }
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "defers an idle restart until the active run ends",
    async () => {
      let restarts = 0;
      const { server, url } = await startServer(
        { "0001-first.md": PENDING_ONE },
        "--delay-ms=800 --questions=0",
        { restart: () => (restarts += 1) },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startRun", file: "0001-first.md" });
        await client.waitFor((message) => message.type === "runStarted");

        client.send({ type: "restartServer", whenIdle: true });
        expect(await client.waitFor((message) => message.type === "upgradePending")).toEqual({
          type: "upgradePending",
        });
        expect(restarts).toBe(0);

        await client.waitFor(
          (message) => message.type === "runStopped" && message.resolved === true,
        );
        expect(await client.waitFor((message) => message.type === "serverRestarting")).toEqual({
          type: "serverRestarting",
        });
        expect(restarts).toBe(1);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "starts the selected ADR, then the lowest remaining pending records",
    async () => {
      const { server, logPath, url } = await startServer(
        {
          "0001-first.md": PENDING_ONE,
          "0002-second.md": PENDING_TWO,
          "0003-third.md": PENDING_THREE,
        },
        "--questions=0",
      );
      const client = await connect(url);

      try {
        client.send({ type: "startRun", file: "0002-second.md" });
        expect(
          await client.waitFor(
            (message) => message.type === "records" && message.next === null,
          ),
        ).toMatchObject({ next: null });

        expect(starts(client)).toEqual([
          "0002-second.md",
          "0001-first.md",
          "0003-third.md",
        ]);
        expect(spawnCount(logPath)).toBe(3);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "refuses a second start during a run and between runs, spawning one process per record",
    async () => {
      const { server, logPath, url } = await startServer(
        {
          "0001-first.md": PENDING_ONE,
          "0002-second.md": PENDING_TWO,
          "0003-third.md": PENDING_THREE,
        },
        "--questions=0",
      );
      const client = await connect(url);

      try {
        client.send({ type: "startRun" });
        await client.waitFor(
          (message) => message.type === "runStarted" && message.file === "0001-first.md",
        );

        client.send({ type: "startRun" });
        expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
          message: "A run is already active.",
        });

        expect(await waitForStop(client)).toMatchObject({
          file: "0001-first.md",
          resolved: true,
        });

        client.send({ type: "startRun" });
        expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
          message: "A run is already active.",
        });

        expect(
          await client.waitFor(
            (message) => message.type === "records" && message.next === null,
          ),
        ).toMatchObject({ next: null });

        expect(
          client.events
            .filter((message) => message.type === "error")
            .map((message) => message.message),
        ).toEqual(["A run is already active.", "A run is already active."]);
        expect(starts(client)).toEqual([
          "0001-first.md",
          "0002-second.md",
          "0003-third.md",
        ]);
        expect(spawnCount(logPath)).toBe(3);
        expect(
          readFileSync(logPath, "utf8")
            .split("\n")
            .filter((line) => line.startsWith("prompt ")).length,
        ).toBe(3);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "relays each question and sends exactly one answer per elicitation",
    async () => {
      const { server, logPath, url } = await startServer(
        { "0001-first.md": PENDING_ONE },
        "--questions=2",
      );
      const client = await connect(url);

      try {
        client.send({ type: "startRun" });
        await client.waitFor((message) => message.type === "runStarted");

        const first = await client.waitFor((message) => message.type === "question");
        expect(first).toMatchObject({
          message: "Choose an answer",
          options: QUESTION_OPTIONS,
        });

        client.send({ type: "answer", id: first.id, value: "Gamma" });
        client.send({ type: "answer", id: first.id, value: "Gamma" });

        expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
          message: "No pending question with that id.",
        });
        await client.waitFor(
          (message) => message.type === "activity" && message.text === "Answer received: Gamma",
        );

        const second = await client.waitFor((message) => message.type === "question");
        expect(second).toMatchObject({
          message: "Choose an answer 2",
          options: QUESTION_OPTIONS,
        });

        client.send({ type: "answer", id: second.id, value: "Beta" });
        await client.waitFor(
          (message) => message.type === "activity" && message.text === "Answer received: Beta",
        );
        expect(await waitForStop(client)).toMatchObject({ resolved: true });

        const answers = readFileSync(logPath, "utf8")
          .split("\n")
          .filter((line) => line.startsWith("answer "));
        expect(answers).toEqual(["answer Gamma", "answer Beta"]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "recommends the first option when the elicitation omits a default",
    async () => {
      const { server, url } = await startServer(
        { "0001-first.md": PENDING_ONE },
        "--questions=1 --questions-unrecommended",
      );
      const client = await connect(url);

      try {
        client.send({ type: "startRun" });
        await client.waitFor((message) => message.type === "runStarted");

        const question = await client.waitFor((message) => message.type === "question");
        expect(question).toMatchObject({
          message: "Choose an answer",
          options: [
            { label: "Alpha", recommended: true },
            { label: "Beta", recommended: false },
          ],
        });
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "ends the sequence without starting another record when the agent turn does not resolve",
    async () => {
      const { server, adrDir, logPath, url } = await startServer(
        { "0001-first.md": PENDING_ONE, "0002-second.md": PENDING_TWO },
        "--questions=0 --no-resolve",
      );
      const client = await connect(url);

      try {
        client.send({ type: "startRun" });
        await client.waitFor((message) => message.type === "runStarted");
        expect(await waitForStop(client)).toMatchObject({
          file: "0001-first.md",
          resolved: false,
          status: "Proposed",
        });

        const refreshed = await client.waitFor((message) => message.type === "records");
        expect(refreshed).toMatchObject({ next: "0001-first.md" });

        // Integration test: the sequence outcome is observable only as the
        // absence of another runStarted from the real server subprocess.
        await Bun.sleep(300);
        expect(starts(client)).toEqual(["0001-first.md"]);
        expect(spawnCount(logPath)).toBe(1);
        expect(frontmatterStatus(await readFile(join(adrDir, "0001-first.md"), "utf8"))).toBe("proposed");
        expect(frontmatterStatus(await readFile(join(adrDir, "0002-second.md"), "utf8"))).toBe("proposed");
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "ends the sequence when the active record file is removed during its run",
    async () => {
      const { server, adrDir, logPath, url } = await startServer(
        { "0001-first.md": PENDING_ONE, "0002-second.md": PENDING_TWO },
        "--questions=0 --remove-record",
      );
      const client = await connect(url);

      try {
        client.send({ type: "startRun" });
        await client.waitFor((message) => message.type === "runStarted");
        expect(await waitForStop(client)).toMatchObject({
          file: "0001-first.md",
          resolved: false,
        });

        expect(await client.waitFor((message) => message.type === "records")).toMatchObject({
          next: "0002-second.md",
        });

        // Integration test: the sequence outcome is observable only as the
        // absence of another runStarted from the real server subprocess.
        await Bun.sleep(300);
        expect(starts(client)).toEqual(["0001-first.md"]);
        expect(spawnCount(logPath)).toBe(1);
        expect(existsSync(join(adrDir, "0001-first.md"))).toBe(false);
        expect(frontmatterStatus(await readFile(join(adrDir, "0002-second.md"), "utf8"))).toBe("proposed");
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "keeps resolving after the only client disconnects",
    async () => {
      const { server, adrDir, logPath, url } = await startServer(
        {
          "0001-first.md": PENDING_ONE,
          "0002-second.md": PENDING_TWO,
          "0003-third.md": PENDING_THREE,
        },
        "--questions=0",
      );
      const client = await connect(url);
      const files = ["0001-first.md", "0002-second.md", "0003-third.md"];

      try {
        client.send({ type: "startRun" });
        await client.waitFor((message) => message.type === "runStarted");
        client.close();

        const deadline = Date.now() + 15000;
        let statuses: string[] = [];
        while (Date.now() < deadline) {
          statuses = await Promise.all(
            files.map((file) => readFile(join(adrDir, file), "utf8")),
          );
          if (statuses.every((source) => frontmatterStatus(source) === "accepted")) break;
          await Bun.sleep(100);
        }

        expect(statuses.every((source) => frontmatterStatus(source) === "accepted")).toBe(true);
        expect(spawnCount(logPath)).toBe(3);
      } finally {
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "refuses to start when no ADR is pending and spawns no process",
    async () => {
      const { server, logPath, url } = await startServer({
        "0001-first.md": fixtureRecord("0001-first.md", "First decision"),
      });
      const client = await connect(url);

      try {
        client.send({ type: "startRun" });
        const error = await client.waitFor((message) => message.type === "error");
        expect(error).toMatchObject({ message: "No pending ADRs to start." });
        expect(spawnCount(logPath)).toBe(0);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "refuses an explicitly selected ADR that is not pending",
    async () => {
      const { server, logPath, url } = await startServer({
        "0001-first.md": fixtureRecord("0001-first.md", "First decision"),
      });
      const client = await connect(url);

      try {
        client.send({ type: "startRun", file: "0001-first.md" });
        expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
          message: "That ADR is not pending.",
        });
        expect(spawnCount(logPath)).toBe(0);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );
});
