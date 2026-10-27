import { connection } from "./connection.svelte";
import type {
  IssuesActivityEntry,
  IssuesRunDetail,
  IssuesRunSummary,
  IssuesSnapshot,
  QueuedIssue,
} from "./types";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
  activity = $state<string[]>([]);
  run = $state<IssuesRunDetail | null>(null);
  selectedRun = $state<string | null>(null);
  answer = $state("");

  get lifecycle(): string {
    return this.snapshot?.lifecycle ?? "stopped";
  }

  get repo(): string | null {
    return this.snapshot?.repo ?? null;
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

  get question(): IssuesSnapshot["question"] {
    return this.snapshot?.question ?? null;
  }

  get notice(): string | null {
    return this.snapshot?.notice ?? null;
  }

  get pending(): number {
    return this.queue.filter((issue) => !issue.handled).length;
  }

  get activeIssueNumbers(): number[] {
    return this.snapshot?.activeRun?.issueNumbers ?? [];
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

  submitAnswer(value: string): void {
    const question = this.question;
    if (question === null || value.trim().length === 0) return;
    connection.send({ type: "answerIssues", id: question.id, value: value.trim() });
    this.answer = "";
  }

  openRun(runId: string): void {
    this.selectedRun = runId;
    this.run = null;
    connection.send({ type: "getIssuesRun", runId });
  }

  closeRun(): void {
    this.selectedRun = null;
    this.run = null;
  }

  handleEvent(message: Record<string, unknown>): void {
    if (isSnapshot(message)) {
      const next = message as unknown as IssuesSnapshot;
      const previous = this.snapshot?.activeRun?.runId ?? null;
      const active = next.activeRun?.runId ?? null;
      this.snapshot = next;
      if (active !== previous) this.activity = [];
      return;
    }
    if (message.type === "issuesActivity" && typeof message.runId === "string") {
      if (message.runId !== this.snapshot?.activeRun?.runId) return;
      const entries = Array.isArray(message.entries) ? message.entries.filter(isEntry) : [];
      this.activity = applyActivity(this.activity, entries, message.replay === true);
      return;
    }
    if (message.type === "issuesRun" && isObject(message.run)) {
      const run = message.run as unknown as IssuesRunDetail;
      if (typeof run.runId === "string" && Array.isArray(run.activityLines)) {
        this.run = run;
        this.selectedRun = run.runId;
      }
    }
  }
}

export const issues = new IssuesStore();
