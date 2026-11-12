/**
 * The one HTTP transport: every request this page makes runs through here.
 *
 * A read answers the frames the server serves for one REST GET, and a command
 * posts the body its operation names. The query and mutation functions call
 * these; no component or store calls `fetch` itself.
 */
import { READY_ENDPOINT } from "../../lib/endpoints.ts";
import { REST_OPERATIONS, requestBody, resourcePath, type RestOperation } from "./rest-map";
import { isStaleBundleProblem, reloadOnceForStaleBundle } from "./stale-bundle";

export interface Envelope {
  type: string;
  [key: string]: unknown;
}

/** The command object the stores and surfaces dispatch. */
export type Command = Record<string, unknown> & { type: string };

/** A refused or unreadable request, named for the surface that shows it. */
export class TransportError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "TransportError";
    this.status = status;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Every frame one answer carries, whether it is one frame or a list. */
function framesOf(body: unknown): Envelope[] {
  if (!isObject(body)) return [];
  if (typeof body.type === "string") return [body as Envelope];
  if (!Array.isArray(body.frames)) return [];
  return body.frames.filter(
    (frame): frame is Envelope => isObject(frame) && typeof frame.type === "string",
  );
}

async function decode(
  response: Response,
  operation: RestOperation,
): Promise<Envelope[]> {
  if (!response.ok) {
    let detail = `The server answered HTTP ${response.status}.`;
    if (response.headers.get("content-type") === "application/problem+json") {
      try {
        const body = (await response.json()) as Record<string, unknown>;
        if (typeof body.detail === "string") detail = body.detail;
      } catch {
        // The status stands as the reason.
      }
    }
    if (
      isStaleBundleProblem(response.status, operation) &&
      reloadOnceForStaleBundle(
        typeof sessionStorage === "undefined" ? null : sessionStorage,
        () => location.reload(),
      )
    ) {
      // The page reloads onto the client the server serves; this read is over.
      return [];
    }
    throw new TransportError(detail, response.status);
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new TransportError("The server answered an unreadable body.");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new TransportError("The server answered an unreadable body.");
  }
  return framesOf(body);
}

/** One REST GET: the resource's own frames. */
export async function readResource(command: Command): Promise<Envelope[]> {
  if (typeof process !== "undefined" && process.env.DEVBOARD_TRACE_READS) {
    console.trace("read", command.type);
  }
  const operation = REST_OPERATIONS[command.type];
  if (operation === undefined || operation.method !== "GET") {
    throw new TransportError(`No REST read is registered for ${command.type}.`);
  }
  let response: Response;
  try {
    response = await fetch(resourcePath(command, operation), {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    throw new TransportError("Could not reach the server.");
  }
  return decode(response, operation);
}

/** One command: its REST method and body, and the frames it answers. */
export async function sendCommand(command: Command): Promise<Envelope[]> {
  const operation = REST_OPERATIONS[command.type];
  if (operation === undefined || operation.method === "GET") {
    throw new TransportError(`No REST command is registered for ${command.type}.`);
  }
  let response: Response;
  try {
    response = await fetch(resourcePath(command, operation), {
      method: operation.method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody(command, operation)),
    });
  } catch {
    throw new TransportError("Could not reach the server.");
  }
  return decode(response, operation);
}

/** Asks the server for one replacement. */
export async function restartServer(): Promise<void> {
  const operation = REST_OPERATIONS.restartServer;
  if (operation === undefined) {
    throw new TransportError("No REST command is registered for restartServer.");
  }
  let response: Response;
  try {
    response = await fetch(operation.path, {
      method: operation.method,
      headers: { accept: "application/json" },
    });
  } catch {
    throw new TransportError("Could not reach the server.");
  }
  if (!response.ok) {
    throw new TransportError(`The server answered HTTP ${response.status}.`, response.status);
  }
}

/** The pid `/ready` names, or `null` when no process answered it. */
export async function answeringPid(): Promise<number | null> {
  try {
    const response = await fetch(READY_ENDPOINT, {
      cache: "no-store",
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    return typeof body.pid === "number" ? body.pid : null;
  } catch {
    return null;
  }
}

/** True when the process answering `/ready` is not the one being replaced. */
export async function replacementAnswers(before: number | null): Promise<boolean> {
  try {
    const response = await fetch(READY_ENDPOINT, { cache: "no-store", method: "HEAD" });
    if (!response.ok) return false;
  } catch {
    return false;
  }
  const pid = await answeringPid();
  if (pid === null) return before === null;
  return before === null || pid !== before;
}

/** One JSON payload posted to a non-REST endpoint, and its decoded body. */
export async function postJson(
  endpoint: string,
  payload: object,
): Promise<{ status: number; ok: boolean; body: Record<string, unknown> | null }> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new TransportError(error instanceof Error ? error.message : String(error));
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: response.status, ok: response.ok, body };
}
