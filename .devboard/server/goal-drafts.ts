/**
 * Proposed-goal drafts and their one elaboration peer.
 *
 * A draft is unprocessed Markdown under `<REPO_DIR>/.devboard/goal-proposals/`.
 * The Drafts view lists them, shows one verbatim, and can start the harness
 * `/goal-draft <path>` command in one ACP peer at a time. The peer itself owns
 * the interview, the goal spec under `.devboard/goals/`, the GitHub issue, and
 * the draft removal; this module only validates paths, streams the transcript,
 * and refuses a second concurrent elaboration.
 */

import { readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AcpConnection, type AcpActivity, type AcpQuestion } from "./acp";
import { GOAL_PROPOSALS_DIRECTORY } from "./goal-proposal";
import {
  appendActivityLine,
  trimActivityLines,
} from "../issues/state";

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
  peer: GoalDraftPeer;
  activity: string[];
  firstStderr: string;
  startedAt: string;
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

/** One elaboration at a time, scoped to one repository. */
export class GoalDraftManager {
  private readonly repoDir: string;
  private readonly command: string;
  private readonly send: (event: unknown) => void;
  private readonly connect: (options: GoalDraftPeerOptions) => GoalDraftPeer;
  private readonly clock: () => Date;
  private readonly log: (line: string) => void;

  private run: GoalDraftRun = { ...IDLE };
  private current: Elaboration | undefined;

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

  snapshot(): GoalDraftRun {
    return {
      ...this.run,
      activity: [...this.run.activity],
      question:
        this.run.question === null
          ? null
          : { ...this.run.question, options: this.run.question.options.map((option) => ({ ...option })) },
    };
  }

  get running(): boolean {
    return this.run.status === "running";
  }

  private publishActivity(): void {
    this.send({ type: "issuesDraftState", draft: this.snapshot() });
  }

  publishDrafts(): void {
    this.send({ type: "issuesDrafts", drafts: listGoalDrafts(this.repoDir) });
  }

  private finish(status: GoalDraftStatus, error: string | null): void {
    this.current = undefined;
    this.run = {
      ...this.run,
      status,
      finishedAt: this.clock().toISOString(),
      error,
      question: null,
    };
    this.publishActivity();
    this.publishDrafts();
  }

  start(relativePath: unknown): { ok: true; path: string } | { ok: false; message: string } {
    if (this.current !== undefined) {
      const path = this.current.path;
      return {
        ok: false,
        message: `An elaboration is already running for ${path}. Stop it before starting another draft.`,
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

    const activity: string[] = [];
    this.run = {
      status: "running",
      path: draft.path,
      startedAt: this.clock().toISOString(),
      finishedAt: null,
      error: null,
      activity,
      question: null,
    };

    const elaboration: Elaboration = {
      path: draft.path,
      peer: undefined as unknown as GoalDraftPeer,
      activity,
      firstStderr: "",
      startedAt: this.run.startedAt ?? this.clock().toISOString(),
    };
    this.current = elaboration;
    try {
      elaboration.peer = this.connect({
        command: this.command,
        cwd: this.repoDir,
        onActivity: (entry) => {
          if (this.current !== elaboration) return;
          appendActivityLine(elaboration.activity, entry.text, entry.append);
          trimActivityLines(elaboration.activity);
          this.run = { ...this.run, activity: elaboration.activity };
          this.publishActivity();
        },
        onQuestion: (question) => {
          if (this.current !== elaboration) return;
          this.run = {
            ...this.run,
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
          this.publishActivity();
        },
        onStderr: (text) => {
          if (this.current !== elaboration) return;
          const line = firstLine(text);
          if (line.length > 0 && elaboration.firstStderr.length === 0) {
            elaboration.firstStderr = line;
          }
        },
      });
    } catch (error) {
      this.finish("failed", error instanceof Error ? error.message : String(error));
      return { ok: false, message: this.run.error ?? "the elaboration peer could not be started" };
    }

    this.publishActivity();
    this.publishDrafts();

    void elaboration.peer
      .run(`/goal-draft ${draft.path}`)
      .then(() => {
        if (this.current !== elaboration) return;
        this.finish("succeeded", null);
      })
      .catch((error: unknown) => {
        if (this.current !== elaboration) return;
        const detail =
          error instanceof Error && error.message.length > 0
            ? error.message
            : elaboration.firstStderr.length > 0
              ? elaboration.firstStderr
              : "the elaboration agent ended with an error";
        this.finish("failed", detail);
      });

    return { ok: true, path: draft.path };
  }

  stop(): boolean {
    const elaboration = this.current;
    if (elaboration === undefined) return false;
    try {
      elaboration.peer.close();
    } catch {
      // The peer already exited.
    }
    this.finish("stopped", null);
    return true;
  }

  answer(id: number | string, value: string): boolean {
    const elaboration = this.current;
    if (elaboration === undefined) return false;
    if (this.run.question === null) return false;
    if (String(this.run.question.id) !== String(id)) return false;
    if (!elaboration.peer.answer(id, value)) return false;
    this.run = { ...this.run, question: null };
    this.publishActivity();
    return true;
  }

  /** Ends the peer without touching the draft; used when the server stops. */
  dispose(): void {
    const elaboration = this.current;
    if (elaboration === undefined) return;
    try {
      elaboration.peer.close();
    } catch {
      // The peer already exited.
    }
    this.current = undefined;
    this.run = {
      ...this.run,
      status: "stopped",
      finishedAt: this.clock().toISOString(),
      question: null,
    };
  }
}
