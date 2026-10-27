/**
 * Operator issue reporting for the local interface.
 *
 * The client sends one action plus the DOM context of the element it is about.
 * A report also carries the operator's free text; the removal and redesign
 * shortcuts carry only the context and use a fixed instruction. This module
 * validates that payload, renders it as a GitHub issue for an implementation
 * agent, and files the issue through the operator's authenticated `gh` command.
 *
 * Reports describe the harness interface itself, so the issue always lands in
 * the harness repository, never in the host project that embeds the harness.
 */

/** The repository that receives every reported UI issue. */
export const FEEDBACK_REPOSITORY = "dsdenes/devboard";

const MAX_REPORT = 8000;
const MAX_CONVERSATION_TURNS = 20;
const MAX_CONVERSATION_TURN = 4000;
const MAX_CONTEXT_FIELD = 2000;
const MAX_DOM_EXCERPT = 8000;
const MAX_VISIBLE_TEXT = 8000;
const MAX_VIEWPORT = 500;
const MAX_TITLE = 200;
const TITLE_PREFIX = "[ui] ";
const BODY_VISIBLE_TEXT = 1500;

/** What the operator asked for when they picked an element. */
export type FeedbackAction = "report" | "remove" | "redesign";

/**
 * The instruction a removal issue carries. It is fixed, so the implementation
 * agent never has to interpret operator text for the one-click shortcuts.
 */
export const REMOVAL_INSTRUCTION = "Remove the selected UI element from the interface.";

/**
 * The instruction a redesign issue carries. It names the normative design
 * sources so the agent checks the element against the project's own system.
 */
export const REDESIGN_INSTRUCTION =
  "Check the selected UI element and redesign it because it does not look good. " +
  "Use the global OMP UI/UX standard (the ui-ux skill) and this repository's " +
  "DESIGN.md and design/tokens.json as the normative design system.";

const ACTION_ERROR = "action must be one of report, remove, redesign.";

/** One turn of the operator's ask conversation about the picked element. */
export interface FeedbackTurn {
  role: "developer" | "agent";
  text: string;
}

export interface FeedbackSubmission {
  action: FeedbackAction;
  report: string;
  conversation: FeedbackTurn[];
  route: string;
  url: string;
  selector: string;
  domExcerpt: string;
  visibleText: string;
  viewport: string;
  capturedAt: string;
}

export interface FeedbackIssue {
  url: string;
  title: string;
}

/** A payload the endpoint refuses with a client error. */
export class FeedbackRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "FeedbackRequestError";
    this.status = status;
  }
}

/** A delivery failure: `gh` could not be started, failed, or timed out. */
export class FeedbackDeliveryError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "FeedbackDeliveryError";
    this.status = status;
  }
}

export interface FeedbackIssueOptions {
  /** Executable plus leading arguments, default `["gh"]`. */
  command: string[];
  /** Directory `gh` runs in. */
  repoDir: string;
  /** Wall-clock bound for the `gh` invocation. */
  timeoutMs: number;
  /** Extra environment for the child, merged after the process environment. */
  env?: Record<string, string>;
}

function field(
  value: unknown,
  name: string,
  limit: number,
  required: false,
): string;
function field(
  value: unknown,
  name: string,
  limit: number,
  required: true,
): string;
function field(
  value: unknown,
  name: string,
  limit: number,
  required: boolean,
): string {
  if (value === undefined || value === null) {
    if (required) throw new FeedbackRequestError(400, `${name} is required.`);
    return "";
  }
  if (typeof value !== "string") {
    throw new FeedbackRequestError(400, `${name} must be a string.`);
  }
  if (value.length > limit) {
    throw new FeedbackRequestError(400, `${name} is longer than ${limit} characters.`);
  }
  if (required && value.trim().length === 0) {
    throw new FeedbackRequestError(400, `${name} must not be empty.`);
  }
  return value;
}

function feedbackAction(value: unknown): FeedbackAction {
  // An absent action keeps the original free-text report contract.
  if (value === undefined || value === null) return "report";
  if (value === "report" || value === "remove" || value === "redesign") return value;
  throw new FeedbackRequestError(400, ACTION_ERROR);
}

/** The element context every browser request carries. */
export interface CapturedFields {
  route: string;
  url: string;
  selector: string;
  domExcerpt: string;
  visibleText: string;
  viewport: string;
  capturedAt: string;
}

/** Validates the captured element context under the shared per-field limits. */
export function parseCapturedFields(source: Record<string, unknown>): CapturedFields {
  return {
    route: field(source.route, "route", MAX_CONTEXT_FIELD, false),
    url: field(source.url, "url", MAX_CONTEXT_FIELD, false),
    selector: field(source.selector, "selector", MAX_CONTEXT_FIELD, false),
    domExcerpt: field(source.dom_excerpt, "dom_excerpt", MAX_DOM_EXCERPT, false),
    visibleText: field(source.visible_text, "visible_text", MAX_VISIBLE_TEXT, false),
    viewport: field(source.viewport, "viewport", MAX_VIEWPORT, false),
    capturedAt: field(source.captured_at, "captured_at", MAX_CONTEXT_FIELD, false),
  };
}

/** Validates the required free text under the shared report limit. */
export function parseReportText(value: unknown): string {
  return field(value, "report", MAX_REPORT, true);
}

/**
 * Validates the ask conversation a report may carry. It is optional, so an
 * older client or a one-click shortcut files exactly as before; a turn is
 * bounded so one report cannot become an unbounded transcript.
 */
export function parseConversation(value: unknown): FeedbackTurn[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new FeedbackRequestError(400, "conversation must be a list.");
  }
  if (value.length > MAX_CONVERSATION_TURNS) {
    throw new FeedbackRequestError(
      400,
      `conversation has more than ${MAX_CONVERSATION_TURNS} turns.`,
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new FeedbackRequestError(400, `conversation[${index}] must be an object.`);
    }
    const turn = entry as Record<string, unknown>;
    if (turn.role !== "developer" && turn.role !== "agent") {
      throw new FeedbackRequestError(
        400,
        `conversation[${index}].role must be developer or agent.`,
      );
    }
    const text = field(turn.text, `conversation[${index}].text`, MAX_CONVERSATION_TURN, true);
    return { role: turn.role, text };
  });
}

/** Validates one JSON body. Unknown fields are ignored for forwards compatibility. */
export function parseFeedbackSubmission(value: unknown): FeedbackSubmission {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FeedbackRequestError(400, "The report must be a JSON object.");
  }
  const source = value as Record<string, unknown>;
  const action = feedbackAction(source.action);
  return {
    action,
    // The one-click shortcuts use a fixed instruction, so any text the client
    // still sends is ignored rather than validated or filed.
    report: action === "report" ? parseReportText(source.report) : "",
    conversation: parseConversation(source.conversation),
    ...parseCapturedFields(source),
  };
}

function collapse(value: string, limit: number): string {
  const single = value.replace(/\s+/g, " ").trim();
  if (single.length <= limit) return single;
  return `${single.slice(0, limit - 1).trimEnd()}…`;
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

function firstLine(value: string): string {
  const line =
    value
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0) ?? "no diagnostic";
  return truncate(line, 300);
}

/** One-line issue title for the submission's action. */
export function feedbackTitle(submission: FeedbackSubmission): string {
  if (submission.action !== "report") {
    const label = submission.action === "remove" ? "Remove element" : "Redesign element";
    const selector = submission.selector.replace(/\s+/g, " ").trim();
    if (selector.length === 0) return `${TITLE_PREFIX}${label}`;
    return truncate(`${TITLE_PREFIX}${label}: ${selector}`, MAX_TITLE);
  }
  const line =
    submission.report
      .split("\n")
      .map((value) => value.trim())
      .find((value) => value.length > 0) ?? "operator report";
  return truncate(`${TITLE_PREFIX}${line.replace(/\s+/g, " ")}`, MAX_TITLE);
}

/** The ticket body: the request first, then the captured context. */
export function feedbackBody(submission: FeedbackSubmission): string {
  const request =
    submission.action === "remove"
      ? ["## Removal request", "", REMOVAL_INSTRUCTION]
      : submission.action === "redesign"
        ? ["## Redesign request", "", REDESIGN_INSTRUCTION]
        : ["## Operator report", "", submission.report.trim()];
  const lines = [...request, ""];

  const context: string[] = [];
  for (const [label, value] of [
    ["Route", submission.route],
    ["URL", submission.url],
    ["Selected element", submission.selector],
    ["Viewport", submission.viewport],
    ["Captured at", submission.capturedAt],
  ] as const) {
    // A backtick inside an inline code span would close it early.
    if (value.trim().length > 0) {
      context.push(`- ${label}: \`${value.trim().replace(/`/g, "'")}\``);
    }
  }

  const visible = collapse(submission.visibleText, BODY_VISIBLE_TEXT);
  if (visible.length > 0) {
    context.push("", "### Visible text", "", visible);
  }

  const dom = submission.domExcerpt.trim();
  if (dom.length > 0) {
    const fence = dom.includes("```") ? "````" : "```";
    context.push("", "### DOM excerpt", "", `${fence}html`, dom, fence);
  }

  if (submission.conversation.length > 0) {
    lines.push("## Conversation", "");
    for (const turn of submission.conversation) {
      const who = turn.role === "developer" ? "Developer" : "Agent";
      lines.push(`**${who}:**`, "", ...turn.text.trim().split("\n"), "");
    }
  }

  lines.push("## Captured UI context", "");
  lines.push(...(context.length === 0 ? ["No page context was captured."] : context));
  return lines.join("\n");
}

/** Files one report and returns the created issue. */
export async function fileFeedbackIssue(
  submission: FeedbackSubmission,
  options: FeedbackIssueOptions,
): Promise<FeedbackIssue> {
  const title = feedbackTitle(submission);
  const body = feedbackBody(submission);
  const args = [
    ...options.command,
    "issue",
    "create",
    "--title",
    title,
    "--body-file",
    "-",
    "--repo",
    FEEDBACK_REPOSITORY,
  ];

  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn({
      cmd: args,
      cwd: options.repoDir,
      env: {
        ...process.env,
        ...options.env,
        // Never wait for interactive authentication inside a request.
        GH_PROMPT_DISABLED: "1",
        NO_COLOR: "1",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new FeedbackDeliveryError(502, `Could not start ${options.command[0]}: ${detail}`);
  }

  // The body goes through stdin, so the operator's text never becomes a
  // process argument visible to `ps`.
  try {
    child.stdin.write(body);
    child.stdin.end();
  } catch {
    // `gh` may have exited before reading; the exit status reports why.
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, options.timeoutMs);
  let code: number;
  try {
    code = await child.exited;
  } finally {
    clearTimeout(timer);
  }
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  if (timedOut) {
    throw new FeedbackDeliveryError(
      504,
      `Issue creation timed out after ${options.timeoutMs} ms.`,
    );
  }
  if (code !== 0) {
    throw new FeedbackDeliveryError(502, `Issue creation failed: ${firstLine(stderr)}`);
  }
  const url = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("http"))
    .at(-1);
  if (url === undefined) {
    throw new FeedbackDeliveryError(502, "Issue creation returned no URL.");
  }
  return { url, title };
}
