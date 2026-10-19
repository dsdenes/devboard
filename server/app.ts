import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { ServerWebSocket } from "bun";
import { AcpConnection, agentPrompt, type AcpQuestion } from "./acp";
import { defaultGoalPath, readGoal, writeGoal } from "./goal";
import { parseRecord, readRecords, type AdrRecord } from "./records";
import { findOpenEpic, type EpicLookup } from "./tracker";

export interface AppOptions {
  adrDir: string;
  staticDir: string;
  hostname: string;
  port: number;
  repoDir?: string;
  goalFile?: string;
  agentCommand?: string;
  tracker?: EpicLookup;
}

interface RunQuestion {
  id: number | string;
  message: string;
  choices: string[];
}

interface ActiveRun {
  file: string;
  title: string;
  agent: AcpConnection | undefined;
  activity: string[];
  question: RunQuestion | null;
}

type LifecycleStage = "goal" | "epic" | "adr" | "implementation" | "finished";

interface LifecycleWork {
  kind: "adr" | "epic";
  id: string;
}

interface LifecycleState {
  stage: LifecycleStage;
  pass: number;
  work: LifecycleWork | null;
}

const EPIC_PROMPT = "/epic-next";
const IMPLEMENT_PROMPT = "/implement-next-epic";

type ClientMessage =
  | { type: "listRecords" }
  | { type: "getGoal" }
  | { type: "saveGoal"; text?: unknown }
  | { type: "startRun"; file?: unknown }
  | { type: "startLifecycle" }
  | { type: "answer"; id?: unknown; value?: unknown };

function parseClientMessage(value: unknown): ClientMessage | undefined {
  if (typeof value !== "object" || value === null || !("type" in value)) return undefined;
  switch (value.type) {
    case "listRecords":
      return { type: "listRecords" };
    case "getGoal":
      return { type: "getGoal" };
    case "saveGoal":
      return { type: "saveGoal", text: "text" in value ? value.text : undefined };
    case "startRun":
      return { type: "startRun", file: "file" in value ? value.file : undefined };
    case "startLifecycle":
      return { type: "startLifecycle" };
    case "answer":
      return {
        type: "answer",
        id: "id" in value ? value.id : undefined,
        value: "value" in value ? value.value : undefined,
      };
    default:
      return undefined;
  }
}

export function createApp(options: AppOptions) {
  const staticRoot = resolve(options.staticDir);
  const adrDir = resolve(options.adrDir);
  const repoDir = options.repoDir ?? dirname(adrDir);
  const goalFile = options.goalFile ?? defaultGoalPath(repoDir);
  const agentCommand = options.agentCommand ?? process.env.AGENT_COMMAND ?? "omp acp";
  const tracker = options.tracker ?? findOpenEpic;

  const clients = new Set<ServerWebSocket<unknown>>();
  let activeRun: ActiveRun | undefined;
  let sequencing = false;
  let lifecycle: LifecycleState = { stage: "goal", pass: 1, work: null };
  let lifecycleRunning = false;

  function send(ws: { send(data: string): unknown }, event: unknown) {
    try {
      ws.send(JSON.stringify(event));
    } catch {
      // The socket closed between accepting the message and sending the reply.
    }
  }

  function broadcast(event: unknown) {
    const payload = JSON.stringify(event);
    for (const client of clients) {
      try {
        client.send(payload);
      } catch {
        // A closing client must not interrupt delivery to the others.
      }
    }
  }

  async function readRecord(file: string): Promise<AdrRecord | undefined> {
    try {
      return parseRecord(file, await readFile(join(adrDir, file), "utf8"));
    } catch {
      return undefined;
    }
  }

  async function getGoal(ws: { send(data: string): unknown }) {
    try {
      send(ws, { type: "goal", text: await readGoal(goalFile) });
    } catch (error) {
      send(ws, {
        type: "error",
        message: `Could not read the goal: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  async function saveGoal(ws: { send(data: string): unknown }, text: unknown) {
    if (lifecycleRunning) {
      send(ws, { type: "error", message: "A lifecycle run is active." });
      return;
    }

    if (typeof text !== "string") {
      send(ws, { type: "error", message: "saveGoal needs the goal text." });
      return;
    }

    try {
      await writeGoal(goalFile, text);
      send(ws, { type: "goal", text });
    } catch (error) {
      send(ws, {
        type: "error",
        message: `Could not save the goal: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  async function runAgent(
    run: ActiveRun,
    prompt = agentPrompt(adrDir, run.file),
  ): Promise<boolean> {
    try {
      const agent = new AcpConnection({
        command: agentCommand,
        cwd: repoDir,
        onActivity(text) {
          if (activeRun !== run) return;
          run.activity.push(text);
          broadcast({ type: "activity", text });
        },
        onQuestion(question: AcpQuestion) {
          if (activeRun !== run) return;
          run.question = {
            id: question.id,
            message: question.message,
            choices: question.choices,
          };
          broadcast({
            type: "question",
            id: question.id,
            message: question.message,
            choices: question.choices,
          });
        },
        onStderr(text) {
          process.stderr.write(text);
        },
      });
      run.agent = agent;

      await agent.run(prompt);
      const record = await readRecord(run.file);
      return await stopRun(run, record !== undefined && !record.pending, record?.status ?? "");
    } catch (error) {
      if (activeRun !== run) return false;
      broadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      const record = await readRecord(run.file);
      return await stopRun(run, record !== undefined && !record.pending, record?.status ?? "");
    }
  }

  async function stopRun(run: ActiveRun, resolved: boolean, status: string): Promise<boolean> {
    if (activeRun !== run) return false;
    activeRun = undefined;
    run.question = null;
    run.agent?.close();

    broadcast({
      type: "runStopped",
      file: run.file,
      title: run.title,
      resolved,
      status,
    });

    try {
      const list = await readRecords(adrDir);
      broadcast({ type: "records", ...list });
    } catch (error) {
      broadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    return resolved;
  }

  async function startRun(ws: { send(data: string): unknown }, file: unknown) {
    if (lifecycleRunning) {
      send(ws, { type: "error", message: "A lifecycle run is active." });
      return;
    }

    if (activeRun !== undefined || sequencing) {
      send(ws, { type: "error", message: "A run is already active." });
      return;
    }

    sequencing = true;
    let selected = typeof file === "string" ? file : undefined;
    let first = true;

    try {
      while (sequencing) {
        const list = await readRecords(adrDir);
        let record: AdrRecord | undefined;

        if (selected !== undefined) {
          record = list.records.find(
            (candidate) => candidate.file === selected && candidate.pending,
          );
          selected = undefined;
          if (record === undefined) {
            send(ws, { type: "error", message: "That ADR is not pending." });
            return;
          }
        } else {
          record = list.records.find((candidate) => candidate.file === list.next);
          if (record === undefined) {
            if (first) send(ws, { type: "error", message: "No pending ADRs to start." });
            return;
          }
        }

        first = false;
        const run: ActiveRun = {
          file: record.file,
          title: record.title,
          agent: undefined,
          activity: [],
          question: null,
        };
        activeRun = run;
        broadcast({ type: "runStarted", file: run.file, title: run.title });

        const resolved = await runAgent(run);
        if (!resolved) return;
      }
    } catch (error) {
      send(ws, {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      sequencing = false;
    }
  }

  function setLifecycle(stage: LifecycleStage, work: LifecycleWork | null) {
    lifecycle = { stage, pass: lifecycle.pass, work };
    broadcast({ type: "lifecycleState", ...lifecycle });
  }

  async function runLifecycleStage(file: string, title: string, prompt: string) {
    const run: ActiveRun = {
      file,
      title,
      agent: undefined,
      activity: [],
      question: null,
    };
    activeRun = run;
    broadcast({ type: "runStarted", file: run.file, title: run.title });
    await runAgent(run, prompt);
  }

  async function runLifecycle() {
    let previousPending: string | undefined;

    while (lifecycleRunning) {
      const existing = await tracker(repoDir);
      if (!lifecycleRunning) return;
      if (existing !== undefined) {
        const id = String(existing.number);
        setLifecycle("implementation", { kind: "epic", id });
        await runLifecycleStage("", existing.title, IMPLEMENT_PROMPT);
        if (!lifecycleRunning) return;

        const remaining = await tracker(repoDir);
        if (!lifecycleRunning) return;
        if (remaining !== undefined && String(remaining.number) === id) {
          broadcast({
            type: "error",
            message: `Implementation ended but epic #${id} is still open.`,
          });
          return;
        }

        lifecycle = { stage: "epic", pass: lifecycle.pass + 1, work: null };
        continue;
      }

      setLifecycle("epic", null);
      await runLifecycleStage("", "Epic generation", EPIC_PROMPT);
      if (!lifecycleRunning) return;

      const created = await tracker(repoDir);
      if (!lifecycleRunning) return;
      if (created !== undefined) continue;

      const list = await readRecords(adrDir);
      if (!lifecycleRunning) return;
      const pending = list.records.filter((record) => record.pending).map((record) => record.file);

      if (pending.length === 0) {
        broadcast({
          type: "error",
          message: "Epic generation ended without an open epic or a pending ADR.",
        });
        return;
      }

      const signature = pending.join("\n");
      if (signature === previousPending) {
        broadcast({
          type: "error",
          message: "Epic generation left the same ADRs pending without opening an epic.",
        });
        return;
      }
      previousPending = signature;

      for (const file of pending) {
        if (!lifecycleRunning) return;
        const record = await readRecord(file);
        if (record === undefined || !record.pending) continue;

        setLifecycle("adr", { kind: "adr", id: record.file });
        await runLifecycleStage(record.file, record.title, agentPrompt(adrDir, record.file));
        if (!lifecycleRunning) return;
      }
    }
  }

  async function startLifecycle(ws: { send(data: string): unknown }) {
    if (lifecycleRunning) {
      send(ws, { type: "error", message: "A lifecycle run is already active." });
      return;
    }

    if (activeRun !== undefined || sequencing) {
      send(ws, { type: "error", message: "A run is already active." });
      return;
    }

    lifecycleRunning = true;
    try {
      await runLifecycle();
    } catch (error) {
      broadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      lifecycleRunning = false;
    }
  }

  function answerQuestion(
    ws: { send(data: string): unknown },
    id: unknown,
    value: unknown,
  ) {
    if (activeRun === undefined) {
      send(ws, { type: "error", message: "No run is active." });
      return;
    }

    if (
      id === undefined ||
      (typeof id !== "string" && typeof id !== "number") ||
      typeof value !== "string" ||
      value.trim().length === 0
    ) {
      send(ws, {
        type: "error",
        message: "An answer needs the question id and a non-empty value.",
      });
      return;
    }

    const run = activeRun;
    if (run.question === null || String(run.question.id) !== String(id)) {
      send(ws, { type: "error", message: "No pending question with that id." });
      return;
    }

    if (run.agent === undefined || !run.agent.answer(run.question.id, value)) {
      send(ws, { type: "error", message: "The question is no longer pending." });
      return;
    }

    run.question = null;
  }

  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,

    async fetch(request, server) {
      const url = new URL(request.url);

      if (url.pathname === "/ws") {
        if (server.upgrade(request)) return;
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD" },
        });
      }

      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const filePath = resolve(staticRoot, relative);
      if (filePath !== staticRoot && !filePath.startsWith(staticRoot + sep)) {
        return new Response("Not Found", { status: 404 });
      }

      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        return new Response("Not Found", { status: 404 });
      }

      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        return new Response("Not Found", { status: 404 });
      }

      return new Response(request.method === "HEAD" ? null : file, {
        headers: { "Content-Type": file.type },
      });
    },

    websocket: {
      open(ws) {
        clients.add(ws);
        if (lifecycleRunning) send(ws, { type: "lifecycleState", ...lifecycle });
        if (activeRun === undefined) return;

        const run = activeRun;
        send(ws, { type: "runStarted", file: run.file, title: run.title });
        for (const text of run.activity) send(ws, { type: "activity", text });
        if (run.question !== null) {
          send(ws, {
            type: "question",
            id: run.question.id,
            message: run.question.message,
            choices: run.question.choices,
          });
        }
      },

      close(ws) {
        clients.delete(ws);
      },

      async message(ws, message) {
        let command: ClientMessage | undefined;
        try {
          command = parseClientMessage(JSON.parse(String(message)));
        } catch {
          command = undefined;
        }
        if (command === undefined) {
          send(ws, { type: "error", message: "Invalid WebSocket message." });
          return;
        }

        try {
          if (command.type === "listRecords") {
            const list = await readRecords(adrDir);
            send(ws, { type: "records", ...list });
          } else if (command.type === "getGoal") {
            await getGoal(ws);
          } else if (command.type === "saveGoal") {
            await saveGoal(ws, command.text);
          } else if (command.type === "startRun") {
            await startRun(ws, command.file);
          } else if (command.type === "startLifecycle") {
            await startLifecycle(ws);
          } else if (command.type === "answer") {
            answerQuestion(ws, command.id, command.value);
          }
        } catch (error) {
          send(ws, {
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
  });

  const stop = server.stop.bind(server);
  server.stop = (closeActiveConnections?: boolean) => {
    sequencing = false;
    lifecycleRunning = false;
    activeRun?.agent?.close();
    activeRun = undefined;
    return stop(closeActiveConnections);
  };

  return server;
}
