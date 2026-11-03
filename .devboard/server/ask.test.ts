import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Server } from "bun";
import { createApp } from "./app";
import { testProviderService } from "./fixtures/test-providers";
import type { ProviderService } from "./providers";

const temporaryDirectories: string[] = [];
const temporaryRoot = join(import.meta.dir, "..", ".tmp");
const STUB_AGENT = join(import.meta.dir, "fixtures", "stub-agent.ts");

const READ_ONLY = "This conversation is read-only. Never edit files, run mutating commands, file issues, commit, or push.";
const BREVITY = "Answer in at most three short sentences and about 400 characters. No preamble and no restating the question.";
const PLAIN = "Reply in plain text without Markdown.";

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, "ask-"));
  temporaryDirectories.push(directory);
  return directory;
}

interface TestServer {
  server: Server<unknown>;
  root: string;
  url: string;
  logPath: string;
  recordPath: string;
}

interface ServerOptions {
  /** Replaces the stub command entirely; a value that cannot start proves failure. */
  command?: string;
  /** Extra stub arguments after `--ask --log=<path>`. */
  agentArguments?: string[];
  /** Replaces the deterministic provider service, to defer peer preparation. */
  providers?: (stateDir: string) => ProviderService;
  /** Wall-clock bound for one Ask turn; defaults to two minutes. */
  askTurnTimeoutMs?: number;
}

async function startServer(options: ServerOptions = {}): Promise<TestServer> {
  const root = await temporaryDirectory();
  const adrDir = join(root, "adrs");
  const staticDir = join(root, "static");
  const logPath = join(root, "agent.log");
  const recordPath = join(root, "gh-call.json");
  await mkdir(adrDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Ask</title>");

  const command =
    options.command ??
    [`bun ${STUB_AGENT}`, "--ask", `--log=${logPath}`, ...(options.agentArguments ?? [])]
      .filter((part) => part.length > 0)
      .join(" ");

  const server = createApp({
    adrDir,
    staticDir,
    hostname: "127.0.0.1",
    port: 0,
    repoDir: root,
    stateDir: join(root, "state"),
    providers:
      options.providers?.(join(root, "state")) ?? testProviderService(join(root, "state")),
    agentCommand: command,
    askTurnTimeoutMs: options.askTurnTimeoutMs,
    tracker: async () => undefined,
    trackerSettle: { attempts: 1 },
  });
  return { server, root, url: `127.0.0.1:${server.port}`, logPath, recordPath };
}

function askContext(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    route: "/boards/42",
    url: "http://127.0.0.1:8080/boards/42",
    selector: "footer > span.status-item:nth-of-type(2)",
    viewport: "1440x900 @1x",
    captured_at: "2026-10-27T10:00:00.000Z",
    visible_text: "issues working (3)",
    dom_excerpt: "<span class=\"status-item\" title=\"fixture/host\">issues working (3)</span>",
    ...overrides,
  };
}

interface TestClient {
  socket: WebSocket;
  events: Record<string, unknown>[];
  ask(conversationId: string, question: string, context?: Record<string, string>): void;
  closeAsk(conversationId: string): void;
  send(command: unknown): void;
  waitFor(
    predicate: (message: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
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
  }[] = [];

  socket.onopen = () => {
    resolve({
      socket,
      events,
      send(command) {
        socket.send(JSON.stringify(command));
      },
      ask(conversationId, question, context = askContext()) {
        socket.send(JSON.stringify({ type: "ask", conversationId, question, context }));
      },
      closeAsk(conversationId) {
        socket.send(JSON.stringify({ type: "closeAsk", conversationId }));
      },
      waitFor(predicate, timeoutMs = 10_000) {
        const index = buffered.findIndex(predicate);
        if (index >= 0) {
          const message = buffered.splice(index, 1)[0];
          if (message !== undefined) return Promise.resolve(message);
        }
        const { promise: waiting, resolve: settle } =
          Promise.withResolvers<Record<string, unknown>>();
        waiters.push({ predicate, resolve: settle });
        const timer = setTimeout(() => {
          const position = waiters.findIndex((waiter) => waiter.resolve === settle);
          if (position >= 0) waiters.splice(position, 1);
          settle({ type: "timeout" });
        }, timeoutMs);
        void waiting.finally(() => clearTimeout(timer));
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
  return promise;
}

function logLines(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter((line) => line.length > 0);
}

function askLog(logPath: string): {
  spawns: number;
  prompts: string[];
  texts: string[];
  exits: number;
} {
  const lines = logLines(logPath);
  return {
    spawns: lines.filter((line) => line.startsWith("ask-start ")).length,
    prompts: lines
      .filter((line) => line.startsWith("ask-prompt "))
      .map((line) => line.slice("ask-prompt ".length)),
    texts: lines
      .filter((line) => line.startsWith("ask-text "))
      .map((line) => {
        const encoded = line.slice(line.indexOf(" ", "ask-text ".length) + 1);
        return JSON.parse(encoded) as string;
      }),
    exits: lines.filter((line) => line.startsWith("exit ")).length,
  };
}

async function eventually(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(25);
  expect(predicate()).toBe(true);
}

function chunks(client: TestClient, conversationId: string): string {
  return client.events
    .filter((event) => event.type === "askChunk" && event.conversationId === conversationId)
    .map((event) => String(event.text ?? ""))
    .join("");
}

describe("ask conversations", () => {
  test("starts no peer until the first ask, then one peer across two turns", async () => {
    const testServer = await startServer();
    const client = await connect(testServer.url);
    try {
      // Opening the panel is a client-only state; the server sees nothing.
      client.send({ type: "getProject" });
      await client.waitFor((message) => message.type === "project");
      expect(askLog(testServer.logPath).spawns).toBe(0);

      client.ask("conversation-1", "What does the StatusBar issues label mean?");
      const first = await client.waitFor(
        (message) => message.type === "askDone" && message.conversationId === "conversation-1",
      );
      expect(first.type).toBe("askDone");
      const firstAnswer = chunks(client, "conversation-1");
      expect(firstAnswer.startsWith("The issues indicator shows")).toBe(true);
      // Thoughts and tool activity never become answer text.
      expect(firstAnswer.includes("Considering the captured element")).toBe(false);
      expect(firstAnswer.includes("Reading the captured element")).toBe(false);
      expect(
        client.events.filter(
          (event) =>
            event.type === "askChunk" &&
            event.conversationId === "conversation-1" &&
            String(event.text ?? "").length > 0,
        ).length,
      ).toBeGreaterThanOrEqual(2);

      client.ask("conversation-1", "Which file renders it?");
      await client.waitFor(
        (message) => message.type === "askDone" && message.conversationId === "conversation-1",
      );
      const secondAnswer = chunks(client, "conversation-1").slice(firstAnswer.length);
      expect(secondAnswer.includes("StatusBar.svelte")).toBe(true);
      expect(secondAnswer).not.toBe(firstAnswer);

      const logged = askLog(testServer.logPath);
      expect(logged.spawns).toBe(1);
      expect(logged.prompts).toHaveLength(2);
      expect(logged.prompts[0]).toContain("What does the StatusBar issues label mean?");
      expect(logged.prompts[0]).not.toContain("Which file renders it?");

      const context = askContext();
      const [firstPrompt, followUp] = logged.texts;
      expect(firstPrompt).toBeDefined();
      for (const [name, value] of Object.entries(context)) {
        expect(firstPrompt).toContain(`${name}: ${value}`);
      }
      for (const sentence of [READ_ONLY, BREVITY, PLAIN]) {
        expect(firstPrompt).toContain(sentence);
        expect(followUp).toContain(sentence);
      }
      expect(firstPrompt).toContain("Question: What does the StatusBar issues label mean?");
      expect(followUp).toContain("Question: Which file renders it?");
      expect(followUp).not.toContain("Captured element context:");
      expect(existsSync(testServer.recordPath)).toBe(false);
    } finally {
      client.close();
      testServer.server.stop(true);
    }
  });

  test("cancels every permission request and performs no write", async () => {
    const probePath = join(
      import.meta.dir,
      "..",
      ".tmp",
      `ask-permission-${crypto.randomUUID()}.txt`,
    );
    const testServer = await startServer({
      agentArguments: [`--permission-probe=${probePath}`],
    });
    const client = await connect(testServer.url);
    try {
      client.ask("conversation-read-only", "Which file renders the issues label?");
      await client.waitFor(
        (message) =>
          message.type === "askDone" && message.conversationId === "conversation-read-only",
      );

      const lines = logLines(testServer.logPath);
      expect(lines.filter((line) => line === "permission cancelled")).toHaveLength(1);
      expect(lines.some((line) => line.startsWith("permission selected"))).toBe(false);
      expect(existsSync(probePath)).toBe(false);
    } finally {
      client.close();
      testServer.server.stop(true);
      await rm(probePath, { force: true });
    }
  });

  test("refuses a second ask while the first turn is in flight", async () => {
    const testServer = await startServer({ agentArguments: ["--ask-delay-ms=250"] });
    const client = await connect(testServer.url);
    try {
      client.ask("conversation-busy", "What does the status bar show?");
      await client.waitFor(
        (message) => message.type === "askChunk" && message.conversationId === "conversation-busy",
      );
      client.ask("conversation-busy", "And what else?");
      const refused = await client.waitFor(
        (message) =>
          message.type === "askError" && message.conversationId === "conversation-busy",
      );
      expect(String(refused.message)).toContain("still answering");
      await client.waitFor(
        (message) => message.type === "askDone" && message.conversationId === "conversation-busy",
      );
      const logged = askLog(testServer.logPath);
      expect(logged.spawns).toBe(1);
      expect(logged.prompts).toHaveLength(1);
    } finally {
      client.close();
      testServer.server.stop(true);
    }
  });

  test("times out a stalled turn and accepts the next ask on a fresh peer", async () => {
    // The deadline also covers the peer's own start-up, so it is far above the
    // spawn and handshake this fixture needs on a loaded runner while still far
    // below the suite's own bound.
    const turnTimeoutMs = 3_000;
    const testServer = await startServer({
      agentArguments: ["--ask-stall"],
      askTurnTimeoutMs: turnTimeoutMs,
    });
    const client = await connect(testServer.url);
    try {
      client.ask("conversation-timeout", "What does the issues label mean?");
      // The peer accepted the prompt and produced no answer.
      await eventually(() => logLines(testServer.logPath).includes("ask-stall"));

      const timedOut = await client.waitFor(
        (message) =>
          message.type === "askError" && message.conversationId === "conversation-timeout",
      );
      expect(String(timedOut.message)).toContain("did not answer within 3 seconds");

      // The deadline kills the peer, so its pending turn cannot complete; one
      // socket delivers in order, so the reply to this command proves every
      // frame produced before the peer died has already arrived.
      const mark = client.events.length;
      await eventually(() => askLog(testServer.logPath).exits === 1);
      client.send({ type: "getProject" });
      await client.waitFor((message) => message.type === "project");
      expect(
        client.events
          .slice(mark)
          .filter((event) => event.conversationId === "conversation-timeout"),
      ).toEqual([]);

      // The conversation is idle and its peer gone: the next ask is accepted
      // and reaches a freshly constructed peer rather than the wedged one.
      client.ask("conversation-timeout", "Which file renders it?");
      await client.waitFor(
        (message) =>
          message.type === "askDone" && message.conversationId === "conversation-timeout",
      );
      const refusal = client.events.find(
        (event) =>
          event.type === "askError" &&
          event.conversationId === "conversation-timeout" &&
          String(event.message).includes("still answering"),
      );
      expect(refusal).toBeUndefined();
      const logged = askLog(testServer.logPath);
      expect(logged.spawns).toBe(2);
      expect(logged.prompts).toHaveLength(2);
      expect(logged.texts[1]).toContain("Earlier in this conversation:");
      expect(logged.texts[1]).toContain("Question: Which file renders it?");
      expect(chunks(client, "conversation-timeout").includes("The issues indicator shows")).toBe(
        true,
      );
    } finally {
      client.close();
      testServer.server.stop(true);
    }
  }, 60_000);

  test("clears the turn deadline when the ask settles", async () => {
    const turnTimeoutMs = 424_242;
    const outstanding = new Set<Timer>();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = ((
      handler: Parameters<typeof setTimeout>[0],
      timeout?: number,
      ...args: unknown[]
    ) => {
      const handle = realSetTimeout(handler, timeout, ...args);
      if (timeout === turnTimeoutMs) outstanding.add(handle);
      return handle;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle?: Timer) => {
      if (handle !== undefined) outstanding.delete(handle);
      return realClearTimeout(handle);
    }) as typeof clearTimeout;
    try {
      for (const command of [undefined, "devboard-ask-missing-agent"]) {
        const testServer = await startServer({ command, askTurnTimeoutMs: turnTimeoutMs });
        const client = await connect(testServer.url);
        try {
          client.ask("conversation-deadline", "What does the issues label mean?");
          await client.waitFor(
            (message) =>
              (message.type === "askDone" || message.type === "askError") &&
              message.conversationId === "conversation-deadline",
          );
          expect(outstanding.size).toBe(0);
        } finally {
          client.close();
          testServer.server.stop(true);
        }
      }
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  test("refuses empty, oversized, and incomplete asks without starting a peer", async () => {
    const testServer = await startServer();
    const client = await connect(testServer.url);
    try {
      client.ask("conversation-bad", "   ");
      await client.waitFor(
        (message) =>
          message.type === "askError" && message.conversationId === "conversation-bad",
      );
      client.ask("conversation-bad", "x".repeat(4001));
      const oversized = await client.waitFor(
        (message) =>
          message.type === "askError" && message.conversationId === "conversation-bad",
      );
      expect(String(oversized.message)).toContain("4000");

      client.socket.send(
        JSON.stringify({
          type: "ask",
          conversationId: "conversation-bad",
          question: "Why?",
          context: { route: "/" },
        }),
      );
      const incomplete = await client.waitFor(
        (message) =>
          message.type === "askError" && message.conversationId === "conversation-bad",
      );
      expect(String(incomplete.message).toLowerCase()).toContain("context");

      const bounded = askContext({ visible_text: "y".repeat(1501) });
      client.ask("conversation-bad", "Why?", bounded);
      await client.waitFor(
        (message) =>
          message.type === "askError" && message.conversationId === "conversation-bad",
      );

      expect(askLog(testServer.logPath).spawns).toBe(0);
      expect(existsSync(testServer.logPath)).toBe(false);
    } finally {
      client.close();
      testServer.server.stop(true);
    }
  });

  test("isolates conversations per socket and streams to the asker only", async () => {
    const testServer = await startServer({ agentArguments: ["--ask-delay-ms=60"] });
    const first = await connect(testServer.url);
    const second = await connect(testServer.url);
    try {
      first.ask("conversation-first", "What does the issues label mean?");
      second.ask("conversation-second", "Which file renders it?");
      await first.waitFor(
        (message) => message.type === "askDone" && message.conversationId === "conversation-first",
      );
      await second.waitFor(
        (message) => message.type === "askDone" && message.conversationId === "conversation-second",
      );
      expect(
        first.events.every((event) => event.conversationId !== "conversation-second"),
      ).toBe(true);
      expect(
        second.events.every((event) => event.conversationId !== "conversation-first"),
      ).toBe(true);
      expect(askLog(testServer.logPath).spawns).toBe(2);
      expect(askLog(testServer.logPath).prompts).toHaveLength(2);
    } finally {
      first.close();
      second.close();
      testServer.server.stop(true);
    }
  });

  test("drops events after a close and kills the peer", async () => {
    const testServer = await startServer({ agentArguments: ["--ask-delay-ms=300"] });
    const client = await connect(testServer.url);
    try {
      client.ask("conversation-closed", "What does the issues label mean?");
      await client.waitFor(
        (message) =>
          message.type === "askChunk" && message.conversationId === "conversation-closed",
      );
      const mark = client.events.length;
      client.closeAsk("conversation-closed");
      await eventually(() => askLog(testServer.logPath).exits === 1);
      // One socket delivers in order: the reply to this command proves every
      // frame produced before the peer died has already arrived.
      client.send({ type: "getProject" });
      await client.waitFor((message) => message.type === "project");
      const after = client.events.slice(mark);
      expect(
        after.every((event) => event.conversationId !== "conversation-closed"),
      ).toBe(true);

      // A fresh conversation starts clean: no replayed turns from the closed one.
      client.ask("conversation-fresh", "Which file renders it?");
      await client.waitFor(
        (message) =>
          message.type === "askDone" && message.conversationId === "conversation-fresh",
      );
      const prompts = askLog(testServer.logPath).prompts;
      expect(prompts).toHaveLength(2);
      expect(askLog(testServer.logPath).texts[1]).not.toContain("Earlier in this conversation:");
      expect(askLog(testServer.logPath).spawns).toBe(2);
    } finally {
      client.close();
      testServer.server.stop(true);
    }
  });

  test("closing a conversation during provider selection spawns no peer", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const selected = Promise.withResolvers<void>();
    let hold = false;
    const testServer = await startServer({
      providers: (stateDir) => {
        const providers = testProviderService(stateDir);
        const select = providers.select.bind(providers);
        providers.select = async () => {
          if (hold) {
            hold = false;
            entered.resolve();
            await release.promise;
          }
          const result = await select();
          selected.resolve();
          return result;
        };
        return providers;
      },
    });
    const client = await connect(testServer.url);
    try {
      hold = true;
      client.ask("conversation-closed-early", "What does the issues label mean?");
      await entered.promise;
      client.closeAsk("conversation-closed-early");
      // One socket delivers in order: the reply proves the close was handled
      // before the environment resolves.
      client.send({ type: "getProject" });
      await client.waitFor((message) => message.type === "project");
      release.resolve();
      // `selected` resolves before the held ask's continuation is queued; one
      // more turn of the microtask queue lets that continuation finish.
      await selected.promise;
      await Promise.resolve();
      expect(askLog(testServer.logPath).spawns).toBe(0);
      expect(askLog(testServer.logPath).prompts).toHaveLength(0);

      // The controller remains usable: a later ask spawns exactly one peer.
      client.ask("conversation-fresh", "Which file renders it?");
      await client.waitFor(
        (message) =>
          message.type === "askDone" && message.conversationId === "conversation-fresh",
      );
      expect(askLog(testServer.logPath).spawns).toBe(1);
    } finally {
      client.close();
      testServer.server.stop(true);
    }
  });

  test("server stop during provider selection leaves no peer", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const selected = Promise.withResolvers<void>();
    let hold = false;
    const testServer = await startServer({
      providers: (stateDir) => {
        const providers = testProviderService(stateDir);
        const select = providers.select.bind(providers);
        providers.select = async () => {
          if (hold) {
            hold = false;
            entered.resolve();
            await release.promise;
          }
          const result = await select();
          selected.resolve();
          return result;
        };
        return providers;
      },
    });
    const client = await connect(testServer.url);
    try {
      hold = true;
      client.ask("conversation-disposed-early", "What does the issues label mean?");
      await entered.promise;
      testServer.server.stop(true);
      release.resolve();
      await selected.promise;
      await Promise.resolve();
      expect(askLog(testServer.logPath).spawns).toBe(0);
      expect(askLog(testServer.logPath).prompts).toHaveLength(0);
    } finally {
      client.close();
      testServer.server.stop(true);
    }
  });

  test("closes every peer of a socket that disconnects", async () => {
    const testServer = await startServer({ agentArguments: ["--ask-delay-ms=300"] });
    const client = await connect(testServer.url);
    client.ask("conversation-socket", "What does the issues label mean?");
    await client.waitFor(
      (message) =>
        message.type === "askChunk" && message.conversationId === "conversation-socket",
    );
    client.close();
    await eventually(() => askLog(testServer.logPath).exits === 1);
    testServer.server.stop(true);
  });

  test("reports a start failure and accepts a later ask", async () => {
    const testServer = await startServer({ command: "devboard-ask-missing-agent" });
    const client = await connect(testServer.url);
    try {
      client.ask("conversation-missing", "What does the issues label mean?");
      const failed = await client.waitFor(
        (message) =>
          message.type === "askError" && message.conversationId === "conversation-missing",
      );
      expect(String(failed.message).length).toBeGreaterThan(0);
      // The conversation is idle again, so the next ask is not a busy refusal.
      client.ask("conversation-missing", "Try again?");
      const retried = await client.waitFor(
        (message) =>
          message.type === "askError" && message.conversationId === "conversation-missing",
      );
      expect(String(retried.message)).not.toContain("still answering");
      expect(existsSync(testServer.recordPath)).toBe(false);
    } finally {
      client.close();
      testServer.server.stop(true);
    }
  });

  test("recovers from an exited peer with the visible conversation", async () => {
    const testServer = await startServer({ agentArguments: ["--ask-exit"] });
    const client = await connect(testServer.url);
    try {
      client.ask("conversation-exit", "What does the issues label mean?");
      await client.waitFor(
        (message) =>
          message.type === "askError" && message.conversationId === "conversation-exit",
      );
      client.ask("conversation-exit", "Which file renders it?");
      await client.waitFor(
        (message) => message.type === "askDone" && message.conversationId === "conversation-exit",
      );
      const logged = askLog(testServer.logPath);
      expect(logged.spawns).toBe(2);
      expect(logged.texts[1]).toContain("Earlier in this conversation:");
      expect(logged.texts[1]).toContain("Developer: What does the issues label mean?");
      const answer = chunks(client, "conversation-exit");
      expect(answer.includes("The issues indicator shows")).toBe(true);
      expect(answer.includes("Considering the captured element")).toBe(false);
    } finally {
      client.close();
      testServer.server.stop(true);
    }
  });

  test("recovers from an alive peer that refuses the handshake", async () => {
    for (const mode of ["--ask-refuse-initialize", "--ask-no-session"]) {
      const testServer = await startServer({ agentArguments: [mode] });
      const client = await connect(testServer.url);
      try {
        client.ask("conversation-handshake", "What does the issues label mean?");
        const failed = await client.waitFor(
          (message) =>
            message.type === "askError" &&
            message.conversationId === "conversation-handshake",
        );
        expect(String(failed.message).length).toBeGreaterThan(0);

        // The process is still alive, but the peer has no session; the next ask
        // must start a new peer and replay the conversation instead of taking
        // the follow-up path of the sessionless one.
        client.ask("conversation-handshake", "Which file renders it?");
        await client.waitFor(
          (message) =>
            message.type === "askDone" && message.conversationId === "conversation-handshake",
        );
        const logged = askLog(testServer.logPath);
        expect(logged.spawns).toBe(2);
        expect(logged.prompts).toHaveLength(1);
        expect(logged.texts[0]).toContain("Earlier in this conversation:");
        expect(logged.texts[0]).toContain("Developer: What does the issues label mean?");
        expect(logged.texts[0]).toContain("Question: Which file renders it?");
        const answer = chunks(client, "conversation-handshake");
        expect(answer.includes("The issues indicator shows")).toBe(true);
      } finally {
        client.close();
        testServer.server.stop(true);
      }
    }
  }, 20_000);

  test("recovers from a rejected prompt and keeps the conversation", async () => {
    const testServer = await startServer({ agentArguments: ["--ask-fail"] });
    const client = await connect(testServer.url);
    try {
      client.ask("conversation-fail", "What does the issues label mean?");
      const failed = await client.waitFor(
        (message) =>
          message.type === "askError" && message.conversationId === "conversation-fail",
      );
      expect(String(failed.message)).toContain("The ask agent failed.");
      client.ask("conversation-fail", "Which file renders it?");
      await client.waitFor(
        (message) => message.type === "askDone" && message.conversationId === "conversation-fail",
      );
      const logged = askLog(testServer.logPath);
      // The peer survived the rejection, so the second turn reused it.
      expect(logged.spawns).toBe(1);
      expect(logged.prompts).toHaveLength(2);
      expect(logged.texts[1]).not.toContain("Captured element context:");
      expect(existsSync(testServer.recordPath)).toBe(false);
    } finally {
      client.close();
      testServer.server.stop(true);
    }
  });

  test("server stop closes every live peer", async () => {
    const testServer = await startServer({ agentArguments: ["--ask-delay-ms=400"] });
    const client = await connect(testServer.url);
    client.ask("conversation-stop", "What does the issues label mean?");
    await client.waitFor(
      (message) =>
        message.type === "askChunk" && message.conversationId === "conversation-stop",
    );
    testServer.server.stop(true);
    await eventually(() => askLog(testServer.logPath).exits === 1);
    expect(existsSync(testServer.recordPath)).toBe(false);
  });
});
