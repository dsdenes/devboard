/**
 * Proposed-goal drafts and their elaboration peers.
 *
 * A draft is unprocessed Markdown under `<REPO_DIR>/.devboard/goal-proposals/`.
 * The Drafts view lists them, shows one verbatim, and can start the harness
 * `/goal-draft <path>` command in one ACP peer per draft. Any number of drafts
 * may elaborate at once; each path has at most one live peer. The peer itself
 * owns the interview, the goal spec under `.devboard/goals/`, the GitHub issue,
 * and the draft removal; this module only validates paths, keeps one run record
 * per path, streams each transcript, and refuses only a duplicate start of the
 * path already running.
 *
 * A peer is not a child of this server. One detached owner process per draft
 * (`goal-draft-owner.ts`) holds the agent and persists its run under
 * `STATE_DIR`, so a version reload's replacement attaches to every running
 * owner; any other server exit ends them with interrupted `failed` runs.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  type Dirent,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GOAL_PROPOSALS_DIRECTORY } from "../lib/goal-proposals";
import { pidAlive } from "../issues/lock";
import { supervisedDetach } from "../watchdog/supervision";
import {
  GOAL_DRAFT_INTERRUPTED,
  GOAL_DRAFT_OWNER_VERSION,
  goalDraftControlDirectory,
  listGoalDraftOwnerStates,
  readGoalDraftHandoff,
  readGoalDraftLease,
  removeGoalDraftHandoff,
  resetGoalDraftRun,
  writeGoalDraftHandoff,
  writeGoalDraftLease,
  writeGoalDraftOwnerCommand,
  writeGoalDraftOwnerState,
  type GoalDraftLease,
  type GoalDraftOwnerState,
} from "./goal-draft-owner";
import { canonicalProcessPath, recordedChildAlive, type RecordedChild } from "./process";

export type GoalDraftStatus = "idle" | "running" | "succeeded" | "failed" | "stopped";

export interface GoalDraftSummary {
  /** Repository-relative path with `/` separators. */
  path: string;
  name: string;
  /** The first Markdown heading text, or the empty string when there is none. */
  heading: string;
}

export interface GoalDraft extends GoalDraftSummary {
  text: string;
}

export interface GoalDraftQuestion {
  id: number | string;
  message: string;
  options: Array<{ label: string; description?: string; recommended: boolean }>;
}

export interface GoalDraftRun {
  status: GoalDraftStatus;
  path: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  activity: string[];
  question: GoalDraftQuestion | null;
}

/**
 * The outcome of starting an elaboration. `stopped` marks a start whose
 * environment resolution finished after the operator stopped it: no owner was
 * spawned and the run stays `stopped`.
 */
export type GoalDraftStartResult =
  | { ok: true; path: string }
  | { ok: false; message: string; stopped?: boolean };

/** A refusal the dashboard shows verbatim; nothing is read or started. */
export class GoalDraftError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GoalDraftError";
    this.status = status;
  }
}

/** The first ATX heading line's text, with trailing hashes removed. */
export function goalDraftHeading(text: string): string {
  for (const line of text.split("\n")) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined) {
      const heading = match[1].replace(/\s+#+\s*$/, "").trim();
      if (heading.length > 0) return heading;
    }
  }
  return "";
}

/**
 * Resolves one repository-relative draft path. Only
 * `<GOAL_PROPOSALS_DIRECTORY>/<name>.md` is accepted, the file must exist as a
 * regular file, and its real path must stay directly inside the real drafts
 * directory, so neither traversal nor a symlink can read elsewhere.
 */
export function resolveGoalDraft(
  repoDir: string,
  relativePath: unknown,
): { path: string; name: string; file: string } {
  if (typeof relativePath !== "string") {
    throw new GoalDraftError(400, "A draft path is required.");
  }
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.length === 0 || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/")) {
    throw new GoalDraftError(400, "A draft path must be repository-relative.");
  }
  const parts = normalized.split("/");
  if (
    parts.length !== 3 ||
    parts[0] !== ".devboard" ||
    parts[1] !== "goal-proposals"
  ) {
    throw new GoalDraftError(
      400,
      `A draft path must name a file directly under ${GOAL_PROPOSALS_DIRECTORY}/.`,
    );
  }
  const name = parts[2] ?? "";
  if (name.length === 0 || name === "." || name === ".." || !name.endsWith(".md")) {
    throw new GoalDraftError(400, "A draft path must end in .md.");
  }

  const directory = resolve(repoDir, GOAL_PROPOSALS_DIRECTORY);
  let realDirectory: string;
  try {
    realDirectory = realpathSync(directory);
  } catch {
    throw new GoalDraftError(404, `No draft at ${normalized}.`);
  }
  const candidate = join(directory, name);
  let realFile: string;
  try {
    realFile = realpathSync(candidate);
  } catch {
    throw new GoalDraftError(404, `No draft at ${normalized}.`);
  }
  if (dirname(realFile) !== realDirectory) {
    throw new GoalDraftError(400, `A draft path must stay directly under ${GOAL_PROPOSALS_DIRECTORY}/.`);
  }
  if (!statSync(realFile).isFile()) {
    throw new GoalDraftError(400, "A draft must be a regular file.");
  }
  return { path: `${GOAL_PROPOSALS_DIRECTORY}/${name}`, name, file: realFile };
}

/** Every regular `.md` file directly under the drafts directory, by name. */
export function listGoalDrafts(repoDir: string): GoalDraftSummary[] {
  const directory = resolve(repoDir, GOAL_PROPOSALS_DIRECTORY);
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const drafts: GoalDraftSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    let text: string;
    try {
      text = readFileSync(join(directory, entry.name), "utf8");
    } catch {
      continue;
    }
    drafts.push({
      path: `${GOAL_PROPOSALS_DIRECTORY}/${entry.name}`,
      name: entry.name,
      heading: goalDraftHeading(text),
    });
  }
  return drafts.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/** Reads one draft's bytes exactly, after the same path validation. */
export function readGoalDraft(repoDir: string, relativePath: unknown): GoalDraft {
  const resolved = resolveGoalDraft(repoDir, relativePath);
  let text: string;
  try {
    text = readFileSync(resolved.file, "utf8");
  } catch {
    throw new GoalDraftError(404, `No draft at ${resolved.path}.`);
  }
  return {
    path: resolved.path,
    name: resolved.name,
    heading: goalDraftHeading(text),
    text,
  };
}

export interface GoalDraftManagerOptions {
  repoDir: string;
  stateDir: string;
  command: string;
  send: (event: unknown) => void;
  /** Resolves the selected provider's environment; throws when none is eligible. */
  environment: () => Promise<Record<string, string | undefined>>;
  now?: () => Date;
  log?: (line: string) => void;
  pollMs?: number;
  /** The detached owner script; defaults to this harness's own module. */
  ownerScript?: string;
  /** Test seam: replace the detached owner spawn. */
  spawnOwner?: (argv: string[], env: Record<string, string | undefined>) => number | undefined;
}

const IDLE: GoalDraftRun = {
  status: "idle",
  path: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  activity: [],
  question: null,
};

/** The result of a start the operator stopped before its owner could spawn. */
const STOPPED_START: GoalDraftStartResult = {
  ok: false,
  stopped: true,
  message: "The elaboration was stopped before it started.",
};

const DEFAULT_POLL_MS = 150;
/** The owners are told their supervisor is alive at this cadence, not every poll. */
const LEASE_INTERVAL_MS = 400;

function copyRun(run: GoalDraftRun): GoalDraftRun {
  return {
    ...run,
    activity: [...run.activity],
    question:
      run.question === null
        ? null
        : { ...run.question, options: run.question.options.map((option) => ({ ...option })) },
  };
}

/** One run per draft path, many concurrent elaborations, scoped to one repository. */
export class GoalDraftManager {
  private readonly repoDir: string;
  private readonly stateDir: string;
  private readonly command: string;
  private readonly send: (event: unknown) => void;
  private readonly environment: () => Promise<Record<string, string | undefined>>;
  private readonly clock: () => Date;
  private readonly log: (line: string) => void;
  private readonly ownerScript: string;
  private readonly spawnOwner: NonNullable<GoalDraftManagerOptions["spawnOwner"]>;
  private readonly pollMs: number;

  /** Runs that still matter: every live run plus finished runs whose draft is listed. */
  private readonly runs = new Map<string, GoalDraftRun>();
  /** The runs whose environment is still resolving, before their owner exists. */
  private readonly starting = new Map<string, GoalDraftRun>();
  /** The last durable owner state read for each path. */
  private readonly owners = new Map<string, GoalDraftOwnerState>();
  /** The owners this dashboard launched or adopted across its own reload. */
  private readonly owned = new Set<string>();
  /** Distinguishes this manager's lease from another manager in one process. */
  private readonly instanceId = randomUUID();
  /** True when this dashboard supervises the owners, not merely observes them. */
  private supervises = false;
  /** True once `begin` attached to the state directory; construction touches nothing. */
  private begun = false;
  private timer: Timer | undefined;
  private lastLeaseAt = 0;
  /** The poll failure already logged, so one stuck state directory logs once. */
  private pollFailure: string | null = null;

  constructor(options: GoalDraftManagerOptions) {
    this.repoDir = resolve(options.repoDir);
    this.stateDir = resolve(options.stateDir);
    this.command = options.command;
    this.send = options.send;
    this.environment = options.environment;
    this.clock = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
    this.ownerScript = options.ownerScript ?? join(import.meta.dir, "goal-draft-owner.ts");
    this.pollMs = Math.max(20, options.pollMs ?? DEFAULT_POLL_MS);
    this.spawnOwner =
      options.spawnOwner ??
      ((argv, env) =>
        supervisedDetach(argv, {
          cwd: this.repoDir,
          env,
          stateDir: this.stateDir,
          onError: (error) => {
            this.log(
              `could not start the goal-draft owner: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          },
        }));
  }

  /**
   * Attaches to the durable runs and starts polling. A dashboard that has not
   * bound its port must never call this: attaching adopts a pending reload
   * handoff, writes the lease, and deletes the handoff, so an abandoned bind
   * attempt would take the lease from the manager that finally serves.
   */
  begin(): void {
    if (this.begun) return;
    this.begun = true;
    this.attach();
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  snapshot(): GoalDraftRun[];
  snapshot(path: string): GoalDraftRun;
  snapshot(path?: string): GoalDraftRun[] | GoalDraftRun {
    if (path !== undefined) return copyRun(this.runs.get(path) ?? IDLE);
    const runs: GoalDraftRun[] = [];
    for (const [runPath, run] of this.runs) {
      if (run.status === "running" || existsSync(resolve(this.repoDir, runPath))) {
        runs.push(copyRun(run));
      }
    }
    return runs.sort((left, right) => ((left.path ?? "") < (right.path ?? "") ? -1 : 1));
  }

  isRunning(path: string): boolean {
    const run = this.runs.get(path);
    return run?.status === "running" && (this.starting.has(path) || this.ownerAlive(path));
  }

  private ownerAlive(path: string): boolean {
    const state = this.owners.get(path);
    return state?.owner != null && recordedChildAlive(state.owner);
  }

  /** True when this manager has a live owner of its own to supervise. */
  private hasOwnedRunning(): boolean {
    return [...this.owned].some(
      (path) => this.runs.get(path)?.status === "running" && this.ownerAlive(path),
    );
  }

  private static stateOwnerAlive(state: GoalDraftOwnerState): boolean {
    return state.owner != null && recordedChildAlive(state.owner);
  }

  private emit(path: string): void {
    this.send({ type: "issuesDraftState", draft: this.snapshot(path) });
  }

  publishDrafts(): void {
    this.send({ type: "issuesDrafts", drafts: listGoalDrafts(this.repoDir) });
  }

  private writeLease(): void {
    const now = Date.now();
    if (now - this.lastLeaseAt < LEASE_INTERVAL_MS) return;
    this.lastLeaseAt = now;
    writeGoalDraftLease(this.stateDir, this.repoDir, {
      pid: process.pid,
      updatedAt: now,
      instance: this.instanceId,
    });
  }

  /** True when a live dashboard other than this manager holds the lease. */
  private leaseHeldByAnother(lease: GoalDraftLease | null): boolean {
    if (lease === null || !pidAlive(lease.pid)) return false;
    if (lease.pid !== process.pid) return true;
    return lease.instance !== undefined && lease.instance !== this.instanceId;
  }

  /** Takes supervision only while no live dashboard already holds it. */
  private takeLease(): void {
    if (this.supervises) return;
    if (this.leaseHeldByAnother(readGoalDraftLease(this.stateDir, this.repoDir))) return;
    writeGoalDraftLease(this.stateDir, this.repoDir, {
      pid: process.pid,
      updatedAt: Date.now(),
      instance: this.instanceId,
    });
    this.lastLeaseAt = Date.now();
    this.supervises = true;
  }

  private persistRun(
    path: string,
    run: GoalDraftRun,
    owner: RecordedChild | null,
  ): GoalDraftOwnerState {
    const updatedAt = this.clock().toISOString();
    const state: GoalDraftOwnerState = {
      version: GOAL_DRAFT_OWNER_VERSION,
      run: copyRun(run),
      owner,
      peer: this.owners.get(path)?.peer ?? null,
      launcherPid: process.pid,
      supervisorPid: process.pid,
      updatedAt,
    };
    writeGoalDraftOwnerState(this.stateDir, this.repoDir, path, state);
    this.owners.set(path, state);
    this.runs.set(path, copyRun(run));
    return state;
  }

  /**
   * Records the missing owner's run as the interrupted failure the next
   * dashboard shows; the draft stays in place and startable.
   */
  private markInterrupted(state: GoalDraftOwnerState): GoalDraftOwnerState {
    const updatedAt = this.clock().toISOString();
    const next: GoalDraftOwnerState = {
      ...state,
      run: {
        ...state.run,
        status: "failed",
        finishedAt: updatedAt,
        error: GOAL_DRAFT_INTERRUPTED,
        question: null,
      },
      peer: null,
      updatedAt,
    };
    writeGoalDraftOwnerState(this.stateDir, this.repoDir, next.run.path!, next);
    this.owners.set(next.run.path!, next);
    this.runs.set(next.run.path!, copyRun(next.run));
    return next;
  }

  /**
   * Attaches this dashboard to every durable run before it serves the Drafts
   * page. A reload's handoff adopts each live owner; owners left without a
   * live supervisor are interrupted; another live dashboard's runs are only
   * observed.
   */
  private attach(): void {
    const states = listGoalDraftOwnerStates(this.stateDir, this.repoDir);
    const handoff = readGoalDraftHandoff(this.stateDir, this.repoDir);
    let adoptable = false;
    for (const state of states) {
      const path = state.run.path!;
      this.owners.set(path, state);
      this.runs.set(path, copyRun(state.run));
      if (state.run.status !== "running") continue;
      if (!GoalDraftManager.stateOwnerAlive(state)) {
        this.markInterrupted(state);
        continue;
      }
      if (handoff !== null) {
        adoptable = true;
        this.owned.add(path);
      }
    }

    if (adoptable) {
      writeGoalDraftLease(this.stateDir, this.repoDir, {
        pid: process.pid,
        updatedAt: Date.now(),
        instance: this.instanceId,
      });
      this.lastLeaseAt = Date.now();
      removeGoalDraftHandoff(this.stateDir, this.repoDir);
      this.supervises = true;
      return;
    }

    removeGoalDraftHandoff(this.stateDir, this.repoDir);
    if (this.leaseHeldByAnother(readGoalDraftLease(this.stateDir, this.repoDir))) return;
    for (const state of states) {
      if (state.run.status !== "running") continue;
      if (!GoalDraftManager.stateOwnerAlive(state)) continue;
      if (state.launcherPid !== null && pidAlive(state.launcherPid)) continue;
      writeGoalDraftOwnerCommand(
        goalDraftControlDirectory(this.stateDir, this.repoDir, state.run.path!),
        { type: "interrupt" },
      );
    }
  }

  /**
   * One timer tick. A state write fails on a full, read-only, or
   * permission-changed state directory; the runs already published stay in
   * place, the failure is logged once, and the interval keeps polling so a
   * writable directory recovers without a restart. Explicit start and stop
   * calls keep calling refresh directly, so their caller still reports the
   * error.
   */
  private poll(): void {
    try {
      this.refresh();
      this.pollFailure = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === this.pollFailure) return;
      this.pollFailure = message;
      this.log(`goal-draft poll failed: ${message}`);
    }
  }

  /** Re-reads every owner's run; publishes only what changed. */
  private refresh(): void {
    const states = listGoalDraftOwnerStates(this.stateDir, this.repoDir);
    const seen = new Set<string>();
    let terminalTransition = false;
    for (const stored of states) {
      const path = stored.run.path!;
      seen.add(path);
      if (this.starting.has(path)) continue;
      const previous = this.runs.get(path);
      const current =
        stored.run.status === "running" && !GoalDraftManager.stateOwnerAlive(stored)
          ? this.markInterrupted(stored)
          : stored;
      this.owners.set(path, current);
      const next = current.run;
      if (JSON.stringify(next) === JSON.stringify(previous)) continue;
      this.runs.set(path, copyRun(next));
      this.emit(path);
      if (previous?.status === "running" && next.status !== "running") terminalTransition = true;
    }
    for (const path of [...this.runs.keys()]) {
      if (seen.has(path) || this.starting.has(path)) continue;
      const previous = this.runs.get(path);
      this.runs.delete(path);
      this.owners.delete(path);
      if (previous?.status === "running") terminalTransition = true;
    }
    if (this.supervises) {
      if (this.leaseHeldByAnother(readGoalDraftLease(this.stateDir, this.repoDir))) {
        this.supervises = false;
      }
    } else if (this.hasOwnedRunning()) {
      this.takeLease();
    }
    if (terminalTransition) this.publishDrafts();
    if (this.supervises && [...this.runs.values()].some((run) => run.status === "running")) {
      this.writeLease();
    }
  }

  async start(relativePath: unknown): Promise<GoalDraftStartResult> {
    this.refresh();
    let draft: GoalDraft;
    try {
      draft = readGoalDraft(this.repoDir, relativePath);
    } catch (error) {
      return {
        ok: false,
        message: error instanceof GoalDraftError ? error.message : String(error),
      };
    }
    const path = draft.path;
    if (this.starting.has(path) || (this.runs.get(path)?.status === "running" && this.ownerAlive(path))) {
      return { ok: false, message: "This draft is being elaborated." };
    }

    const startedAt = this.clock().toISOString();
    const run: GoalDraftRun = {
      status: "running",
      path,
      startedAt,
      finishedAt: null,
      error: null,
      activity: [],
      question: null,
    };
    this.starting.set(path, run);
    this.runs.set(path, copyRun(run));
    this.emit(path);
    this.publishDrafts();

    let env: Record<string, string | undefined>;
    try {
      env = await this.environment();
    } catch (error) {
      // A stop outranks a late start failure: the operator's `stopped` state
      // must not become `failed` after the environment rejected.
      if (this.starting.get(path) !== run) return STOPPED_START;
      this.starting.delete(path);
      const message = error instanceof Error ? error.message : String(error);
      this.persistRun(
        path,
        {
          ...run,
          status: "failed",
          finishedAt: this.clock().toISOString(),
          error: message,
        },
        null,
      );
      this.emit(path);
      this.publishDrafts();
      return { ok: false, message };
    }

    // A stop can land while the environment resolves. No owner exists yet, so
    // close nothing and keep the operator's `stopped` state as the final one.
    if (this.starting.get(path) !== run) return STOPPED_START;
    this.starting.delete(path);

    resetGoalDraftRun(this.stateDir, this.repoDir, path);
    this.persistRun(path, run, null);
    this.takeLease();

    const argv = [
      process.execPath,
      this.ownerScript,
      "--repo",
      this.repoDir,
      "--state-dir",
      this.stateDir,
      "--path",
      path,
    ];
    const pid = this.spawnOwner(argv, {
      ...env,
      AGENT_COMMAND: this.command,
    });
    if (pid === undefined) {
      const message = "the elaboration peer could not be started";
      this.persistRun(
        path,
        {
          ...run,
          status: "failed",
          finishedAt: this.clock().toISOString(),
          error: message,
        },
        null,
      );
      this.emit(path);
      this.publishDrafts();
      return { ok: false, message };
    }

    this.persistRun(path, run, { pid, argv, cwd: canonicalProcessPath(this.repoDir) });
    this.owned.add(path);
    this.emit(path);
    this.publishDrafts();
    return { ok: true, path };
  }

  stop(path: string): boolean {
    const starting = this.starting.get(path);
    if (starting !== undefined) {
      this.starting.delete(path);
      const stopped: GoalDraftRun = {
        ...starting,
        status: "stopped",
        finishedAt: this.clock().toISOString(),
        error: null,
        question: null,
      };
      this.persistRun(path, stopped, null);
      this.emit(path);
      this.publishDrafts();
      return true;
    }
    this.refresh();
    const run = this.runs.get(path);
    if (run?.status !== "running") return false;
    if (!this.ownerAlive(path)) {
      const state = this.owners.get(path);
      if (state !== undefined) {
        this.markInterrupted(state);
        this.emit(path);
        this.publishDrafts();
      }
      return false;
    }
    writeGoalDraftOwnerCommand(
      goalDraftControlDirectory(this.stateDir, this.repoDir, path),
      { type: "stop" },
    );
    return true;
  }

  answer(path: string, id: number | string, value: string): boolean {
    this.refresh();
    const run = this.runs.get(path);
    if (run?.status !== "running" || run.question === null) return false;
    if (String(run.question.id) !== String(id)) return false;
    if (!this.ownerAlive(path)) return false;
    writeGoalDraftOwnerCommand(
      goalDraftControlDirectory(this.stateDir, this.repoDir, path),
      { type: "answer", id, value },
    );
    return true;
  }

  /**
   * Removes one draft and its recorded run. A draft whose elaboration is live
   * or still closing stays: its owner is reading that file and would write a
   * goal for a proposal the operator just deleted. The list is republished
   * only after the file and its run state are gone, so no client can select a
   * draft that no longer exists.
   */
  delete(relativePath: unknown): GoalDraftSummary {
    this.refresh();
    const resolved = resolveGoalDraft(this.repoDir, relativePath);
    const draft = readGoalDraft(this.repoDir, resolved.path);
    if (this.isRunning(draft.path) || this.ownerAlive(draft.path)) {
      throw new GoalDraftError(
        409,
        "This draft is being elaborated. Stop the elaboration and delete it again.",
      );
    }
    try {
      unlinkSync(resolved.file);
    } catch {
      throw new GoalDraftError(404, `No draft at ${draft.path}.`);
    }
    resetGoalDraftRun(this.stateDir, this.repoDir, draft.path);
    this.runs.delete(draft.path);
    this.owners.delete(draft.path);
    this.owned.delete(draft.path);
    this.publishDrafts();
    return { path: draft.path, name: draft.name, heading: draft.heading };
  }

  /**
   * Tells the owners a replacement is coming, so they keep their agents across
   * the reload. Written before the server stops; only the reload control calls it.
   */
  handoff(): void {
    this.refresh();
    if (!this.supervises) return;
    if (!this.hasOwnedRunning()) return;
    writeGoalDraftHandoff(this.stateDir, this.repoDir, { at: Date.now(), pid: process.pid });
  }

  /**
   * Stops observing; a graceful reload keeps the owners for its replacement,
   * and any other stop interrupts only the owners this manager launched or
   * adopted, never another live dashboard's elaborations.
   */
  dispose(handoff = false): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.starting.clear();
    if (!this.supervises && this.owned.size === 0) {
      if (!handoff) removeGoalDraftHandoff(this.stateDir, this.repoDir);
      return;
    }
    this.supervises = false;
    if (handoff) return;
    for (const path of this.owned) {
      if (this.runs.get(path)?.status !== "running" || !this.ownerAlive(path)) continue;
      writeGoalDraftOwnerCommand(
        goalDraftControlDirectory(this.stateDir, this.repoDir, path),
        { type: "interrupt" },
      );
    }
    removeGoalDraftHandoff(this.stateDir, this.repoDir);
  }
}
