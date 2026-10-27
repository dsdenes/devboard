import { connection } from "./connection.svelte";
import { notifications } from "./notifications.svelte";
import type {
  GoalDraftDetail,
  GoalDraftRun,
  GoalDraftSummary,
  IssuesActivityEntry,
  IssuesAgent,
  IssuesRunDetail,
  IssuesRunSummary,
  IssuesSnapshot,
  QueuedIssue,
} from "./types";

export const GOAL_LABEL = "goal";
export const DRAFT_PATH_KEY = "devboard.issues.draft.v1";
export const DRAFT_PAGE_KEY = "devboard.issues.draftsPage.v1";

export function markDraftsPage(open: boolean): void {
  try {
    if (open) localStorage.setItem(DRAFT_PAGE_KEY, "1");
    else localStorage.removeItem(DRAFT_PAGE_KEY);
  } catch {
    // Storage may be unavailable; the current session still works.
  }
}

export function draftsPageWasOpen(): boolean {
  try {
    return localStorage.getItem(DRAFT_PAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function isGoalIssue(issue: { labels?: string[] }): boolean {
  return issue.labels?.includes(GOAL_LABEL) === true;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readDraftPath(): string | null {
  try {
    const value = localStorage.getItem(DRAFT_PATH_KEY);
    return value === null || value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

function writeDraftPath(path: string | null): void {
  try {
    if (path === null) localStorage.removeItem(DRAFT_PATH_KEY);
    else localStorage.setItem(DRAFT_PATH_KEY, path);
  } catch {
    // Storage may be unavailable; the selection then lasts the session only.
  }
}

function isSnapshot(value: Record<string, unknown>): boolean {
  return (
    value.type === "issuesState" &&
    typeof value.root === "string" &&
    typeof value.lifecycle === "string" &&
    typeof value.enabled === "boolean" &&
    Array.isArray(value.queue) &&
    Array.isArray(value.runs)
  );
}

function isEntry(value: unknown): value is IssuesActivityEntry {
  return isObject(value) && typeof value.text === "string" && typeof value.append === "boolean";
}

function applyActivity(lines: string[], entries: IssuesActivityEntry[], replay: boolean): string[] {
  const next = replay ? [] : [...lines];
  for (const entry of entries) {
    if (entry.append && next.length > 0) next[next.length - 1] += entry.text;
    else next.push(entry.text);
  }
  return next;
}

/**
 * The Issues mode's client state. It never polls: the dashboard replays the
 * worker's snapshot and activity on connect, then streams both as the worker
 * persists them. Controls only send commands.
 */
export class IssuesStore {
  snapshot = $state<IssuesSnapshot | null>(null);
  agentActivity = $state<Record<string, string[]>>({});
  run = $state<IssuesRunDetail | null>(null);
  runError = $state<string | null>(null);
  selectedRun = $state<string | null>(null);
  private requestedRun: string | null = null;
  /** Issue numbers whose close request is still unanswered. */
  closing = $state<number[]>([]);

  drafts = $state<GoalDraftSummary[]>([]);
  draftRun = $state<GoalDraftRun | null>(null);
  draft = $state<GoalDraftDetail | null>(null);
  draftPath = $state<string | null>(readDraftPath());
  draftError = $state<string | null>(null);
  draftAnswer = $state("");

  get lifecycle(): string {
    return this.snapshot?.lifecycle ?? "stopped";
  }

  get repo(): string | null {
    return this.snapshot?.repo ?? null;
  }

  /**
   * The header's origin label. A missing snapshot is not evidence that the
   * checkout has no origin, so only a received snapshot may say so.
   */
  get repoLabel(): string {
    if (this.repo !== null) return this.repo;
    return this.snapshot === null ? "…" : "No GitHub origin";
  }

  get enabled(): boolean {
    return this.snapshot?.enabled === true;
  }

  get paused(): boolean {
    return this.snapshot?.paused === true;
  }

  get running(): boolean {
    return this.lifecycle === "running" || this.lifecycle === "pausing";
  }

  get queue(): QueuedIssue[] {
    return [...(this.snapshot?.queue ?? [])].sort((left, right) => left.number - right.number);
  }

  get runs(): IssuesRunSummary[] {
    return this.snapshot?.runs ?? [];
  }

  get agents(): IssuesAgent[] {
    return [...(this.snapshot?.agents ?? [])].sort(
      (left, right) => left.issueNumber - right.issueNumber,
    );
  }

  activityFor(runId: string): string[] {
    return this.agentActivity[runId] ?? [];
  }

  agentFor(runId: string): IssuesAgent | null {
    return this.snapshot?.agents.find((agent) => agent.runId === runId) ?? null;
  }

  /** The run status a card shows: the live run's status, else its history. */
  statusFor(runId: string): string {
    return this.snapshot?.runs.find((run) => run.runId === runId)?.status ?? "running";
  }

  get notice(): string | null {
    return this.snapshot?.notice ?? null;
  }

  get pending(): number {
    return this.queue.filter((issue) => !issue.handled).length;
  }

  get cooldowns(): Record<string, string> {
    return this.snapshot?.cooldowns ?? {};
  }

  get cooldownCount(): number {
    return Object.keys(this.cooldowns).length;
  }

  get earliestCooldown(): string | null {
    const times = Object.values(this.cooldowns)
      .map((value) => Date.parse(value))
      .filter((value) => Number.isFinite(value));
    if (times.length === 0) return null;
    return new Date(Math.min(...times)).toISOString();
  }

  get draftRunning(): boolean {
    return this.draftRun?.status === "running";
  }

  get draftBusyPath(): string | null {
    return this.draftRunning ? (this.draftRun?.path ?? null) : null;
  }

  get draftStatus(): string {
    return this.draftRun?.status ?? "idle";
  }

  /** The stated reason another draft's start control is disabled, or null. */
  draftStartBlocker(path: string): string | null {
    const busy = this.draftBusyPath;
    if (busy === null) return null;
    return busy === path
      ? "This draft is being elaborated."
      : `An elaboration is running for ${busy}.`;
  }

  refreshDrafts(): void {
    if (!connection.open) return;
    connection.send({ type: "getGoalDrafts" });
  }

  openDraft(path: string): void {
    this.draftPath = path;
    this.draft = null;
    this.draftError = null;
    writeDraftPath(path);
    if (connection.open) connection.send({ type: "getGoalDraft", path });
  }

  clearDraft(): void {
    this.draftPath = null;
    this.draft = null;
    this.draftError = null;
    writeDraftPath(null);
  }

  startDraft(): void {
    const path = this.draftPath;
    if (path === null || this.draftRunning) return;
    this.draftError = null;
    connection.send({ type: "startGoalDraft", path });
  }

  stopDraft(): void {
    if (!this.draftRunning) return;
    connection.send({ type: "stopGoalDraft" });
  }

  submitDraftAnswer(value: string): void {
    const question = this.draftRun?.question ?? null;
    if (question === null || value.trim().length === 0) return;
    connection.send({ type: "answerGoalDraft", id: question.id, value: value.trim() });
    this.draftAnswer = "";
  }

  get canStart(): boolean {
    return connection.open && !this.enabled;
  }

  get canPause(): boolean {
    return this.enabled && !this.paused && this.lifecycle !== "pausing";
  }

  get canResume(): boolean {
    return this.enabled && this.paused && this.lifecycle !== "stopped";
  }

  get canStop(): boolean {
    return this.enabled;
  }

  get canCheck(): boolean {
    return this.enabled && !this.paused;
  }

  start(): void {
    connection.send({ type: "startIssues" });
  }

  pause(): void {
    connection.send({ type: "pauseIssues" });
  }

  resume(): void {
    connection.send({ type: "resumeIssues" });
  }

  stop(): void {
    connection.send({ type: "stopIssues" });
  }

  check(): void {
    connection.send({ type: "checkIssues" });
  }

  canClose(number: number): boolean {
    return connection.open && !this.closing.includes(number);
  }

  /** Closes one issue on the tracker as not planned. */
  closeIssue(number: number): void {
    if (!Number.isInteger(number) || number <= 0) return;
    if (!this.canClose(number)) return;
    this.closing = [...this.closing, number];
    if (!connection.send({ type: "closeIssue", number })) {
      this.closing = this.closing.filter((entry) => entry !== number);
    }
  }

  submitAgentAnswer(runId: string, questionId: number | string, value: string): void {
    if (value.trim().length === 0) return;
    connection.send({
      type: "answerIssues",
      id: questionId,
      value: value.trim(),
      runId,
    });
  }

  openRun(runId: string): void {
    this.selectedRun = runId;
    this.requestedRun = runId;
    this.run = null;
    this.runError = null;
    connection.send({ type: "getIssuesRun", runId });
  }

  /** Fetches one run's history once unless it is already selected. */
  loadRun(runId: string): void {
    if (this.requestedRun === runId && (this.run?.runId === runId || this.selectedRun === runId)) {
      return;
    }
    this.openRun(runId);
  }

  closeRun(): void {
    this.selectedRun = null;
    this.requestedRun = null;
    this.run = null;
  }

  handleEvent(message: Record<string, unknown>): void {
    if (isSnapshot(message)) {
      const next = message as unknown as IssuesSnapshot;
      this.snapshot = next;
      const live = new Set((next.agents ?? []).map((agent) => agent.runId));
      const kept: Record<string, string[]> = {};
      for (const [runId, lines] of Object.entries(this.agentActivity)) {
        if (live.has(runId)) kept[runId] = lines;
      }
      this.agentActivity = kept;
      const open = new Set((next.queue ?? []).map((issue) => issue.number));
      this.closing = this.closing.filter((number) => open.has(number));
      return;
    }
    if (message.type === "issuesActivity" && typeof message.runId === "string") {
      const runId = message.runId;
      const entries = Array.isArray(message.entries) ? message.entries.filter(isEntry) : [];
      if (!(this.snapshot?.agents ?? []).some((agent) => agent.runId === runId)) return;
      this.agentActivity = {
        ...this.agentActivity,
        [runId]: applyActivity(this.agentActivity[runId] ?? [], entries, message.replay === true),
      };
      return;
    }
    if (message.type === "issuesRun" && isObject(message.run)) {
      const run = message.run as unknown as IssuesRunDetail;
      if (typeof run.runId === "string" && Array.isArray(run.activityLines)) {
        this.run = run;
        this.runError = null;
        this.selectedRun = run.runId;
      }
      return;
    }
    if (message.type === "issuesClosed" && typeof message.number === "number") {
      const number = message.number;
      // A successful closure stays pending until the queue no longer lists the
      // issue, so a paused or stopped worker cannot invite a duplicate call.
      if (message.ok === true) {
        notifications.push("success", `Closed issue #${number}.`);
      } else {
        this.closing = this.closing.filter((entry) => entry !== number);
        if (typeof message.message === "string") notifications.push("error", message.message);
      }
      return;
    }
    if (message.type === "error" && message.message === "No such issues run.") {
      this.runError = "No such issues run.";
      return;
    }
    if (message.type === "issuesDrafts" && Array.isArray(message.drafts)) {
      const drafts = (message.drafts as GoalDraftSummary[]).filter(
        (draft) => typeof draft?.path === "string" && typeof draft?.name === "string",
      );
      this.drafts = drafts.sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
      const known = new Set(drafts.map((draft) => draft.path));
      if (this.draftPath !== null && !known.has(this.draftPath)) {
        this.clearDraft();
      }
      return;
    }
    if (message.type === "issuesDraftState" && isObject(message.draft)) {
      const run = message.draft as unknown as GoalDraftRun;
      if (typeof run.status !== "string") return;
      this.draftRun = {
        ...run,
        activity: Array.isArray(run.activity) ? run.activity : [],
        question: (run.question ?? null) as GoalDraftRun["question"],
      };
      if (run.status === "running") this.draftError = null;
      return;
    }
    if (message.type === "issuesDraftDetail" && isObject(message.draft)) {
      const draft = message.draft as unknown as GoalDraftDetail;
      if (typeof draft.path === "string" && typeof draft.text === "string") {
        this.draft = draft;
        this.draftPath = draft.path;
        writeDraftPath(draft.path);
        this.draftError = null;
      }
      return;
    }
    if (message.type === "issuesDraftError" && typeof message.message === "string") {
      // A stored path whose draft is gone opens the list instead of an error.
      if (this.draft === null && this.draftPath !== null && message.message.startsWith("No draft at")) {
        this.clearDraft();
        return;
      }
      this.draftError = message.message;
    }
  }
}

export const issues = new IssuesStore();
