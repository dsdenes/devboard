import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
const createGoalWrite = !process.argv.includes("--no-create-goal-write");
const goalFile = argument("goal");
const prepareSkills = process.argv.includes("--prepare-skills");
const prepareSkillsInvalid = process.argv.includes("--prepare-skills-invalid");
const prepareSkillsEmpty = process.argv.includes("--prepare-skills-empty");
const prepareSkillsConflict = process.argv.includes("--prepare-skills-conflict");
const prepareSkillsCollision = process.argv.includes("--prepare-skills-collision");
const prepareSkillsError = process.argv.includes("--prepare-skills-error");
const collisionName = argument("collision-name") ?? "custom-skill";
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

function writeSkill(
  name: string,
  description: string,
  body: string,
  header = `name: ${name}\ndescription: ${description}`,
) {
  const directory = join(process.cwd(), ".omp", "skills", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "SKILL.md"),
    `---\n${header}\nmetadata:\n  devboard-managed: "true"\n---\n\n${body}\n`,
  );
  log(`skill ${name}`);
}

function writePreparedSkills() {
  if (prepareSkillsEmpty) return;

  writeSkill(
    "dependency-direction",
    "Choose dependency direction and boundary ownership for any layered design.",
    "# Dependency direction\n\n- Always declare dependencies in one direction.\n- Keep policy separate from delivery and storage concerns.\n",
  );
  writeSkill(
    "cohesive-units",
    "Organize units of code so each owns one cohesive responsibility.",
    "# Cohesive units\n\n- Prefer small units with one responsibility.\n- Keep each public interface narrow and explicit.\n",
  );
  writeSkill(
    "behavior-first-testing",
    "Verify observable behavior with focused automated tests.",
    "# Behavior-first testing\n\n- Test observable behavior at the public boundary.\n- Prefer focused tests that fail for one reason.\n",
  );

  if (prepareSkillsConflict) {
    writeSkill(
      "dependency-direction",
      "Choose dependency direction and boundary ownership for any layered design.",
      "# Dependency direction\n\n- Always use dependency injection.\n- Keep policy separate from delivery and storage concerns.\n",
    );
  }

  if (prepareSkillsCollision) {
    writeSkill(
      collisionName,
      "A generated skill placed at an unmanaged skill's name.",
      "# Generated skill\n\n- Keep one writer for every installed skill.\n",
    );
  }

  if (prepareSkillsInvalid) {
    writeSkill(
      "invalid-skill",
      "",
      "# Invalid skill\n\n- Missing a description.\n",
      "name: Invalid Name\ndescription:",
    );
  }
}

async function askQuestions(count: number) {
  for (let index = 0; index < count; index += 1) {
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
            oneOf: [
              { const: "Alpha", title: "Alpha", description: "Alpha leads to the first outcome." },
              { const: "Beta", title: "Beta", description: "Beta leads to the second outcome." },
            ],
            default: "Alpha",
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
  const revising = reviseGoal && firstLine.startsWith("Revise the goal");
  log(`prompt ${firstLine}`);
  if (revising) log(`request ${text ?? ""}`);

  if (prepareSkills && firstLine === "/prepare-skills") {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "stub-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Researching public standards, architecture patterns, and testing practice",
          },
        },
      },
    });

    if (delayMs > 0) await Bun.sleep(delayMs);
    await askQuestions(forcedQuestions !== undefined ? Number(forcedQuestions) : 0);

    if (prepareSkillsError) process.exit(1);

    writePreparedSkills();
    log("prepared");
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "stub-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Reviewed every installed skill; no contradictions" },
        },
      },
    });
    return;
  }

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
  } else if (revising) {
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

  if (file !== undefined && !revising) {
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

  const questionCount = creating || revising
    ? 1
    : forcedQuestions !== undefined
      ? Number(forcedQuestions)
      : file !== undefined && pendingCount(dirname(file)) === 1
        ? 1
        : 0;

  await askQuestions(questionCount);

  if (creating) {
    if (goalFile !== undefined && createGoalWrite) {
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

  if (revising) {
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
