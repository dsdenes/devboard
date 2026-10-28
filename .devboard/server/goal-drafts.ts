/**
 * Proposed-goal drafts and their elaboration peers.
 *
 * A draft is unprocessed Markdown under `<REPO_DIR>/.devboard/goal-proposals/`.
 * The Drafts view lists them, shows one verbatim, and can start the harness
 * `/goal-draft <path>` command in one ACP peer per draft path. Several drafts
 * may elaborate at once: the manager keeps one run per path, streams each
 * peer's transcript, answers only the addressed draft, and refuses a second
 * peer for a path that is already running.
 */

import { readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
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
  onActivity: (activity: AcpActivity) => void;
  onQuestion: (question: AcpQuestion) => void;
  onStderr: (text: string) => void;
}

export interface GoalDraftManagerOptions {
  repoDir: string;
  command: string;
  send: (event: unknown) => void;
  /** Injected for tests; defaults to the real ACP client. */
  connect?: (options: GoalDraftPeerOptions) => GoalDraftPeer;
  now?: () => Date;
  log?: (line: string) => void;
}

interface Elaboration {
  path: string;
  /** Undefined only while the peer is being constructed or after it closed. */
  peer: GoalDraftPeer | undefined;
  run: GoalDraftRun;
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

function idleRun(): GoalDraftRun {
  return {
    status: "idle",
    path: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    activity: [],
    question: null,
  };
}

function cloneRun(run: GoalDraftRun): GoalDraftRun {
  return {
    ...run,
    activity: [...run.activity],
    question:
      run.question === null
        ? null
        : { ...run.question, options: run.question.options.map((option) => ({ ...option })) },
  };
}

/** The map key for one draft path; the same normalization the reader applies. */
function draftKey(relativePath: unknown): string | undefined {
  return typeof relativePath === "string" ? relativePath.replace(/\\/g, "/") : undefined;
}

/** One peer per draft path, scoped to one repository; any number may run. */
export class GoalDraftManager {
  private readonly repoDir: string;
  private readonly command: string;
  private readonly send: (event: unknown) => void;
  private readonly connect: (options: GoalDraftPeerOptions) => GoalDraftPeer;
  private readonly clock: () => Date;
  private readonly log: (line: string) => void;

  private readonly elaborations = new Map<string, Elaboration>();

  constructor(options: GoalDraftManagerOptions) {
    this.repoDir = resolve(options.repoDir);
    this.command = options.command;
    this.send = options.send;
    this.connect =
      options.connect ??
      ((peerOptions) => new AcpConnection(peerOptions) as unknown as GoalDraftPeer);
    this.clock = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
  }

  /** One draft's own run; idle when that path never started. */
  snapshotFor(relativePath: string): GoalDraftRun {
    const elaboration = this.elaborations.get(draftKey(relativePath) ?? relativePath);
    return elaboration === undefined ? idleRun() : cloneRun(elaboration.run);
  }

  /** Every draft's own run, sorted by path, for replay after a reconnect. */
  snapshots(): GoalDraftRun[] {
    return [...this.elaborations.values()]
      .map((elaboration) => cloneRun(elaboration.run))
      .sort((left, right) => {
        const leftPath = left.path ?? "";
        const rightPath = right.path ?? "";
        return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
      });
  }

  get running(): boolean {
    return [...this.elaborations.values()].some(
      (elaboration) => elaboration.run.status === "running",
    );
  }

  private publishState(): void {
    this.send({ type: "issuesDraftState", drafts: this.snapshots() });
  }

  publishDrafts(): void {
    this.send({ type: "issuesDrafts", drafts: listGoalDrafts(this.repoDir) });
  }

  /**
   * Ends one elaboration: closes its peer exactly once, then records the next
   * status. The peer is closed here rather than at each call site so a
   * success, a failure, a stop, and a connect failure all release the agent.
   */
  private finish(elaboration: Elaboration, status: GoalDraftStatus, error: string | null): void {
    const peer = elaboration.peer;
    elaboration.peer = undefined;
    if (peer !== undefined) {
      try {
        peer.close();
      } catch {
        // The peer already exited.
      }
    }
    elaboration.run = {
      ...elaboration.run,
      status,
      finishedAt: this.clock().toISOString(),
      error,
      question: null,
    };
    this.publishState();
    this.publishDrafts();
  }

  /**
   * Every live elaboration peer's identity, recorded in the state so a
   * replacement server can end every orphaned child.
   */
  children(): RecordedChild[] {
    const children: RecordedChild[] = [];
    for (const elaboration of this.elaborations.values()) {
      const peer = elaboration.peer;
      const pid = peer?.pid;
      if (peer === undefined || pid === undefined) continue;
      children.push({ pid, argv: peer.argv, cwd: this.repoDir });
    }
    return children;
  }

  start(relativePath: unknown): { ok: true; path: string } | { ok: false; message: string } {
    const key = draftKey(relativePath);
    if (key !== undefined && this.elaborations.get(key)?.run.status === "running") {
      return { ok: false, message: "This draft is being elaborated." };
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

    const elaboration: Elaboration = {
      path: draft.path,
      peer: undefined,
      run: {
        status: "running",
        path: draft.path,
        startedAt: this.clock().toISOString(),
        finishedAt: null,
        error: null,
        activity: [],
        question: null,
      },
      firstStderr: "",
    };
    this.elaborations.set(draft.path, elaboration);

    let peer: GoalDraftPeer;
    try {
      peer = this.connect({
        command: this.command,
        cwd: this.repoDir,
        onActivity: (entry) => {
          if (this.elaborations.get(elaboration.path) !== elaboration) return;
          if (elaboration.run.status !== "running") return;
          appendActivityLine(elaboration.run.activity, entry.text, entry.append);
          trimActivityLines(elaboration.run.activity);
          this.publishState();
        },
        onQuestion: (question) => {
          if (this.elaborations.get(elaboration.path) !== elaboration) return;
          if (elaboration.run.status !== "running") return;
          elaboration.run = {
            ...elaboration.run,
            question: {
              id: question.id,
              message: question.message,
              options: question.options.map((option) => ({
                label: option.label,
                ...(option.description === undefined ? {} : { description: option.description }),
                recommended: option.recommended,
              })),
            },
          };
          this.publishState();
        },
        onStderr: (text) => {
          if (this.elaborations.get(elaboration.path) !== elaboration) return;
          const line = firstLine(text);
          if (line.length > 0 && elaboration.firstStderr.length === 0) {
            elaboration.firstStderr = line;
          }
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.finish(elaboration, "failed", message);
      return { ok: false, message };
    }

    elaboration.peer = peer;
    this.publishState();
    this.publishDrafts();

    void peer
      .run(`/goal-draft ${draft.path}`)
      .then(() => {
        if (this.elaborations.get(elaboration.path) !== elaboration) return;
        if (elaboration.run.status !== "running") return;
        this.finish(elaboration, "succeeded", null);
      })
      .catch((error: unknown) => {
        if (this.elaborations.get(elaboration.path) !== elaboration) return;
        if (elaboration.run.status !== "running") return;
        const detail =
          error instanceof Error && error.message.length > 0
            ? error.message
            : elaboration.firstStderr.length > 0
              ? elaboration.firstStderr
              : "the elaboration agent ended with an error";
        this.finish(elaboration, "failed", detail);
      });

    return { ok: true, path: draft.path };
  }

  stop(relativePath: unknown): boolean {
    const elaboration = this.elaborations.get(draftKey(relativePath) ?? "");
    if (elaboration === undefined || elaboration.run.status !== "running") return false;
    this.finish(elaboration, "stopped", null);
    return true;
  }

  answer(relativePath: unknown, id: number | string, value: string): boolean {
    const elaboration = this.elaborations.get(draftKey(relativePath) ?? "");
    if (elaboration === undefined || elaboration.peer === undefined) return false;
    if (elaboration.run.status !== "running") return false;
    if (elaboration.run.question === null) return false;
    if (String(elaboration.run.question.id) !== String(id)) return false;
    if (!elaboration.peer.answer(id, value)) return false;
    elaboration.run = { ...elaboration.run, question: null };
    this.publishState();
    return true;
  }

  /** Ends every peer without touching the drafts; used when the server stops. */
  dispose(): void {
    for (const elaboration of this.elaborations.values()) {
      const peer = elaboration.peer;
      elaboration.peer = undefined;
      if (peer !== undefined) {
        try {
          peer.close();
        } catch {
          // The peer already exited.
        }
      }
      if (elaboration.run.status === "running") {
        elaboration.run = {
          ...elaboration.run,
          status: "stopped",
          finishedAt: this.clock().toISOString(),
          question: null,
        };
      }
    }
  }
}
