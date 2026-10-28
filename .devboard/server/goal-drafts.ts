/**
 * Proposed-goal drafts and their one elaboration peer.
 *
 * A draft is unprocessed Markdown under `<REPO_DIR>/.devboard/goal-proposals/`.
 * The Drafts view lists them, shows one verbatim, and can start the harness
 * `/goal-draft <path>` command in one ACP peer at a time. The peer itself owns
 * the interview, the goal spec under `.devboard/goals/`, the GitHub issue, and
 * the draft removal; this module only validates paths, streams the transcript,
 * and refuses a second concurrent elaboration.
 *
 * The peer is not a child of this server. A detached owner process
 * (`goal-draft-owner.ts`) holds the agent and persists its run under
 * `STATE_DIR`, so a version reload's replacement attaches to the same agent;
 * any other server exit ends it with an interrupted `failed` run.
 */

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GOAL_PROPOSALS_DIRECTORY } from "./goal-proposal";
import { pidAlive } from "../issues/lock";
import { journalKey } from "./journal";
import {
  GOAL_DRAFT_INTERRUPTED,
  GOAL_DRAFT_OWNER_VERSION,
  goalDraftControlDirectory,
  readGoalDraftHandoff,
  readGoalDraftLease,
  readGoalDraftOwnerState,
  removeGoalDraftHandoff,
  writeGoalDraftHandoff,
  writeGoalDraftLease,
  writeGoalDraftOwnerCommand,
  writeGoalDraftOwnerState,
  type GoalDraftOwnerState,
} from "./goal-draft-owner";
import { recordedChildAlive, type RecordedChild } from "./state";

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
/** The owner is told its supervisor is alive at this cadence, not every poll. */
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

/** One elaboration at a time, scoped to one repository. */
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

  private run: GoalDraftRun = { ...IDLE };
  private state: GoalDraftOwnerState | undefined;
  /** The run whose environment is resolving, before its owner is spawned. */
  private starting: GoalDraftRun | undefined;
  /** True when this dashboard is the owner's supervisor, not an observer. */
  private supervises = false;
  private timer: Timer | undefined;
  private lastLeaseAt = 0;

  constructor(options: GoalDraftManagerOptions) {
    this.repoDir = resolve(options.repoDir);
    this.stateDir = resolve(options.stateDir);
    this.command = options.command;
    this.send = options.send;
    this.environment = options.environment;
    this.clock = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
    this.ownerScript = options.ownerScript ?? join(import.meta.dir, "goal-draft-owner.ts");
    this.spawnOwner =
      options.spawnOwner ??
      ((argv, env) => {
        try {
          const child = spawn(argv[0]!, argv.slice(1), {
            cwd: this.repoDir,
            env,
            detached: true,
            stdio: "ignore",
          });
          child.unref();
          return child.pid;
        } catch (error) {
          this.log(
            `could not start the goal-draft owner: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return undefined;
        }
      });
    this.attach();
    this.timer = setInterval(
      () => this.refresh(),
      Math.max(20, options.pollMs ?? DEFAULT_POLL_MS),
    );
    this.timer.unref?.();
  }

  snapshot(): GoalDraftRun {
    return copyRun(this.run);
  }

  private get controlDirectory(): string {
    return goalDraftControlDirectory(this.stateDir, this.repoDir);
  }

  private ownerAlive(state: GoalDraftOwnerState | undefined = this.state): boolean {
    return state?.owner != null && recordedChildAlive(state.owner);
  }

  private emit(): void {
    this.send({ type: "issuesDraftState", draft: this.snapshot() });
  }

  private writeLease(): void {
    const now = Date.now();
    if (now - this.lastLeaseAt < LEASE_INTERVAL_MS) return;
    this.lastLeaseAt = now;
    writeGoalDraftLease(this.stateDir, this.repoDir, { pid: process.pid, updatedAt: now });
  }

  private persistRun(run: GoalDraftRun, owner: RecordedChild | null): GoalDraftOwnerState {
    const updatedAt = this.clock().toISOString();
    const state: GoalDraftOwnerState = {
      version: GOAL_DRAFT_OWNER_VERSION,
      run: copyRun(run),
      owner,
      peer: null,
      supervisorPid: process.pid,
      updatedAt,
    };
    writeGoalDraftOwnerState(this.stateDir, this.repoDir, state);
    this.state = state;
    this.run = copyRun(run);
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
    writeGoalDraftOwnerState(this.stateDir, this.repoDir, next);
    return next;
  }

  /**
   * Attaches this dashboard to a durable run before it serves the Drafts
   * page. A reload's handoff is adopted; an owner left without a live
   * supervisor is interrupted; another live dashboard's run is only observed.
   */
  private attach(): void {
    const state = readGoalDraftOwnerState(this.stateDir, this.repoDir);
    if (state === undefined) {
      removeGoalDraftHandoff(this.stateDir, this.repoDir);
      return;
    }
    if (state.run.status === "running") {
      if (!this.ownerAlive(state)) {
        this.state = this.markInterrupted(state);
        this.run = copyRun(this.state.run);
        return;
      }
      if (readGoalDraftHandoff(this.stateDir, this.repoDir) !== null) {
        writeGoalDraftLease(this.stateDir, this.repoDir, { pid: process.pid, updatedAt: Date.now() });
        this.lastLeaseAt = Date.now();
        removeGoalDraftHandoff(this.stateDir, this.repoDir);
        this.supervises = true;
      } else {
        const lease = readGoalDraftLease(this.stateDir, this.repoDir);
        if (lease === null || lease.pid === process.pid || !pidAlive(lease.pid)) {
          writeGoalDraftOwnerCommand(this.controlDirectory, { type: "interrupt" });
        }
      }
    } else {
      removeGoalDraftHandoff(this.stateDir, this.repoDir);
    }
    this.state = state;
    this.run = copyRun(state.run);
  }

  /** Re-reads the owner's run; publishes only what changed. */
  private refresh(): void {
    if (this.starting !== undefined) return;
    const previous = this.run;
    const stored = readGoalDraftOwnerState(this.stateDir, this.repoDir);
    if (stored === undefined) {
      if (previous.status === "idle" && previous.activity.length === 0) {
        this.state = undefined;
        return;
      }
      this.state = undefined;
      this.run = { ...IDLE };
      this.emit();
      if (previous.status === "running") this.publishDrafts();
      return;
    }

    const current =
      stored.run.status === "running" && !this.ownerAlive(stored)
        ? this.markInterrupted(stored)
        : stored;
    this.state = current;
    const next = current.run;
    const changed = JSON.stringify(next) !== JSON.stringify(previous);
    this.run = copyRun(next);
    if (changed) {
      this.emit();
      if (previous.status === "running" && next.status !== "running") this.publishDrafts();
    }
    if (this.supervises && next.status === "running") this.writeLease();
  }

  publishDrafts(): void {
    this.send({ type: "issuesDrafts", drafts: listGoalDrafts(this.repoDir) });
  }

  async start(relativePath: unknown): Promise<GoalDraftStartResult> {
    this.refresh();
    if (this.run.status === "running" && (this.starting !== undefined || this.ownerAlive())) {
      return {
        ok: false,
        message: `An elaboration is already running for ${this.run.path}. Stop it before starting another draft.`,
      };
    }
    let draft: GoalDraft;
    try {
      draft = readGoalDraft(this.repoDir, relativePath);
    } catch (error) {
      return {
        ok: false,
        message: error instanceof GoalDraftError ? error.message : String(error),
      };
    }

    removeGoalDraftHandoff(this.stateDir, this.repoDir);
    const startedAt = this.clock().toISOString();
    const run: GoalDraftRun = {
      status: "running",
      path: draft.path,
      startedAt,
      finishedAt: null,
      error: null,
      activity: [],
      question: null,
    };
    this.starting = run;
    this.run = copyRun(run);
    this.emit();
    this.publishDrafts();

    let env: Record<string, string | undefined>;
    try {
      env = await this.environment();
    } catch (error) {
      // A stop outranks a late start failure: the operator's `stopped` state
      // must not become `failed` after the environment rejected.
      if (this.starting !== run) return STOPPED_START;
      this.starting = undefined;
      const message = error instanceof Error ? error.message : String(error);
      this.persistRun(
        {
          ...run,
          status: "failed",
          finishedAt: this.clock().toISOString(),
          error: message,
        },
        null,
      );
      this.emit();
      this.publishDrafts();
      return { ok: false, message };
    }

    // A stop can land while the environment resolves. No owner exists yet, so
    // close nothing and keep the operator's `stopped` state as the final one.
    if (this.starting !== run) return STOPPED_START;
    this.starting = undefined;

    const argv = [
      process.execPath,
      this.ownerScript,
      "--repo",
      this.repoDir,
      "--state-dir",
      this.stateDir,
    ];
    this.persistRun(run, null);
    this.lastLeaseAt = Date.now();
    writeGoalDraftLease(this.stateDir, this.repoDir, {
      pid: process.pid,
      updatedAt: this.lastLeaseAt,
    });

    const pid = this.spawnOwner(argv, {
      ...env,
      AGENT_COMMAND: this.command,
    });
    if (pid === undefined) {
      const message = "the elaboration peer could not be started";
      this.persistRun(
        {
          ...run,
          status: "failed",
          finishedAt: this.clock().toISOString(),
          error: message,
        },
        null,
      );
      this.emit();
      this.publishDrafts();
      return { ok: false, message };
    }

    this.persistRun(run, { pid, argv, cwd: this.repoDir });
    this.supervises = true;
    this.emit();
    this.publishDrafts();
    return { ok: true, path: draft.path };
  }

  stop(): boolean {
    if (this.starting !== undefined) {
      const run = this.starting;
      this.starting = undefined;
      const stopped: GoalDraftRun = {
        ...run,
        status: "stopped",
        finishedAt: this.clock().toISOString(),
        error: null,
        question: null,
      };
      this.persistRun(stopped, null);
      this.emit();
      this.publishDrafts();
      return true;
    }
    this.refresh();
    if (this.run.status !== "running") return false;
    if (!this.ownerAlive()) {
      if (this.state !== undefined) {
        this.state = this.markInterrupted(this.state);
        this.run = copyRun(this.state.run);
        this.emit();
      }
      return false;
    }
    writeGoalDraftOwnerCommand(this.controlDirectory, { type: "stop" });
    return true;
  }

  answer(id: number | string, value: string): boolean {
    this.refresh();
    if (this.run.status !== "running" || this.run.question === null) return false;
    if (String(this.run.question.id) !== String(id)) return false;
    if (!this.ownerAlive()) return false;
    writeGoalDraftOwnerCommand(this.controlDirectory, { type: "answer", id, value });
    return true;
  }

  /**
   * Tells the owner a replacement is coming, so it keeps the agent across the
   * reload. Written before the server stops; only the reload control calls it.
   */
  handoff(): void {
    this.refresh();
    if (!this.supervises) return;
    if (this.run.status !== "running" || !this.ownerAlive()) return;
    writeGoalDraftHandoff(this.stateDir, this.repoDir, { at: Date.now(), pid: process.pid });
  }

  /**
   * Stops observing; a graceful reload keeps the owner for its replacement,
   * and any other stop ends the elaboration with the interrupted failure.
   */
  dispose(handoff = false): void {
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.starting !== undefined) {
      this.starting = undefined;
      if (!handoff) removeGoalDraftHandoff(this.stateDir, this.repoDir);
      return;
    }
    if (!this.supervises) {
      if (!handoff) removeGoalDraftHandoff(this.stateDir, this.repoDir);
      return;
    }
    this.supervises = false;
    if (handoff) return;
    if (this.run.status === "running" && this.ownerAlive()) {
      writeGoalDraftOwnerCommand(this.controlDirectory, { type: "interrupt" });
    }
    removeGoalDraftHandoff(this.stateDir, this.repoDir);
  }
}
