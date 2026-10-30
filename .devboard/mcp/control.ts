import { agentRegistry } from "../server/agents/registry";
import { resolveContained } from "./context";
import type { McpContext } from "./context";
import {
  dashboardCommand,
  selectDashboard,
  type DashboardReply,
} from "./dashboard";
import { goalText } from "./goals";

/**
 * Harness control. Every tool discovers the single live dashboard for this
 * repository, delegates to its existing command handling, waits for the
 * resulting state or event, and returns it. A refusal from the dashboard is an
 * error result with no state change.
 */

function stripType(reply: DashboardReply): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(reply)) {
    if (key === "type") continue;
    result[key] = value;
  }
  return result;
}

function isLimit(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100);
}

export interface BackgroundAgentControl {
  id: string;
  action: "start" | "stop" | "set_settings" | "disable_timer";
  agent: Record<string, unknown>;
}

export async function backgroundAgentControl(
  context: McpContext,
  options: {
    action?: unknown;
    id?: unknown;
    minutes?: unknown;
    maxPerHour?: unknown;
    maxPending?: unknown;
  },
): Promise<BackgroundAgentControl> {
  if (typeof options.id !== "string" || options.id.length === 0) {
    throw new Error("id is required.");
  }
  const descriptor = agentRegistry.get(options.id);
  if (descriptor === undefined) {
    throw new Error(`Unknown background agent: ${options.id}.`);
  }
  if (
    options.action !== "start" &&
    options.action !== "stop" &&
    options.action !== "set_settings" &&
    options.action !== "disable_timer"
  ) {
    throw new Error("action must be start, stop, set_settings, or disable_timer.");
  }
  let command: Record<string, unknown>;
  if (options.action === "set_settings") {
    if (
      typeof options.minutes !== "number" ||
      !Number.isInteger(options.minutes) ||
      options.minutes < descriptor.cadence.minMinutes ||
      options.minutes > descriptor.cadence.maxMinutes
    ) {
      throw new Error("The cadence must be an integer from 1 through 1440 minutes.");
    }
    if (!isLimit(options.maxPerHour) || !isLimit(options.maxPending)) {
      throw new Error("Both limits must be empty or integers from 1 through 100.");
    }
    command = {
      type: "setAgentSettings",
      id: options.id,
      minutes: options.minutes,
      maxPerHour: options.maxPerHour,
      maxPending: options.maxPending,
    };
  } else if (options.action === "disable_timer") {
    command = { type: "disableAgentTimer", id: options.id };
  } else if (options.action === "start") {
    command = { type: "startAgent", id: options.id };
  } else {
    command = { type: "stopAgent", id: options.id };
  }
  const dashboard = selectDashboard(context.repoDir, { dashboards: context.dashboards });
  const reply = await dashboardCommand(
    dashboard,
    command,
    (candidate) =>
      candidate.type === "agentState" &&
      typeof candidate.agent === "object" &&
      candidate.agent !== null &&
      "id" in candidate.agent &&
      candidate.agent.id === options.id,
  );
  const agent =
    typeof reply.agent === "object" && reply.agent !== null
      ? (reply.agent as Record<string, unknown>)
      : {};
  return {
    id: options.id,
    action: options.action,
    agent,
  };
}

const ISSUES_ACTIONS = {
  start: "startIssues",
  pause: "pauseIssues",
  resume: "resumeIssues",
  stop: "stopIssues",
  check_now: "checkIssues",
} as const;

export async function issuesControl(
  context: McpContext,
  options: { action?: unknown },
): Promise<{ action: string; issues: Record<string, unknown> }> {
  if (typeof options.action !== "string" || !(options.action in ISSUES_ACTIONS)) {
    throw new Error("action must be start, pause, resume, stop, or check_now.");
  }
  const action = options.action as keyof typeof ISSUES_ACTIONS;
  const dashboard = selectDashboard(context.repoDir, { dashboards: context.dashboards });
  // Only a Start replays the snapshot; every other action needs the follow-up
  // read, and a refusal arrives before it.
  const reply = await dashboardCommand(
    dashboard,
    action === "start"
      ? { type: ISSUES_ACTIONS[action] }
      : [{ type: ISSUES_ACTIONS[action] }, { type: "getIssues" }],
    (candidate) => candidate.type === "issuesState",
  );
  return { action, issues: stripType(reply) };
}

const LIFECYCLE_ACTIONS = {
  start: "startLifecycle",
  pause: "pauseLifecycle",
  resume: "resumeLifecycle",
  stop: "stopLifecycle",
} as const;

/**
 * The reply each lifecycle action actually produces. A manual start pauses an
 * advancing lifecycle first, which publishes `lifecycleState`, then starts the
 * record and publishes `runStarted`; with an idle or paused lifecycle only
 * `runStarted` follows.
 */
const LIFECYCLE_REPLIES: Record<string, string[]> = {
  start: ["lifecycleState"],
  pause: ["lifecycleState"],
  resume: ["lifecycleState"],
  stop: ["lifecycleState"],
  start_run: ["lifecycleState", "runStarted"],
};

export async function lifecycleControl(
  context: McpContext,
  options: { action?: unknown; file?: unknown },
): Promise<{ action: string; goal: string; event: Record<string, unknown> }> {
  if (typeof options.action !== "string") throw new Error("action is required.");
  let command: Record<string, unknown>;
  if (options.action in LIFECYCLE_ACTIONS) {
    const action = options.action as keyof typeof LIFECYCLE_ACTIONS;
    command = { type: LIFECYCLE_ACTIONS[action] };
  } else if (options.action === "start_run") {
    const file = resolveContained(context.repoDir, options.file, "file", { mustExist: true });
    if (!file.relative.startsWith("adrs/") || !file.relative.endsWith(".md")) {
      throw new Error("start_run needs a repository-relative adrs/*.md file.");
    }
    command = { type: "startRun", file: file.relative };
  } else {
    throw new Error("action must be start, pause, resume, stop, or start_run.");
  }
  const accepted = new Set(LIFECYCLE_REPLIES[options.action] ?? []);
  const dashboard = selectDashboard(context.repoDir, { dashboards: context.dashboards });
  const reply = await dashboardCommand(
    dashboard,
    command,
    (candidate) =>
      typeof candidate.type === "string" &&
      accepted.has(candidate.type) &&
      // A lane's runStarted belongs to other work; only the manual sequence's
      // own start answers a start_run.
      (candidate.type !== "runStarted" || candidate.manual === true),
  );
  return {
    action: options.action,
    goal: goalText(context).goal,
    // The type names which frame answered, so a start_run caller can tell
    // `runStarted` from the `lifecycleState` published while pausing.
    event: { ...reply },
  };
}

const GOAL_ACTIONS = {
  save: "saveGoal",
  create: "createGoal",
  revise: "reviseGoal",
  prepare_skills: "prepareSkills",
  reset_implementation: "resetImplementation",
} as const;

const GOAL_REPLIES: Record<string, string[]> = {
  save: ["goal"],
  create: ["goalCreationStarted"],
  revise: ["goalRevisionStarted"],
  prepare_skills: ["skillsPreparationStarted", "skillsState"],
  reset_implementation: ["implementationResetStarted"],
};

export async function goalControl(
  context: McpContext,
  options: { action?: unknown; text?: unknown; request?: unknown },
): Promise<{ action: string; goal: string; event: Record<string, unknown> }> {
  if (typeof options.action !== "string" || !(options.action in GOAL_ACTIONS)) {
    throw new Error("action must be save, create, revise, prepare_skills, or reset_implementation.");
  }
  const action = options.action as keyof typeof GOAL_ACTIONS;
  const command: Record<string, unknown> = { type: GOAL_ACTIONS[action] };
  if (action === "save") {
    if (typeof options.text !== "string") throw new Error("save needs text.");
    command.text = options.text;
  }
  if (action === "revise") {
    if (typeof options.request !== "string") throw new Error("revise needs a request.");
    command.request = options.request;
  }
  const accepted = new Set(GOAL_REPLIES[action] ?? []);
  const dashboard = selectDashboard(context.repoDir, { dashboards: context.dashboards });
  const reply = await dashboardCommand(
    dashboard,
    command,
    (candidate) => typeof candidate.type === "string" && accepted.has(candidate.type),
  );
  return { action, goal: goalText(context).goal, event: stripType(reply) };
}

const FLOW_ACTIONS = {
  create_goal: "createFlowGoal",
  save_goal: "saveFlowGoal",
  start_implementation: "startFlowImplementation",
  stop_implementation: "stopFlowImplementation",
} as const;

export async function flowControl(
  context: McpContext,
  options: { action?: unknown; text?: unknown },
): Promise<{ action: string; flow: Record<string, unknown> }> {
  if (typeof options.action !== "string" || !(options.action in FLOW_ACTIONS)) {
    throw new Error("action must be create_goal, save_goal, start_implementation, or stop_implementation.");
  }
  const action = options.action as keyof typeof FLOW_ACTIONS;
  const command: Record<string, unknown> = { type: FLOW_ACTIONS[action] };
  if (action === "save_goal") {
    if (typeof options.text !== "string") throw new Error("save_goal needs text.");
    command.text = options.text;
  }
  const dashboard = selectDashboard(context.repoDir, { dashboards: context.dashboards });
  const reply = await dashboardCommand(
    dashboard,
    command,
    (candidate) => candidate.type === "flowSnapshot" || candidate.type === "flowError",
  );
  if (reply.type === "flowError") {
    throw new Error(String(reply.message ?? "the dashboard refused the Flow command"));
  }
  return { action, flow: stripType(reply) };
}
