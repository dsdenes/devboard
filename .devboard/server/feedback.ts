/**
 * Operator issue reporting for the local interface.
 *
 * The client sends one free-text report plus the DOM context of the element
 * the report is about. This module validates that payload, renders it as a
 * GitHub issue for an implementation agent, and files the issue through the
 * host's authenticated `gh` command. Nothing about the host is assumed beyond
 * a GitHub remote reachable from `REPO_DIR` (or an explicit `FEEDBACK_REPO`).
 */

const MAX_REPORT = 8000;
const MAX_CONTEXT_FIELD = 2000;
const MAX_DOM_EXCERPT = 8000;
const MAX_VISIBLE_TEXT = 8000;
const MAX_VIEWPORT = 500;
const MAX_TITLE = 200;
const TITLE_PREFIX = "[ui] ";
const BODY_VISIBLE_TEXT = 1500;

export interface FeedbackSubmission {
  report: string;
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
  /** Directory `gh` runs in; it resolves the GitHub remote from here. */
  repoDir: string;
  /** `owner/name` override; when absent `gh` uses `repoDir`'s remote. */
  repository?: string;
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

/** Validates one JSON body. Unknown fields are ignored for forwards compatibility. */
export function parseFeedbackSubmission(value: unknown): FeedbackSubmission {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FeedbackRequestError(400, "The report must be a JSON object.");
  }
  const source = value as Record<string, unknown>;
  return {
    report: field(source.report, "report", MAX_REPORT, true),
    route: field(source.route, "route", MAX_CONTEXT_FIELD, false),
    url: field(source.url, "url", MAX_CONTEXT_FIELD, false),
    selector: field(source.selector, "selector", MAX_CONTEXT_FIELD, false),
    domExcerpt: field(source.dom_excerpt, "dom_excerpt", MAX_DOM_EXCERPT, false),
    visibleText: field(source.visible_text, "visible_text", MAX_VISIBLE_TEXT, false),
    viewport: field(source.viewport, "viewport", MAX_VIEWPORT, false),
    capturedAt: field(source.captured_at, "captured_at", MAX_CONTEXT_FIELD, false),
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

/** One-line title from the report's first meaningful line. */
export function feedbackTitle(report: string): string {
  const line =
    report
      .split("\n")
      .map((value) => value.trim())
      .find((value) => value.length > 0) ?? "operator report";
  return truncate(`${TITLE_PREFIX}${line.replace(/\s+/g, " ")}`, MAX_TITLE);
}

/** The ticket body: the operator's words first, then the captured context. */
export function feedbackBody(submission: FeedbackSubmission): string {
  const lines = ["## Operator report", "", submission.report.trim(), ""];

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

  lines.push("## Captured UI context", "");
  lines.push(...(context.length === 0 ? ["No page context was captured."] : context));
  return lines.join("\n");
}

function firstLine(value: string): string {
  const line =
    value
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0) ?? "no diagnostic";
  return truncate(line, 300);
}

/** Files one report and returns the created issue. */
export async function fileFeedbackIssue(
  submission: FeedbackSubmission,
  options: FeedbackIssueOptions,
): Promise<FeedbackIssue> {
  const title = feedbackTitle(submission.report);
  const body = feedbackBody(submission);
  const args = [
    ...options.command,
    "issue",
    "create",
    "--title",
    title,
    "--body-file",
    "-",
  ];
  if (options.repository !== undefined && options.repository.length > 0) {
    args.push("--repo", options.repository);
  }

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
