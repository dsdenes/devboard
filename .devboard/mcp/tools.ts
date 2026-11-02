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
import {
  closeIssue,
  commentIssue,
  createIssue,
  getIssue,
  listIssues,
} from "./issues";
import { searchJournal } from "./journal";
import { devboardStatus } from "./status";
import { runVerification } from "./verification";
import {
  acknowledgeFlowSteering,
  recordFlowCheckpoint,
  recordFlowVerification,
  registerFlowWidgets,
} from "./flow";
import {
  stageDiscoverContribution,
  stageDiscoverGlossary,
  stageDiscoverSheet,
  stageDiscoverSignificance,
  stageDiscoverSkill,
} from "./discover";
import { requestDesignRelease } from "./design";
import { recordWatchdogDuplicate } from "./watchdog";
import { recordMcpOptimizerSkip } from "./mcp-optimizer";
import { pickEntryPoint } from "../lib/entry-point";
import { logToolCall } from "./tool-log";

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

/** Tools whose successful or failed call leaves a state change or a record. */
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "background_agent_control",
  "mcp_optimizer_proposal_skip",
  "design_release_request",
  "discover_contribution_stage",
  "discover_glossary_stage",
  "discover_sheet_stage",
  "discover_significance_stage",
  "discover_skill_stage",
  "flow_checkpoint_record",
  "flow_control",
  "flow_steering_ack",
  "flow_verification_record",
  "flow_widgets_register",
  "goal_control",
  "goal_draft_file",
  "goal_spec_write",
  "issue_close",
  "issue_comment",
  "issue_create",
  "issues_control",
  "lifecycle_control",
  "watchdog_duplicate_record",
]);

type Schema = Record<string, unknown>;

function typeMatches(value: unknown, type: unknown): boolean {
  if (Array.isArray(type)) return type.some((entry) => typeMatches(value, entry));
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

/**
 * The argument check every tool call passes before its handler runs. It covers
 * the subset the catalog writes: type, enum, required, properties, items,
 * additionalProperties, bounds, and list length. A refusal is returned before
 * any write, so an invalid call never has a side effect.
 */
export function validateArguments(schema: Schema, value: unknown, path = "arguments"): string | undefined {
  const type = schema["type"];
  if (type !== undefined && !typeMatches(value, type)) {
    return `${path} does not match type ${JSON.stringify(type)}.`;
  }
  const allowed = schema["enum"];
  if (Array.isArray(allowed) && !allowed.includes(value)) {
    return `${path} must be one of ${allowed.map(String).join(", ")}.`;
  }
  if (typeof value === "number") {
    const minimum = schema["minimum"];
    const maximum = schema["maximum"];
    if (typeof minimum === "number" && value < minimum) {
      return `${path} must be at least ${minimum}.`;
    }
    if (typeof maximum === "number" && value > maximum) {
      return `${path} must be at most ${maximum}.`;
    }
  }
  if (Array.isArray(value)) {
    const minItems = schema["minItems"];
    const maxItems = schema["maxItems"];
    if (typeof minItems === "number" && value.length < minItems) {
      return `${path} must hold at least ${minItems} item(s).`;
    }
    if (typeof maxItems === "number" && value.length > maxItems) {
      return `${path} must hold at most ${maxItems} item(s).`;
    }
    const items = schema["items"];
    if (typeof items === "object" && items !== null && !Array.isArray(items)) {
      for (const [index, entry] of value.entries()) {
        const detail = validateArguments(items as Schema, entry, `${path}[${index}]`);
        if (detail !== undefined) return detail;
      }
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    const properties =
      typeof schema["properties"] === "object" && schema["properties"] !== null
        ? (schema["properties"] as Record<string, unknown>)
        : {};
    const required = Array.isArray(schema["required"]) ? schema["required"] : [];
    for (const key of required) {
      if (typeof key === "string" && (value as Record<string, unknown>)[key] === undefined) {
        return `${path}.${key} is required.`;
      }
    }
    const record = value as Record<string, unknown>;
    if (schema["additionalProperties"] === false) {
      const unknown = Object.keys(record).find((key) => !(key in properties));
      if (unknown !== undefined) return `${path}.${unknown} is not allowed.`;
    }
    for (const [key, entry] of Object.entries(record)) {
      const property = properties[key];
      if (entry === undefined || typeof property !== "object" || property === null) continue;
      const detail = validateArguments(property as Schema, entry, `${path}.${key}`);
      if (detail !== undefined) return detail;
    }
  }
  return undefined;
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
      return await devboardStatus(context);
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
    case "issue_create":
      return createIssue(context, {
        title: args.title,
        body: args.body,
        labels: args.labels,
      });
    case "issue_comment":
      return commentIssue(context, { number: args.number, body: args.body });
    case "entry_point":
      return pickEntryPoint({
        repoDir: context.repoDir,
        surface: args.surface,
        ...(args.seed === undefined ? {} : { seed: args.seed }),
        environment: context.environment,
      });
    case "flow_widgets_register":
      return registerFlowWidgets(context, {
        sessionDir: args.sessionDir,
        widgets: args.widgets,
      });
    case "flow_steering_ack":
      return acknowledgeFlowSteering(context, {
        sessionDir: args.sessionDir,
        ids: args.ids,
      });
    case "flow_checkpoint_record":
      return recordFlowCheckpoint(context, {
        sessionDir: args.sessionDir,
        id: args.id,
        timestamp: args.timestamp,
        summary: args.summary,
        files: args.files,
        commit: args.commit,
        verification: args.verification,
      });
    case "flow_verification_record":
      return recordFlowVerification(context, {
        sessionDir: args.sessionDir,
        command: args.command,
        status: args.status,
        timestamp: args.timestamp,
        output: args.output,
      });
    case "discover_sheet_stage":
      return stageDiscoverSheet(context, {
        stagingDir: args.stagingDir,
        sheet: args.sheet,
      });
    case "discover_contribution_stage":
      return stageDiscoverContribution(context, {
        stagingDir: args.stagingDir,
        contribution: args.contribution,
      });
    case "discover_glossary_stage":
      return stageDiscoverGlossary(context, {
        stagingDir: args.stagingDir,
        context: args.context,
        yaml: args.yaml,
      });
    case "discover_significance_stage":
      return stageDiscoverSignificance(context, {
        stagingDir: args.stagingDir,
        significance: args.significance,
      });
    case "discover_skill_stage":
      return stageDiscoverSkill(context, {
        stagingDir: args.stagingDir,
        name: args.name,
        description: args.description,
        body: args.body,
      });
    case "design_release_request":
      return requestDesignRelease(context, {
        cycleDir: args.cycleDir,
        summary: args.summary,
        rationale: args.rationale,
      });
    case "watchdog_duplicate_record":
      return recordWatchdogDuplicate(context, {
        fingerprint: args.fingerprint,
        issue: args.issue,
        representative: args.representative,
      });
    case "mcp_optimizer_proposal_skip":
      return recordMcpOptimizerSkip(context, { family: args.family, reason: args.reason });
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
  const definition = typeof name === "string" ? toolDefinition(name) : undefined;
  if (typeof name !== "string" || definition === undefined) {
    return { error: `Unknown tool: ${String(name)}` };
  }
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
    return { error: "Tool arguments must be an object." };
  }
  const argumentsObject = (args ?? {}) as Record<string, unknown>;
  const invalid = validateArguments(definition.inputSchema, argumentsObject);
  if (invalid !== undefined) {
    const result = { error: invalid };
    if (MUTATING_TOOLS.has(name)) logToolCall(context, name, result);
    return result;
  }
  try {
    const result = { value: await dispatch(context, name, argumentsObject) };
    if (MUTATING_TOOLS.has(name)) logToolCall(context, name, result);
    return result;
  } catch (error) {
    const result = { error: error instanceof Error ? error.message : String(error) };
    if (MUTATING_TOOLS.has(name)) logToolCall(context, name, result);
    return result;
  }
}
