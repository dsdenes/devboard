import { connection } from "./connection.svelte";
import { queryClient } from "./query-client";
import { queueCounts } from "./issues-queue";
import { notifications } from "./notifications.svelte";
import type {
  IssuesActivityEntry,
  IssuesAgent,
  IssuesLifecycle,
  IssuesRunDetail,
  IssuesRunSummary,
  IssuesSnapshot,
  QueuedIssue,
} from "./types";

export const GOAL_LABEL = "goal";

export function isGoalIssue(issue: { labels?: string[] }): boolean {
  return issue.labels?.includes(GOAL_LABEL) === true;
}

/**
 * True for a deferral line an older harness wrote into `notice`. It describes
 * a start that is not in force, so the Overview never shows it as a notice.
 */
export function isDeferralShaped(text: string): boolean {
  const trimmed = text.trimEnd();
  return trimmed.includes("deferred:") && trimmed.endsWith("the start is deferred");
}

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
  agentActivity = $state<Record<string, string[]>>({});
  run = $state<IssuesRunDetail | null>(null);
  runError = $state<string | null>(null);
  selectedRun = $state<string | null>(null);
  /**
   * The run this connection generation asked history for. A reconnect clears
   * it, so a frame lost while the socket was down is asked for again; the
   * selection never stands in for that answer.
   */
  private requestedRun: string | null = null;
  /** Issue numbers whose close request is still unanswered. */
  closing = $state<number[]>([]);
  /**
   * One revision per issue, bumped by every `issuesClosed` frame whether the
   * server accepted the close or refused it. A row's Close control latches
   * this as its confirming evidence, so a refusal releases that row's label on
   * the frame that carries its reason; `closing` alone never changes on a
   * refusal, because the issue stays in the queue.
   */
  closeAnswers = $state<Record<number, number>>({});
  /**
   * One revision per run, bumped by the frame that answers a dispatched
   * answer: an `issuesState` snapshot after an accepted answer, or the `error`
   * frame of a refused one. An Answer control latches this as its confirming
   * evidence, so a refusal releases its busy word at once instead of waiting
   * for the ceiling.
   */
  private answerRevisions = $state<Record<string, number>>({});
  /** Runs whose answer frame was dispatched and still awaits its reply. */
  private readonly unanswered = new Set<string>();

  /**
   * The number of answering frames for a run's dispatched answer. It never
   * changes until an answer is sent, so an idle control never leaves its
   * resting label.
   */
  answerRevision(runId: string): number {
    return this.answerRevisions[runId] ?? 0;
  }

  /** Settles every dispatched answer the server has now answered. */
  private settleAnswers(): void {
    if (this.unanswered.size === 0) return;
    const next = { ...this.answerRevisions };
    for (const runId of this.unanswered) {
      next[runId] = (next[runId] ?? 0) + 1;
    }
    this.unanswered.clear();
    this.answerRevisions = next;
  }

  /**
   * True once the connect-time replay has named the live agents. A run request
   * made before the replay cannot tell a finished run from a running one.
   */
  get ready(): boolean {
    return this.snapshot !== null;
  }

  get lifecycle(): IssuesLifecycle {
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

  /**
   * The harness version of the worker that owns a run. The run record's own
   * value is authoritative; a live agent carries it for a run record an older
   * server did not annotate.
   */
  versionForRun(runId: string): string | null {
    const agent = this.agentFor(runId);
    if (agent?.harnessVersion != null) return agent.harnessVersion;
    return this.snapshot?.runs.find((run) => run.runId === runId)?.harnessVersion ?? null;
  }

  get notice(): string | null {
    const notice = this.snapshot?.notice ?? null;
    return notice !== null && isDeferralShaped(notice) ? null : notice;
  }

  /** The start the governor defers right now, or null when none waits. */
  get deferral(): string | null {
    return this.snapshot?.deferral ?? null;
  }

  /**
   * True while the dashboard's accepted Start still runs its stop proof,
   * preflight, or spawn. The Start control reads it as the answered state.
   */
  get starting(): boolean {
    return this.snapshot?.starting === true;
  }

  /** Why the last accepted Start spawned nothing, or null. */
  get startError(): string | null {
    return this.snapshot?.startError ?? null;
  }

  /**
   * The Start control's confirming evidence: a start in flight, or the
   * refusal that answered one. Both change on the frame the action changed,
   * so the control leaves its busy word instead of waiting for the ceiling.
   */
  get startEvidence(): string {
    return `${this.starting ? "starting" : "idle"}|${this.startError ?? ""}`;
  }

  /** Open issues waiting for an agent; a running issue is not pending. */
  get pending(): number {
    return queueCounts(this.queue).pending;
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

  get canStart(): boolean {
    return connection.open && !this.enabled && !this.starting;
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

  /**
   * Starts the worker. Returns false when the command never reached the
   * server, so the control releases its label instead of waiting out the
   * ceiling for an answer nothing asked for.
   */
  start(): boolean {
    return connection.send({ type: "startIssues" });
  }

  pause(): boolean {
    return connection.send({ type: "pauseIssues" });
  }

  resume(): boolean {
    return connection.send({ type: "resumeIssues" });
  }

  stop(): boolean {
    return connection.send({ type: "stopIssues" });
  }

  check(): boolean {
    return connection.send({ type: "checkIssues" });
  }

  /**
   * Clears the pending close requests and the run history request before a
   * reconnect's state requests are sent. A close frame lost while the socket
   * was down leaves its issue in `closing` forever, because the replay still
   * lists it as open. The replayed `issuesState` stays authoritative: a close
   * that landed drops the issue from the queue. A history read whose answer
   * never landed is cleared for the same reason: the selection alone never
   * proves the fetch happened, so the focus tab must ask again.
   */
  resetActiveOperations(): void {
    this.closing = [];
    this.requestedRun = null;
  }

  canClose(number: number): boolean {
    return connection.open && !this.closing.includes(number);
  }

  /**
   * The revision of the last answer the server gave for one issue's close,
   * `0` before any. A close control reads it as evidence: every answer, the
   * refusal included, changes it.
   */
  closeRevision(number: number): number {
    return this.closeAnswers[number] ?? 0;
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

  /**
   * Sends one answer to the run that asked it. Returns false when nothing was
   * sent, so the control keeps the typed text and shows no busy word; a
   * dispatch that did send settles `answerRevision` on its answering frame.
   */
  submitAgentAnswer(runId: string, questionId: number | string, value: string): boolean {
    if (value.trim().length === 0) return false;
    if (
      !connection.send({
        type: "answerIssues",
        id: questionId,
        value: value.trim(),
        runId,
      })
    ) {
      return false;
    }
    this.unanswered.add(runId);
    return true;
  }

  /**
   * Requests one run's history. The selection and the requested marker move
   * only after the frame reaches the socket, so a rejected send leaves loadRun
   * free to retry instead of claiming a request that never happened.
   */
  openRun(runId: string): void {
    if (!connection.open) return;
    this.selectedRun = runId;
    this.requestedRun = runId;
    this.run = null;
    this.runError = null;
    // The selected run is a query in the plan; opening it re-reads the stored
    // history instead of sending a per-feature request.
    void queryClient.invalidateQueries({ queryKey: ["getIssuesRun", runId] });
  }

  /**
   * Requests one run's history unless its detail is already loaded or this
   * connection generation already asked for it. The selection is not evidence
   * that the history arrived: `openRun` sets `selectedRun` before the answer
   * lands, so a frame lost to a closed socket would otherwise latch for the
   * tab's whole life. One cleared marker per reconnect yields exactly one
   * request per open transition.
   */
  loadRun(runId: string): void {
    if (this.run?.runId === runId || this.requestedRun === runId) return;
    this.openRun(runId);
  }

  handleEvent(message: Record<string, unknown>): void {
    if (message.type === "error") {
      // The generic error frame is a command's refusal. An answer dispatch
      // still awaiting its reply is refused by it, so release its control
      // instead of leaving it to the ceiling.
      this.settleAnswers();
      return;
    }
    if (isSnapshot(message)) {
      const next = message as unknown as IssuesSnapshot;
      this.snapshot = next;
      this.settleAnswers();
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
      // Every answer changes the evidence a close control latched: a refusal
      // must release that row's label at once instead of holding it until the
      // ceiling, because the refused issue stays in the queue.
      this.closeAnswers = { ...this.closeAnswers, [number]: this.closeRevision(number) + 1 };
      // A successful closure stays pending until the queue no longer lists the
      // issue, so a paused or stopped worker cannot invite a duplicate call.
      if (message.ok === true) {
        notifications.push("Issues", "success", `Closed issue #${number}.`);
      } else {
        this.closing = this.closing.filter((entry) => entry !== number);
        if (typeof message.message === "string") {
          notifications.push("Issues", "error", message.message);
        }
      }
      return;
    }
    if (message.type === "issuesRunMissing") {
      // A run whose history is gone answers its own frame: the focus page
      // renders that as unavailable, and the generic server error channel
      // never raises a notification for a pruned or restored history entry.
      this.runError = "No such issues run.";
      return;
    }
  }
}

export const issues = new IssuesStore();
