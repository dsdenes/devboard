import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

function argumentAll(name: string): string[] {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .filter((value) => value.startsWith(prefix))
    .map((value) => value.slice(prefix.length));
}

/** Parses repeated `--mode=<id>:<value>` arguments into an id-keyed map. */
function idOptions(name: string): Map<string, string> {
  const options = new Map<string, string>();
  for (const entry of argumentAll(name)) {
    const split = entry.indexOf(":");
    if (split < 0) continue;
    options.set(entry.slice(0, split), entry.slice(split + 1));
  }
  return options;
}

/** Deterministic per-epic timing and one-line activity overrides. */
const laneDelays = idOptions("lane-delay");
const laneActivities = idOptions("lane-activity");
const blockerEpics = new Set(argumentAll("blocker-epic"));
const questionEpics = new Set(argumentAll("question-epic"));
/** JSON list of open epics the verification server's tracker reads. */
const fixtureTracker = argument("fixture-tracker");
/** Repository whose branches and `main` a fixture lane merges into. */
const fixtureRepo = argument("fixture-repo");
const noClose = process.argv.includes("--no-close");
const generatedEpics = argumentAll("generate-epic");
const generationBudget = Number(argument("generation-budget") ?? generatedEpics.length);
const laneDelayMs = Number(argument("lane-delay-ms") ?? 0);
const laneSettleMs = Number(argument("lane-settle-ms") ?? 0);
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
const busyContinuations = Number(argument("busy-continuations") ?? 0);
let busyRemaining = busyContinuations;
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

interface FixtureEpic {
  number: number;
  title: string;
  url: string;
}

function readFixtureTracker(path: string): FixtureEpic[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is FixtureEpic =>
        typeof entry === "object" &&
        entry !== null &&
        "number" in entry &&
        typeof entry.number === "number",
    );
  } catch {
    return [];
  }
}

function writeFixtureTracker(path: string, list: FixtureEpic[]) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(list, null, 2)}\n`);
  renameSync(temporary, path);
}

/** Serializes the stub's own tracker and merge writes across lane processes. */
function withLock<T>(lockPath: string, action: () => T): T {
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - started > 10_000) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return action();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function closeFixtureEpic(id: string) {
  if (fixtureTracker === undefined) return;
  withLock(`${fixtureTracker}.lock`, () => {
    writeFixtureTracker(
      fixtureTracker,
      readFixtureTracker(fixtureTracker).filter((epic) => String(epic.number) !== id),
    );
  });
  log(`closed ${id}`);
}

function fileFixtureEpic(entry: string): boolean {
  if (fixtureTracker === undefined) return false;
  const split = entry.indexOf(":");
  if (split < 0) return false;
  const number = Number(entry.slice(0, split));
  const title = entry.slice(split + 1);
  if (!Number.isInteger(number)) return false;

  let filed = false;
  withLock(`${fixtureTracker}.lock`, () => {
    const counterPath = `${fixtureTracker}.generation-count`;
    let count = 0;
    try {
      count = Number(readFileSync(counterPath, "utf8").trim());
    } catch {
      count = 0;
    }
    if (Number.isFinite(count) && count >= generationBudget) return;
    const list = readFixtureTracker(fixtureTracker);
    if (list.some((epic) => epic.number === number)) return;
    list.push({ number, title, url: `https://fixture.test/issues/${number}` });
    writeFixtureTracker(fixtureTracker, list);
    writeFileSync(counterPath, `${count + 1}\n`);
    filed = true;
  });
  if (filed) log(`filed ${number}`);
  return filed;
}

function gitTeardown(repo: string, args: string[]): { code: number; stderr: string } {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", repo, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode ?? -1, stderr: result.stderr.toString() };
}

/** Simulates the peer's own merge: branch, sentinel commit, merge, cleanup. */
function mergeFixtureLane(id: string) {
  if (fixtureRepo === undefined) return;
  const worktree = join(fixtureRepo, ".worktree", `stub-epic-${id}`);
  const branch = `devboard/stub-epic-${id}`;
  mkdirSync(join(fixtureRepo, ".worktree"), { recursive: true });
  gitTeardown(fixtureRepo, ["worktree", "remove", "--force", worktree]);
  gitTeardown(fixtureRepo, ["branch", "-D", branch]);
  const added = gitTeardown(fixtureRepo, ["worktree", "add", worktree, "-b", branch, "main"]);
  if (added.code !== 0) {
    log(`merge-failed ${id} worktree ${added.stderr.trim()}`);
    return;
  }
  writeFileSync(join(worktree, `epic-${id}.txt`), `epic ${id}\n`);
  gitTeardown(worktree, ["add", "-A"]);
  gitTeardown(worktree, ["commit", "-m", `feat: epic ${id}`]);

  withLock(join(fixtureRepo, ".git", "stub-merge.lock"), () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const merged = gitTeardown(fixtureRepo, [
        "merge",
        "--no-ff",
        branch,
        "-m",
        `merge epic ${id}`,
      ]);
      if (merged.code === 0) {
        log(`merged ${id}`);
        const pushed = gitTeardown(fixtureRepo, ["push", "origin", "main"]);
        if (pushed.code === 0) log(`pushed ${id}`);
        else log(`push-failed ${id}`);
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    log(`merge-failed ${id}`);
  });

  gitTeardown(fixtureRepo, ["worktree", "remove", "--force", worktree]);
  gitTeardown(fixtureRepo, ["branch", "-D", branch]);
}

function implementationEpic(text: string): string | undefined {
  const match = /^\/implement-next-epic(?:\s+(\d+))?/.exec(text);
  if (match === null) return undefined;
  if (match[1] !== undefined) return match[1];
  const open = fixtureTracker === undefined ? [] : readFixtureTracker(fixtureTracker);
  return open.length === 1 && open[0] !== undefined ? String(open[0].number) : undefined;
}

async function runImplementationLane(id: string) {
  const activity = laneActivities.get(id) ?? `Working on epic ${id}`;
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "stub-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: activity },
      },
    },
  });

  const override = laneDelays.get(id);
  const delay = override !== undefined ? Number(override) : laneDelayMs > 0 ? laneDelayMs : delayMs;
  if (Number.isFinite(delay) && delay > 0) await Bun.sleep(delay);

  const questionCount = questionEpics.has(id)
    ? 1
    : forcedQuestions !== undefined
      ? Number(forcedQuestions)
      : 0;
  if (questionCount > 0) {
    await askQuestions(questionCount);
  }

  if (blockerEpics.has(id)) {
    const message = `DEVBOARD-BLOCKED: fixture blocker for epic ${id}`;
    log(`blocked ${id}`);
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "stub-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: message },
        },
      },
    });
    return;
  }

  if (noClose) return;
  if (laneSettleMs > 0) await Bun.sleep(laneSettleMs);
  mergeFixtureLane(id);
  closeFixtureEpic(id);
}

async function runGenerationLane() {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "stub-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Choosing the next epics" },
      },
    },
  });
  if (delayMs > 0) await Bun.sleep(delayMs);
  for (const entry of generatedEpics) {
    if (fileFixtureEpic(entry)) {
      const number = entry.slice(0, entry.indexOf(":"));
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "stub-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Filed epic ${number}` },
          },
        },
      });
    }
  }
  if (laneSettleMs > 0) await Bun.sleep(laneSettleMs);
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

function promptText(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null || !("prompt" in params)) return undefined;
  const blocks = Array.isArray(params.prompt) ? params.prompt : [];
  return blocks
    .map((block) => {
      if (typeof block !== "object" || block === null || !("text" in block)) return undefined;
      const value = block.text;
      return typeof value === "string" ? value : undefined;
    })
    .find((candidate): candidate is string => typeof candidate === "string");
}

async function promptTurn(params: unknown) {
  const text = promptText(params);
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

  const laneEpic =
    firstLine.startsWith("/implement-next-epic") && !creating && !revising
      ? implementationEpic(firstLine)
      : undefined;
  if (laneEpic !== undefined) {
    await runImplementationLane(laneEpic);
    return;
  }

  if (firstLine === "/epic-next" && !creating && !revising) {
    await runGenerationLane();
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
      const text = promptText(message.params) ?? "";
      if (busyRemaining > 0 && text.startsWith("The implementation turn ended")) {
        busyRemaining -= 1;
        log("busy");
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32003,
            message: "Session is busy",
            data: { reason: "session_busy", hint: "steer|followUp|wait" },
          },
        });
        return;
      }
      void promptTurn(message.params).then(() => {
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
