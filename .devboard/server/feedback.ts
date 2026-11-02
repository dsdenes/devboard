import { giteaCreateIssue, type FetchLike } from "../lib/gitea";

/**
 * Operator issue reporting for the local interface.
 *
 * The client sends one action plus the DOM context of the element it is about.
 * A report also carries the operator's free text and, when the panel answered
 * questions, the Ask conversation; the removal and redesign shortcuts carry
 * only the context and use a fixed instruction. This module
 * validates that payload, renders it as a Gitea issue for an implementation
 * agent, and files the issue through the configured Gitea API.
 *
 * Reports describe the harness interface itself, so the issue always lands in
 * the harness repository, never in the host project that embeds the harness.
 * Without `DEVBOARD_GITEA_URL` reporting is disabled rather than redirected to
 * another forge.
 */

/** The repository that receives every reported UI issue. */
export const FEEDBACK_REPOSITORY = "dsdenes/devboard";

const MAX_REPORT = 8000;
const MAX_CONTEXT_FIELD = 2000;
const MAX_DOM_EXCERPT = 8000;
const MAX_VISIBLE_TEXT = 8000;
const MAX_VIEWPORT = 500;
const MAX_TITLE = 200;
const TITLE_PREFIX = "[ui] ";
const BODY_VISIBLE_TEXT = 1500;
/** Bounds shared with the client's Ask transcript capture. */
const MAX_CONVERSATION_TURNS = 40;
const MAX_CONVERSATION_TURN = 4000;
const MAX_CONVERSATION_TEXT = 12_000;

/** What the operator asked for when they picked an element. */
export type FeedbackAction = "REPORT" | "REMOVE" | "REDESIGN";

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
  "Use the project UI/UX skill (devboard-ui-ux) and this repository's " +
  "DESIGN.md and design/tokens.json as the normative design system.";

const ACTION_ERROR = "action must be one of REPORT, REMOVE, REDESIGN.";

/** One visible turn of the element-scoped Ask conversation. */
export interface FeedbackTurn {
  role: "DEVELOPER" | "AGENT";
  text: string;
}

export interface FeedbackSubmission {
  action: FeedbackAction;
  report: string;
  /** The Ask conversation the operator had about this element, if any. */
  conversation: FeedbackTurn[];
  route: string;
  url: string;
  selector: string;
  domExcerpt: string;
  visibleText: string;
  viewport: string;
  capturedAt: string;
}

/** The common hypertext control object: a link to the filed issue. */
export interface FeedbackIssue {
  title: string;
  links: {
    issue: {
      href: string;
    };
  };
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

/** A delivery failure: the Gitea API refused the request or timed out. */
export class FeedbackDeliveryError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "FeedbackDeliveryError";
    this.status = status;
  }
}

export interface FeedbackIssueOptions {
  /** Gitea HTTP origin; reporting is disabled when this is absent. */
  baseUrl: string;
  /** `owner/name` repository that receives the issue. */
  repo: string;
  token?: string;
  /** Wall-clock bound for the API request. */
  timeoutMs: number;
  /** Test seam; production uses the global fetch. */
  fetchImpl?: FetchLike;
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
  if (value === undefined || value === null) return "REPORT";
  if (value === "REPORT" || value === "REMOVE" || value === "REDESIGN") return value;
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

/** The body keys the captured-context validator reads, in wire naming. */
const CAPTURED_KEYS: readonly string[] = [
  "route",
  "url",
  "selector",
  "dom_excerpt",
  "visible_text",
  "viewport",
  "captured_at",
];

/** The body keys `POST /feedback` accepts; every other key is refused with 400. */
export const FEEDBACK_BODY_KEYS: readonly string[] = [
  "action",
  "report",
  "conversation",
  ...CAPTURED_KEYS,
];

/** The body keys `POST /goal-proposals` accepts: the report's set without `action`. */
export const GOAL_PROPOSAL_BODY_KEYS: readonly string[] = FEEDBACK_BODY_KEYS.filter(
  (key) => key !== "action",
);

/** Refuses the first body key the endpoint does not accept. */
export function rejectUnknownFields(
  source: Record<string, unknown>,
  accepted: readonly string[],
): void {
  for (const key of Object.keys(source)) {
    if (!accepted.includes(key)) {
      throw new FeedbackRequestError(400, `unknown field: ${key}.`);
    }
  }
}

/** Validates the required free text under the shared report limit. */
export function parseReportText(value: unknown): string {
  return field(value, "report", MAX_REPORT, true);
}

/**
 * Validates the Ask conversation. A submission without one carries no turns,
 * so an older client keeps filing reports unchanged.
 */
export function parseConversation(value: unknown): FeedbackTurn[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new FeedbackRequestError(400, "conversation must be an array.");
  }
  if (value.length > MAX_CONVERSATION_TURNS) {
    throw new FeedbackRequestError(
      400,
      `conversation has more than ${MAX_CONVERSATION_TURNS} turns.`,
    );
  }
  const turns: FeedbackTurn[] = [];
  let total = 0;
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new FeedbackRequestError(400, `conversation[${index}] must be an object.`);
    }
    const source = entry as Record<string, unknown>;
    const role = source.role;
    if (role !== "DEVELOPER" && role !== "AGENT") {
      throw new FeedbackRequestError(
        400,
        `conversation[${index}].role must be DEVELOPER or AGENT.`,
      );
    }
    const text = field(source.text, `conversation[${index}].text`, MAX_CONVERSATION_TURN, true);
    total += text.length;
    turns.push({ role, text });
  }
  if (total > MAX_CONVERSATION_TEXT) {
    throw new FeedbackRequestError(
      400,
      `conversation is longer than ${MAX_CONVERSATION_TEXT} characters.`,
    );
  }
  return turns;
}

/** Validates one JSON body, refusing any key the endpoint does not accept. */
export function parseFeedbackSubmission(value: unknown): FeedbackSubmission {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FeedbackRequestError(400, "The report must be a JSON object.");
  }
  const source = value as Record<string, unknown>;
  rejectUnknownFields(source, FEEDBACK_BODY_KEYS);
  const action = feedbackAction(source.action);
  return {
    action,
    // The one-click shortcuts use a fixed instruction, so any text the client
    // still sends is ignored rather than validated or filed.
    report: action === "REPORT" ? parseReportText(source.report) : "",
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
  if (submission.action !== "REPORT") {
    const label = submission.action === "REMOVE" ? "Remove element" : "Redesign element";
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

/**
 * The Ask conversation as Markdown: one labelled block per visible turn. It is
 * empty when the operator filed without asking the agent anything.
 */
export function conversationSection(conversation: FeedbackTurn[]): string[] {
  const lines: string[] = [];
  for (const turn of conversation) {
    lines.push("", `**${turn.role === "DEVELOPER" ? "You" : "Agent"}:**`, "", turn.text.trim());
  }
  if (lines.length === 0) return [];
  return ["## Ask conversation", ...lines];
}

/** The ticket body: the request first, then the conversation and captured context. */
export function feedbackBody(submission: FeedbackSubmission): string {
  const request =
    submission.action === "REMOVE"
      ? ["## Removal request", "", REMOVAL_INSTRUCTION]
      : submission.action === "REDESIGN"
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

  const conversation = conversationSection(submission.conversation);
  if (conversation.length > 0) lines.push(...conversation, "");

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
  const fetchImpl = options.fetchImpl ?? fetch;
  const withTimeout: FetchLike = (input, init) =>
    fetchImpl(input, {
      ...init,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  try {
    const issue = await giteaCreateIssue(
      {
        baseUrl: options.baseUrl,
        project: options.repo,
        ...(options.token === undefined ? {} : { token: options.token }),
      },
      { title, body },
      withTimeout,
    );
    return { title, links: { issue: { href: issue.url } } };
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new FeedbackDeliveryError(
        504,
        `Issue creation timed out after ${options.timeoutMs} ms.`,
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new FeedbackDeliveryError(502, `Issue creation failed: ${firstLine(detail)}`);
  }
}
