import type {
  DiscoverAgentState,
  IssuesAgent,
  Lane,
  RunQuestion,
} from "./types";

/**
 * The OS notification channel is separate from the in-app `NotificationStore`:
 * it raises one desktop notification per pending agent question, and nothing
 * else. It is driven by the full question set observed after every server
 * frame, so a repeated snapshot, a poll, or a reconnect cannot raise a second
 * notification for a question the page already announced.
 */

export type NotificationPermission = "default" | "granted" | "denied" | "unsupported";

/** What the status-bar control shows. `blocked` is read from the browser. */
export type OsNotificationState = "off" | "on" | "blocked";

export interface OsNotificationMessage {
  title: string;
  body: string;
}

export interface OsNotificationEnvironment {
  /** The browser's current permission, read live rather than persisted. */
  permission(): NotificationPermission;
  /** Asks the browser; a dismissed prompt resolves to `default`. */
  requestPermission(): Promise<NotificationPermission>;
  show(message: OsNotificationMessage): void;
  readEnabled(): boolean;
  writeEnabled(enabled: boolean): void;
}

/** One pending question with the identity that dedupes it across snapshots. */
export interface PendingQuestion {
  /** Stable across every snapshot of the same pending question in a run. */
  key: string;
  /** The agent or surface that asked, for the notification's title. */
  label: string;
  /** The question the agent is waiting on. */
  message: string;
}

export interface GoalQuestionSource {
  question: RunQuestion | null;
  lanes: readonly Lane[];
  creationActive: boolean;
  revisionActive: boolean;
  skillsPrepActive: boolean;
  manualRunActive: boolean;
  runFile: string | null;
  runTitle: string | null;
  laneLabel(lane: Lane): string;
}

export interface DiscoverQuestionSource {
  question: RunQuestion | null;
  agentQuestions: Record<string, RunQuestion | null>;
  agents: readonly DiscoverAgentState[];
  runId: string | null;
  /** True while a Discover run owns the cards; a stopped run keeps no question. */
  active: boolean;
}

export interface FlowQuestionSource {
  sessionId: string | null;
  status: string;
  question: RunQuestion | null;
  goalCreation: { question: RunQuestion | null } | null;
  conversation: { widgetId: string; question: RunQuestion | null } | null;
  widgets: readonly { id: string; concept: string }[];
}

export interface IssuesQuestionSource {
  agents: readonly IssuesAgent[];
  draftRuns: Record<string, { path: string | null; status: string; question: RunQuestion | null }>;
  drafts: readonly { path: string; name: string }[];
}

export interface QuestionSources {
  goal: GoalQuestionSource;
  discover: DiscoverQuestionSource;
  flow: FlowQuestionSource;
  issues: IssuesQuestionSource;
}

export const NOTIFICATION_TITLE = "devboard";

export const ENABLED_KEY = "devboard.osNotifications.v1";

/**
 * The identity includes the run the question belongs to and the question
 * itself, so equal numeric ids in two runs stay distinct and a new question in
 * the same run still announces itself.
 */
function pending(key: string, label: string, question: RunQuestion): PendingQuestion {
  return {
    key: `${key}|${String(question.id)}|${question.message}`,
    label,
    message: question.message,
  };
}

function goalQuestions(goal: GoalQuestionSource): PendingQuestion[] {
  const questions: PendingQuestion[] = [];
  for (const lane of goal.lanes) {
    if (lane.question === null) continue;
    questions.push(
      pending(`goal:lane:${lane.id}`, `Goal lane · ${goal.laneLabel(lane)}`, lane.question),
    );
  }
  const question = goal.question;
  if (question === null) return questions;
  if (goal.creationActive) {
    questions.push(pending("goal:creation", "Goal creation", question));
  } else if (goal.revisionActive) {
    questions.push(pending("goal:revision", "Goal revision", question));
  } else if (goal.skillsPrepActive) {
    questions.push(pending("goal:skills", "Skills preparation", question));
  } else {
    const run = goal.runFile ?? goal.runTitle ?? (goal.manualRunActive ? "manual" : "");
    questions.push(pending(`goal:run:${run}`, "Manual goal run", question));
  }
  return questions;
}

function discoverQuestions(discover: DiscoverQuestionSource): PendingQuestion[] {
  // A stopped run leaves the last question on its agent record, but nothing is
  // waiting on the operator any more.
  if (!discover.active) return [];
  const questions: PendingQuestion[] = [];
  const agents = new Map(discover.agents.map((agent) => [agent.id, agent]));
  const asking = Object.keys(discover.agentQuestions).sort();
  for (const id of asking) {
    const question = discover.agentQuestions[id];
    if (question === null || question === undefined) continue;
    const agent = agents.get(id);
    if (agent !== undefined && agent.state !== "running") continue;
    questions.push(
      pending(`discover:agent:${id}`, `Discover agent · ${agent?.label ?? id}`, question),
    );
  }
  const question = discover.question;
  if (
    question !== null &&
    !questions.some(
      (entry) => entry.key.endsWith(`|${String(question.id)}|${question.message}`),
    )
  ) {
    questions.push(pending(`discover:run:${discover.runId ?? "active"}`, "Discover", question));
  }
  return questions;
}

function flowQuestions(flow: FlowQuestionSource): PendingQuestion[] {
  const questions: PendingQuestion[] = [];
  const session = flow.sessionId ?? "";
  const running = flow.status === "running";
  if (running && flow.question !== null) {
    questions.push(pending(`flow:session:${session}`, "Flow session", flow.question));
  }
  const creation = flow.goalCreation?.question ?? null;
  if (creation !== null) {
    questions.push(pending(`flow:goal:${session}`, "Flow goal creation", creation));
  }
  const conversation = flow.conversation;
  if (running && conversation !== null && conversation.question !== null) {
    const widget = flow.widgets.find((entry) => entry.id === conversation.widgetId);
    const label =
      widget === undefined ? "Flow conversation" : `Flow conversation · ${widget.concept}`;
    questions.push(
      pending(`flow:conversation:${conversation.widgetId}`, label, conversation.question),
    );
  }
  return questions;
}

function issuesQuestions(issues: IssuesQuestionSource): PendingQuestion[] {
  const questions: PendingQuestion[] = [];
  for (const agent of issues.agents) {
    if (agent.question === null) continue;
    questions.push(
      pending(
        `issues:agent:${agent.runId}`,
        `Issues · issue #${agent.issueNumber}`,
        agent.question,
      ),
    );
  }
  const names = new Map(issues.drafts.map((draft) => [draft.path, draft.name]));
  for (const path of Object.keys(issues.draftRuns).sort()) {
    const run = issues.draftRuns[path];
    if (run === null || run === undefined || run.question === null) continue;
    if (run.status !== "running") continue;
    questions.push(
      pending(`issues:draft:${path}`, `Issues draft · ${names.get(path) ?? path}`, run.question),
    );
  }
  return questions;
}

/** Every pending agent question across Goal, Discover, Flow, and Issues. */
export function collectPendingQuestions(sources: QuestionSources): PendingQuestion[] {
  return [
    ...goalQuestions(sources.goal),
    ...discoverQuestions(sources.discover),
    ...flowQuestions(sources.flow),
    ...issuesQuestions(sources.issues),
  ];
}

/**
 * The operator's channel: an explicit control, the browser's permission, and
 * one notification per pending question per page session.
 */
export class OsNotificationController {
  enabled = $state(false);
  permission = $state<NotificationPermission>("default");
  private notified = new Set<string>();
  private pending: PendingQuestion[] = [];

  constructor(private readonly environment: OsNotificationEnvironment) {
    this.enabled = environment.readEnabled();
    this.permission = environment.permission();
  }

  get state(): OsNotificationState {
    if (this.permission === "denied" || this.permission === "unsupported") return "blocked";
    return this.permission === "granted" && this.enabled ? "on" : "off";
  }

  /** The control's accessible name; it names the channel and its state. */
  get label(): string {
    if (this.state === "on") return "OS notifications on";
    if (this.state === "blocked") return "OS notifications blocked";
    return "OS notifications off";
  }

  get title(): string {
    if (this.state === "on") {
      return "OS notifications are on. Click to stop desktop notifications for agent questions.";
    }
    if (this.state === "blocked") {
      return "OS notifications are blocked. Allow notifications for this site in the browser "
        + "to turn them on.";
    }
    return "OS notifications are off. Click to allow and receive a desktop notification for "
      + "every pending agent question.";
  }

  /** Re-reads the browser's permission; a revoked grant shows as blocked. */
  refresh(): void {
    this.permission = this.environment.permission();
  }

  async toggle(): Promise<void> {
    this.refresh();
    if (this.permission === "denied" || this.permission === "unsupported") return;
    if (this.permission === "granted") {
      this.setEnabled(!this.enabled);
      return;
    }
    const outcome = await this.environment.requestPermission();
    this.permission = outcome;
    if (outcome === "granted") {
      this.setEnabled(true);
    } else {
      // A denied or dismissed prompt leaves the channel off.
      this.setEnabled(false);
    }
  }

  /**
   * Observes the complete pending set. A question is announced the first time
   * this page sees it while the channel is on; a question that is gone is
   * simply absent, and answering never changes the notified set.
   */
  observe(questions: readonly PendingQuestion[]): void {
    this.refresh();
    this.pending = [...questions];
    this.announce(questions);
  }

  private setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.environment.writeEnabled(enabled);
    // Turning the channel on announces every pending question the channel has
    // not already announced in this page session.
    if (enabled) this.announce(this.pending);
  }

  private announce(questions: readonly PendingQuestion[]): void {
    if (this.state !== "on") return;
    for (const question of questions) {
      if (this.notified.has(question.key)) continue;
      this.notified.add(question.key);
      this.environment.show({
        title: `${NOTIFICATION_TITLE} · ${question.label}`,
        body: question.message,
      });
    }
  }
}

/** The real browser channel: the Notification API and the profile's storage. */
export function browserEnvironment(): OsNotificationEnvironment {
  // The Notification API is absent in a runtime without a browser.
  const api = (): typeof Notification | undefined =>
    typeof globalThis.Notification === "undefined" ? undefined : globalThis.Notification;

  return {
    permission: () => {
      const notifications = api();
      if (notifications === undefined) return "unsupported";
      const permission = notifications.permission;
      if (permission === "granted" || permission === "denied") return permission;
      return "default";
    },
    requestPermission: async () => {
      const notifications = api();
      if (notifications === undefined) return "unsupported";
      try {
        const result = await notifications.requestPermission();
        if (result === "granted" || result === "denied") return result;
        return "default";
      } catch {
        // A refused request leaves the channel off instead of breaking the page.
        return "default";
      }
    },
    show: ({ title, body }) => {
      const notifications = api();
      if (notifications === undefined || notifications.permission !== "granted") return;
      try {
        // Informational only: no click handler and no navigation.
        new notifications(title, { body });
      } catch {
        // A browser that refuses one notification must not break the dashboard.
      }
    },
    readEnabled: () => {
      try {
        return globalThis.localStorage?.getItem(ENABLED_KEY) === "1";
      } catch {
        return false;
      }
    },
    writeEnabled: (enabled: boolean) => {
      try {
        if (enabled) globalThis.localStorage?.setItem(ENABLED_KEY, "1");
        else globalThis.localStorage?.removeItem(ENABLED_KEY);
      } catch {
        // A blocked localStorage keeps the choice for this page only.
      }
    },
  };
}

export const osNotifications = new OsNotificationController(browserEnvironment());
