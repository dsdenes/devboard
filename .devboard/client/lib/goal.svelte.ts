import { connection } from "./connection.svelte";
import type {
  AdrRecord,
  Lane,
  LaneEpic,
  LifecycleStage,
  LifecycleState,
  RunAction,
  RunQuestion,
  RunQuestionOption,
  SkillContradiction,
  SkillSummary,
} from "./types";

type Message = Record<string, unknown>;

const LIFECYCLE_STAGES = new Set<string>(["goal", "epic", "adr", "implementation", "finished"]);
const LANE_STATUSES = new Set<string>(["running", "paused", "closed", "failed", "retrying", "parked"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

function isRecord(value: unknown): value is AdrRecord {
  return (
    isObject(value) &&
    typeof value.file === "string" &&
    typeof value.title === "string" &&
    typeof value.status === "string" &&
    typeof value.pending === "boolean" &&
    typeof value.summary === "string"
  );
}

function isOption(value: unknown): value is RunQuestionOption {
  return (
    isObject(value) &&
    typeof value.label === "string" &&
    (value.description === undefined || typeof value.description === "string") &&
    typeof value.recommended === "boolean"
  );
}

function isQuestion(value: unknown): value is RunQuestion {
  return (
    isObject(value) &&
    (typeof value.id === "string" || typeof value.id === "number") &&
    typeof value.message === "string" &&
    Array.isArray(value.options) &&
    value.options.every(isOption)
  );
}

function isSkill(value: unknown): value is SkillSummary {
  return (
    isObject(value) &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    (value.family === undefined || value.family === "prepare" || value.family === "discover") &&
    (value.state === undefined ||
      value.state === "generated" ||
      value.state === "edited" ||
      value.state === "missing") &&
    (value.content === undefined || typeof value.content === "string")
  );
}

function isContradiction(value: unknown): value is SkillContradiction {
  return (
    isObject(value) &&
    Array.isArray(value.skills) &&
    value.skills.length === 2 &&
    value.skills.every((name) => typeof name === "string") &&
    Array.isArray(value.directives) &&
    value.directives.length === 2 &&
    value.directives.every((directive) => typeof directive === "string")
  );
}

function isEpic(value: unknown): value is LaneEpic {
  return (
    isObject(value) &&
    typeof value.number === "number" &&
    typeof value.title === "string" &&
    typeof value.url === "string"
  );
}

function isLane(value: unknown): value is Lane {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    (value.kind === "generation" || value.kind === "implementation" || value.kind === "adr") &&
    typeof value.attempt === "number" &&
    typeof value.status === "string" &&
    LANE_STATUSES.has(value.status) &&
    (value.epic === null || isEpic(value.epic)) &&
    (value.record === null ||
      (isObject(value.record) &&
        typeof value.record.file === "string" &&
        typeof value.record.title === "string")) &&
    Array.isArray(value.activity) &&
    value.activity.every(isText) &&
    (value.question === null || isQuestion(value.question))
  );
}

function isLifecycle(value: unknown): value is LifecycleState & Message {
  if (
    !isObject(value) ||
    typeof value.stage !== "string" ||
    !LIFECYCLE_STAGES.has(value.stage) ||
    typeof value.pass !== "number" ||
    typeof value.paused !== "boolean"
  ) {
    return false;
  }
  if (value.work === null) return true;
  return (
    isObject(value.work) &&
    (value.work.kind === "adr" || value.work.kind === "epic") &&
    (typeof value.work.id === "string" || typeof value.work.id === "number")
  );
}

function appendLine(lines: string[], text: string, append: boolean): string[] {
  if (append && lines.length > 0) {
    return [...lines.slice(0, -1), (lines[lines.length - 1] ?? "") + text];
  }
  return [...lines, text];
}

export class GoalStore {
  records = $state<AdrRecord[]>([]);
  next = $state<string | null>(null);

  goalText = $state("");
  goalReady = $state(false);
  creationActive = $state(false);
  revisionActive = $state(false);
  /** Guidance typed for the next revision; one revision consumes the draft. */
  revisionRequest = $state("");
  skillsPrepActive = $state(false);

  runFile = $state<string | null>(null);
  runTitle = $state<string | null>(null);
  runAction = $state<RunAction>("resolving");
  runState = $state<"idle" | "active" | "stopped">("idle");
  /** When this dashboard saw the current run start; the server sends no stamp. */
  runStartedAt = $state<string | null>(null);
  laneStartedAt = $state<Record<string, string>>({});
  manualRunActive = $state(false);
  activity = $state<string[]>([]);
  question = $state<RunQuestion | null>(null);
  draft = $state("");
  laneDraft = $state("");
  /**
   * Bumped by the frame that answers a dispatched answer: the
   * `questionCleared` broadcast of an accepted one, or the `error` frame of a
   * refused one. An answer control latches this as its confirming evidence, so
   * a refusal releases its busy word at once instead of waiting for the
   * ceiling, and neither event costs the prompt or the draft.
   */
  private answers = $state(0);
  /** Answer dispatches that reached the server and await their reply. */
  private answering = 0;

  lifecycle = $state<LifecycleState>({ stage: "goal", pass: 1, work: null, paused: false });
  lifecycleSeen = $state(false);
  lanes = $state<Lane[]>([]);
  openEpics = $state(0);
  runningLanes = $state(0);

  skills = $state<SkillSummary[]>([]);
  contradictions = $state<SkillContradiction[]>([]);

  resetArmed = $state(false);
  resetting = $state(false);
  resetStatus = $state<string | null>(null);

  /**
   * Clears the operation flags before a reconnect's state requests are sent.
   * A stop frame missed during the disconnect otherwise leaves the tab busy.
   * The server replays the started frame of an operation that is still active
   * before answering getGoal and getSkills, so a live operation returns, and
   * it replays a finished run's terminal frame, so that one returns stopped.
   * A reset that ended during the disconnect replays neither frame, so the
   * clear below re-enables Reset, Start/Stop, and skill delete; the replay's
   * started frame restores the flag for a reset that is still live, and the
   * completed reset's report in `resetStatus` survives.
   */
  resetActiveOperations(): void {
    this.creationActive = false;
    this.revisionActive = false;
    this.skillsPrepActive = false;
    this.resetting = false;
    this.runFile = null;
    this.runTitle = null;
    this.runState = "idle";
    this.runStartedAt = null;
    this.manualRunActive = false;
    this.activity = [];
    this.question = null;
    this.draft = "";
    // A frame lost to the closed socket answers no dispatch on this connection
    // generation, so the reconnect owes none.
    this.answering = 0;
  }

  get pendingCount(): number {
    return this.records.filter((record) => record.pending).length;
  }

  get running(): boolean {
    return this.runState === "active";
  }

  /**
   * A question the run cannot advance past: the run-level one, or any lane's.
   * A paused lifecycle keeps a lane's question, so pause never hides it.
   */
  get questionWaiting(): boolean {
    return this.question !== null || this.lanes.some((lane) => lane.question !== null);
  }

  get lifecycleActive(): boolean {
    return (
      this.lifecycleSeen &&
      (this.lifecycle.paused ||
        this.lifecycle.stage === "adr" ||
        this.lifecycle.stage === "implementation" ||
        (this.lifecycle.stage === "epic" && this.lifecycle.work === null))
    );
  }

  get controlsDisabled(): boolean {
    return (
      this.running ||
      this.lifecycleActive ||
      this.revisionActive ||
      this.creationActive ||
      this.skillsPrepActive
    );
  }

  get runStartDisabled(): boolean {
    return (
      this.creationActive ||
      this.revisionActive ||
      this.skillsPrepActive ||
      this.manualRunActive ||
      (!this.lifecycleActive && this.running)
    );
  }

  get runStartTitle(): string | undefined {
    if (this.creationActive) return "Goal creation is active. Wait for it to finish.";
    if (this.revisionActive) return "The goal is being revised. Wait for it to finish.";
    if (this.skillsPrepActive) return "Skills are being prepared. Wait for it to finish.";
    if (this.manualRunActive || (!this.lifecycleActive && this.running)) {
      return "A run is active. Interrupt it before starting another.";
    }
    if (this.lifecycleActive) return "Interrupt the lifecycle and resolve the ADRs manually.";
    return undefined;
  }

  get revisionDisabled(): boolean {
    return (
      this.creationActive ||
      this.skillsPrepActive ||
      this.manualRunActive ||
      (this.lifecycleActive ? !this.lifecycle.paused : this.running)
    );
  }

  get skillsPrepared(): boolean {
    return this.skills.length > 0;
  }

  get prepareDisabled(): boolean {
    return this.controlsDisabled || !this.goalReady;
  }

  get lifecycleButtonDisabled(): boolean {
    if (!connection.open) return true;
    if (this.lifecycleActive) {
      return this.resetting || this.creationActive || this.revisionActive || this.skillsPrepActive;
    }
    return (
      this.resetting ||
      this.controlsDisabled ||
      !this.goalReady ||
      !this.skillsPrepared
    );
  }

  get startLifecycleTitle(): string | undefined {
    if (!this.goalReady) return "Save a non-empty goal before starting the lifecycle.";
    if (!this.skillsPrepared) return "Prepare skills before starting the lifecycle.";
    return undefined;
  }

  get lifecycleButtonTitle(): string | undefined {
    return this.lifecycleActive
      ? "Stop the lifecycle and its current run."
      : this.startLifecycleTitle;
  }

  get resetDisabled(): boolean {
    return !connection.open || this.resetting;
  }

  get activityActive(): boolean {
    return this.running || this.creationActive || this.revisionActive || this.skillsPrepActive;
  }

  get currentAction(): string {
    return this.activity[this.activity.length - 1] ?? "";
  }

  get previousActions(): string[] {
    return this.activity.slice(0, -1);
  }

  get previousActionsLabel(): string {
    const count = this.previousActions.length;
    return count === 1 ? "1 previous action" : `${count} previous actions`;
  }

  get lifecycleWorkTitle(): string | null {
    if (this.lifecycle.work === null) return null;
    if (this.lifecycle.work.kind === "epic") return `Epic #${this.lifecycle.work.id}`;
    return (
      this.records.find((record) => record.file === this.lifecycle.work?.id)?.title ??
      this.lifecycle.work.id
    );
  }

  get lifecycleWorkUrl(): string | null {
    return this.lifecycle.work?.kind === "epic" ? (this.lifecycle.work.url ?? null) : null;
  }

  lane(id: string): Lane | null {
    return this.lanes.find((lane) => lane.id === id) ?? null;
  }

  createGoal(): void {
    connection.send({ type: "createGoal" });
  }

  reviseGoal(): void {
    const request = this.revisionRequest.trim();
    connection.send(request.length > 0 ? { type: "reviseGoal", request } : { type: "reviseGoal" });
  }

  prepareSkills(): void {
    connection.send({ type: "prepareSkills" });
  }

  get skillDeleteDisabled(): boolean {
    return !connection.open || this.controlsDisabled || this.resetting;
  }

  deleteSkill(name: string): void {
    if (this.skillDeleteDisabled) return;
    connection.send({ type: "deleteSkill", name });
  }

  start(target?: string): void {
    connection.send(
      target === undefined ? { type: "startRun" } : { type: "startRun", file: target },
    );
  }

  startRecord(record: AdrRecord): void {
    this.start(record.file === this.next ? undefined : record.file);
  }

  startNext(): void {
    this.start();
  }

  toggleLifecycle(): void {
    connection.send({ type: this.lifecycleActive ? "stopLifecycle" : "startLifecycle" });
  }

  pauseLifecycle(): void {
    connection.send({ type: "pauseLifecycle" });
  }

  resumeLifecycle(): void {
    connection.send({ type: "resumeLifecycle" });
  }

  stopLifecycle(): void {
    connection.send({ type: "stopLifecycle" });
  }

  armReset(): void {
    if (this.resetDisabled) return;
    this.resetArmed = true;
  }

  cancelReset(): void {
    this.resetArmed = false;
  }

  confirmReset(): void {
    if (!this.resetArmed || this.resetDisabled) return;
    connection.send({ type: "resetImplementation" });
  }

  resetImplementation(): void {
    this.armReset();
  }

  /**
   * The number of frames that answered a dispatched answer. It never changes
   * until an answer is sent, so an idle control never leaves its resting label.
   */
  get answerRevision(): number {
    return this.answers;
  }

  /** Settles one dispatched answer the server has now answered. */
  private settleAnswer(): void {
    if (this.answering === 0) return;
    this.answering -= 1;
    this.answers += 1;
  }

  /**
   * Shows the manual run's question. The draft belongs to the question it
   * answers, so it clears only when a different question replaces the one it
   * was typed for; a poll that repeats the same question keeps it.
   */
  private showQuestion(pending: RunQuestion): void {
    if (this.question === null || String(this.question.id) !== String(pending.id)) {
      this.draft = "";
      this.settleAnswer();
    }
    this.question = pending;
  }

  /** Revokes the manual run's question, whose answer was accepted. */
  private dropQuestion(): void {
    this.question = null;
    this.draft = "";
    this.settleAnswer();
  }

  /**
   * Revokes the manual run's question when it is the one an accepted answer
   * named, and reports whether it was. Another question that arrived since is
   * left alone.
   */
  private clearQuestion(id: unknown): boolean {
    if (this.question === null || String(this.question.id) !== String(id)) return false;
    this.dropQuestion();
    return true;
  }

  /** Shows one lane's question, keeping the draft typed for the same one. */
  private showLaneQuestion(laneId: string, pending: RunQuestion): void {
    const lane = this.lane(laneId);
    if (lane === null) return;
    if (lane.question === null || String(lane.question.id) !== String(pending.id)) {
      this.laneDraft = "";
      this.settleAnswer();
    }
    this.lanes = this.lanes.map((entry) =>
      entry.id === laneId ? { ...entry, question: pending } : entry,
    );
  }

  /** Revokes one lane's question an accepted answer named. */
  private clearLaneQuestion(laneId: string, id: unknown): boolean {
    const lane = this.lane(laneId);
    if (lane === null || lane.question === null) return false;
    if (String(lane.question.id) !== String(id)) return false;
    this.lanes = this.lanes.map((entry) =>
      entry.id === laneId ? { ...entry, question: null } : entry,
    );
    this.laneDraft = "";
    this.settleAnswer();
    return true;
  }

  /**
   * Applies the question a `*Started` snapshot carries. A live start names
   * none because it holds none, and the polled replay of a live operation
   * carries the question it still holds or null, so a prompt returns after a
   * reload and one whose answer landed goes away.
   */
  private applySnapshotQuestion(value: unknown): void {
    if (value === undefined || value === null) {
      this.dropQuestion();
      return;
    }
    if (isQuestion(value)) this.showQuestion(value);
  }

  /**
   * Sends one answer to the run that asked it. Returns false when nothing was
   * sent, so the control keeps the draft and shows no busy word. The prompt and
   * the draft stay until a frame proves the answer was accepted, so a refused
   * answer costs neither.
   */
  submitAnswer(value: string): boolean {
    if (this.question === null) return false;
    const trimmed = value.trim();
    if (trimmed.length === 0) return false;
    const id = this.question.id;
    if (!connection.send({ type: "answer", id, value: trimmed })) return false;
    this.answering += 1;
    return true;
  }

  /** The lane counterpart of `submitAnswer`. */
  submitLaneAnswer(laneId: string, value: string): boolean {
    const lane = this.lane(laneId);
    if (lane === null || lane.question === null) return false;
    const trimmed = value.trim();
    if (trimmed.length === 0) return false;
    const id = lane.question.id;
    if (!connection.send({ type: "answer", lane: laneId, id, value: trimmed })) {
      return false;
    }
    this.answering += 1;
    return true;
  }

  laneLabel(lane: Lane): string {
    const base =
      lane.kind === "generation"
        ? "Epic generation"
        : lane.kind === "adr"
          ? (lane.record?.title ?? lane.record?.file ?? "ADR resolution")
          : `Epic #${lane.epic?.number ?? ""}`;
    return lane.attempt > 1 ? `${base} (attempt ${lane.attempt})` : base;
  }

  laneIdentity(lane: Lane): { text: string; url: string | null } {
    if (lane.kind === "generation") return { text: "Epic generation", url: null };
    if (lane.kind === "adr") {
      return { text: `${lane.record?.title ?? ""} (${lane.record?.file ?? ""})`, url: null };
    }
    return { text: lane.epic?.title ?? "", url: lane.epic?.url ?? null };
  }

  handleEvent(message: Message): void {
    const type = message.type;

    if (type === "error") {
      // The generic error frame is a command's refusal. An answer dispatch that
      // still awaits its reply is refused by it, so its control is released at
      // once and the prompt and the draft stay for the retry.
      this.settleAnswer();
      return;
    }

    if (type === "records" && Array.isArray(message.records) && message.records.every(isRecord)) {
      this.records = message.records;
      this.next = typeof message.next === "string" ? message.next : null;
      return;
    }

    if (type === "goal" && typeof message.text === "string") {
      this.goalText = message.text;
      this.goalReady = message.text.trim().length > 0;
      return;
    }

    if (type === "goalCreationStarted") {
      this.creationActive = true;
      this.activity = [];
      this.applySnapshotQuestion(message.question);
      return;
    }
    if (type === "goalCreationStopped") {
      this.creationActive = false;
      this.dropQuestion();
      if (message.completed === true && typeof message.text === "string") {
        this.goalText = message.text;
        this.goalReady = message.text.trim().length > 0;
      }
      return;
    }
    if (type === "goalRevisionStarted") {
      this.revisionActive = true;
      this.revisionRequest = "";
      this.activity = [];
      this.applySnapshotQuestion(message.question);
      return;
    }
    if (type === "goalRevisionStopped") {
      this.revisionActive = false;
      this.revisionRequest = "";
      this.dropQuestion();
      if (message.completed === true && typeof message.text === "string") {
        this.goalText = message.text;
        this.goalReady = message.text.trim().length > 0;
      }
      return;
    }

    if (type === "skillsState") {
      if (
        !this.skillsPrepActive &&
        Array.isArray(message.skills) &&
        message.skills.every(isSkill) &&
        Array.isArray(message.contradictions) &&
        message.contradictions.every(isContradiction)
      ) {
        this.skills = message.skills;
        this.contradictions = message.contradictions;
      }
      return;
    }
    if (type === "skillsPreparationStarted") {
      this.skillsPrepActive = true;
      this.activity = [];
      this.applySnapshotQuestion(message.question);
      return;
    }
    if (type === "skillsPreparationStopped") {
      this.skillsPrepActive = false;
      this.dropQuestion();
      if (
        message.completed === true &&
        Array.isArray(message.skills) &&
        message.skills.every(isSkill)
      ) {
        this.skills = message.skills;
        this.contradictions = Array.isArray(message.contradictions)
          ? message.contradictions.filter(isContradiction)
          : [];
      }
      return;
    }

    if (type === "laneState") {
      if (
        Array.isArray(message.lanes) &&
        message.lanes.every(isLane) &&
        typeof message.openEpics === "number" &&
        typeof message.runningLanes === "number"
      ) {
        // A lane snapshot is authoritative for the question each lane holds:
        // an answer accepted elsewhere, or before a reload, arrives only as a
        // lane without its question, so the draft that answered it goes too.
        const dropped = message.lanes.some((lane) => {
          const before = this.lanes.find((entry) => entry.id === lane.id);
          return (
            before?.question != null &&
            (lane.question === null ||
              String(lane.question.id) !== String(before.question.id))
          );
        });
        if (dropped) {
          this.laneDraft = "";
          this.settleAnswer();
        }
        this.lanes = message.lanes;
        this.openEpics = message.openEpics;
        this.runningLanes = message.runningLanes;
        const starts = { ...this.laneStartedAt };
        let changed = false;
        for (const lane of this.lanes) {
          if (
            (lane.status === "running" || lane.status === "retrying") &&
            starts[lane.id] === undefined
          ) {
            starts[lane.id] = new Date().toISOString();
            changed = true;
          }
        }
        if (changed) this.laneStartedAt = starts;
      }
      return;
    }

    if (type === "runStarted" && message.lane === undefined) {
      if (typeof message.file === "string" && typeof message.title === "string") {
        // The polled getGoal replay re-sends this frame every 2 s for a live
        // run, so only the frame that starts a run the store does not already
        // hold live may stamp it: a second run of the same ADR passes through
        // runStopped (stopped) or resetActiveOperations (idle) first, and a
        // retitled run is still the same run.
        const continued = this.runState === "active" && this.runFile === message.file;
        this.runFile = message.file;
        this.runTitle = message.title;
        this.runAction =
          message.action === "implementing" || message.action === "generating"
            ? message.action
            : "resolving";
        this.runState = "active";
        if (!continued) this.runStartedAt = new Date().toISOString();
        this.manualRunActive = message.manual === true;
        this.activity = [];
        this.applySnapshotQuestion(message.question);
      }
      return;
    }

    if (type === "activity" && typeof message.text === "string") {
      if (typeof message.lane === "string") {
        const laneId = message.lane;
        this.lanes = this.lanes.map((lane) =>
          lane.id === laneId
            ? {
                ...lane,
                activity: appendLine(lane.activity, message.text as string, message.append === true),
              }
            : lane,
        );
      } else {
        this.activity = appendLine(this.activity, message.text, message.append === true);
      }
      return;
    }

    if (type === "question" && isQuestion(message)) {
      const pending: RunQuestion = {
        id: message.id,
        message: message.message,
        options: message.options,
      };
      if (typeof message.lane === "string") {
        this.showLaneQuestion(message.lane, pending);
      } else {
        this.showQuestion(pending);
      }
      return;
    }

    if (type === "questionCleared") {
      // The accepted answer's own frame. A refused one sends only an `error`,
      // so neither the prompt nor the draft leaves before this arrives.
      const cleared =
        typeof message.lane === "string"
          ? this.clearLaneQuestion(message.lane, message.id)
          : this.clearQuestion(message.id);
      if (!cleared) this.settleAnswer();
      return;
    }

    if (type === "runStopped" && message.lane === undefined) {
      this.runFile = null;
      this.runTitle = null;
      this.runState = "stopped";
      this.runStartedAt = null;
      this.manualRunActive = false;
      this.dropQuestion();
      // The polled replay of a finished run carries its last activity lines,
      // because the stop broadcast that would have shown them reaches no page.
      // Assigning them whole keeps every poll from appending a second copy.
      if (Array.isArray(message.activity) && message.activity.every(isText)) {
        this.activity = message.activity;
      }
      return;
    }

    if (type === "implementationResetStarted") {
      this.resetting = true;
      this.resetArmed = false;
      this.resetStatus = null;
      return;
    }
    if (type === "implementationResetStopped") {
      this.resetting = false;
      this.resetArmed = false;
      this.resetStatus =
        message.completed === true
          ? `Reset committed as ${typeof message.commit === "string" ? message.commit : "an unknown commit"}.`
          : "Reset did not complete.";
      return;
    }

    if (type === "lifecycleState" && isLifecycle(message)) {
      this.lifecycle = {
        stage: message.stage as LifecycleStage,
        pass: message.pass,
        work:
          message.work === null
            ? null
            : {
                kind: message.work.kind as "adr" | "epic",
                id: String((message.work as unknown as Record<string, unknown>).id),
                ...(typeof (message.work as unknown as Record<string, unknown>).url === "string"
                  ? { url: (message.work as unknown as Record<string, unknown>).url as string }
                  : {}),
              },
        paused: message.paused,
      } as LifecycleState;
      if (this.lifecycle.stage !== "goal" || this.lifecycle.paused) this.lifecycleSeen = true;
    }
  }
}

export const goal = new GoalStore();
