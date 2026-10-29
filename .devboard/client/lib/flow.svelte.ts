import { connection } from "./connection.svelte";
import { notifications } from "./notifications.svelte";
import { saveFeedback } from "./save-feedback.svelte";
import type {
  AnswerTarget,
  FlowBlocker,
  FlowCheckpoint,
  FlowConversation,
  FlowFile,
  FlowGoalCreation,
  FlowHistoryEntry,
  FlowPr,
  FlowSnapshot,
  FlowStatus,
  FlowSteeringNote,
  FlowVerification,
  FlowWidget,
  RunQuestion,
} from "./types";

type Message = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function appendLine(lines: string[], text: string, append: boolean): string[] {
  if (append && lines.length > 0) {
    return [...lines.slice(0, -1), (lines[lines.length - 1] ?? "") + text];
  }
  return [...lines, text];
}

function isHttpUrl(url: string): boolean {
  return url.startsWith("https://") || url.startsWith("http://");
}

export class FlowStore {
  sessionId = $state<string | null>(null);
  status = $state<FlowStatus>("none");
  goal = $state("");
  decisions = $state("");
  worktree = $state<string | null>(null);
  branch = $state<string | null>(null);
  baseRevision = $state<string | null>(null);
  files = $state<FlowFile[]>([]);
  widgets = $state<FlowWidget[]>([]);
  steering = $state<FlowSteeringNote[]>([]);
  checkpoints = $state<FlowCheckpoint[]>([]);
  verification = $state<FlowVerification | null>(null);
  blockers = $state<FlowBlocker[]>([]);
  pr = $state<FlowPr | null>(null);
  prError = $state<string | null>(null);
  leftover = $state<string | null>(null);
  question = $state<RunQuestion | null>(null);
  goalCreation = $state<FlowGoalCreation | null>(null);
  conversation = $state<FlowConversation | null>(null);
  activity = $state<string[]>([]);
  notice = $state<string | null>(null);
  history = $state<FlowHistoryEntry[]>([]);
  errorMessage = $state<string | null>(null);
  noticeMessage = $state<string | null>(null);

  goalDraft = $state("");
  goalDirty = $state(false);
  private pendingGoalSave: string | null = null;
  decisionsDraft = $state("");
  decisionsDirty = $state(false);
  private pendingDecisionsSave: string | null = null;
  steeringDraft = $state("");
  conversationDraft = $state("");
  conclusionDraft = $state("");
  answers = $state<Record<AnswerTarget, string>>({
    goal: "",
    implementation: "",
    conversation: "",
  });

  refusingId = $state<string | null>(null);
  refuseReason = $state("");

  get startDisabled(): boolean {
    return this.status === "merged" || this.status === "running" || this.goal.trim().length === 0;
  }

  get stopDisabled(): boolean {
    return this.status !== "running";
  }

  get readyDisabled(): boolean {
    return !(this.status === "stopped" && this.pr?.state === "draft");
  }

  get mergeDisabled(): boolean {
    return !(this.status === "stopped" && this.pr?.state === "live");
  }

  get conversationStale(): boolean {
    return (
      this.conversation !== null &&
      !this.widgets.some((widget) => widget.id === this.conversation?.widgetId)
    );
  }

  widget(id: string): FlowWidget | null {
    return this.widgets.find((widget) => widget.id === id) ?? null;
  }

  file(path: string): FlowFile | null {
    return this.files.find((file) => file.path === path) ?? null;
  }

  checkpoint(id: string): FlowCheckpoint | null {
    return this.checkpoints.find((checkpoint) => checkpoint.id === id) ?? null;
  }

  detailFiles(widget: FlowWidget): FlowFile[] {
    return widget.files
      .map((path) => this.file(path))
      .filter((file): file is FlowFile => file !== null);
  }

  applySnapshot(message: FlowSnapshot): void {
    this.sessionId = message.sessionId;
    this.status = message.status;
    this.goal = message.goal;
    this.decisions = message.decisions;
    this.worktree = message.worktree;
    this.branch = message.branch;
    this.baseRevision = message.baseRevision;
    this.files = message.files;
    this.widgets = message.widgets;
    this.steering = message.steering;
    this.checkpoints = message.checkpoints;
    this.verification = message.verification;
    this.blockers = message.blockers;
    this.pr = message.pr;
    this.prError = message.prError;
    this.leftover = message.leftover;
    this.question = message.question;
    this.goalCreation = message.goalCreation;
    this.conversation = message.conversation;
    this.activity = message.activity;
    this.notice = message.notice;
    this.history = message.history;
    if (this.pendingGoalSave !== null) {
      // Only a snapshot carrying the sent text confirms the save. A refused
      // save publishes the persisted goal instead, and replacing the draft
      // then would silently discard the operator's unsaved edit.
      if (message.goal === this.pendingGoalSave) {
        this.goalDirty = false;
        this.goalDraft = message.goal;
        this.pendingGoalSave = null;
        saveFeedback.saved("Flow goal saved.");
      }
    } else if (!this.goalDirty) {
      this.goalDraft = message.goal;
    }
    if (this.pendingDecisionsSave !== null) {
      if (message.decisions === this.pendingDecisionsSave) {
        this.decisionsDirty = false;
        this.decisionsDraft = message.decisions;
        this.pendingDecisionsSave = null;
        saveFeedback.saved("Decision board saved.");
      }
    } else if (!this.decisionsDirty) {
      this.decisionsDraft = message.decisions;
    }
  }

  setGoalDraft(text: string): void {
    this.goalDraft = text;
    this.goalDirty = text !== this.goal;
    // Editing past the sent text means the server's echo no longer describes
    // the draft, so it must not clear the flag or replace the newer text.
    if (this.pendingGoalSave !== null && text !== this.pendingGoalSave) {
      this.pendingGoalSave = null;
    }
  }

  setDecisionsDraft(text: string): void {
    this.decisionsDraft = text;
    this.decisionsDirty = text !== this.decisions;
    if (this.pendingDecisionsSave !== null && text !== this.pendingDecisionsSave) {
      this.pendingDecisionsSave = null;
    }
  }

  /**
   * Sends the draft and leaves it dirty: the server refuses a goal save while
   * the implementation runs and answers with a `flowError` frame, so only a
   * snapshot carrying the sent text may clear the flag.
   */
  saveGoal(): void {
    if (!connection.send({ type: "saveFlowGoal", text: this.goalDraft })) return;
    this.pendingGoalSave = this.goalDraft;
  }

  discardDecisionsDraft(): void {
    this.decisionsDraft = this.decisions;
    this.decisionsDirty = false;
    this.pendingDecisionsSave = null;
  }

  /** Sends the board and leaves it dirty until the server's echo confirms it. */
  saveDecisions(): void {
    if (!connection.send({ type: "saveFlowDecisions", text: this.decisionsDraft })) return;
    this.pendingDecisionsSave = this.decisionsDraft;
  }

  createGoal(): void {
    connection.send({ type: "createFlowGoal" });
  }

  startImplementation(): void {
    connection.send({ type: "startFlowImplementation" });
  }

  stopImplementation(): void {
    connection.send({ type: "stopFlowImplementation" });
  }

  toggleWidget(widget: FlowWidget): void {
    connection.send({ type: "acceptFlowWidget", id: widget.id, accepted: !widget.accepted });
  }

  startRefuse(widget: FlowWidget): void {
    this.refusingId = widget.id;
    this.refuseReason = "";
  }

  cancelRefuse(): void {
    this.refusingId = null;
    this.refuseReason = "";
  }

  confirmRefuse(widget: FlowWidget): void {
    connection.send({ type: "refuseFlowWidget", id: widget.id, reason: this.refuseReason });
    this.refusingId = null;
    this.refuseReason = "";
  }

  discuss(widget: FlowWidget): void {
    connection.send({ type: "openFlowWidget", id: widget.id });
  }

  sendSteering(): void {
    const text = this.steeringDraft;
    if (text.trim().length === 0) return;
    connection.send({ type: "sendFlowSteering", text });
    this.steeringDraft = "";
  }

  dismissBlocker(blocker: FlowBlocker): void {
    connection.send({ type: "dismissFlowBlocker", id: blocker.id });
  }

  answerQuestion(pending: RunQuestion, value: string, target: AnswerTarget): void {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    connection.send({ type: "flowAnswer", id: pending.id, value: trimmed, target });
    this.answers[target] = "";
    if (target === "goal" && this.goalCreation !== null) {
      this.goalCreation = { ...this.goalCreation, question: null };
    } else if (target === "conversation" && this.conversation !== null) {
      this.conversation = { ...this.conversation, question: null };
    } else if (target === "implementation") {
      this.question = null;
    }
  }

  sendConversation(): void {
    const text = this.conversationDraft;
    if (text.trim().length === 0) return;
    connection.send({ type: "sendFlowConversation", text });
    this.conversationDraft = "";
  }

  sendConclusion(): void {
    const text = this.conclusionDraft;
    if (text.trim().length === 0) return;
    connection.send({ type: "sendFlowConclusion", text });
  }

  closeConversation(): void {
    connection.send({ type: "closeFlowWidget" });
  }

  retryPr(): void {
    connection.send({ type: "retryFlowPr" });
  }

  markPrReady(): void {
    connection.send({ type: "markFlowPrReady" });
  }

  mergePr(): void {
    connection.send({ type: "mergeFlowPr" });
  }

  isHttpUrl(url: string): boolean {
    return isHttpUrl(url);
  }

  outputTail(output: string): string {
    return output.length > 2000 ? `…${output.slice(-2000)}` : output;
  }

  handleEvent(message: Message): void {
    const type = message.type;

    if (type === "flowSnapshot" && isObject(message)) {
      this.applySnapshot(message as unknown as FlowSnapshot);
      return;
    }
    if (type === "flowGoalStarted") {
      this.goalCreation = { activity: [], question: null };
      this.errorMessage = null;
      return;
    }
    if (type === "flowGoalStopped") {
      this.goalCreation = null;
      if (message.completed === true && typeof message.text === "string") {
        this.goal = message.text;
        this.goalDirty = false;
        this.goalDraft = message.text;
        this.pendingGoalSave = null;
      }
      return;
    }
    if (type === "flowActivity" && typeof message.text === "string") {
      const append = message.append === true;
      if (this.goalCreation !== null) {
        this.goalCreation = {
          ...this.goalCreation,
          activity: appendLine(this.goalCreation.activity, message.text, append),
        };
      } else {
        this.activity = appendLine(this.activity, message.text, append);
      }
      return;
    }
    if (
      type === "flowQuestion" &&
      (typeof message.id === "string" || typeof message.id === "number") &&
      typeof message.message === "string" &&
      Array.isArray(message.options)
    ) {
      const pending = {
        id: message.id,
        message: message.message,
        options: message.options,
      } as RunQuestion;
      if (message.target === "goal") {
        this.goalCreation = {
          activity: this.goalCreation?.activity ?? [],
          question: pending,
        };
      } else if (message.target === "conversation") {
        if (this.conversation !== null) this.conversation = { ...this.conversation, question: pending };
      } else {
        this.question = pending;
      }
      return;
    }
    if (type === "flowNotice" && typeof message.message === "string") {
      this.notice = message.message;
      this.noticeMessage = message.message;
      notifications.push("Flow", "notice", message.message);
      return;
    }
    if (type === "flowImplementationStarted") {
      this.status = "running";
      this.activity = [];
      if (typeof message.sessionId === "string") this.sessionId = message.sessionId;
      if (typeof message.worktree === "string") this.worktree = message.worktree;
      if (typeof message.branch === "string") this.branch = message.branch;
      if (typeof message.baseRevision === "string") this.baseRevision = message.baseRevision;
      return;
    }
    if (type === "flowStopped") {
      if (this.status !== "merged") this.status = "stopped";
      this.question = null;
      return;
    }
    if (type === "flowError" && typeof message.message === "string") {
      this.errorMessage = message.message;
      notifications.push("Flow", "error", message.message);
      return;
    }
    if (type === "flowFiles" && Array.isArray(message.files)) {
      this.files = message.files as FlowFile[];
      return;
    }
    if (type === "flowWidgets" && Array.isArray(message.widgets)) {
      this.widgets = message.widgets as FlowWidget[];
      return;
    }
    if (type === "flowSteering" && Array.isArray(message.notes)) {
      this.steering = message.notes as FlowSteeringNote[];
      return;
    }
    if (type === "flowDecisions" && typeof message.text === "string") {
      this.decisions = message.text;
      if (
        this.pendingDecisionsSave !== null &&
        message.text === this.pendingDecisionsSave
      ) {
        this.decisionsDirty = false;
        this.decisionsDraft = message.text;
        this.pendingDecisionsSave = null;
        saveFeedback.saved("Decision board saved.");
      } else if (!this.decisionsDirty) {
        this.decisionsDraft = message.text;
      }
      return;
    }
    if (type === "flowCheckpoints" && Array.isArray(message.checkpoints)) {
      this.checkpoints = message.checkpoints as FlowCheckpoint[];
      return;
    }
    if (type === "flowVerification") {
      this.verification = (message.verification ?? null) as FlowVerification | null;
      return;
    }
    if (type === "flowBlockers" && Array.isArray(message.blockers)) {
      this.blockers = message.blockers as FlowBlocker[];
      return;
    }
    if (type === "flowPr") {
      this.pr = (message.pr ?? null) as FlowPr | null;
      return;
    }
    if (type === "flowConversationStarted" && typeof message.widgetId === "string") {
      this.conversation = {
        widgetId: message.widgetId,
        messages: [],
        activity: [],
        question: null,
      };
      this.conversationDraft = "";
      this.conclusionDraft = "";
      return;
    }
    if (
      type === "flowConversationStopped" &&
      this.conversation !== null &&
      message.widgetId === this.conversation.widgetId
    ) {
      this.conversation = null;
      return;
    }
    if (
      type === "flowConversationMessage" &&
      this.conversation !== null &&
      (message.role === "developer" || message.role === "agent") &&
      typeof message.text === "string"
    ) {
      this.conversation = {
        ...this.conversation,
        messages: [...this.conversation.messages, { role: message.role, text: message.text }],
      };
      return;
    }
    if (
      type === "flowConversationActivity" &&
      this.conversation !== null &&
      typeof message.text === "string"
    ) {
      this.conversation = {
        ...this.conversation,
        activity: appendLine(this.conversation.activity, message.text, message.append === true),
      };
      return;
    }
    if (
      type === "flowConversationQuestion" &&
      this.conversation !== null &&
      (typeof message.id === "string" || typeof message.id === "number") &&
      typeof message.message === "string" &&
      Array.isArray(message.options)
    ) {
      this.conversation = {
        ...this.conversation,
        question: {
          id: message.id,
          message: message.message,
          options: message.options,
        } as RunQuestion,
      };
    }
  }
}

export const flow = new FlowStore();
