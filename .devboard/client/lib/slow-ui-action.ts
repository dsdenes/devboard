import { slowUiActionIdempotencyKey } from "./notification-issue";
import type { NotificationIssueState } from "./types";

/**
 * The background latency guard: one operator action is measured from its
 * dispatch to its first answer — the frame that answers it, or the action's
 * own HTTP response. An action unanswered at `SLOW_UI_ACTION_BUDGET_MS` files
 * one issue through the existing reporting path, so the slowness is fixed
 * rather than masked. The guard never touches the control's own ceiling, a
 * timer, a request, or a polling interval.
 */

/** The fixed background budget. It never replaces the command ceiling. */
export const SLOW_UI_ACTION_BUDGET_MS = 1000;

/**
 * The instruction every slow-action issue carries. It is fixed, so the Issues
 * worker receives one unambiguous request instead of operator prose.
 */
export const SLOW_UI_ACTION_INSTRUCTION =
  "Do not hide this slowness with a UI trick. Do not add optimistic rendering, a spinner, a skeleton, a cache, a debounce, a retry, a longer timeout, or a relaxed budget. Reproduce the same action, measure which part of the system consumed the time, find the root cause, and fix it systematically. Add a regression test that fails on the slow path. Do not remove, raise, or bypass this detector.";

/** Where one send came from. Only an operator action and a first-paint read are guarded. */
export type SlowUiActionOrigin = "operator" | "initial" | "refresh" | "reconnect";

/** The page context captured when an action is dispatched. */
export interface SlowUiActionContext {
  route: string;
  url: string;
  selector: string;
  domExcerpt: string;
  visibleText: string;
  viewport: string;
  capturedAt: string;
}

/** Completes one action when its own answer arrives, whatever the status. */
export interface SlowUiActionTicket {
  complete(): void;
}

/** One breached action, as the notice card and the report describe it. */
export interface SlowUiActionNotice {
  identity: string;
  command: string;
  subject: string;
  label: string;
  route: string;
  budgetMs: number;
  dispatchedAt: string;
  text: string;
}

/** The card links one breach to its filed issue, or states why it is not filed. */
export interface SlowUiActionSink {
  reportingEnabled(): boolean;
  captureContext(): SlowUiActionContext;
  show(notice: SlowUiActionNotice): number;
  update(notificationId: number, issue: NotificationIssueState): void;
  file(
    report: string,
    idempotencyKey: string,
  ): Promise<{ ok: true; url: string } | { ok: false; error: string }>;
}

interface PendingAction {
  command: Record<string, unknown>;
  http: boolean;
  commandName: string;
  subject: string;
  identity: string;
  label: string;
  route: string;
  dispatchedAt: string;
  timer: ReturnType<typeof setTimeout> | null;
}

interface FilingRecord {
  report: string;
  idempotencyKey: string;
}

/** The fields an action's identity reads from its wire command, in order. */
const SUBJECT_FIELDS = ["id", "run_id", "runId", "path", "name", "url"] as const;

/** The field that confirms one command, when the frame carries one. */
const COMPLETION_SUBJECT: Record<string, string> = {
  startAgent: "id",
  stopAgent: "id",
  setAgentSettings: "id",
  disableAgentTimer: "id",
  refreshAgent: "id",
  getAgent: "id",
  getAgentPrompt: "id",
  startGoalDraft: "path",
  stopGoalDraft: "path",
  answerGoalDraft: "path",
  getGoalDraft: "path",
  deleteGoalDraft: "path",
  getIssuesRun: "runId",
  closeIssue: "number",
  answerIssues: "runId",
};

/** The first inbound frame type that answers each command. */
const RESPONSE_TYPES: Record<string, string[]> = {
  listRecords: ["records"],
  getGoal: ["goal"],
  getProject: ["project"],
  getVersion: ["versionState"],
  getMcpTools: ["mcpTools"],
  getInstalledSkills: ["installedSkills"],
  getComplexity: ["complexityState"],
  setInstalledSkillEnabled: ["installedSkills", "error"],
  getIssues: ["issuesState"],
  getIssuesRun: ["issuesRun", "error"],
  startIssues: ["issuesState", "error"],
  pauseIssues: ["issuesState", "error"],
  resumeIssues: ["issuesState", "error"],
  stopIssues: ["issuesState", "error"],
  checkIssues: ["issuesState", "error"],
  answerIssues: ["issuesState", "error"],
  closeIssue: ["issuesClosed", "error"],
  getGoalDrafts: ["issuesDrafts"],
  getGoalDraft: ["issuesDraftDetail", "issuesDraftError", "error"],
  startGoalDraft: ["issuesDraftState", "issuesDraftError", "error"],
  stopGoalDraft: ["issuesDraftState", "issuesDraftError", "error"],
  deleteGoalDraft: ["issuesDrafts", "error"],
  answerGoalDraft: ["issuesDraftState", "issuesDraftError", "error"],
  getAgents: ["agentsState"],
  getAgent: ["agentState"],
  refreshAgent: ["agentState"],
  startAgent: ["agentState", "error"],
  stopAgent: ["agentState", "error"],
  setAgentSettings: ["agentState", "error"],
  disableAgentTimer: ["agentState", "error"],
  getAgentPrompt: ["agentPromptState"],
  startRun: ["issuesState", "agentState", "error"],
  startLifecycle: ["goalCreationStarted", "skillsPreparationStarted", "implementationResetStarted", "error"],
  stopLifecycle: ["goalCreationStopped", "skillsPreparationStopped", "implementationResetStopped", "error"],
  pauseLifecycle: ["goalCreationStarted", "goalCreationStopped", "goalRevisionStarted", "goalRevisionStopped", "error"],
  resumeLifecycle: ["goalCreationStarted", "goalCreationStopped", "goalRevisionStarted", "goalRevisionStopped", "error"],
  reviseGoal: ["goalRevisionStarted", "goalRevisionStopped", "error"],
  createGoal: ["goalCreationStarted", "goalCreationStopped", "error"],
  prepareSkills: ["skillsPreparationStarted", "skillsPreparationStopped", "error"],
  getSkills: ["skillsState"],
  deleteSkill: ["installedSkills", "error"],
  resetImplementation: ["implementationResetStarted", "implementationResetStopped", "error"],
  createFlowGoal: ["flowGoalStarted", "flowSnapshot", "flowError"],
  cancelFlowGoal: ["flowGoalStopped", "flowSnapshot", "flowError"],
  startFlowImplementation: ["flowSnapshot", "flowError"],
  stopFlowImplementation: ["flowSnapshot", "flowError"],
  retryFlowPr: ["flowSnapshot", "flowError"],
  markFlowPrReady: ["flowSnapshot", "flowError"],
  mergeFlowPr: ["flowSnapshot", "flowError"],
  sendFlowSteering: ["flowSnapshot", "flowError"],
  acceptFlowWidget: ["flowSnapshot", "flowError"],
  refuseFlowWidget: ["flowSnapshot", "flowError"],
  openFlowWidget: ["flowSnapshot", "flowError"],
  closeFlowWidget: ["flowSnapshot", "flowError"],
  sendFlowConversation: ["flowConversationStarted", "flowSnapshot", "flowError"],
  sendFlowConclusion: ["flowSnapshot", "flowError"],
  dismissFlowBlocker: ["flowSnapshot", "flowError"],
  flowAnswer: ["flowSnapshot", "flowError"],
  answer: ["goal", "error"],
  discoverProject: ["discoverStarted", "discoverState", "discoverStopped", "discoverError"],
  discoverAgent: ["discoverState", "discoverError"],
  discoverRemote: ["discoverState", "discoverError"],
  switchDiscoverRemote: ["discoverState", "discoverError"],
  removeDiscoverRemote: ["discoverState", "discoverError"],
  clearDiscoverRemote: ["discoverState", "discoverError"],
  stopDiscover: ["discoverStopped", "discoverState", "discoverError"],
  answerDiscover: ["discoverState", "discoverError"],
  getDiscover: ["discoverState"],
  confirmGlossaryTerm: ["discoverState", "discoverError"],
  rejectGlossaryTerm: ["discoverState", "discoverError"],
  ask: ["askError"],
  closeAsk: ["error"],
  getProviders: ["providersState"],
  saveProvider: ["providersState", "providerError"],
  deleteProvider: ["providersState", "providerError"],
  setProviderEnabled: ["providersState", "providerError"],
  refreshProviders: ["providersState", "providerError"],
  getResources: ["resourcesState"],
  setResources: ["resourcesState", "error"],
};

/**
 * The command's identifying value, or an empty string when it carries none.
 * The field that confirms the action names it: an answering frame echoes that
 * same field, so a subject read from another one could never be matched — an
 * answer carries both the draft path it belongs to and the question id, and
 * only the frame's field confirms it.
 */
export function actionSubject(command: Record<string, unknown>): string {
  const type = command.type;
  const confirming = typeof type === "string" ? COMPLETION_SUBJECT[type] : undefined;
  const fields: readonly string[] =
    confirming === undefined ? SUBJECT_FIELDS : [confirming, ...SUBJECT_FIELDS];
  for (const field of fields) {
    const value = command[field];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

/** `<command>|<subject>|<route>`: elapsed time and timestamps never enter it. */
export function actionIdentity(command: string, subject: string, route: string): string {
  return `${command}|${subject}|${route}`;
}

function capped(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * The report one breach posts. Its first non-empty line becomes the issue
 * title, so the label and budget lead; the command, subject, route, dispatch
 * time, captured UI context, and fixed instruction follow. The whole value
 * stays inside the server's 8000-unit report bound.
 */
export function slowActionReport(
  notice: Pick<
    SlowUiActionNotice,
    "label" | "command" | "subject" | "route" | "budgetMs" | "dispatchedAt"
  >,
  context: SlowUiActionContext,
): string {
  const label = capped(notice.label, 280);
  const first = `Slow UI action: ${label} exceeded the ${notice.budgetMs} ms budget.`;
  const subject = notice.subject.length === 0 ? "(none)" : capped(notice.subject, 280);
  const meta = [
    `Command: ${capped(notice.command, 120)}`,
    `Subject: ${subject}`,
    `Route: ${capped(notice.route, 280)}`,
    `Budget: ${notice.budgetMs} ms`,
    `Dispatched at: ${notice.dispatchedAt}`,
  ].join("\n");
  const ui = [
    "UI context:",
    `URL: ${capped(context.url, 600)}`,
    `Selector: ${capped(context.selector, 240)}`,
    `Viewport: ${capped(context.viewport, 100)}`,
    `Visible text: ${capped(context.visibleText, 1000)}`,
    `DOM excerpt: ${capped(context.domExcerpt, 3000)}`,
    `Captured at: ${context.capturedAt}`,
  ].join("\n");
  return `${first}\n\n${meta}\n\n${ui}\n\n${SLOW_UI_ACTION_INSTRUCTION}`;
}

function frameValue(frame: Record<string, unknown>, key: string): unknown {
  const agent = frame.agent;
  const draft = frame.draft;
  const run = frame.run;
  if (key === "id") {
    if (typeof agent === "object" && agent !== null) {
      const value = (agent as Record<string, unknown>).id;
      if (value !== undefined) return value;
    }
    if (frame.widgetId !== undefined) return frame.widgetId;
    return frame.id;
  }
  if (key === "path") {
    const draftPath =
      typeof draft === "object" && draft !== null
        ? (draft as Record<string, unknown>).path
        : undefined;
    return frame.path ?? draftPath;
  }
  if (key === "runId") {
    const runId =
      typeof run === "object" && run !== null
        ? (run as Record<string, unknown>).runId
        : undefined;
    const draftRunId =
      typeof draft === "object" && draft !== null
        ? (draft as Record<string, unknown>).runId
        : undefined;
    return frame.runId ?? runId ?? draftRunId;
  }
  if (key === "number") return frame.number;
  return frame[key];
}

/** The frame answers this action only when its type and subject both fit. */
function answers(action: PendingAction, frame: Record<string, unknown>): boolean {
  const type = frame.type;
  if (typeof type !== "string") return false;
  // A generic error carries no action identity. Treating it as an answer would
  // let a refusal raised for another command complete this one.
  if (type === "error") return false;
  const expected = RESPONSE_TYPES[action.commandName];
  if (expected === undefined || !expected.includes(type)) return false;
  const key = COMPLETION_SUBJECT[action.commandName];
  if (key === undefined || action.subject.length === 0) return true;
  const value = frameValue(frame, key);
  if (value === undefined || value === null) return true;
  return String(value) === action.subject;
}

/**
 * Tracks operator actions and first-paint reads. It is inert until a sink is
 * installed, so a test or a server-only render never files anything.
 */
export class SlowUiActionGuard {
  #sink: SlowUiActionSink | null = null;
  #budgetMs = SLOW_UI_ACTION_BUDGET_MS;
  #now: () => number = () => Date.now();
  #pending = new Set<PendingAction>();
  /** One card and one automatic POST per identity in this page session. */
  #cards = new Map<string, number>();
  #filings = new Map<number, FilingRecord>();

  install(
    sink: SlowUiActionSink,
    options: { budgetMs?: number; now?: () => number } = {},
  ): void {
    this.#sink = sink;
    this.#budgetMs = options.budgetMs ?? SLOW_UI_ACTION_BUDGET_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Stops tracking entirely; the next page session starts with an empty map. */
  uninstall(): void {
    this.reset();
    this.#sink = null;
    this.#cards.clear();
    this.#filings.clear();
  }

  /**
   * Registers one dispatch unless its origin is a refresh or a reconnect.
   * Returns the ticket its caller completes when the action's own HTTP
   * response arrives, and null when nothing is tracked.
   */
  dispatch(command: unknown, origin: SlowUiActionOrigin): SlowUiActionTicket | null {
    if (this.#sink === null) return null;
    if (origin !== "operator" && origin !== "initial") return null;
    if (typeof command !== "object" || command === null || Array.isArray(command)) return null;
    const record = command as Record<string, unknown>;
    if (typeof record.type !== "string") return null;
    const context = this.#sink.captureContext();
    const subject = actionSubject(record);
    const identity = actionIdentity(record.type, subject, context.route);
    const action: PendingAction = {
      command: record,
      http: false,
      commandName: record.type,
      subject,
      identity,
      label: subject.length === 0 ? record.type : `${record.type} ${subject}`,
      route: context.route,
      dispatchedAt: new Date(this.#now()).toISOString(),
      timer: null,
    };
    action.timer = setTimeout(() => this.#breach(action), this.#budgetMs);
    this.#pending.add(action);
    return { complete: () => this.#finish(action) };
  }

  /**
   * Registers one operator-initiated HTTP mutation. The response, whatever its
   * status, is the first answer; the caller completes the ticket when it
   * arrives. The guard's own filing never comes through here.
   */
  dispatchHttp(endpoint: string): SlowUiActionTicket | null {
    const sink = this.#sink;
    if (sink === null) return null;
    const context = sink.captureContext();
    const action: PendingAction = {
      command: { type: endpoint },
      http: true,
      commandName: endpoint,
      subject: "",
      identity: actionIdentity(endpoint, "", context.route),
      label: endpoint,
      route: context.route,
      dispatchedAt: new Date(this.#now()).toISOString(),
      timer: null,
    };
    action.timer = setTimeout(() => this.#breach(action), this.#budgetMs);
    this.#pending.add(action);
    return { complete: () => this.#finish(action) };
  }

  /** Completes every pending action the frame answers. */
  observe(frame: unknown): void {
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
    const record = frame as Record<string, unknown>;
    if (typeof record.type !== "string") return;
    for (const action of [...this.#pending]) {
      if (action.http || !answers(action, record)) continue;
      this.#finish(action);
    }
  }

  /** Clears pending actions without filing: a reconnect starts no breach. */
  reset(): void {
    for (const action of this.#pending) clearTimeout(action.timer ?? undefined);
    this.#pending.clear();
  }

  /** Retries one failed card's filing with the same report and idempotency key. */
  async retry(notificationId: number): Promise<void> {
    const sink = this.#sink;
    const record = this.#filings.get(notificationId);
    if (sink === null || record === undefined) return;
    if (!sink.reportingEnabled()) {
      sink.update(notificationId, { status: "disabled" });
      return;
    }
    sink.update(notificationId, { status: "pending" });
    await this.#file(notificationId, record);
  }

  #finish(action: PendingAction): void {
    if (action.timer !== null) {
      clearTimeout(action.timer);
      action.timer = null;
    }
    this.#pending.delete(action);
  }

  #breach(action: PendingAction): void {
    action.timer = null;
    if (!this.#pending.delete(action)) return;
    const sink = this.#sink;
    if (sink === null) return;
    if (this.#cards.has(action.identity)) return;
    const context: SlowUiActionContext = sink.captureContext();
    const notice: SlowUiActionNotice = {
      identity: action.identity,
      command: action.commandName,
      subject: action.subject,
      label: action.label,
      route: action.route,
      budgetMs: this.#budgetMs,
      dispatchedAt: action.dispatchedAt,
      text: `Slow UI action: ${action.label} exceeded the ${this.#budgetMs} ms budget.`,
    };
    const notificationId = sink.show(notice);
    this.#cards.set(action.identity, notificationId);
    const record: FilingRecord = {
      report: slowActionReport(notice, context),
      idempotencyKey: slowUiActionIdempotencyKey(action.identity),
    };
    this.#filings.set(notificationId, record);
    if (!sink.reportingEnabled()) {
      sink.update(notificationId, { status: "disabled" });
      return;
    }
    sink.update(notificationId, { status: "pending" });
    void this.#file(notificationId, record);
  }

  async #file(notificationId: number, record: FilingRecord): Promise<void> {
    const sink = this.#sink;
    if (sink === null) return;
    try {
      const outcome = await sink.file(record.report, record.idempotencyKey);
      sink.update(
        notificationId,
        outcome.ok
          ? { status: "filed", href: outcome.url }
          : { status: "failed", detail: outcome.error },
      );
    } catch (error) {
      sink.update(notificationId, {
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const slowUiAction = new SlowUiActionGuard();
