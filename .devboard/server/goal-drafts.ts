/**
 * Proposed-goal drafts and their elaboration peers.
 *
 * A draft is unprocessed Markdown under `<REPO_DIR>/.devboard/goal-proposals/`.
 * The Drafts view lists them, shows one verbatim, and can start the harness
 * `/goal-draft <path>` command in one ACP peer per draft. Any number of drafts
 * may elaborate at once; each path has at most one live peer. The peer itself
 * owns the interview, the goal spec under `.devboard/goals/`, the GitHub issue,
 * and the draft removal; this module validates paths, keeps one run record per
 * path, streams each transcript, and refuses only a duplicate start of the
 * path already running.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  type Dirent,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AcpConnection, type AcpActivity, type AcpQuestion } from "./acp";
import { GOAL_PROPOSALS_DIRECTORY } from "./goal-proposal";
import {
  appendActivityLine,
  trimActivityLines,
} from "../issues/state";
import type { RecordedChild } from "./state";

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
 * environment or peer construction finished after the operator stopped it:
 * the peer was closed without running the prompt and the run stays `stopped`.
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

export interface GoalDraftPeer {
  readonly pid: number | undefined;
  readonly argv: string[];
  run(prompt: string): Promise<unknown>;
  answer(id: number | string, value: string): boolean;
  close(): void;
}

export interface GoalDraftPeerOptions {
  command: string;
  cwd: string;
  env: Record<string, string | undefined>;
  onActivity: (activity: AcpActivity) => void;
  onQuestion: (question: AcpQuestion) => void;
  onStderr: (text: string) => void;
}

export interface GoalDraftManagerOptions {
  repoDir: string;
  command: string;
  send: (event: unknown) => void;
  /** Resolves the selected provider's environment; throws when none is eligible. */
  environment: () => Promise<Record<string, string | undefined>>;
  /** Injected for tests; defaults to the real ACP client. */
  connect?: (options: GoalDraftPeerOptions) => GoalDraftPeer;
  now?: () => Date;
  log?: (line: string) => void;
}

interface Elaboration {
  path: string;
  /** Undefined only while the peer is being constructed. */
  peer: GoalDraftPeer | undefined;
  activity: string[];
  firstStderr: string;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
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

/** The result of a start the operator stopped before its peer could run. */
const STOPPED_START: GoalDraftStartResult = {
  ok: false,
  stopped: true,
  message: "The elaboration was stopped before it started.",
};

/** One run per draft path, many concurrent elaborations, scoped to one repository. */
export class GoalDraftManager {
  private readonly repoDir: string;
  private readonly command: string;
  private readonly send: (event: unknown) => void;
  private readonly environment: () => Promise<Record<string, string | undefined>>;
  private readonly connect: (options: GoalDraftPeerOptions) => GoalDraftPeer;
  private readonly clock: () => Date;
  private readonly log: (line: string) => void;

  /** Runs that still matter: every live run plus finished runs whose draft is listed. */
  private readonly runs = new Map<string, GoalDraftRun>();
  /** The live peer per draft path; at most one per path. */
  private readonly live = new Map<string, Elaboration>();

  constructor(options: GoalDraftManagerOptions) {
    this.repoDir = resolve(options.repoDir);
    this.command = options.command;
    this.send = options.send;
    this.environment = options.environment;
    this.connect =
      options.connect ??
      ((peerOptions) => new AcpConnection(peerOptions) as unknown as GoalDraftPeer);
    this.clock = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
  }

  snapshot(): GoalDraftRun[];
  snapshot(path: string): GoalDraftRun;
  snapshot(path?: string): GoalDraftRun[] | GoalDraftRun {
    if (path !== undefined) return this.copyOf(this.runs.get(path) ?? IDLE);
    const runs: GoalDraftRun[] = [];
    for (const [runPath, run] of this.runs) {
      if (run.status === "running" || existsSync(resolve(this.repoDir, runPath))) {
        runs.push(this.copyOf(run));
      }
    }
    return runs.sort((left, right) => ((left.path ?? "") < (right.path ?? "") ? -1 : 1));
  }

  private copyOf(run: GoalDraftRun): GoalDraftRun {
    return {
      ...run,
      activity: [...run.activity],
      question:
        run.question === null
          ? null
          : { ...run.question, options: run.question.options.map((option) => ({ ...option })) },
    };
  }

  isRunning(path: string): boolean {
    return this.live.has(path);
  }

  private publishRun(path: string): void {
    this.send({ type: "issuesDraftState", draft: this.snapshot(path) });
  }

  publishDrafts(): void {
    this.send({ type: "issuesDrafts", drafts: listGoalDrafts(this.repoDir) });
  }

  /**
   * Ends one elaboration: closes its peer exactly once, then clears it. The
   * peer is closed here rather than at each call site so a success, a
   * failure, a stop, and a connect failure all release the agent process.
   * Other drafts' peers and runs are untouched.
   */
  private finish(path: string, status: GoalDraftStatus, error: string | null): void {
    const elaboration = this.live.get(path);
    this.live.delete(path);
    if (elaboration?.peer !== undefined) {
      try {
        elaboration.peer.close();
      } catch {
        // The peer already exited.
      }
    }
    const run = this.runs.get(path);
    if (run === undefined) return;
    this.runs.set(path, {
      ...run,
      status,
      finishedAt: this.clock().toISOString(),
      error,
      question: null,
    });
    this.publishRun(path);
    this.publishDrafts();
  }

  /**
   * Every running elaboration peer's identity, recorded in the state so a
   * replacement server can end every orphaned child.
   */
  children(): RecordedChild[] {
    const children: RecordedChild[] = [];
    for (const elaboration of this.live.values()) {
      const peer = elaboration.peer;
      const pid = peer?.pid;
      if (peer === undefined || pid === undefined) continue;
      children.push({ pid, argv: peer.argv, cwd: this.repoDir });
    }
    return children;
  }

  async start(relativePath: unknown): Promise<GoalDraftStartResult> {
    let draft: GoalDraft;
    try {
      draft = readGoalDraft(this.repoDir, relativePath);
    } catch (error) {
      return {
        ok: false,
        message: error instanceof GoalDraftError ? error.message : String(error),
      };
    }
    if (this.live.has(draft.path)) {
      return { ok: false, message: "This draft is being elaborated." };
    }

    const path = draft.path;
    const activity: string[] = [];
    const startedAt = this.clock().toISOString();
    this.runs.set(path, {
      status: "running",
      path,
      startedAt,
      finishedAt: null,
      error: null,
      activity,
      question: null,
    });

    const elaboration: Elaboration = {
      path,
      peer: undefined,
      activity,
      firstStderr: "",
    };
    this.live.set(path, elaboration);
    let peer: GoalDraftPeer;
    let env: Record<string, string | undefined>;
    try {
      env = await this.environment();
      peer = this.connect({
        command: this.command,
        cwd: this.repoDir,
        env,
        onActivity: (entry) => {
          if (this.live.get(path) !== elaboration) return;
          const run = this.runs.get(path);
          if (run === undefined) return;
          appendActivityLine(elaboration.activity, entry.text, entry.append);
          trimActivityLines(elaboration.activity);
          this.runs.set(path, { ...run, activity: elaboration.activity });
          this.publishRun(path);
        },
        onQuestion: (question) => {
          if (this.live.get(path) !== elaboration) return;
          const run = this.runs.get(path);
          if (run === undefined) return;
          this.runs.set(path, {
            ...run,
            question: {
              id: question.id,
              message: question.message,
              options: question.options.map((option) => ({
                label: option.label,
                ...(option.description === undefined ? {} : { description: option.description }),
                recommended: option.recommended,
              })),
            },
          });
          this.publishRun(path);
        },
        onStderr: (text) => {
          if (this.live.get(path) !== elaboration) return;
          const line = firstLine(text);
          if (line.length > 0 && elaboration.firstStderr.length === 0) {
            elaboration.firstStderr = line;
          }
        },
      });
    } catch (error) {
      // A stop outranks a late start failure: the operator's `stopped` state
      // must not become `failed` after the environment or connect rejected.
      if (this.live.get(path) !== elaboration) return STOPPED_START;
      this.finish(path, "failed", error instanceof Error ? error.message : String(error));
      return {
        ok: false,
        message:
          this.runs.get(path)?.error ?? "the elaboration peer could not be started",
      };
    }

    // A stop can land while the environment resolves or while `connect`
    // constructs the peer. `finish` could not see that peer, so it was
    // neither closed nor prevented from running; close it here and keep the
    // operator's `stopped` state as the final one.
    if (this.live.get(path) !== elaboration) {
      try {
        peer.close();
      } catch {
        // The peer already exited.
      }
      return STOPPED_START;
    }

    elaboration.peer = peer;
    this.publishRun(path);
    this.publishDrafts();

    void peer
      .run(`/goal-draft ${path}`)
      .then(() => {
        if (this.live.get(path) !== elaboration) return;
        this.finish(path, "succeeded", null);
      })
      .catch((error: unknown) => {
        if (this.live.get(path) !== elaboration) return;
        const detail =
          error instanceof Error && error.message.length > 0
            ? error.message
            : elaboration.firstStderr.length > 0
              ? elaboration.firstStderr
              : "the elaboration agent ended with an error";
        this.finish(path, "failed", detail);
      });

    return { ok: true, path };
  }

  stop(path: string): boolean {
    const elaboration = this.live.get(path);
    if (elaboration === undefined) return false;
    this.finish(path, "stopped", null);
    return true;
  }

  answer(path: string, id: number | string, value: string): boolean {
    const elaboration = this.live.get(path);
    if (elaboration === undefined || elaboration.peer === undefined) return false;
    const run = this.runs.get(path);
    if (run?.question === null || run?.question === undefined) return false;
    if (String(run.question.id) !== String(id)) return false;
    if (!elaboration.peer.answer(id, value)) return false;
    this.runs.set(path, { ...run, question: null });
    this.publishRun(path);
    return true;
  }

  /** Ends every peer without touching the drafts; used when the server stops. */
  dispose(): void {
    const finishedAt = this.clock().toISOString();
    for (const [path, elaboration] of this.live) {
      try {
        elaboration.peer?.close();
      } catch {
        // The peer already exited.
      }
      const run = this.runs.get(path);
      if (run !== undefined) {
        this.runs.set(path, {
          ...run,
          status: "stopped",
          finishedAt,
          question: null,
        });
      }
    }
    this.live.clear();
  }
}
