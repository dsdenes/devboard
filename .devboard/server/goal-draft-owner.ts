/**
 * The detached owner of one running draft elaboration.
 *
 * The dashboard starts one owner per draft and never holds the ACP peer
 * itself. The owner spawns the agent, streams its activity and question into a
 * draft-keyed state file under `STATE_DIR`, and consumes answer/stop commands
 * from a control directory beside it. Because the owner is in its own session,
 * a replacement dashboard that the reload control starts attaches to the same
 * owners and the same agent processes.
 *
 * The owner watches the dashboard that supervises it. A reload writes a
 * handoff marker before it exits, so the owner waits for the replacement to
 * take the lease; any other exit ends the agent and records one `failed` run
 * naming the interruption, which the next dashboard shows while leaving the
 * draft startable. Every owner watches the same repository-level lease and
 * marker, so a replacement adopts each running draft independently.
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AcpConnection, type AcpActivity } from "./acp";
import { isInteger, isRecord } from "../issues/guards";
import { pidAlive } from "../issues/lock";
import { appendActivityLine, trimActivityLines } from "../issues/state";
import { journalKey } from "./journal";
import type { GoalDraftQuestion, GoalDraftRun, GoalDraftStatus } from "./goal-drafts";
import { canonicalProcessPath, recordedChildAlive, type RecordedChild } from "./state";

/** Envelope version of the owner state file. */
export const GOAL_DRAFT_OWNER_VERSION = 1;

/**
 * How long an owner waits for the replacement dashboard a reload promised.
 * Under ten seconds so a replacement that never arrives still ends the agent
 * within the interruption bound.
 */
export const HANDOFF_GRACE_MS = 8_000;

/** The recorded error of an elaboration the server exit ended. */
export const GOAL_DRAFT_INTERRUPTED =
  "The server exit interrupted the elaboration, so it was not resumed. Start the draft again.";

const OWNER_CHECK_MS = 200;
const PEER_CLOSE_GRACE_MS = 1_500;

/** Everything one detached owner persists for one draft. */
export interface GoalDraftOwnerState {
  version: number;
  run: GoalDraftRun;
  /** The owner process itself, used to prove identity before signalling it. */
  owner: RecordedChild | null;
  /** The recorded ACP peer process the owner holds. */
  peer: RecordedChild | null;
  /** The dashboard that launched this owner; the lease holder may differ. */
  launcherPid: number | null;
  supervisorPid: number | null;
  updatedAt: string;
}

/** A dashboard-to-owner instruction; commands are consumed in name order. */
export type GoalDraftOwnerCommand =
  | { type: "answer"; id: number | string; value: string }
  | { type: "stop" }
  | { type: "interrupt" };

/** The marker a reload writes so its replacement may adopt the owners. */
export interface GoalDraftHandoff {
  at: number;
  pid: number;
}

/** The dashboard that currently supervises the owners. */
export interface GoalDraftLease {
  pid: number;
  updatedAt: number;
  /**
   * The dashboard instance that wrote the lease. Two managers can share one
   * process, so the pid alone cannot tell this manager's lease from another's;
   * absent in leases written before this field existed.
   */
  instance?: string;
}

/** `<STATE_DIR>/goal-drafts/<repository key>`. */
export function goalDraftStateDirectory(stateDir: string, repoDir: string): string {
  return join(resolve(stateDir), "goal-drafts", journalKey(resolve(repoDir)));
}

/** The directory holding one state directory per running or finished draft. */
export function goalDraftRunsDirectory(stateDir: string, repoDir: string): string {
  return join(goalDraftStateDirectory(stateDir, repoDir), "runs");
}

/** The draft-keyed directory; the path never becomes a filename. */
export function goalDraftRunDirectory(stateDir: string, repoDir: string, path: string): string {
  const key = createHash("sha256").update(path).digest("hex").slice(0, 24);
  return join(goalDraftRunsDirectory(stateDir, repoDir), key);
}

export function goalDraftOwnerStatePath(
  stateDir: string,
  repoDir: string,
  path: string,
): string {
  return join(goalDraftRunDirectory(stateDir, repoDir, path), "state.json");
}

export function goalDraftControlDirectory(
  stateDir: string,
  repoDir: string,
  path: string,
): string {
  return join(goalDraftRunDirectory(stateDir, repoDir, path), "control");
}

export function goalDraftHandoffPath(stateDir: string, repoDir: string): string {
  return join(goalDraftStateDirectory(stateDir, repoDir), "handoff.json");
}

export function goalDraftLeasePath(stateDir: string, repoDir: string): string {
  return join(goalDraftStateDirectory(stateDir, repoDir), "lease.json");
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Replaces one file atomically; a reader never sees a half-written value. */
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`);
  renameSync(temporary, path);
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

function parseChild(value: unknown): RecordedChild | null {
  if (!isRecord(value)) return null;
  if (!isInteger(value.pid) || value.pid <= 0) return null;
  if (!Array.isArray(value.argv) || !value.argv.every((entry) => typeof entry === "string")) {
    return null;
  }
  if (typeof value.cwd !== "string" || value.cwd.length === 0) return null;
  return { pid: value.pid, argv: [...value.argv], cwd: value.cwd };
}

const STATUSES: readonly GoalDraftStatus[] = ["idle", "running", "succeeded", "failed", "stopped"];

function parseQuestion(value: unknown): GoalDraftQuestion | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" && !isInteger(value.id)) return undefined;
  if (typeof value.message !== "string") return undefined;
  if (!Array.isArray(value.options)) return undefined;
  const options: GoalDraftQuestion["options"] = [];
  for (const option of value.options) {
    if (!isRecord(option) || typeof option.label !== "string") return undefined;
    options.push({
      label: option.label,
      ...(typeof option.description === "string" ? { description: option.description } : {}),
      recommended: option.recommended === true,
    });
  }
  return {
    id: value.id,
    message: value.message,
    options,
  };
}

function parseRun(value: unknown): GoalDraftRun | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.status !== "string") return undefined;
  if (!STATUSES.includes(value.status as GoalDraftStatus)) return undefined;
  if (!(value.path === null || typeof value.path === "string")) return undefined;
  if (!(value.startedAt === null || typeof value.startedAt === "string")) return undefined;
  if (!(value.finishedAt === null || typeof value.finishedAt === "string")) return undefined;
  if (!(value.error === null || typeof value.error === "string")) return undefined;
  if (!Array.isArray(value.activity) || !value.activity.every((line) => typeof line === "string")) {
    return undefined;
  }
  const question = parseQuestion(value.question ?? null);
  if (question === undefined) return undefined;
  return {
    status: value.status as GoalDraftStatus,
    path: value.path,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    error: value.error,
    activity: [...value.activity],
    question,
  };
}

function parseState(value: unknown): GoalDraftOwnerState | undefined {
  if (!isRecord(value) || value.version !== GOAL_DRAFT_OWNER_VERSION) return undefined;
  const run = parseRun(value.run);
  if (run === undefined || run.path === null) return undefined;
  const supervisorPid = isInteger(value.supervisorPid) ? value.supervisorPid : null;
  const launcherPid = isInteger(value.launcherPid) ? value.launcherPid : supervisorPid;
  return {
    version: GOAL_DRAFT_OWNER_VERSION,
    run,
    owner: parseChild(value.owner),
    peer: parseChild(value.peer),
    launcherPid,
    supervisorPid,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
  };
}

/** Reads one draft's owner state; unusable bytes read as absent. */
export function readGoalDraftOwnerState(
  stateDir: string,
  repoDir: string,
  path: string,
): GoalDraftOwnerState | undefined {
  return parseState(readJson(goalDraftOwnerStatePath(stateDir, repoDir, path)));
}

/** Every readable owner state under the repository's runs directory. */
export function listGoalDraftOwnerStates(
  stateDir: string,
  repoDir: string,
): GoalDraftOwnerState[] {
  let names: string[];
  try {
    names = readdirSync(goalDraftRunsDirectory(stateDir, repoDir));
  } catch {
    return [];
  }
  const states: GoalDraftOwnerState[] = [];
  for (const name of names.sort()) {
    const state = parseState(
      readJson(join(goalDraftRunsDirectory(stateDir, repoDir), name, "state.json")),
    );
    if (state !== undefined) states.push(state);
  }
  return states;
}

export function writeGoalDraftOwnerState(
  stateDir: string,
  repoDir: string,
  path: string,
  state: GoalDraftOwnerState,
): void {
  writeJson(goalDraftOwnerStatePath(stateDir, repoDir, path), state);
}

/**
 * Forgets one draft's previous run and its queued commands, so a fresh owner
 * never consumes a stop or answer meant for its predecessor.
 */
export function resetGoalDraftRun(stateDir: string, repoDir: string, path: string): void {
  rmSync(goalDraftRunDirectory(stateDir, repoDir, path), { recursive: true, force: true });
}

export function readGoalDraftHandoff(
  stateDir: string,
  repoDir: string,
): GoalDraftHandoff | null {
  const parsed = readJson(goalDraftHandoffPath(stateDir, repoDir));
  if (!isRecord(parsed) || !isInteger(parsed.at) || !isInteger(parsed.pid)) return null;
  return { at: parsed.at, pid: parsed.pid };
}

export function writeGoalDraftHandoff(
  stateDir: string,
  repoDir: string,
  handoff: GoalDraftHandoff,
): void {
  writeJson(goalDraftHandoffPath(stateDir, repoDir), handoff);
}

export function removeGoalDraftHandoff(stateDir: string, repoDir: string): void {
  removeFile(goalDraftHandoffPath(stateDir, repoDir));
}

export function readGoalDraftLease(
  stateDir: string,
  repoDir: string,
): GoalDraftLease | null {
  const parsed = readJson(goalDraftLeasePath(stateDir, repoDir));
  if (!isRecord(parsed) || !isInteger(parsed.pid) || !isInteger(parsed.updatedAt)) return null;
  return {
    pid: parsed.pid,
    updatedAt: parsed.updatedAt,
    ...(typeof parsed.instance === "string" && parsed.instance.length > 0
      ? { instance: parsed.instance }
      : {}),
  };
}

export function writeGoalDraftLease(
  stateDir: string,
  repoDir: string,
  lease: GoalDraftLease,
): void {
  writeJson(goalDraftLeasePath(stateDir, repoDir), lease);
}

let commandSequence = 0;

/** Writes one instruction atomically; the owner consumes it in name order. */
export function writeGoalDraftOwnerCommand(
  directory: string,
  command: GoalDraftOwnerCommand,
): void {
  mkdirSync(directory, { recursive: true });
  commandSequence += 1;
  const name = `${String(Date.now()).padStart(14, "0")}-${String(commandSequence).padStart(6, "0")}.json`;
  const path = join(directory, name);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(command)}\n`);
  renameSync(temporary, path);
}

function parseCommand(text: string): GoalDraftOwnerCommand | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed.type === "stop" || parsed.type === "interrupt") return { type: parsed.type };
  if (parsed.type !== "answer") return undefined;
  if (typeof parsed.id !== "string" && !isInteger(parsed.id)) return undefined;
  if (typeof parsed.value !== "string") return undefined;
  return { type: "answer", id: parsed.id, value: parsed.value };
}

/** Reads and consumes every pending instruction in name order. */
export function takeGoalDraftOwnerCommands(directory: string): GoalDraftOwnerCommand[] {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const commands: GoalDraftOwnerCommand[] = [];
  for (const name of names) {
    const path = join(directory, name);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    removeFile(path);
    const parsed = parseCommand(text);
    if (parsed !== undefined) commands.push(parsed);
  }
  return commands;
}

function argument(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function selfChild(cwd: string): RecordedChild {
  let argv: string[] = [];
  try {
    argv = readFileSync("/proc/self/cmdline", "utf8").split("\u0000").filter(Boolean);
  } catch {
    // Without /proc the identity is still useful to the dashboard's own reads.
  }
  if (argv.length === 0) argv = [...process.argv];
  return { pid: process.pid, argv, cwd: canonicalProcessPath(cwd) };
}

/** Ends the peer and proves it gone before the owner records its outcome. */
async function closePeer(peer: AcpConnection | undefined, child: RecordedChild | null): Promise<void> {
  try {
    peer?.close();
  } catch {
    // The peer already exited.
  }
  if (child === null) return;
  const deadline = Date.now() + PEER_CLOSE_GRACE_MS;
  while (Date.now() < deadline && recordedChildAlive(child)) await Bun.sleep(25);
  if (!recordedChildAlive(child)) return;
  try {
    process.kill(child.pid, "SIGKILL");
  } catch {
    return;
  }
  const forced = Date.now() + 500;
  while (Date.now() < forced && recordedChildAlive(child)) await Bun.sleep(25);
}

/** Runs one draft's owner until its elaboration ends; the entry point of its process. */
export async function runGoalDraftOwner(argv: string[]): Promise<void> {
  const repoDir = resolve(argument(argv, "--repo") ?? "");
  const stateDir = resolve(argument(argv, "--state-dir") ?? "");
  const draftPath = argument(argv, "--path");
  if (
    argument(argv, "--repo") === undefined ||
    argument(argv, "--state-dir") === undefined ||
    draftPath === undefined
  ) {
    process.stderr.write("goal-draft owner: --repo, --state-dir, and --path are required.\n");
    process.exit(2);
  }

  // The dashboard writes the running state before it spawns this process.
  const launchDeadline = Date.now() + 2_000;
  let stored = readGoalDraftOwnerState(stateDir, repoDir, draftPath);
  while ((stored === undefined || stored.run.status !== "running") && Date.now() < launchDeadline) {
    await Bun.sleep(20);
    stored = readGoalDraftOwnerState(stateDir, repoDir, draftPath);
  }
  if (stored === undefined || stored.run.status !== "running") {
    process.exit(0);
  }

  const run: GoalDraftRun = {
    ...stored.run,
    activity: [...stored.run.activity],
    question: stored.run.question,
  };
  const owner = selfChild(repoDir);
  const launcherPid = stored.launcherPid;
  let supervisorPid: number | null = stored.supervisorPid;
  let peer: AcpConnection | undefined;
  let peerChild: RecordedChild | null = stored.peer;
  let firstStderr = "";
  let done = false;
  let timer: Timer | undefined;
  let handoffDeadline: number | undefined;

  const controlDirectory = goalDraftControlDirectory(stateDir, repoDir, draftPath);

  const persist = (): void => {
    writeGoalDraftOwnerState(stateDir, repoDir, draftPath, {
      version: GOAL_DRAFT_OWNER_VERSION,
      run,
      owner,
      peer: peerChild,
      launcherPid,
      supervisorPid,
      updatedAt: new Date().toISOString(),
    });
  };

  const finish = async (status: GoalDraftStatus, error: string | null): Promise<void> => {
    if (done) return;
    done = true;
    clearInterval(timer);
    const closing = peer;
    const closingChild = peerChild;
    peer = undefined;
    peerChild = null;
    run.status = status;
    run.finishedAt = new Date().toISOString();
    run.error = error;
    run.question = null;
    await closePeer(closing, closingChild);
    persist();
    process.exit(0);
  };

  const interrupt = (): void => {
    void finish("failed", GOAL_DRAFT_INTERRUPTED);
  };

  const checkSupervisor = (): void => {
    const lease = readGoalDraftLease(stateDir, repoDir);
    if (lease !== null && pidAlive(lease.pid)) {
      supervisorPid = lease.pid;
      handoffDeadline = undefined;
      return;
    }
    // Another live dashboard may hold this owner's lease while this manager
    // stays alive; losing the lease must not end what the launcher still owns.
    if (launcherPid !== null && pidAlive(launcherPid)) return;
    if (supervisorPid !== null && pidAlive(supervisorPid)) return;
    const handoff = readGoalDraftHandoff(stateDir, repoDir);
    if (handoff !== null) {
      handoffDeadline ??= handoff.at + HANDOFF_GRACE_MS;
      if (Date.now() < handoffDeadline) return;
    }
    interrupt();
  };

  const apply = (command: GoalDraftOwnerCommand): void => {
    if (done) return;
    if (command.type === "interrupt") {
      interrupt();
      return;
    }
    if (command.type === "stop") {
      void finish("stopped", null);
      return;
    }
    if (run.question === null) return;
    if (String(run.question.id) !== String(command.id)) return;
    if (peer === undefined || !peer.answer(command.id, command.value)) return;
    run.question = null;
    persist();
  };

  timer = setInterval(() => {
    if (done) return;
    for (const command of takeGoalDraftOwnerCommands(controlDirectory)) apply(command);
    if (done) return;
    checkSupervisor();
  }, OWNER_CHECK_MS);

  process.on("SIGTERM", interrupt);
  process.on("SIGINT", interrupt);

  try {
    peer = new AcpConnection({
      // The elaboration contract reads the repository directly and names no
      // skill. OMP's background description compression of a loaded skill logs
      // a warning the watchdog files when the selected model cannot serve that
      // request, so this peer discovers none.
      command: `${process.env.AGENT_COMMAND ?? "omp acp"} --no-skills`,
      cwd: repoDir,
      stateDir,
      onActivity: (activity: AcpActivity) => {
        if (done) return;
        appendActivityLine(run.activity, activity.text, activity.append);
        trimActivityLines(run.activity);
        persist();
      },
      onQuestion: (question) => {
        if (done) return;
        run.question = {
          id: question.id,
          message: question.message,
          options: question.options.map((option) => ({
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
            recommended: option.recommended,
          })),
        };
        persist();
      },
      onStderr: (text: string) => {
        if (done) return;
        const line = text
          .split("\n")
          .map((entry) => entry.trim())
          .find((entry) => entry.length > 0);
        if (line !== undefined && firstStderr.length === 0) firstStderr = line;
      },
    });
  } catch (error) {
    await finish("failed", error instanceof Error ? error.message : String(error));
    return;
  }

  const pid = peer.pid;
  peerChild = pid === undefined ? null : { pid, argv: peer.argv, cwd: repoDir };
  persist();

  void peer
    .run(`/goal-draft ${run.path}`)
    .then(() => finish("succeeded", null))
    .catch((error: unknown) => {
      const detail =
        error instanceof Error && error.message.length > 0
          ? error.message
          : firstStderr.length > 0
            ? firstStderr
            : "the elaboration agent ended with an error";
      void finish("failed", detail);
    });
}

if (import.meta.main) {
  void runGoalDraftOwner(process.argv.slice(2));
}
