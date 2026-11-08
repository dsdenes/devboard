import { SvelteMap } from "svelte/reactivity";
import { REPORTS_ENDPOINT } from "../../lib/endpoints.ts";
import type { AppNotification, Severity } from "./notifications.svelte";

/** The server's `report` bound; the title line and metadata must fit inside it. */
export const MAX_NOTIFICATION_REPORT = 8000;

/**
 * The instruction every automatically filed error issue carries. It is fixed,
 * so the Issues worker reads one unambiguous request and needs no operator
 * text to decide what to do.
 */
export const AUTOMATIC_ISSUE_INSTRUCTION =
  "Investigate this error and fix it if it is needed.";

/** Why an error card names no issue when the dashboard cannot report at all. */
export const REPORTING_DISABLED_DETAIL = "reporting is disabled.";

const SEVERITY_LABEL: Record<Severity, string> = {
  error: "Error",
  warning: "Warning",
  notice: "Notice",
  success: "Success",
};

/**
 * The report a notification files. Its first line becomes the issue title, so
 * the notification text leads, labelled with its severity; the source and
 * timestamp follow as context. An optional instruction closes the report, and
 * the whole thing stays inside the server's bound even for a long message.
 */
export function notificationReport(item: AppNotification, instruction?: string): string {
  const prefix = `${SEVERITY_LABEL[item.severity]} notification: `;
  const suffix = `\n\nSource: ${item.source}\nRaised at: ${item.at}`;
  const closing = instruction === undefined ? "" : `\n\n${instruction}`;
  const budget = Math.max(0, MAX_NOTIFICATION_REPORT - prefix.length - suffix.length - closing.length);
  const text = item.text.trim();
  const body =
    text.length <= budget ? text : `${text.slice(0, Math.max(0, budget - 1)).trimEnd()}…`;
  return `${prefix}${body}${suffix}${closing}`;
}

/** The page context a notification carries into its issue. */
export interface NotificationContext {
  route: string;
  url: string;
  selector: string;
  domExcerpt: string;
  visibleText: string;
  viewport: string;
  capturedAt: string;
}

/** The `/reports` body a notification posts; the server contract is unchanged. */
export interface NotificationIssueRequest {
  action: "REPORT";
  report: string;
  route: string;
  url: string;
  selector: string;
  dom_excerpt: string;
  visible_text: string;
  viewport: string;
  captured_at: string;
}

/**
 * What one error notification's filing has done in this page session. An
 * identical notification shares the outcome, so a repeated error links to the
 * issue already filed instead of filing a second one.
 */
export type NotificationFiling =
  | { status: "pending" }
  | { status: "filed"; href: string }
  | { status: "failed"; detail: string };

/** Identical notifications: the same severity, source, and text. */
export function notificationFingerprint(item: AppNotification): string {
  return JSON.stringify([item.severity, item.source, item.text]);
}

/**
 * The `Idempotency-Key` an error notification files under. The fingerprint is
 * identical in every page session, so two windows that raise the same error
 * post the same key and the server answers the second with the issue filed by
 * the first instead of filing a duplicate. Only errors carry it: a warning is
 * filed by an explicit click and each click files its own issue.
 */
export function notificationIdempotencyKey(item: AppNotification): string {
  return `notification-error:${fnv1a64(notificationFingerprint(item))}`;
}

/**
 * The `Idempotency-Key` one slow UI action files under. The action identity is
 * identical in every page session, so a reload or a second window posts the
 * same key and the server replays the issue already filed instead of creating
 * a duplicate inside its 24-hour retention window.
 */
export function slowUiActionIdempotencyKey(identity: string): string {
  return `slow-ui-action:${fnv1a64(identity)}`;
}

/**
 * FNV-1a over the fingerprint's UTF-8 bytes: a fixed 16-hex-digit key that is
 * pure ASCII, well inside the header's 255-character bound.
 */
function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

/** The request one notification posts, with the instruction an error carries. */
export function notificationIssueRequest(
  item: AppNotification,
  context: NotificationContext,
): NotificationIssueRequest {
  const instruction = item.severity === "error" ? AUTOMATIC_ISSUE_INSTRUCTION : undefined;
  return {
    action: "REPORT",
    report: notificationReport(item, instruction),
    route: context.route,
    url: context.url,
    selector: context.selector,
    dom_excerpt: context.domExcerpt,
    visible_text: context.visibleText,
    viewport: context.viewport,
    captured_at: context.capturedAt,
  };
}

/**
 * Files one slow UI action through the existing `/reports` endpoint. The
 * report is already bounded and its first line becomes the issue title. The
 * keyed request lets the server's 24-hour replay cache guarantee one issue per
 * action identity across page sessions.
 */
export async function fileSlowUiAction(
  report: string,
  idempotencyKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    const response = await fetchImpl(REPORTS_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ action: "REPORT", report }),
    });
    const body = (await response.json().catch(() => null)) as {
      links?: { issue?: { href?: unknown } };
      detail?: unknown;
    } | null;
    const href = body?.links?.issue?.href;
    if (!response.ok || typeof href !== "string") {
      return {
        ok: false,
        error:
          typeof body?.detail === "string"
            ? body.detail
            : `The server refused the report (${response.status}).`,
      };
    }
    return { ok: true, url: href };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

type FetchLike = typeof fetch;

/**
 * Files notification issues and remembers, for the life of the page, what each
 * identical error produced. An automatic filing happens once per identity; a
 * manual warning filing and an explicit retry always post.
 */
export class NotificationFiler {
  /** The outcome of each error identity; reading it is reactive. */
  readonly states = new SvelteMap<string, NotificationFiling>();
  /** The request in flight per identity, so one card never posts twice. */
  private readonly inFlight = new Map<string, Promise<NotificationFiling>>();

  /** The recorded outcome for this notification's identity, if any. */
  state(item: AppNotification): NotificationFiling | undefined {
    return this.states.get(notificationFingerprint(item));
  }

  /**
   * Files an error notification unless this page session already has its
   * outcome or a request for it is in flight. Returns undefined when the
   * identity was already decided, so no second POST is sent.
   */
  autoFile(
    item: AppNotification,
    context: () => NotificationContext,
    fetchImpl: FetchLike = fetch,
  ): Promise<NotificationFiling> {
    const key = notificationFingerprint(item);
    const known = this.states.get(key);
    if (known !== undefined) {
      return this.inFlight.get(key) ?? Promise.resolve(known);
    }
    return this.file(item, context, fetchImpl);
  }

  /**
   * Posts one notification and records the outcome. A retry and a warning
   * both use it; the outcome is shared with later identical errors.
   */
  file(
    item: AppNotification,
    context: () => NotificationContext,
    fetchImpl: FetchLike = fetch,
  ): Promise<NotificationFiling> {
    const key = notificationFingerprint(item);
    const running = this.inFlight.get(key);
    if (running !== undefined) return running;
    const promise = this.#deliver(item, context, fetchImpl, key);
    this.inFlight.set(key, promise);
    this.states.set(key, { status: "pending" });
    return promise;
  }

  /** Posts one notification without recording or deduplicating it. */
  async submit(
    item: AppNotification,
    context: () => NotificationContext,
    fetchImpl: FetchLike = fetch,
  ): Promise<NotificationFiling> {
    try {
      return await this.#post(item, context, fetchImpl);
    } catch (error) {
      return {
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Forgets every outcome; tests use it to start a fresh page session. */
  reset(): void {
    this.states.clear();
    this.inFlight.clear();
  }

  async #deliver(
    item: AppNotification,
    context: () => NotificationContext,
    fetchImpl: FetchLike,
    key: string,
  ): Promise<NotificationFiling> {
    let outcome: NotificationFiling;
    try {
      outcome = await this.#post(item, context, fetchImpl);
    } catch (error) {
      outcome = {
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    this.inFlight.delete(key);
    this.states.set(key, outcome);
    return outcome;
  }

  async #post(
    item: AppNotification,
    context: () => NotificationContext,
    fetchImpl: FetchLike,
  ): Promise<NotificationFiling> {
    const payload = notificationIssueRequest(item, context());
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (item.severity === "error") {
      headers["idempotency-key"] = notificationIdempotencyKey(item);
    }
    const response = await fetchImpl(REPORTS_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => null)) as {
      links?: { issue?: { href?: unknown } };
      detail?: unknown;
    } | null;
    const href = body?.links?.issue?.href;
    if (!response.ok || typeof href !== "string") {
      throw new Error(
        typeof body?.detail === "string"
          ? body.detail
          : `The server refused the report (${response.status}).`,
      );
    }
    return { status: "filed", href };
  }
}

export const notificationFiler = new NotificationFiler();
