import { appendFileSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * A deterministic ACP peer for the interface's browser verification and tests.
 *
 * It answers the protocol handshake, streams a little activity, optionally
 * interviews the developer, writes `- Status: Accepted` into the record named
 * in the prompt, and ends the turn.
 */

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const logPath = argument("log");
const delayMs = Number(argument("delay-ms") ?? 0);
const forcedQuestions = argument("questions");
const reviseGoal = process.argv.includes("--revise-goal");
const createGoal = process.argv.includes("--create-goal");
const goalFile = argument("goal");
const resolveRecord = !process.argv.includes("--no-resolve");
const removeRecord = process.argv.includes("--remove-record");
const CREATED_GOAL = "# Created goal\n\nThe agent wrote this.";
const SETTLE_DELAY_MS = 400;

function log(line: string) {
  if (logPath !== undefined) appendFileSync(logPath, `${line}\n`);
}

function write(message: unknown) {
  const line = `${JSON.stringify(message)}\n`;
  process.stdout.write(line);
}

const pending = new Map<string, (result: unknown) => void>();
let nextRequestId = 1;

function request(method: string, params: unknown): Promise<unknown> {
  const id = nextRequestId++;
  const { promise, resolve } = Promise.withResolvers<unknown>();
  pending.set(String(id), resolve);
  write({ jsonrpc: "2.0", id, method, params });
  return promise;
}

function pendingCount(directory: string): number {
  try {
    return readdirSync(directory)
      .filter((file) => file.endsWith(".md"))
      .filter((file) => /^\s*(?:[-*+]\s+)?status\s*:\s*proposed\s*$/im.test(readFileSync(join(directory, file), "utf8")))
      .length;
  } catch {
    return 0;
  }
}

function markAccepted(file: string) {
  const source = readFileSync(file, "utf8");
  const updated = /^\s*(?:[-*+]\s+)?status\s*:\s*proposed\s*$/im.test(source)
    ? source.replace(/^(\s*(?:[-*+]\s+)?status\s*:\s*)proposed\s*$/im, "$1Accepted")
    : `${source.replace(/\s*$/, "")}\n\n- Status: Accepted\n`;
  writeFileSync(file, updated);
}

async function promptTurn(params: Record<string, unknown>) {
  const blocks = Array.isArray(params.prompt) ? params.prompt : [];
  const text = blocks
    .map((block) => {
      if (typeof block !== "object" || block === null || !("text" in block)) return undefined;
      const value = block.text;
      return typeof value === "string" ? value : undefined;
    })
    .find((candidate): candidate is string => typeof candidate === "string");
  const file = typeof text === "string" ? /(?:^|\s)(\S+\.md)(?:\s|$)/.exec(text)?.[1] : undefined;
  const firstLine = text?.split("\n")[0] ?? "";
  const creating = createGoal && firstLine === "/goal-outcome";
  log(`prompt ${firstLine}`);
  if (reviseGoal) log(`request ${text ?? ""}`);

  if (creating) {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "stub-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Creating the goal" },
        },
      },
    });
  } else if (reviseGoal) {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "stub-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Revising the goal" },
        },
      },
    });
  } else if (file === undefined) {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "stub-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Working on ${firstLine}` },
        },
      },
    });
  }

  if (delayMs > 0) await Bun.sleep(delayMs);

  if (file !== undefined && !reviseGoal) {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "stub-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Inspecting ${basename(file)}` },
        },
      },
    });
  }

  const questionCount = creating || reviseGoal
    ? 1
    : forcedQuestions !== undefined
      ? Number(forcedQuestions)
      : file !== undefined && pendingCount(dirname(file)) === 1
        ? 1
        : 0;

  for (let index = 0; index < questionCount; index += 1) {
    const response = await request("elicitation/create", {
      mode: "form",
      sessionId: "stub-session",
      message: index === 0 ? "Choose an answer" : `Choose an answer ${index + 1}`,
      requestedSchema: {
        type: "object",
        properties: {
          value: {
            type: "string",
            title: index === 0 ? "Choose an answer" : `Choose an answer ${index + 1}`,
            enum: ["Alpha", "Beta"],
          },
        },
        required: ["value"],
      },
    });
    const content =
      typeof response === "object" && response !== null && "content" in response
        ? response.content
        : undefined;
    const value =
      typeof content === "object" && content !== null && "value" in content
        ? content.value
        : undefined;
    log(`answer ${String(value ?? "")}`);
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "stub-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Answer received: ${String(value ?? "")}` },
        },
      },
    });
  }

  if (creating) {
    if (goalFile !== undefined) {
      writeFileSync(goalFile, CREATED_GOAL);
      log(`created ${goalFile}`);
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "stub-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Created the goal" },
          },
        },
      });
    }
    return;
  }

  if (reviseGoal) {
    if (goalFile !== undefined) {
      writeFileSync(goalFile, "# Revised goal\n\nThe agent rewrote this.");
      log(`revised ${goalFile}`);
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "stub-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Revised the goal" },
          },
        },
      });
    }
    return;
  }

  if (file !== undefined) {
    await Bun.sleep(SETTLE_DELAY_MS);
    if (removeRecord) {
      unlinkSync(file);
      log(`removed ${file}`);
    } else if (resolveRecord) {
      markAccepted(file);
      log(`resolved ${file}`);
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "stub-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Updated ${basename(file)}` },
          },
        },
      });
    }
  }
}

function handleMessage(message: Record<string, unknown>) {
  if (typeof message.method === "string" && message.id !== undefined) {
    if (message.method === "initialize") {
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "stub-agent", version: "0.1.0" },
        },
      });
    } else if (message.method === "session/new") {
      write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "stub-session" } });
    } else if (message.method === "session/prompt") {
      void promptTurn((message.params ?? {}) as Record<string, unknown>).then(() => {
        write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      });
    } else if (message.method === "session/cancel") {
      // Nothing to do for the stub.
    } else {
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      });
    }
    return;
  }

  if (message.id === undefined) return;
  pending.get(String(message.id))?.(message.result);
  pending.delete(String(message.id));
}

log(`spawn ${process.pid}`);

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) {
      try {
        handleMessage(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Ignore malformed frames.
      }
    }
    newline = buffer.indexOf("\n");
  }
}
