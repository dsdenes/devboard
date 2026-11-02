/**
 * The one MCP catalog. `tools/list` and the Coach `tool-gap` filter both read
 * this module: a tool name and its `covers` entries exist here and nowhere
 * else. The list is sorted by name so one unchanged state yields one stable
 * catalog byte for byte.
 */

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Normalized command signatures this tool replaces. */
  covers?: readonly string[];
}

const STRING = { type: "string" } as const;
const INTEGER = { type: "integer" } as const;
const STRING_OR_NULL = { type: ["string", "null"] } as const;
const LIMIT = { type: "integer", minimum: 1, maximum: 200 } as const;

const NO_ARGUMENTS = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

function object(properties: Record<string, unknown>, required: readonly string[] = []): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length === 0 ? {} : { required: [...required] }),
  };
}

const TOOLS: readonly McpToolDefinition[] = [
  {
    name: "agent_session_read",
    title: "Read one agent session",
    description:
      "Reads one ACP peer transcript in message order, bounded by rows and bytes. " +
      "Each message carries index, timestamp, role, bounded text, tool name, the " +
      "error flag, usage, and a failure fingerprint.",
    inputSchema: object(
      {
        id: STRING,
        offset: { type: "integer", minimum: 0 },
        limit: LIMIT,
      },
      ["id"],
    ),
  },
  {
    name: "agent_session_search",
    title: "Search agent sessions",
    description:
      "Case-insensitive substring search across this repository's ACP peer " +
      "transcripts, newest session first. At most 100 matches with a 200-character " +
      "snippet.",
    inputSchema: object({ query: STRING, limit: LIMIT }, ["query"]),
  },
  {
    name: "agent_sessions_list",
    title: "List agent sessions",
    description:
      "Lists this repository's ACP peer transcripts newest first with id, relative " +
      "path, start time, title, relative cwd, message count, tool-error count, " +
      "tokens, and cost.",
    inputSchema: object({
      since: STRING,
      until: STRING,
      cwd: STRING,
      limit: LIMIT,
      offset: { type: "integer", minimum: 0 },
    }),
    covers: ["rg --files", "find .devboard/.tmp/providers"],
  },
  {
    name: "background_agent_control",
    title: "Control a background agent",
    description:
      "Delegates start, stop, set_settings, or disable_timer to the single live " +
      "dashboard for this repository and returns its resulting agent snapshot.",
    inputSchema: object(
      {
        action: { type: "string", enum: ["start", "stop", "set_settings", "disable_timer"] },
        id: STRING,
        minutes: INTEGER,
        maxPerHour: { type: ["integer", "null"], minimum: 1, maximum: 100 },
        maxPending: { type: ["integer", "null"], minimum: 1, maximum: 100 },
      },
      ["action", "id"],
    ),
  },
  {
    name: "background_agent_get",
    title: "Read one background agent",
    description:
      "Returns one background agent's snapshot from the live dashboard, or its " +
      "persisted state when no dashboard is live.",
    inputSchema: object({ id: STRING }, ["id"]),
  },
  {
    name: "background_agents_list",
    title: "List background agents",
    description:
      "Returns every background agent's snapshot from the live dashboard, or the " +
      "persisted state when no dashboard is live.",
    inputSchema: NO_ARGUMENTS,
  },
  {
    name: "devboard_status",
    title: "Read Devboard status",
    description:
      "Returns the resolved repository root, harness directory, state directory, " +
      "live dashboard port and pid when one exists, and the harness version state.",
    inputSchema: NO_ARGUMENTS,
    covers: ["git rev-parse --show-toplevel"],
  },
  {
    name: "flow_control",
    title: "Control Flow mode",
    description:
      "Delegates create_goal, start_implementation, or stop_implementation to " +
      "the live dashboard and returns the resulting Flow snapshot.",
    inputSchema: object(
      {
        action: {
          type: "string",
          enum: ["create_goal", "start_implementation", "stop_implementation"],
        },
      },
      ["action"],
    ),
  },
  {
    name: "goal_control",
    title: "Control Goal mode",
    description:
      "Delegates create, revise, prepare_skills, or reset_implementation to the " +
      "live dashboard and returns the resulting Goal-mode state.",
    inputSchema: object(
      {
        action: {
          type: "string",
          enum: ["create", "revise", "prepare_skills", "reset_implementation"],
        },
        request: STRING,
      },
      ["action"],
    ),
  },
  {
    name: "goal_draft_file",
    title: "File a goal draft as an issue",
    description:
      "Ensures the exact `goal` label, creates one issue from a goal spec's bytes, " +
      "reads it back, verifies the label and byte equality, and only then removes an " +
      "optional named draft.",
    inputSchema: object(
      {
        specPath: STRING,
        title: STRING,
        draftPath: STRING,
      },
      ["specPath", "title"],
    ),
  },
  {
    name: "goal_draft_read",
    title: "Read a goal draft",
    description: "Returns one proposed-goal draft under `.devboard/goal-proposals/` verbatim.",
    inputSchema: object({ path: STRING }, ["path"]),
  },
  {
    name: "goal_drafts_list",
    title: "List goal drafts",
    description: "Lists the proposed-goal drafts directly under `.devboard/goal-proposals/`.",
    inputSchema: NO_ARGUMENTS,
    covers: ["ls .devboard/goal-proposals", "find .devboard/goal-proposals"],
  },
  {
    name: "goal_get",
    title: "Read the goal document",
    description: "Returns the goal document's text.",
    inputSchema: NO_ARGUMENTS,
    covers: ["cat GOAL.md"],
  },
  {
    name: "goal_spec_write",
    title: "Write a goal spec",
    description:
      "Writes `.devboard/goals/<slug>.md` with the five required sections once each, " +
      "a derived kebab-case slug, and the first free numeric suffix.",
    inputSchema: object(
      {
        objective: STRING,
        successCriteria: STRING,
        verification: STRING,
        boundaries: STRING,
        stopConditions: STRING,
        slug: STRING,
      },
      ["objective", "successCriteria", "verification", "boundaries", "stopConditions"],
    ),
  },
  {
    name: "issue_close",
    title: "Close an issue",
    description:
      "Closes one issue through the repository's own forge as completed or not " +
      "planned and returns the resulting state.",
    inputSchema: object(
      { number: INTEGER, reason: { type: "string", enum: ["completed", "not planned"] } },
      ["number"],
    ),
  },
  {
    name: "issue_get",
    title: "Read one issue",
    description: "Returns one issue's title, body, labels, state, and URL.",
    inputSchema: object({ number: INTEGER }, ["number"]),
    covers: ["gh issue view", "gh issue list"],
  },
  {
    name: "issues_control",
    title: "Control the Issues worker",
    description:
      "Delegates start, pause, resume, stop, or check_now to the live dashboard and " +
      "returns the Issues snapshot.",
    inputSchema: object(
      {
        action: { type: "string", enum: ["start", "pause", "resume", "stop", "check_now"] },
      },
      ["action"],
    ),
  },
  {
    name: "issues_list",
    title: "List issues",
    description:
      "Lists the repository's open and closed issues with number, title, state, " +
      "labels, URL, and creation time.",
    inputSchema: object({
      state: { type: "string", enum: ["open", "closed", "all"] },
      limit: LIMIT,
    }),
    covers: ["gh issue list"],
  },
  {
    name: "journal_search",
    title: "Search the dashboard journal",
    description:
      "Filters this repository's dashboard journal records by kind, scope, window, " +
      "and substring, newest first. At most 200 records and 64 KiB.",
    inputSchema: object({
      kind: STRING,
      scope: STRING,
      since: STRING,
      until: STRING,
      query: STRING,
      limit: LIMIT,
    }),
  },
  {
    name: "lifecycle_control",
    title: "Control Goal-mode lifecycle",
    description:
      "Delegates start, pause, resume, stop, or start_run to the live dashboard and " +
      "returns the Goal-mode state.",
    inputSchema: object(
      {
        action: { type: "string", enum: ["start", "pause", "resume", "stop", "start_run"] },
        file: STRING,
      },
      ["action"],
    ),
  },
  {
    name: "verification_run",
    title: "Run a verification check",
    description:
      "Runs one allowlisted check from `.devboard/package.json` with a 900-second " +
      "timeout and at most 16 KiB of captured output. The check's complete output is " +
      "written to `<stateDir>/<check>.log` and that path is returned as `log`.",
    inputSchema: object(
      {
        check: STRING,
        paths: { type: "array", items: STRING, maxItems: 50 },
      },
      ["check"],
    ),
    covers: [
      "bun test",
      "bun run check",
      "bun run build",
      "bunx tsc --noEmit",
      "bun run verify:agents",
      "bun run verify:coach",
      "bun run verify:install",
      "bun run verify:interface",
      "bun run verify:issues",
      "bun run verify:mcp",
      "bun run verify:providers",
      "bun run verify:scout",
      "bun run verify:ui",
      "bun run verify:update",
      "bun run verify:watchdog",
    ],
  },
];

export const MCP_TOOLS: readonly McpToolDefinition[] = Object.freeze(
  [...TOOLS].sort((left, right) => left.name.localeCompare(right.name)),
);

export const MCP_TOOL_NAMES: readonly string[] = Object.freeze(
  MCP_TOOLS.map((tool) => tool.name),
);

/** Every command signature an MCP tool replaces, for the Coach filter. */
export const MCP_COVERS: readonly string[] = Object.freeze(
  [...new Set(MCP_TOOLS.flatMap((tool) => tool.covers ?? []))].sort(),
);

export function toolDefinition(name: string): McpToolDefinition | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}

/** The `tools/list` payload: from the catalog, already sorted by name. */
export function toolListPayload(): { tools: McpToolDefinition[] } {
  return { tools: MCP_TOOLS.map((tool) => ({ ...tool })) };
}
