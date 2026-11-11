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
   */
  resetActiveOperations(): void {
    this.creationActive = false;
    this.revisionActive = false;
    this.skillsPrepActive = false;
    this.runFile = null;
    this.runTitle = null;
    this.runState = "idle";
    this.runStartedAt = null;
    this.manualRunActive = false;
    this.activity = [];
    this.question = null;
    this.draft = "";
  }

  get pendingCount(): number {
    return this.records.filter((record) => record.pending).length;
  }

  get running(): boolean {
    return this.runState === "active";
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
    connection.send({ type: "reviseGoal" });
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

  submitAnswer(value: string): void {
    if (this.question === null) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    const id = this.question.id;
    this.question = null;
    this.draft = "";
    connection.send({ type: "answer", id, value: trimmed });
  }

  submitLaneAnswer(laneId: string, value: string): void {
    const lane = this.lane(laneId);
    if (lane === null || lane.question === null) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    const id = lane.question.id;
    lane.question = null;
    this.laneDraft = "";
    connection.send({ type: "answer", lane: laneId, id, value: trimmed });
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
      this.question = null;
      this.draft = "";
      return;
    }
    if (type === "goalCreationStopped") {
      this.creationActive = false;
      this.question = null;
      this.draft = "";
      if (message.completed === true && typeof message.text === "string") {
        this.goalText = message.text;
        this.goalReady = message.text.trim().length > 0;
      }
      return;
    }
    if (type === "goalRevisionStarted") {
      this.revisionActive = true;
      this.activity = [];
      this.question = null;
      this.draft = "";
      return;
    }
    if (type === "goalRevisionStopped") {
      this.revisionActive = false;
      this.question = null;
      this.draft = "";
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
      this.question = null;
      this.draft = "";
      return;
    }
    if (type === "skillsPreparationStopped") {
      this.skillsPrepActive = false;
      this.question = null;
      this.draft = "";
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
        this.runFile = message.file;
        this.runTitle = message.title;
        this.runAction =
          message.action === "implementing" || message.action === "generating"
            ? message.action
            : "resolving";
        this.runState = "active";
        this.runStartedAt = new Date().toISOString();
        this.manualRunActive = message.manual === true;
        this.activity = [];
        this.question = null;
        this.draft = "";
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
        const laneId = message.lane;
        this.lanes = this.lanes.map((lane) =>
          lane.id === laneId ? { ...lane, question: pending } : lane,
        );
      } else {
        this.question = pending;
        this.draft = "";
      }
      return;
    }

    if (type === "runStopped" && message.lane === undefined) {
      this.runFile = null;
      this.runTitle = null;
      this.runState = "stopped";
      this.runStartedAt = null;
      this.manualRunActive = false;
      this.question = null;
      this.draft = "";
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
