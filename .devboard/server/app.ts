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

interface GoalRevision {
  agent: AcpConnection | undefined;
  activity: string[];
  question: RunQuestion | null;
}

interface GoalCreation {
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
  paused: boolean;
}

const EPIC_PROMPT = "/epic-next";
const IMPLEMENT_PROMPT = "/implement-next-epic";
const GOAL_CREATION_PROMPT = "/goal-outcome";

function goalRevisionPrompt(goalFile: string, request: string | undefined): string {
  const guidance = request?.trim();
  return [
    `Revise the goal in ${goalFile}.`,
    "Ask the developer any questions you need, one at a time.",
    "When the revision is complete, write the complete revised goal text to that file and end the turn.",
    ...(guidance === undefined || guidance.length === 0 ? [] : ["", `Guidance: ${guidance}`]),
  ].join("\n");
}

type ClientMessage =
  | { type: "listRecords" }
  | { type: "getGoal" }
  | { type: "saveGoal"; text?: unknown }
  | { type: "startRun"; file?: unknown }
  | { type: "startLifecycle" }
  | { type: "pauseLifecycle" }
  | { type: "resumeLifecycle" }
  | { type: "reviseGoal"; request?: unknown }
  | { type: "createGoal" }
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
    case "pauseLifecycle":
      return { type: "pauseLifecycle" };
    case "resumeLifecycle":
      return { type: "resumeLifecycle" };
    case "reviseGoal":
      return { type: "reviseGoal", request: "request" in value ? value.request : undefined };
    case "createGoal":
      return { type: "createGoal" };
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
  // The creation skill always writes the repository's goal document, while
  // getGoal and saveGoal keep using the configured goal file.
  const creationGoalFile = defaultGoalPath(repoDir);
  const agentCommand = options.agentCommand ?? process.env.AGENT_COMMAND ?? "omp acp";
  const tracker = options.tracker ?? findOpenEpic;

  const clients = new Set<ServerWebSocket<unknown>>();
  let activeRun: ActiveRun | undefined;
  let sequencing = false;
  let goalRevision: GoalRevision | undefined;
  let goalCreation: GoalCreation | undefined;
  let goalCreationPending = false;
  let lifecycle: LifecycleState = { stage: "goal", pass: 1, work: null, paused: false };
  let lastLifecycle: LifecycleState | undefined;
  let lifecycleRunning = false;
  const resumeWaiters: (() => void)[] = [];

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

  function sendRunConversation(target: { send(data: string): unknown }, run: ActiveRun) {
    send(target, { type: "runStarted", file: run.file, title: run.title });
    for (const text of run.activity) send(target, { type: "activity", text });
    if (run.question !== null) {
      send(target, {
        type: "question",
        id: run.question.id,
        message: run.question.message,
        choices: run.question.choices,
      });
    }
  }

  /** Restores the suspended lifecycle conversation after a revision ends. */
  function broadcastRunConversation() {
    if (activeRun === undefined) return;
    for (const client of clients) sendRunConversation(client, activeRun);
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
      // An absent goal document is an unset goal, so the section reports
      // `Goal not set` and offers the creation control instead of an error.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        send(ws, { type: "goal", text: "" });
        return;
      }
      send(ws, {
        type: "error",
        message: `Could not read the goal: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  async function saveGoal(ws: { send(data: string): unknown }, text: unknown) {
    if (lifecycleRunning && !lifecycle.paused) {
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

  async function stopGoalRevision(revision: GoalRevision, succeeded: boolean) {
    if (goalRevision !== revision) return;
    goalRevision = undefined;
    revision.question = null;
    revision.agent?.close();

    if (!succeeded) {
      broadcast({ type: "goalRevisionStopped", completed: false });
      broadcastRunConversation();
      return;
    }

    try {
      const text = await readGoal(goalFile);
      broadcast({ type: "goalRevisionStopped", completed: true, text });
      broadcastRunConversation();
    } catch (error) {
      broadcast({
        type: "error",
        message: `Could not read the revised goal: ${error instanceof Error ? error.message : String(error)}`,
      });
      broadcast({ type: "goalRevisionStopped", completed: false });
      broadcastRunConversation();
    }
  }

  async function stopGoalCreation(creation: GoalCreation, succeeded: boolean) {
    if (goalCreation !== creation) return;
    goalCreation = undefined;
    creation.question = null;
    creation.agent?.close();

    if (!succeeded) {
      broadcast({ type: "goalCreationStopped", completed: false });
      broadcastRunConversation();
      return;
    }

    let text: string;
    try {
      text = await readFile(creationGoalFile, "utf8");
    } catch (error) {
      broadcast({
        type: "error",
        message: `Could not read the created goal: ${error instanceof Error ? error.message : String(error)}`,
      });
      broadcast({ type: "goalCreationStopped", completed: false });
      broadcastRunConversation();
      return;
    }

    if (text.trim().length === 0) {
      broadcast({
        type: "error",
        message: "The goal creation ended without a non-empty goal.",
      });
      broadcast({ type: "goalCreationStopped", completed: false });
      broadcastRunConversation();
      return;
    }

    broadcast({ type: "goalCreationStopped", completed: true, text });
    broadcastRunConversation();
  }

  async function startGoalCreation(ws: { send(data: string): unknown }) {
    if (goalCreation !== undefined || goalCreationPending) {
      send(ws, { type: "error", message: "A goal creation is already active." });
      return;
    }

    if (goalRevision !== undefined) {
      send(ws, { type: "error", message: "A goal revision is active." });
      return;
    }

    if (lifecycleRunning && !lifecycle.paused) {
      send(ws, { type: "error", message: "A lifecycle run is active." });
      return;
    }

    // A paused lifecycle keeps its suspended peer in activeRun; only a run that
    // the creation would contend with refuses the start.
    if (!(lifecycleRunning && lifecycle.paused) && (activeRun !== undefined || sequencing)) {
      send(ws, { type: "error", message: "A run is already active." });
      return;
    }

    goalCreationPending = true;
    let existing: string | undefined;
    try {
      existing = await readFile(creationGoalFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        goalCreationPending = false;
        send(ws, {
          type: "error",
          message: `Could not read the goal: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
    }
    goalCreationPending = false;

    if (existing !== undefined && existing.trim().length > 0) {
      send(ws, { type: "error", message: "The goal is already set." });
      return;
    }

    const creation: GoalCreation = { agent: undefined, activity: [], question: null };
    goalCreation = creation;
    broadcast({ type: "goalCreationStarted" });

    try {
      const agent = new AcpConnection({
        command: agentCommand,
        cwd: repoDir,
        onActivity(text) {
          if (goalCreation !== creation) return;
          creation.activity.push(text);
          broadcast({ type: "activity", text });
        },
        onQuestion(question: AcpQuestion) {
          if (goalCreation !== creation) return;
          creation.question = {
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
      creation.agent = agent;

      await agent.run(GOAL_CREATION_PROMPT);
      if (goalCreation !== creation) return;
      await stopGoalCreation(creation, true);
    } catch (error) {
      if (goalCreation !== creation) return;
      broadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      await stopGoalCreation(creation, false);
    }
  }

  async function startGoalRevision(ws: { send(data: string): unknown }, request: unknown) {
    if (goalCreation !== undefined) {
      send(ws, { type: "error", message: "A goal creation is active." });
      return;
    }

    if (lifecycleRunning && !lifecycle.paused) {
      send(ws, { type: "error", message: "A lifecycle run is active." });
      return;
    }

    if (goalRevision !== undefined) {
      send(ws, { type: "error", message: "A goal revision is already active." });
      return;
    }

    // A paused lifecycle keeps its suspended peer in activeRun; only a run that
    // the revision would contend with refuses the start.
    if (!(lifecycleRunning && lifecycle.paused) && (activeRun !== undefined || sequencing)) {
      send(ws, { type: "error", message: "A run is already active." });
      return;
    }

    if (request !== undefined && typeof request !== "string") {
      send(ws, { type: "error", message: "reviseGoal needs the guidance text." });
      return;
    }

    const revision: GoalRevision = { agent: undefined, activity: [], question: null };
    goalRevision = revision;
    broadcast({ type: "goalRevisionStarted" });

    try {
      const agent = new AcpConnection({
        command: agentCommand,
        cwd: repoDir,
        onActivity(text) {
          if (goalRevision !== revision) return;
          revision.activity.push(text);
          broadcast({ type: "activity", text });
        },
        onQuestion(question: AcpQuestion) {
          if (goalRevision !== revision) return;
          revision.question = {
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
      revision.agent = agent;

      await agent.run(
        goalRevisionPrompt(goalFile, typeof request === "string" ? request : undefined),
      );
      if (goalRevision !== revision) return;
      await stopGoalRevision(revision, true);
    } catch (error) {
      if (goalRevision !== revision) return;
      broadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      await stopGoalRevision(revision, false);
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
    if (goalCreation !== undefined) {
      send(ws, { type: "error", message: "A goal creation is active." });
      return;
    }

    if (lifecycleRunning) {
      send(ws, { type: "error", message: "A lifecycle run is active." });
      return;
    }

    if (goalRevision !== undefined) {
      send(ws, { type: "error", message: "A goal revision is active." });
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

  /** Broadcasts the current state and retains it for clients that connect later. */
  function publishLifecycle() {
    lastLifecycle = lifecycle;
    broadcast({ type: "lifecycleState", ...lifecycle });
  }

  function setLifecycle(stage: LifecycleStage, work: LifecycleWork | null) {
    lifecycle = { stage, pass: lifecycle.pass, work, paused: false };
    publishLifecycle();
  }

  /** Holds the lifecycle loop at the current stage until an explicit resume. */
  async function holdWhilePaused() {
    while (lifecycleRunning && lifecycle.paused) {
      await new Promise<void>((resolve) => resumeWaiters.push(resolve));
    }
  }

  function pauseLifecycle(ws: { send(data: string): unknown }) {
    if (!lifecycleRunning) {
      send(ws, { type: "error", message: "No lifecycle run is active." });
      return;
    }

    if (lifecycle.paused) {
      send(ws, { type: "error", message: "The lifecycle run is already paused." });
      return;
    }

    activeRun?.agent?.pause();
    lifecycle = { ...lifecycle, paused: true };
    publishLifecycle();
  }

  function resumeLifecycle(ws: { send(data: string): unknown }) {
    if (goalCreation !== undefined) {
      send(ws, { type: "error", message: "A goal creation is active." });
      return;
    }

    if (!lifecycleRunning) {
      send(ws, { type: "error", message: "No lifecycle run is active." });
      return;
    }

    if (goalRevision !== undefined) {
      send(ws, { type: "error", message: "A goal revision is active." });
      return;
    }

    if (!lifecycle.paused) {
      send(ws, { type: "error", message: "The lifecycle run is not paused." });
      return;
    }

    lifecycle = { ...lifecycle, paused: false };
    publishLifecycle();
    activeRun?.agent?.resume();
    for (const resolve of resumeWaiters.splice(0)) resolve();
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

  /** Returns true only when the pass produced no epic and no pending ADR. */
  async function runLifecycle(): Promise<boolean> {
    let previousPending: string | undefined;

    while (lifecycleRunning) {
      await holdWhilePaused();
      if (!lifecycleRunning) return false;

      const existing = await tracker(repoDir);
      await holdWhilePaused();
      if (!lifecycleRunning) return false;
      if (existing !== undefined) {
        const id = String(existing.number);
        setLifecycle("implementation", { kind: "epic", id });
        await runLifecycleStage("", existing.title, IMPLEMENT_PROMPT);
        await holdWhilePaused();
        if (!lifecycleRunning) return false;

        const remaining = await tracker(repoDir);
        await holdWhilePaused();
        if (!lifecycleRunning) return false;
        if (remaining !== undefined && String(remaining.number) === id) {
          broadcast({
            type: "error",
            message: `Implementation ended but epic #${id} is still open.`,
          });
          return false;
        }

        lifecycle = { stage: "epic", pass: lifecycle.pass + 1, work: null, paused: false };
        publishLifecycle();
        continue;
      }

      if (lifecycle.stage !== "epic" || lifecycle.work !== null) {
        setLifecycle("epic", null);
      }
      await runLifecycleStage("", "Epic generation", EPIC_PROMPT);
      await holdWhilePaused();
      if (!lifecycleRunning) return false;

      const created = await tracker(repoDir);
      await holdWhilePaused();
      if (!lifecycleRunning) return false;
      if (created !== undefined) continue;

      const list = await readRecords(adrDir);
      await holdWhilePaused();
      if (!lifecycleRunning) return false;
      const pending = list.records.filter((record) => record.pending).map((record) => record.file);

      if (pending.length === 0) {
        await holdWhilePaused();
        if (!lifecycleRunning) return false;
        setLifecycle("finished", null);
        return true;
      }

      const signature = pending.join("\n");
      if (signature === previousPending) {
        broadcast({
          type: "error",
          message: "Epic generation left the same ADRs pending without opening an epic.",
        });
        return false;
      }
      previousPending = signature;

      for (const file of pending) {
        await holdWhilePaused();
        if (!lifecycleRunning) return false;
        const record = await readRecord(file);
        await holdWhilePaused();
        if (!lifecycleRunning) return false;
        if (record === undefined || !record.pending) continue;

        setLifecycle("adr", { kind: "adr", id: record.file });
        await runLifecycleStage(record.file, record.title, agentPrompt(adrDir, record.file));
        await holdWhilePaused();
        if (!lifecycleRunning) return false;
      }
    }

    return false;
  }

  async function startLifecycle(ws: { send(data: string): unknown }) {
    if (goalCreation !== undefined) {
      send(ws, { type: "error", message: "A goal creation is active." });
      return;
    }

    if (lifecycleRunning) {
      send(ws, { type: "error", message: "A lifecycle run is already active." });
      return;
    }

    if (goalRevision !== undefined) {
      send(ws, { type: "error", message: "A goal revision is active." });
      return;
    }

    if (activeRun !== undefined || sequencing) {
      send(ws, { type: "error", message: "A run is already active." });
      return;
    }

    let goalSettled = false;
    try {
      goalSettled = (await readGoal(goalFile)).trim().length > 0;
    } catch {
      // A missing or unreadable goal document is not settled.
    }
    if (!goalSettled) {
      send(ws, {
        type: "error",
        message: "The goal is not set. Save a non-empty goal before starting the lifecycle.",
      });
      return;
    }

    lifecycleRunning = true;
    // Report the run as active before the first tracker lookup: clients need the
    // stage to disable their start controls and offer pause while the lookup runs.
    lifecycle = { stage: "epic", pass: lifecycle.pass, work: null, paused: false };
    publishLifecycle();
    let finished = false;
    try {
      finished = await runLifecycle();
    } catch (error) {
      broadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      const wasPaused = lifecycle.paused;
      lifecycleRunning = false;
      lifecycle = { ...lifecycle, paused: false };
      for (const resolve of resumeWaiters.splice(0)) resolve();
      if (finished) {
        if (wasPaused) publishLifecycle();
      } else {
        // An aborted run leaves no work behind: report the idle goal stage,
        // retain the pass already reached, and make the run available again.
        lifecycle = { stage: "goal", pass: lifecycle.pass, work: null, paused: false };
        publishLifecycle();
      }
    }
  }

  function answerQuestion(
    ws: { send(data: string): unknown },
    id: unknown,
    value: unknown,
  ) {
    const active = goalCreation ?? goalRevision ?? activeRun;
    if (active === undefined) {
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

    if (active.question === null || String(active.question.id) !== String(id)) {
      send(ws, { type: "error", message: "No pending question with that id." });
      return;
    }

    if (active.agent === undefined || !active.agent.answer(active.question.id, value)) {
      send(ws, { type: "error", message: "The question is no longer pending." });
      return;
    }

    active.question = null;
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
        const replayed = lifecycleRunning ? lifecycle : lastLifecycle;
        if (replayed !== undefined) send(ws, { type: "lifecycleState", ...replayed });
        if (activeRun !== undefined) sendRunConversation(ws, activeRun);

        const creation = goalCreation;
        if (creation !== undefined) {
          send(ws, { type: "goalCreationStarted" });
          for (const text of creation.activity) send(ws, { type: "activity", text });
          if (creation.question !== null) {
            send(ws, {
              type: "question",
              id: creation.question.id,
              message: creation.question.message,
              choices: creation.question.choices,
            });
          }
        }

        const revision = goalRevision;
        if (revision === undefined) return;

        send(ws, { type: "goalRevisionStarted" });
        for (const text of revision.activity) send(ws, { type: "activity", text });
        if (revision.question !== null) {
          send(ws, {
            type: "question",
            id: revision.question.id,
            message: revision.question.message,
            choices: revision.question.choices,
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
          } else if (command.type === "pauseLifecycle") {
            pauseLifecycle(ws);
          } else if (command.type === "resumeLifecycle") {
            resumeLifecycle(ws);
          } else if (command.type === "reviseGoal") {
            await startGoalRevision(ws, command.request);
          } else if (command.type === "createGoal") {
            await startGoalCreation(ws);
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
    goalRevision?.agent?.close();
    goalRevision = undefined;
    goalCreation?.agent?.close();
    goalCreation = undefined;
    goalCreationPending = false;
    return stop(closeActiveConnections);
  };

  return server;
}
