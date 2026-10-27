import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { frontmatterStatus, isPendingStatus, setFrontmatterStatus } from "./adr-source";

/**
 * A deterministic ACP peer for the interface's browser verification and tests.
 *
 * It answers the protocol handshake, streams a little activity, optionally
 * interviews the developer, writes `status: accepted` into the frontmatter of
 * the record named in the prompt, and ends the turn. With `--discover` it
 * instead stages the sheet, glossary, and five Discover skills named by
 * `/discover <staging-dir>`.
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

/** Flow Mode: the goal, implementation, analyst, and widget-conversation turns. */
const flowGoal = process.argv.includes("--flow-goal");
const flowImplement = process.argv.includes("--flow-implement");
const flowChange = process.argv.includes("--flow-change");
const flowWidget = process.argv.includes("--flow-widget");
const flowGoalEmpty = process.argv.includes("--flow-goal-empty");
const flowGoalFail = process.argv.includes("--flow-goal-fail");
const flowGoalText =
  argument("flow-goal-text") ?? "# Flow goal\n\nMake the fixture behavior observable.";
const flowCheckpoints = Math.max(1, Number(argument("flow-checkpoints") ?? 1));
const flowStepDelay = Number(argument("flow-step-delay") ?? 0);
const flowBlocked = process.argv.includes("--flow-blocked");
const flowQuestion = process.argv.includes("--flow-question");
const flowVerification = argument("flow-verification") ?? "passed";
const flowAnalystPartial = process.argv.includes("--flow-analyst-partial");
const flowAnalystFail = process.argv.includes("--flow-analyst-fail");
const flowAnalystEmpty = process.argv.includes("--flow-analyst-empty");
const flowAnalystForeign = process.argv.includes("--flow-analyst-foreign");
const flowSilentCheckpoints = process.argv.includes("--flow-silent-checkpoints");
const flowPreCommitDelay = Number(argument("flow-pre-commit-delay") ?? 0);
/** File this stub waits for before its second and later checkpoints. */
const flowWaitFile = argument("flow-wait-file");
const flowNoVerification = process.argv.includes("--flow-no-verification");

/** Discover Mode: the crawl staging turn and its validation-failure variants. */
const discover = process.argv.includes("--discover");
const discoverQuestion = process.argv.includes("--discover-question");
const discoverProse =
  argument("discover-prose") ??
  "A fixture host with a small order domain used to verify the Discover crawl";
const discoverInvalidSheet = process.argv.includes("--discover-invalid-sheet");
const discoverSheetAbsolute = process.argv.includes("--discover-sheet-absolute");
const discoverSheetNoEvidence = process.argv.includes("--discover-sheet-no-evidence");
const discoverSheetSecret = process.argv.includes("--discover-sheet-secret");
const discoverSheetTwoSentences = process.argv.includes("--discover-sheet-two-sentences");
/** Stages a level without `happyPath`, the shape an older prompt wrote. */
const discoverSheetNoHappyPath = process.argv.includes("--discover-sheet-no-happy-path");
/** Stages a happy-path count larger than the level's test count. */
const discoverSheetHappyOverflow = process.argv.includes("--discover-sheet-happy-overflow");
const discoverGlossaryInvalid = process.argv.includes("--discover-glossary-invalid");
const discoverGlossaryGrounding = process.argv.includes("--discover-glossary-grounding");
/** Omits a concept from the staged glossary, so a published one is preserved unscored. */
const discoverGlossaryDrop = process.argv.includes("--discover-glossary-drop");
/** The staged significance sidecar defect, or "" for a valid sidecar. */
const discoverSignificance = argument("discover-significance") ?? "";
const discoverMissingArtifact = process.argv.includes("--discover-missing-artifact");
const discoverExtraArtifact = process.argv.includes("--discover-extra-artifact");
const discoverWriteOutside = process.argv.includes("--discover-write-outside");
const discoverError = process.argv.includes("--discover-error");
const discoverNoExit = process.argv.includes("--discover-no-exit");

/** Ask mode: a read-only answer, preceded by thought and tool noise. */
const ask = process.argv.includes("--ask");
const askDelayMs = Number(argument("ask-delay-ms") ?? 0);
const askFail = process.argv.includes("--ask-fail");
const askExit = process.argv.includes("--ask-exit");

/** Draft elaboration mode: simulate the goal-draft command's observable work. */
const goalDraft = process.argv.includes("--goal-draft");
const goalDraftFinish = argument("goal-draft-finish");
const ASK_INSTRUCTION = "This conversation is read-only.";
const ASK_ANSWER_ONE =
  "The issues indicator shows the lifecycle the detached worker published for this repository. " +
  "It turns amber while a run is working and shows failed when the last run failed. " +
  "It sits in the status bar and opens the Issues mode.";
const ASK_ANSWER_TWO =
  "The status bar renders that label in StatusBar.svelte from the issues snapshot the server sends. " +
  "The count is the open issues the tracker returned for the host repository. " +
  "No other status item opens a mode.";
let askTurns = 0;
const DISCOVER_SECRET = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
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
/** One prompt turn at a time, so a queued message answers in order. */
let promptChain: Promise<void> = Promise.resolve();

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
      .filter((file) => isPendingStatus(frontmatterStatus(readFileSync(join(directory, file), "utf8"))))
      .length;
  } catch {
    return 0;
  }
}

function markAccepted(file: string) {
  const source = readFileSync(file, "utf8");
  if (frontmatterStatus(source) === undefined) return;
  writeFileSync(file, setFrontmatterStatus(source, "accepted"));
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

/**
 * The `/goal-draft` turn. The draft's own bytes choose the scenario:
 * `STUB-QUESTION` asks one question first, `STUB-HANG` waits for Stop, and
 * `STUB-FAIL` reports a failed label verification. A successful turn writes
 * the five-section spec and removes the draft, exactly as the prompt requires.
 */
async function runGoalDraft(relativePath: string) {
  log(`goal-draft ${relativePath}`);
  const draftPath = join(process.cwd(), relativePath);
  let source = "";
  try {
    source = readFileSync(draftPath, "utf8");
  } catch {
    // A missing draft still produces a deterministic failure.
  }
  stream("Reading the draft and researching the repository");

  if (source.includes("STUB-QUESTION")) {
    await askQuestions(1);
  }
  if (source.includes("STUB-FAIL")) {
    throw new Error("goal label verification failed");
  }
  if (source.includes("STUB-HANG")) {
    while (goalDraftFinish === undefined || !existsSync(goalDraftFinish)) {
      await Bun.sleep(50);
    }
  }

  const name = basename(relativePath, ".md");
  const spec = join(process.cwd(), ".devboard", "goals", `${name}.md`);
  mkdirSync(dirname(spec), { recursive: true });
  writeFileSync(
    spec,
    [
      "## Objective",
      "",
      `Finalized ${name}.`,
      "",
      "## Success criteria",
      "",
      "- The stub wrote this spec.",
      "",
      "## Verification",
      "",
      "- Read this file.",
      "",
      "## Boundaries",
      "",
      "- The fixture only.",
      "",
      "## Stop conditions",
      "",
      "- Halt on a missing prerequisite.",
      "",
    ].join("\n"),
  );
  log(`goal-draft-verified ${relativePath}`);
  unlinkSync(draftPath);
  stream("Filed the goal issue and verified the goal label");
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

/** JSON lines of a Flow session file, tolerant of an absent or partial file. */
function readLines(path: string): Record<string, unknown>[] {
  let source = "";
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const entries: Record<string, unknown>[] = [];
  for (const line of source.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === "object" && value !== null) entries.push(value as Record<string, unknown>);
    } catch {
      // A partial tail costs one entry.
    }
  }
  return entries;
}

function writeJsonFile(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function flowGit(repo: string, args: string[]) {
  return Bun.spawnSync({
    cmd: [
      "git",
      "-C",
      repo,
      "-c",
      "user.name=Flow Stub",
      "-c",
      "user.email=stub@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
}

function stream(text: string, append = false) {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "stub-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
        ...(append ? { messageId: "flow-stream" } : {}),
      },
    },
  });
}

/** Reads new steering notes and acknowledges each one before a checkpoint. */
function consumeSteering(directory: string): Record<string, unknown>[] {
  const notes = readLines(join(directory, "steering.jsonl"));
  const acked = new Set(
    readLines(join(directory, "steering-ack.jsonl")).map((entry) => String(entry.id ?? "")),
  );
  const fresh = notes.filter((note) => !acked.has(String(note.id ?? "")));
  for (const note of fresh) {
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, "steering-ack.jsonl"), `${JSON.stringify({ id: note.id })}\n`);
    log(`flow-ack ${String(note.id ?? "")}`);
    appendFileSync(join(process.cwd(), "steering-applied.txt"), `${String(note.text ?? "")}\n`);
  }
  log(`flow-steering-read ${fresh.length}`);
  return fresh;
}

async function runFlowGoal(directory: string) {
  log(`flow-goal ${directory}`);
  stream("Interviewing the developer about the Flow goal");
  if (delayMs > 0) await Bun.sleep(delayMs);
  await askQuestions(1);
  if (flowGoalFail) {
    log("flow-goal-failed");
    return;
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "goal.md"), flowGoalEmpty ? "" : flowGoalText);
  log(`flow-goal-written ${directory}`);
  stream("Wrote the Flow goal");
}

async function runFlowImplementation(directory: string) {
  log(`flow-implement ${directory} cwd=${process.cwd()}`);
  stream("Reading the plan");

  if (flowQuestion) await askQuestions(1);
  if (flowPreCommitDelay > 0) await Bun.sleep(flowPreCommitDelay);

  for (let index = 1; index <= flowCheckpoints; index += 1) {
    try {
      const decisions = readFileSync(join(directory, "decisions.md"), "utf8");
      log(`flow-decisions-read ${index} ${decisions.length}`);
    } catch {
      log(`flow-decisions-read ${index} 0`);
    }
    if (index > 1) {
      if (flowWaitFile !== undefined) {
        const deadline = Date.now() + 30_000;
        while (!existsSync(flowWaitFile) && Date.now() < deadline) await Bun.sleep(25);
        log(`flow-wait-done ${existsSync(flowWaitFile) ? "yes" : "timeout"}`);
      }
      consumeSteering(directory);
    }
    mkdirSync(join(process.cwd(), "src"), { recursive: true });
    writeFileSync(join(process.cwd(), "src", "app.txt"), `version ${index}\n`);
    writeFileSync(
      join(process.cwd(), "src", "config.json"),
      `${JSON.stringify({ version: index }, null, 2)}\n`,
    );
    if (index > 1) writeFileSync(join(process.cwd(), "src", `extra-${index}.txt`), `extra ${index}\n`);

    flowGit(process.cwd(), ["add", "-A"]);
    const committed = flowGit(process.cwd(), [
      "commit",
      "-m",
      `checkpoint ${index}: fixture change`,
    ]);
    if ((committed.exitCode ?? 1) !== 0) {
      log(`flow-commit-failed ${committed.stderr.toString().trim()}`);
      return;
    }
    const revision = flowGit(process.cwd(), ["rev-parse", "--short=7", "HEAD"]);
    const commit = revision.stdout.toString().trim();
    const verifiedAt = new Date().toISOString();
    if (!flowNoVerification) {
      writeJsonFile(join(directory, "verification.json"), {
        command: "bun test",
        status: flowVerification,
        timestamp: verifiedAt,
        output:
          flowVerification === "failed"
            ? "1 failing test: fixture verification failed\n"
            : "0 failing tests: fixture verification passed\n",
      });
    }
    mkdirSync(directory, { recursive: true });
    if (!flowSilentCheckpoints) {
      appendFileSync(
        join(directory, "checkpoints.jsonl"),
        `${JSON.stringify({
          id: `cp-${index}`,
          timestamp: verifiedAt,
          summary: `checkpoint ${index} — fixture change`,
          files: index > 1 ? 3 : 2,
          commit,
          verification: flowVerification,
        })}\n`,
      );
    }
    log(`flow-checkpoint ${index} ${commit}`);
    stream(`Committed checkpoint ${index}`);
    if (index < flowCheckpoints && flowStepDelay > 0) await Bun.sleep(flowStepDelay);
  }

  if (flowBlocked) {
    const message = "DEVBOARD-BLOCKED: the fixture cannot continue past this checkpoint";
    log("flow-blocked");
    stream(message);
    mkdirSync(directory, { recursive: true });
    appendFileSync(
      join(directory, "blockers.jsonl"),
      `${JSON.stringify({ id: "blocker-fixture", timestamp: new Date().toISOString(), text: message.slice("DEVBOARD-BLOCKED: ".length) })}\n`,
    );
  }
}

async function runFlowChange(directory: string) {
  log(`flow-change ${directory}`);
  stream("Classifying the changed files");
  const request = JSON.parse(readFileSync(join(directory, "request.json"), "utf8")) as {
    files?: { path?: unknown }[];
  };
  const files = (request.files ?? [])
    .map((file) => file.path)
    .filter((path): path is string => typeof path === "string");
  if (flowAnalystFail) {
    writeFileSync(join(directory, "widgets.json"), "this is not widget json");
    log("flow-widgets-failed");
    return;
  }
  if (flowAnalystEmpty) {
    writeJsonFile(join(directory, "widgets.json"), { widgets: [] });
    log("flow-widgets 0");
    return;
  }
  const selected = flowAnalystPartial ? files.slice(0, 1) : files;
  const widgets: unknown[] = [];
  if (selected.length > 0) {
    widgets.push({
      category: "contract",
      concept: "Application contract",
      summary: "The application's observable contract changed.",
      rationale: "Callers observe a different result.",
      files: [selected[0]],
    });
  }
  if (selected.length > 1) {
    widgets.push({
      category: "data",
      concept: "Stored configuration",
      summary: "The stored configuration changed.",
      rationale: "Persisted values have a new shape.",
      files: selected.slice(1),
    });
  }
  if (flowAnalystForeign) {
    widgets.push({
      category: "entity",
      concept: "A file outside the diff",
      summary: "This widget invents a file.",
      rationale: "It must be rejected by the server's validation.",
      files: ["src/not-in-the-diff.txt"],
    });
  }
  writeJsonFile(join(directory, "widgets.json"), { widgets });
  log(`flow-widgets ${widgets.length}`);
}

async function runFlowWidget(rest: string) {
  const split = /^(\S+)\s+(\S+)/.exec(rest);
  log(`flow-widget ${split?.[1] ?? ""} ${split?.[2] ?? ""}`);
  stream("Reviewing the widget and its diff");
  await askQuestions(1);
  stream("The widget conversation is read-only");
}

type DiscoverConfidence = "observed" | "declared" | "inferred" | "unknown";

interface DiscoverLabel {
  language: "en" | "de";
  text: string;
}

interface DiscoverConcept {
  id: string;
  prefLabels: DiscoverLabel[];
  altLabels: DiscoverLabel[];
  hiddenLabels: Array<DiscoverLabel & { reason: string; rejectedOn: string }>;
  definitions: DiscoverLabel[];
  scopeNote: null;
  example: null;
  historyNote: null;
  status: "unconfirmed" | "proposed";
  origin: "owner" | "llm";
  standardRef: null;
  kind: "entity" | "value";
  grounding: string[];
  broader: null;
  related: string[];
}

const discoverEvidenceCandidates = [
  "README.md",
  "package.json",
  "src",
  "test",
  ".github/workflows",
];

/** Existing repo-relative evidence paths, in candidate order, plus a safe fallback. */
function discoverEvidencePaths() {
  const available = discoverEvidenceCandidates.filter((path) =>
    existsSync(join(process.cwd(), path)),
  );
  const fallback = available.length > 0 ? available : ["."];
  return {
    available,
    primary: fallback[0] ?? ".",
    manifest: existsSync(join(process.cwd(), "package.json")) ? "package.json" : fallback[0] ?? ".",
    source: existsSync(join(process.cwd(), "src")) ? "src" : fallback[0] ?? ".",
    tests: existsSync(join(process.cwd(), "test")) ? "test" : fallback[0] ?? ".",
    ci: existsSync(join(process.cwd(), ".github", "workflows")) ? ".github/workflows" : undefined,
    hasManifest: existsSync(join(process.cwd(), "package.json")),
    hasTests: existsSync(join(process.cwd(), "test")),
    hasSource: existsSync(join(process.cwd(), "src")),
  };
}

function discoverLeaf(
  value: unknown,
  evidence: string[],
  confidence: DiscoverConfidence = "observed",
): Record<string, unknown> {
  return { value, evidence: [...new Set(evidence)].sort(), confidence };
}

function discoverUnknown(reason: string): Record<string, unknown> {
  return { value: null, evidence: [], confidence: "unknown", reason };
}

/** One-line, one-sentence bounded prose no longer than `limit` characters. */
function discoverOneSentence(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim().replace(/[.!?]+$/g, "").replace(/[.!?]\s+/g, " ");
  if (flat.length > limit - 1) return `${flat.slice(0, limit - 1).trimEnd()}.`;
  return `${flat}.`;
}

function discoverSheet(): Record<string, unknown> {
  const paths = discoverEvidencePaths();
  const evidence = [paths.primary];
  const sheet: Record<string, unknown> = {
    schemaVersion: 1,
    definition: discoverLeaf(
      discoverSheetTwoSentences
        ? "First sentence describes the fixture project. Second sentence describes the crawl."
        : discoverOneSentence(discoverProse, 240),
      evidence,
      "declared",
    ),
    stack: discoverLeaf(
      ["Bun", "TypeScript"],
      [paths.manifest],
      paths.hasManifest ? "declared" : "inferred",
    ),
    deployment: {
      class: discoverLeaf(
        paths.hasManifest ? "package" : "none",
        [paths.manifest],
        "observed",
      ),
      artifact: discoverLeaf("fixture-host", [paths.manifest], "declared"),
      target: discoverUnknown("No publication target was found in the crawled files."),
      pipelineSources:
        paths.ci === undefined
          ? discoverUnknown("No CI configuration was found in the crawled files.")
          : discoverLeaf([paths.ci], [paths.ci], "observed"),
    },
    environments: discoverLeaf(
      [{ name: "production", purpose: "Changes reach production through a direct push." }],
      evidence,
      "inferred",
    ),
    commands: {
      install: paths.hasManifest
        ? discoverLeaf("bun install", [paths.manifest], "declared")
        : discoverUnknown("No install command was found in the crawled files."),
      build: paths.hasManifest
        ? discoverLeaf("bun run build", [paths.manifest], "declared")
        : discoverUnknown("No build command was found in the crawled files."),
      test: paths.hasManifest
        ? discoverLeaf("bun test", [paths.manifest], "declared")
        : discoverUnknown("No test command was found in the crawled files."),
      lint: discoverUnknown("No lint command was found in the crawled files."),
      typecheck: discoverUnknown("No typecheck command was found in the crawled files."),
      dev: paths.hasManifest
        ? discoverLeaf("bun run dev", [paths.manifest], "declared")
        : discoverUnknown("No dev command was found in the crawled files."),
      tryOut: discoverUnknown("No try-out command was found in the crawled files."),
      release: discoverUnknown("No release command was found in the crawled files."),
    },
    branching: {
      defaultBranch: discoverLeaf("main", ["git branch"], "observed"),
      mergeMethod: discoverLeaf("merge commit", ["git log"], "inferred"),
      releaseBranches: discoverLeaf([], ["git branch"], "observed"),
      model: discoverLeaf("pull-request", ["git log"], "inferred"),
    },
    testing: {
      levels: paths.hasTests
        ? discoverLeaf(
            [
              discoverSheetNoHappyPath
                ? {
                    level: "unit",
                    tests: "1",
                    paths: [paths.tests],
                    command: "npm test",
                    fixtures: [],
                  }
                : {
                    level: "unit",
                    tests: "1",
                    happyPath: discoverSheetHappyOverflow ? "2" : "1",
                    paths: [paths.tests],
                    command: "npm run test:unit",
                    fixtures: [],
                  },
            ],
            [paths.tests],
            "observed",
          )
        : discoverUnknown("No test files were found in the crawled files."),
      pyramid: paths.hasTests
        ? discoverLeaf("Unit tests are the only observed level.", [paths.tests], "inferred")
        : discoverUnknown("No test files were found in the crawled files."),
    },
    architecture: {
      contexts: paths.hasSource
        ? discoverLeaf(
            [
              {
                name: "Orders",
                path: "src",
                responsibility: "Owns order records and order totals.",
                entryPoints: ["src"],
                dependsOn: [],
              },
              {
                name: "Cli",
                path: "src/cli",
                responsibility: "Parses commands and prints order totals.",
                entryPoints: ["src/cli"],
                dependsOn: ["Orders"],
              },
            ],
            ["src"],
            "observed",
          )
        : discoverUnknown("No source directory was found in the crawled files."),
      dependencyDirection: paths.hasSource
        ? discoverLeaf(
            "Dependencies point inward toward the Orders domain code.",
            ["src"],
            "inferred",
          )
        : discoverUnknown("No source directory was found in the crawled files."),
      externalBoundaries: paths.hasSource
        ? discoverLeaf([], ["src"], "observed")
        : discoverUnknown("No source directory was found in the crawled files."),
      sharedKernels: paths.hasSource
        ? discoverLeaf([], ["src"], "observed")
        : discoverUnknown("No source directory was found in the crawled files."),
    },
    ci: {
      provider:
        paths.ci === undefined
          ? discoverLeaf("none detected", evidence, "observed")
          : discoverLeaf("GitHub Actions", [paths.ci], "observed"),
      triggers:
        paths.ci === undefined
          ? discoverLeaf([], evidence, "observed")
          : discoverLeaf(["push"], [paths.ci], "observed"),
      jobs:
        paths.ci === undefined
          ? discoverLeaf([], evidence, "observed")
          : discoverLeaf(["test"], [paths.ci], "observed"),
      qualityGates:
        paths.ci === undefined
          ? discoverLeaf([], evidence, "observed")
          : discoverLeaf(["bun test"], [paths.ci], "declared"),
      qualityGateDetails:
        paths.ci === undefined
          ? discoverLeaf([], evidence, "observed")
          : discoverLeaf(
              [
                {
                  name: "bun test",
                  description: "Runs every fixture test with Bun's test runner.",
                  command: "bun test",
                },
              ],
              [paths.ci],
              "declared",
            ),
      artifacts:
        paths.ci === undefined
          ? discoverLeaf([], evidence, "observed")
          : discoverLeaf([], [paths.ci], "observed"),
    },
    runtime: {
      languages: discoverLeaf(["TypeScript"], [paths.manifest], "declared"),
      runtimes: discoverLeaf(["Bun"], [paths.manifest], "declared"),
      packageManagers: discoverLeaf(["bun"], [paths.manifest], "declared"),
      versions: discoverLeaf([], [paths.manifest], "observed"),
      manifests: paths.hasManifest
        ? discoverLeaf(["package.json"], [paths.manifest], "observed")
        : discoverUnknown("No manifest was found in the crawled files."),
    },
    dependencyMap: {
      binaries: discoverLeaf([], [paths.manifest], "observed"),
      packages: discoverLeaf([], [paths.manifest], "observed"),
      routes: discoverLeaf([], [paths.manifest], "observed"),
      jobs: discoverLeaf([], [paths.manifest], "observed"),
      externalServices: discoverLeaf([], [paths.manifest], "observed"),
      dataStores: discoverLeaf([], [paths.manifest], "observed"),
      keyDependencies: discoverLeaf([], [paths.manifest], "declared"),
    },
    delivery: {
      artifactTarget: discoverLeaf("package", [paths.manifest], "declared"),
      releaseChannels: discoverLeaf([], [paths.manifest], "declared"),
      versionScheme: discoverUnknown("No versioning scheme was found in the crawled files."),
      migrationPolicy: discoverUnknown("No migration policy was found in the crawled files."),
    },
  };

  // Both leaf shapes were constructed above; the casts only narrow the variant mutations.
  const stack = sheet.stack as { value: unknown; evidence: string[] };
  const deployment = sheet.deployment as { artifact: { value: unknown } };
  if (discoverInvalidSheet) stack.value = ["x".repeat(200)];
  if (discoverSheetAbsolute) stack.evidence = ["/etc/passwd"];
  if (discoverSheetNoEvidence) stack.evidence = [];
  if (discoverSheetSecret) deployment.artifact.value = DISCOVER_SECRET;

  return sheet;
}

function discoverLabelLines(field: string, labels: DiscoverLabel[]): string[] {
  if (labels.length === 0) return [`    ${field}: []`];
  return [
    `    ${field}:`,
    ...labels.flatMap((label) => [
      `      - language: ${label.language}`,
      `        text: ${JSON.stringify(label.text)}`,
    ]),
  ];
}

function discoverConceptLines(concept: DiscoverConcept): string[] {
  const hidden =
    concept.hiddenLabels.length === 0
      ? ["    hiddenLabels: []"]
      : [
          "    hiddenLabels:",
          ...concept.hiddenLabels.flatMap((label) => [
            `      - language: ${label.language}`,
            `        text: ${JSON.stringify(label.text)}`,
            `        reason: ${JSON.stringify(label.reason)}`,
            `        rejectedOn: ${JSON.stringify(label.rejectedOn)}`,
          ]),
        ];
  return [
    `  - id: ${concept.id}`,
    ...discoverLabelLines("prefLabels", concept.prefLabels),
    ...discoverLabelLines("altLabels", concept.altLabels),
    ...hidden,
    ...discoverLabelLines("definitions", concept.definitions),
    "    scopeNote: null",
    "    example: null",
    "    historyNote: null",
    `    status: ${concept.status}`,
    `    origin: ${concept.origin}`,
    "    standardRef: null",
    `    kind: ${concept.kind}`,
    "    grounding:",
    ...concept.grounding.map((entry) => `      - ${JSON.stringify(entry)}`),
    "    broader: null",
    `    related: ${JSON.stringify(concept.related)}`,
  ];
}

function discoverGlossary(): { yaml: string; concepts: DiscoverConcept[] } {
  const paths = discoverEvidencePaths();
  const available = paths.available.length > 0 ? paths.available : ["."];
  const firstGrounding = `code:${available[0] ?? "."}`;
  const secondGrounding = `code:${available[1] ?? available[0] ?? "."}`;
  const seed = discoverOneSentence(discoverProse, 152).replace(/\.$/, "");
  const order: DiscoverConcept = {
    id: "order",
    prefLabels: [{ language: "en", text: "Order" }],
    altLabels: [],
    hiddenLabels: [],
    definitions: [
      { language: "en", text: discoverOneSentence(`${seed} names one customer order request`, 160) },
    ],
    scopeNote: null,
    example: null,
    historyNote: null,
    status: "unconfirmed",
    origin: "owner",
    standardRef: null,
    kind: "entity",
    grounding: [firstGrounding],
    broader: null,
    related: [],
  };
  const orderTotal: DiscoverConcept = {
    id: discoverGlossaryInvalid ? "order" : "order-total",
    prefLabels: [{ language: "en", text: "Order Total" }],
    altLabels: [],
    hiddenLabels: [],
    definitions: [
      {
        language: "en",
        text: discoverOneSentence(`${seed} sums the lines of one order`, 160),
      },
    ],
    scopeNote: null,
    example: null,
    historyNote: null,
    status: "proposed",
    origin: "llm",
    standardRef: null,
    kind: "value",
    grounding: [discoverGlossaryGrounding ? "code:src/does-not-exist.ts" : secondGrounding],
    broader: null,
    related: [],
  };
  const option: DiscoverConcept = {
    id: "option",
    prefLabels: [{ language: "en", text: "Option" }],
    altLabels: [],
    hiddenLabels: [],
    definitions: [
      {
        language: "en",
        text: discoverOneSentence(`${seed} names an entry of a choice list`, 160),
      },
    ],
    scopeNote: null,
    example: null,
    historyNote: null,
    status: "unconfirmed",
    origin: "owner",
    standardRef: null,
    kind: "entity",
    grounding: [secondGrounding],
    broader: null,
    related: [],
  };
  const concepts = discoverGlossaryDrop ? [order] : [order, option, orderTotal];
  const lines = [
    "boundedContext: orders",
    "titles:",
    "  - language: en",
    `    text: ${JSON.stringify("Orders")}`,
    "concepts:",
    ...concepts.flatMap(discoverConceptLines),
  ];
  return { yaml: `${lines.join("\n")}\n`, concepts };
}

/** Scores the fixture concepts; the generic `option` scores lowest on purpose. */
const DISCOVER_SIGNIFICANCE: Record<string, { score: number; reason: string }> = {
  order: { score: 80, reason: "Every fixture checkout creates one order record." },
  option: { score: 10, reason: "A framework option token, not a domain term." },
  "order-total": { score: 90, reason: "The order total is the domain's central summed value." },
};

function discoverSignificanceSidecar(
  concepts: DiscoverConcept[],
): Record<string, unknown> {
  const ids = [...new Set(concepts.map((concept) => concept.id))];
  const entries: Record<string, { score: number; reason: string }> = Object.fromEntries(
    ids.map((id) => [
      id,
      { ...(DISCOVER_SIGNIFICANCE[id] ?? { score: 50, reason: "Observed in the fixture host." }) },
    ]),
  );
  const first = ids[0];
  if (discoverSignificance === "unknown-concept") delete entries[ids[1] ?? first ?? ""];
  if (discoverSignificance === "extra-concept" && first !== undefined) {
    entries["ghost-term"] = { score: 50, reason: "A concept that is not staged." };
  }
  if (discoverSignificance === "score") entries.option = { score: 101, reason: "Out of range." };
  if (discoverSignificance === "reason-empty") entries.option = { score: 10, reason: "  " };
  if (discoverSignificance === "reason-multiline") {
    entries.option = { score: 10, reason: "One line.\nA second line." };
  }
  if (discoverSignificance === "reason-absolute") {
    entries.option = { score: 10, reason: "/home/operator/secret.ts defines it." };
  }
  if (discoverSignificance === "reason-secret") {
    entries.option = { score: 10, reason: `Pinned by ${DISCOVER_SECRET}` };
  }
  const contexts: Record<string, unknown> = { orders: entries };
  if (discoverSignificance === "unknown-context") {
    contexts["other-context"] = { "another-term": { score: 50, reason: "Not a staged context." } };
  }
  if (discoverSignificance === "extra-key") return { schemaVersion: 1, contexts, note: "extra" };
  if (discoverSignificance === "schema") return { schemaVersion: 2, contexts };
  if (discoverSignificance === "score-object") {
    return { schemaVersion: 1, contexts: { orders: { order: { score: "80", reason: "Text score." } } } };
  }
  return { schemaVersion: 1, contexts };
}

interface DiscoverSkill {
  name: string;
  role: string;
  description: string;
  body: string[];
}

function discoverSkills(): DiscoverSkill[] {
  const glossaryPath = ".omp/discover/glossary/orders.glossary.yaml";
  return [
    {
      name: "discover-testing-strategy",
      role: "testing-strategy",
      description:
        "Apply the observed unit-test level and the project's recorded test command before requesting review.",
      body: [
        "- Run `bun test` from the repository root before review.",
        "- Treat the unit level as the only implemented test level; add new cases there.",
        "- Add a failing case first and keep one assertion focus per test file.",
        "- Report untested areas as unknown instead of inventing an integration or end-to-end suite.",
      ],
    },
    {
      name: "discover-naming-conventions",
      role: "naming-conventions",
      description:
        "Name code after the grounded glossary terms and keep the observed casing across the project.",
      body: [
        `- Name domain types and functions after the preferred labels in ${glossaryPath}.`,
        "- Keep file names kebab-case and exported types PascalCase.",
        "- Use camelCase for functions, variables, and flags.",
        `- Reject aliases the glossary does not define; propose new terms through the glossary process in ${glossaryPath}.`,
      ],
    },
    {
      name: "discover-coding-conventions",
      role: "coding-conventions",
      description:
        "Keep typed, explicit code that reuses the dependencies the manifest already records.",
      body: [
        "- Keep exported functions typed; never leave an implicit any boundary.",
        "- Handle recoverable errors at the caller; never swallow a failure silently.",
        "- Prefer an already-installed dependency over adding a new one.",
        "- Run `bun test` before claiming a change is complete.",
      ],
    },
    {
      name: "discover-architecture-boundaries",
      role: "architecture-boundaries",
      description:
        "Keep domain behavior inside its bounded context and preserve the observed dependency direction.",
      body: [
        "- Keep domain behavior inside its bounded context.",
        "- Point imports inward toward domain modules; never import delivery code from the domain.",
        `- Do not add a cross-context import without recording the boundary in ${glossaryPath}.`,
        "- Treat an external service as absent until a manifest or source file declares one.",
      ],
    },
    {
      name: "discover-glossary",
      role: "glossary",
      description:
        "Use the canonical glossary, honor human decisions, and propose new terms explicitly.",
      body: [
        `- Treat ${glossaryPath} as the canonical glossary for every naming decision.`,
        "- Never write a confirmed status into a generated glossary; only a human confirm decision may do that.",
        "- Reject a proposed term with a non-empty reason instead of deleting it.",
        "- Propose new terms through Discover with grounding and let a human confirm them.",
        "- Never label code with an invalidated preferred label; no concept is invalidated in this baseline.",
      ],
    },
  ];
}

function discoverSkillText(skill: DiscoverSkill): string {
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    "metadata:",
    '  devboard-managed: "true"',
    '  devboard-family: "discover"',
    `  devboard-skill: ${skill.role}`,
    "---",
    "",
    ...skill.body,
    "",
  ].join("\n");
}

async function runDiscover(staging: string) {
  stream("Scanning manifests");
  stream("Reading tests");
  stream("Mapping architecture");
  if (discoverQuestion) await askQuestions(1);

  if (discoverError) {
    stream("Crawl failed while reading manifests");
    process.exit(1);
  }

  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "sheet.json"), `${JSON.stringify(discoverSheet(), null, 2)}\n`);

  mkdirSync(join(staging, "glossary"), { recursive: true });
  const glossary = discoverGlossary();
  writeFileSync(join(staging, "glossary", "orders.glossary.yaml"), glossary.yaml);
  if (discoverSignificance !== "missing") {
    const sidecar =
      discoverSignificance === "invalid"
        ? "{ not json"
        : discoverSignificance === "array"
          ? "[]"
          : `${JSON.stringify(discoverSignificanceSidecar(glossary.concepts), null, 2)}\n`;
    writeFileSync(join(staging, "glossary", "significance.json"), sidecar);
  }

  const skills = discoverSkills();
  for (const [index, skill] of skills.entries()) {
    if (discoverMissingArtifact && index === skills.length - 1) continue;
    const directory = join(staging, "skills", skill.name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), discoverSkillText(skill));
  }

  if (discoverExtraArtifact) {
    writeFileSync(join(staging, "notes.txt"), "Extra staged note.\n");
  }

  if (discoverWriteOutside) {
    const note = join(process.cwd(), ".omp", "discover", "staging-note.txt");
    mkdirSync(dirname(note), { recursive: true });
    writeFileSync(note, "Written outside staging by the stub.\n");
    writeFileSync(
      join(process.cwd(), "GOAL.md"),
      "# Discover stub goal\n\nThe stub wrote outside staging.\n",
    );
    // The host fingerprint ignores .omp/discover, and the failure drill must
    // leave the published Discover tree byte-identical; GOAL.md still proves
    // the outside write.
    unlinkSync(note);
  }

  if (discoverNoExit) await Bun.sleep(delayMs > 0 ? delayMs : 60_000);
}

/**
 * The peer is announced with the prompt that starts its first turn, so a test
 * that counts peers sees the announcement together with the turn it started.
 */
let announced = false;

async function promptTurn(params: unknown) {
  if (!announced) {
    announced = true;
    log(`spawn ${process.pid}`);
  }
  const text = promptText(params);
  const file = typeof text === "string" ? /(?:^|\s)(\S+\.md)(?:\s|$)/.exec(text)?.[1] : undefined;
  const firstLine = text?.split("\n")[0] ?? "";

  if (ask && text !== undefined && text.includes(ASK_INSTRUCTION)) {
    askTurns += 1;
    if (askTurns === 1) log(`ask-spawn ${process.pid}`);
    const question = /(?:^|\n)Question: ([^\n]*)/.exec(text)?.[1] ?? "";
    log(`ask-prompt ${askTurns} ${question}`);
    log(`ask-text ${askTurns} ${JSON.stringify(text)}`);
    // Thoughts and tool activity precede the answer; the panel must drop them.
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "stub-session",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Considering the captured element before answering." },
          messageId: `ask-thought-${askTurns}`,
        },
      },
    });
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "stub-session",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: `ask-tool-${askTurns}`,
          title: "Reading the captured element",
          kind: "read",
          status: "pending",
        },
      },
    });
    if (askDelayMs > 0) await Bun.sleep(askDelayMs);
    // The first peer of a conversation exits; its replacement, which carries
    // the earlier turns, answers. A new process cannot see ask turns alone.
    const firstPeer = !text.includes("Earlier in this conversation:");
    if (askExit && firstPeer) {
      log("ask-exit");
      process.exit(0);
    }
    if (askFail && askTurns === 1) throw new Error("The ask agent failed.");
    const answer = askTurns === 1 ? ASK_ANSWER_ONE : ASK_ANSWER_TWO;
    const split = answer.indexOf(". ") + 2;
    stream(answer.slice(0, split).trim());
    if (askDelayMs > 0) await Bun.sleep(askDelayMs);
    stream(answer.slice(split).trim());
    return;
  }

  if (goalDraft && firstLine.startsWith("/goal-draft ")) {
    await runGoalDraft(firstLine.slice("/goal-draft ".length).trim());
    return;
  }
  if (flowGoal && firstLine.startsWith("/flow-goal ")) {
    log(`prompt ${firstLine}`);
    await runFlowGoal(firstLine.slice("/flow-goal ".length).trim());
    return;
  }
  if (flowImplement && firstLine.startsWith("/flow-implement ")) {
    log(`prompt ${firstLine}`);
    await runFlowImplementation(firstLine.slice("/flow-implement ".length).trim());
    return;
  }
  if (flowChange && firstLine.startsWith("/flow-change ")) {
    log(`prompt ${firstLine}`);
    await runFlowChange(firstLine.slice("/flow-change ".length).trim());
    return;
  }
  if (flowWidget && firstLine.startsWith("/flow-widget ")) {
    log(`prompt ${firstLine}`);
    await runFlowWidget(firstLine.slice("/flow-widget ".length).trim());
    return;
  }
  if (
    flowWidget &&
    text !== undefined &&
    !firstLine.startsWith("/") &&
    !firstLine.startsWith("Revise the goal")
  ) {
    log(`flow-conversation ${firstLine}`);
    stream(`Developer: ${firstLine}`);
    return;
  }

  if (discover && firstLine.startsWith("/discover ")) {
    log(`prompt ${firstLine}`);
    await runDiscover(firstLine.slice("/discover ".length).trim());
    return;
  }

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
      promptChain = promptChain.then(async () => {
        try {
          await promptTurn(message.params);
          write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        } catch (error) {
          write({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
          });
        }
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

// A killed peer records that it left exactly once, so a test can prove the close.
let loggedExit = false;
function logExit() {
  if (loggedExit) return;
  loggedExit = true;
  log(`exit ${process.pid}`);
}
process.on("exit", logExit);
process.on("SIGTERM", () => {
  logExit();
  process.exit(0);
});

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
