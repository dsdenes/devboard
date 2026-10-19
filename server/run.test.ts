import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { createApp } from "./app";

const temporaryDirectories: string[] = [];
const STUB_AGENT = join(import.meta.dir, "fixtures", "stub-agent.ts");

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

async function startServer(files: Record<string, string>, agentArguments = ""): Promise<TestServer> {
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
    agentCommand: `bun ${STUB_AGENT} --log=${logPath} ${agentArguments}`.trim(),
  });

  return { server, adrDir, logPath, url: `127.0.0.1:${server.port}` };
}

interface TestClient {
  socket: WebSocket;
  send(command: unknown): void;
  waitFor(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  close(): void;
}

function connect(url: string): Promise<TestClient> {
  const { promise, resolve, reject } = Promise.withResolvers<TestClient>();
  const socket = new WebSocket(`ws://${url}/ws`);
  const buffered: Record<string, unknown>[] = [];
  const waiters: {
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }[] = [];

  socket.onopen = () => {
    resolve({
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

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const PENDING_ONE = "# First decision\n\n- Status: Proposed\n\n## Context\n\nFirst.\n\n## Decision\n\n";
const PENDING_TWO = "# Second decision\n\n- Status: Proposed\n\n## Context\n\nSecond.\n\n## Decision\n\n";

describe("agent runs", () => {
  test(
    "starts the lowest pending ADR by default, relays activity, and refreshes records on stop",
    async () => {
      const { server, adrDir, logPath, url } = await startServer(
        { "0001-first.md": PENDING_ONE, "0002-second.md": PENDING_TWO },
        "--questions=0",
      );
      const client = await connect(url);

      try {
        client.send({ type: "listRecords" });
        expect(await client.waitFor((message) => message.type === "records")).toMatchObject({
          next: "0001-first.md",
        });

        client.send({ type: "startRun" });
        expect(await client.waitFor((message) => message.type === "runStarted")).toMatchObject({
          file: "0001-first.md",
          title: "First decision",
        });
        expect(await client.waitFor((message) => message.type === "activity")).toMatchObject({
          text: "Inspecting 0001-first.md",
        });
        expect(await waitForStop(client)).toMatchObject({
          file: "0001-first.md",
          resolved: true,
          status: "Accepted",
        });
        expect(await client.waitFor((message) => message.type === "records")).toMatchObject({
          next: "0002-second.md",
        });

        expect(await readFile(join(adrDir, "0001-first.md"), "utf8")).toContain(
          "- Status: Accepted",
        );

        client.send({ type: "startRun" });
        expect(await client.waitFor((message) => message.type === "runStarted")).toMatchObject({
          file: "0002-second.md",
          title: "Second decision",
        });
        expect(await waitForStop(client)).toMatchObject({ resolved: true });
        expect(spawnCount(logPath)).toBe(2);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "starts a selected non-next pending ADR and leaves the earlier one pending",
    async () => {
      const { server, adrDir, logPath, url } = await startServer(
        { "0001-first.md": PENDING_ONE, "0002-second.md": PENDING_TWO },
        "--questions=0",
      );
      const client = await connect(url);

      try {
        client.send({ type: "startRun", file: "0002-second.md" });
        expect(await client.waitFor((message) => message.type === "runStarted")).toMatchObject({
          file: "0002-second.md",
          title: "Second decision",
        });
        expect(await waitForStop(client)).toMatchObject({ file: "0002-second.md", resolved: true });

        expect(await readFile(join(adrDir, "0002-second.md"), "utf8")).toContain(
          "- Status: Accepted",
        );
        expect(await readFile(join(adrDir, "0001-first.md"), "utf8")).toContain(
          "- Status: Proposed",
        );
        expect(spawnCount(logPath)).toBe(1);

        const refreshed = await client.waitFor((message) => message.type === "records");
        expect(refreshed).toMatchObject({
          next: "0001-first.md",
          records: [
            { file: "0001-first.md", pending: true },
            { file: "0002-second.md", pending: false },
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
    "refuses a second start while a run is active and spawns one process",
    async () => {
      const { server, logPath, url } = await startServer(
        { "0001-first.md": PENDING_ONE },
        "--questions=0 --delay-ms=400",
      );
      const client = await connect(url);

      try {
        client.send({ type: "startRun" });
        await client.waitFor((message) => message.type === "runStarted");
        await client.waitFor((message) => message.type === "activity");

        client.send({ type: "startRun" });
        expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
          message: "A run is already active.",
        });
        expect(await waitForStop(client)).toMatchObject({ resolved: true });
        expect(spawnCount(logPath)).toBe(1);
        expect(
          readFileSync(logPath, "utf8")
            .split("\n")
            .filter((line) => line.startsWith("prompt ")).length,
        ).toBe(1);
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
          choices: ["Alpha", "Beta"],
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
          choices: ["Alpha", "Beta"],
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
    "stops without resolving when the agent turn ends unchanged",
    async () => {
      const { server, adrDir, url } = await startServer(
        { "0001-first.md": PENDING_ONE },
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
        expect(await readFile(join(adrDir, "0001-first.md"), "utf8")).toContain(
          "- Status: Proposed",
        );
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "refuses to start when no ADR is pending and spawns no process",
    async () => {
      const { server, logPath, url } = await startServer({
        "0001-first.md": "# First decision\n\n- Status: Accepted\n",
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
        "0001-first.md": "# First decision\n\n- Status: Accepted\n",
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
