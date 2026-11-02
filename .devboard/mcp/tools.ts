import {
  listSessions,
  readSessionMessages,
  searchSessions,
} from "../lib/agent-sessions";
import type { McpContext } from "./context";
import { backgroundAgentGet, backgroundAgentsList } from "./agents";
import {
  backgroundAgentControl,
  flowControl,
  goalControl,
  issuesControl,
  lifecycleControl,
} from "./control";
import type { McpToolDefinition } from "./catalog";
import { toolDefinition } from "./catalog";
import { fileGoalDraft, goalDraft, goalDrafts, goalText, writeGoalSpec } from "./goals";
import { closeIssue, getIssue, listIssues } from "./issues";
import { searchJournal } from "./journal";
import { devboardStatus } from "./status";
import { runVerification } from "./verification";

/**
 * One dispatcher for every catalog tool. A handler validates its arguments,
 * performs no model call, and returns a JSON value; an unknown tool or a
 * refused argument produces an error result without a side effect.
 */

export interface ToolResult {
  value?: unknown;
  error?: string;
}

function stringArgument(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

async function dispatch(
  context: McpContext,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "agent_sessions_list":
      return listSessions({
        stateDir: context.stateDir,
        repoDir: context.repoDir,
        ...(optionalString(args, "since") === undefined ? {} : { since: optionalString(args, "since") }),
        ...(optionalString(args, "until") === undefined ? {} : { until: optionalString(args, "until") }),
        ...(optionalString(args, "cwd") === undefined ? {} : { cwd: optionalString(args, "cwd") }),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
      });
    case "agent_session_read": {
      const id = stringArgument(args, "id");
      const page = readSessionMessages({
        stateDir: context.stateDir,
        repoDir: context.repoDir,
        id,
        ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      });
      if (page === undefined) throw new Error(`No session ${id} in this repository's evidence.`);
      return page;
    }
    case "agent_session_search":
      return searchSessions({
        stateDir: context.stateDir,
        repoDir: context.repoDir,
        query: stringArgument(args, "query"),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      });
    case "background_agent_control":
      return backgroundAgentControl(context, {
        action: args.action,
        id: args.id,
        minutes: args.minutes,
        maxPerHour: args.maxPerHour,
        maxPending: args.maxPending,
      });
    case "background_agent_get": {
      const id = stringArgument(args, "id");
      const agent = await backgroundAgentGet(context, id);
      if (agent === undefined) throw new Error(`Unknown background agent: ${id}.`);
      return agent;
    }
    case "background_agents_list":
      return { agents: await backgroundAgentsList(context) };
    case "devboard_status":
      return devboardStatus(context);
    case "flow_control":
      return flowControl(context, { action: args.action });
    case "goal_control":
      return goalControl(context, {
        action: args.action,
        request: args.request,
      });
    case "goal_draft_file": {
      const result = await fileGoalDraft(context, {
        specPath: args.specPath,
        title: args.title,
        draftPath: args.draftPath,
      });
      if (!result.ok) {
        throw new Error(`goal_draft_file failed at "${result.step}": ${result.message}`);
      }
      return result;
    }
    case "goal_draft_read":
      return goalDraft(context, args.path);
    case "goal_drafts_list":
      return { drafts: goalDrafts(context) };
    case "goal_get":
      return goalText(context);
    case "goal_spec_write":
      return writeGoalSpec(context, {
        objective: args.objective,
        successCriteria: args.successCriteria,
        verification: args.verification,
        boundaries: args.boundaries,
        stopConditions: args.stopConditions,
        slug: args.slug,
      });
    case "issue_close":
      return closeIssue(context, { number: args.number, reason: args.reason });
    case "issue_get":
      return getIssue(context, args.number);
    case "issues_control":
      return issuesControl(context, { action: args.action });
    case "issues_list":
      return listIssues(context, { state: args.state, limit: args.limit });
    case "journal_search":
      return searchJournal(context, {
        kind: args.kind,
        scope: args.scope,
        since: args.since,
        until: args.until,
        query: args.query,
        limit: args.limit,
      });
    case "lifecycle_control":
      return lifecycleControl(context, { action: args.action, file: args.file });
    case "verification_run":
      return runVerification(context, args.check, args.paths);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** The catalog entry for a tool name, if one exists. */
export function definition(name: string): McpToolDefinition | undefined {
  return toolDefinition(name);
}

export async function callTool(
  context: McpContext,
  name: unknown,
  args: unknown,
): Promise<ToolResult> {
  if (typeof name !== "string" || toolDefinition(name) === undefined) {
    return { error: `Unknown tool: ${String(name)}` };
  }
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
    return { error: "Tool arguments must be an object." };
  }
  try {
    return { value: await dispatch(context, name, (args ?? {}) as Record<string, unknown>) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
