import { connection } from "./connection.svelte";
import { discover } from "./discover.svelte";
import type {
  AdrRecord,
  Lane,
  LaneEpic,
  LaneStatus,
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
    value.activity.every((line) => typeof line === "string") &&
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
  goalDraft = $state("");
  goalDirty = $state(false);
  goalReady = $state(false);
  /** Text of the save awaiting a `goal` echo; null when nothing is in flight. */
  private pendingGoalSave: string | null = null;
  creationActive = $state(false);
  revisionActive = $state(false);
  revisionRequest = $state("");
  skillsPrepActive = $state(false);

  runFile = $state<string | null>(null);
  runTitle = $state<string | null>(null);
  runAction = $state<RunAction>("resolving");
  runState = $state<"idle" | "active" | "stopped">("idle");
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
  selectedSkill = $state<string | null>(null);
  contradictions = $state<SkillContradiction[]>([]);

  resetArmed = $state(false);
  resetting = $state(false);
  resetStatus = $state<string | null>(null);

  /**
   * Clears the operation flags before a reconnect's state requests are sent.
   * A stop frame missed during the disconnect otherwise leaves the tab busy.
   * The server replays the started frame of an operation that is still active
   * before answering getGoal and getSkills, so a live operation returns.
   */
  resetActiveOperations(): void {
    this.creationActive = false;
    this.revisionActive = false;
    this.skillsPrepActive = false;
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

  selectSkill(name: string | null): void {
    this.selectedSkill = name;
  }

  private keepSelectedSkill(): void {
    if (this.selectedSkill !== null && !this.skills.some((skill) => skill.name === this.selectedSkill)) {
      this.selectedSkill = null;
    }
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

  get goalEditingDisabled(): boolean {
    return (
      (this.lifecycleActive && !this.lifecycle.paused) ||
      this.skillsPrepActive ||
      discover.active ||
      discover.cloning !== null
    );
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

  setGoalDraft(text: string): void {
    this.goalDraft = text;
    this.goalDirty = text !== this.goalText;
    // Editing past the sent text means the server's echo no longer describes
    // the draft, so it must not clear the flag or replace the newer text.
    if (this.pendingGoalSave !== null && text !== this.pendingGoalSave) {
      this.pendingGoalSave = null;
    }
  }

  /**
   * Sends the draft and leaves it dirty: the server refuses a save while other
   * work runs and answers with an `error` frame instead of the confirming
   * `goal` frame, so only that confirmation may clear the flag.
   */
  saveGoal(): void {
    if (!connection.send({ type: "saveGoal", text: this.goalDraft })) return;
    this.pendingGoalSave = this.goalDraft;
  }

  discardDraft(): void {
    this.goalDraft = this.goalText;
    this.goalDirty = false;
    this.pendingGoalSave = null;
  }

  createGoal(): void {
    connection.send({ type: "createGoal" });
  }

  reviseGoal(): void {
    const request = this.revisionRequest.trim();
    connection.send(
      request.length === 0 ? { type: "reviseGoal" } : { type: "reviseGoal", request },
    );
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
      if (!this.revisionActive && !this.creationActive) {
        this.goalText = message.text;
        if (this.pendingGoalSave !== null) {
          // Only the echo of the sent text confirms the save. Any other frame
          // is a reconnect snapshot, another tab, or a refused save's later
          // state, and leaving the draft untouched keeps it unsaved.
          if (message.text === this.pendingGoalSave) {
            this.goalDirty = false;
            this.goalDraft = message.text;
            this.pendingGoalSave = null;
          }
        } else if (!this.goalDirty) {
          this.goalDraft = message.text;
        }
        this.goalReady = message.text.trim().length > 0;
      }
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
        this.goalDraft = message.text;
        this.goalDirty = false;
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
        this.goalDraft = message.text;
        this.goalDirty = false;
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
        this.keepSelectedSkill();
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
        this.keepSelectedSkill();
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
      this.manualRunActive = false;
      this.question = null;
      this.draft = "";
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
