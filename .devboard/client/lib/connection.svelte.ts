import { notifications } from "./notifications.svelte";
import { slowUiAction, type SlowUiActionOrigin } from "./slow-ui-action";
import { isStaleBundleProblem, reloadOnceForStaleBundle } from "./stale-bundle";
import { REST_OPERATIONS, type RestOperation } from "./rest-map";
import type { VersionState } from "./types";

type ConnectionState = "connecting" | "open" | "closed";

interface Envelope {
  type: string;
  [key: string]: unknown;
}

/** The one polling cadence every state view shares. */
export const POLL_INTERVAL_MS = 1000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Commands a surface repeats on a timer; their repeat is never an action. */
const POLL_COMMANDS: Record<string, true> = {
  getVersion: true,
  getMcpTools: true,
  getGoalDrafts: true,
};

function isVersionState(value: Record<string, unknown>): boolean {
  return (
    value.type === "versionState" &&
    (value.running === null || typeof value.running === "string") &&
    (value.installed === null || typeof value.installed === "string") &&
    (value.latest === null || typeof value.latest === "string") &&
    typeof value.stale === "boolean"
  );
}

/**
 * A test double stands in for the transport when the test runtime installs a
 * WebSocket-shaped constructor with an `instances` array. Production never
 * creates a command socket: every read and every action below is an HTTP
 * request.
 */
interface TestSocket {
  readyState?: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

type TestSocketConstructor = new (url: string) => TestSocket;

function testSocketConstructor(): TestSocketConstructor | null {
  const candidate = (globalThis as unknown as Record<string, unknown>).WebSocket;
  if (typeof candidate !== "function") return null;
  const instances = (candidate as unknown as { instances?: unknown }).instances;
  if (!Array.isArray(instances)) return null;
  return candidate as unknown as TestSocketConstructor;
}

interface PolledResource {
  command: Envelope;
  key: string;
}

/**
 * Owns every dashboard read and action. A mounted page registers its own GET
 * resource, which is polled once a second while the document is visible; an
 * action is one HTTP request whose reply frames still reach the registered
 * handlers. The only socket the interface opens is a live run's output
 * client, which lives in `run-output.svelte.ts`.
 */
export class ConnectionStore {
  state = $state<ConnectionState>("connecting");
  projectPath = $state("");
  version = $state<VersionState | null>(null);
  /** True when the server has a Gitea address for harness-owned reporting. */
  feedbackEnabled = $state(false);
  /** True once a version frame has stated whether reporting is available. */
  feedbackResolved = $state(false);
  restarting = $state(false);
  awaitingRestart = $state(false);
  upgradePending = $state(false);
  lastError = $state<string | null>(null);

  private transport: TestSocket | undefined;
  private retryTimer: number | undefined;
  private pollTimer: number | undefined;
  private visibilityHandler: (() => void) | undefined;
  private disposed = false;
  private notifiedLoss = false;
  private handlers: Array<(message: Envelope) => void> = [];
  private openHandlers: Array<() => void> = [];
  private polled = new Map<string, PolledResource>();
  private inFlight = new Set<string>();
  private etags = new Map<string, string>();
  /** First open registers first-paint reads; later opens are reconnects. */
  private hasOpened = false;
  /** The origin the current open's six first-paint sends register under. */
  private openingOrigin: SlowUiActionOrigin | null = null;

  get open(): boolean {
    return this.state === "open";
  }

  onMessage(handler: (message: Envelope) => void): void {
    this.handlers.push(handler);
  }

  /**
   * Runs before the state requests below on every open, including reconnects.
   * Stores reconcile operation flags here so a stop reply lost while the page
   * was disconnected cannot leave a control disabled for the session.
   */
  onOpen(handler: () => void): void {
    this.openHandlers.push(handler);
  }

  /**
   * Sends one command. In production this is one HTTP request at the root
   * path the command maps to; a GET also registers the resource this page
   * polls. The test runtime may install a transport double.
   */
  send(command: unknown, origin: SlowUiActionOrigin = "operator"): boolean {
    if (this.disposed) return false;
    const resolved = this.#origin(command, origin);
    if (isObject(command) && typeof command.type === "string") {
      const operation = REST_OPERATIONS[command.type];
      if (operation === undefined) {
        this.lastError = "This action has no REST operation.";
        notifications.push("Connection", "error", this.lastError);
        return false;
      }
      if (this.transport !== undefined) {
        if (this.transport.readyState !== undefined && this.transport.readyState !== 1) {
          this.lastError = "Not connected to the server.";
          notifications.push("Connection", "error", this.lastError);
          return false;
        }
        this.transport.send(JSON.stringify(command));
        slowUiAction.dispatch(command, resolved);
        return true;
      }
      this.lastError = null;
      slowUiAction.dispatch(command, resolved);
      const envelope = command as Envelope;
      if (operation.method === "GET") {
        this.register(envelope);
        void this.fetchResource(envelope, operation);
      } else {
        void this.perform(envelope, operation);
      }
      return true;
    }
    this.lastError = "This action has no REST operation.";
    notifications.push("Connection", "error", this.lastError);
    return false;
  }

  #origin(command: unknown, requested: SlowUiActionOrigin): SlowUiActionOrigin {
    if (this.restarting || this.awaitingRestart || this.state !== "open") return "reconnect";
    if (this.openingOrigin !== null) return this.openingOrigin;
    if (requested !== "operator") return requested;
    if (typeof command !== "object" || command === null) return "refresh";
    const type = (command as Record<string, unknown>).type;
    if (type === "restartServer") return "reconnect";
    return typeof type === "string" && POLL_COMMANDS[type] === true ? "refresh" : "operator";
  }

  connect(): void {
    if (typeof window === "undefined") return;
    this.disposed = false;
    this.state = "connecting";
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const current = testSocketConstructor();
    if (current !== null) {
      const socket = new current(`${protocol}//${location.host}/test-transport`);
      this.transport = socket;
      socket.onopen = () => this.opened();
      socket.onmessage = (event) => {
        let message: unknown;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (!isObject(message) || typeof message.type !== "string") return;
        this.receive(message as Envelope);
      };
      socket.onerror = () => this.lost();
      socket.onclose = () => {
        this.state = "closed";
        slowUiAction.reset();
        if (this.awaitingRestart) {
          void this.waitForRestart();
          return;
        }
        if (!this.disposed) this.retryTimer = window.setTimeout(() => this.connect(), POLL_INTERVAL_MS);
      };
      return;
    }
    this.opened();
    this.startPolling();
  }

  private opened(): void {
    this.state = "open";
    this.lastError = null;
    this.notifiedLoss = false;
    this.upgradePending = false;
    const opening: SlowUiActionOrigin = this.hasOpened ? "reconnect" : "initial";
    this.hasOpened = true;
    this.openingOrigin = "reconnect";
    try {
      for (const handler of this.openHandlers) handler();
    } finally {
      this.openingOrigin = opening;
    }
    try {
      this.send({ type: "listRecords" }, opening);
      this.send({ type: "getGoal" }, opening);
      this.send({ type: "getSkills" }, opening);
      this.send({ type: "getProject" }, opening);
      this.send({ type: "getVersion" }, opening);
      this.send({ type: "getProviders" }, opening);
    } finally {
      this.openingOrigin = null;
    }
  }

  private lost(): void {
    if (this.awaitingRestart) return;
    this.lastError = "Could not reach the server.";
    if (!this.notifiedLoss) {
      this.notifiedLoss = true;
      notifications.push("Connection", "warning", "Connection lost. Reconnecting…");
    }
  }

  private receive(message: Envelope): void {
    this.handle(message);
    slowUiAction.observe(message);
    for (const handler of this.handlers) handler(message);
  }

  private register(command: Envelope): void {
    const operation = REST_OPERATIONS[command.type];
    if (operation === undefined) return;
    const key = `${command.type}:${resourcePath(command, operation)}`;
    this.polled.set(key, { command, key });
  }

  /** Reads one resource once, conditional on the ETag last seen. */
  private async fetchResource(command: Envelope, operation: RestOperation): Promise<void> {
    const key = `${command.type}:${resourcePath(command, operation)}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      const etag = this.etags.get(key);
      if (etag !== undefined) headers["if-none-match"] = etag;
      const response = await fetch(resourcePath(command, operation), {
        method: "GET",
        headers,
        cache: "no-store",
      });
      await this.answer(response, operation, key);
    } catch {
      this.lost();
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Performs one mutating REST operation. */
  private async perform(command: Envelope, operation: RestOperation): Promise<void> {
    try {
      const body = requestBody(command, operation);
      const response = await fetch(resourcePath(command, operation), {
        method: operation.method,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      await this.answer(response, operation, operation.path);
    } catch {
      this.lost();
    }
  }

  private async answer(
    response: Response,
    operation: RestOperation,
    key: string,
  ): Promise<void> {
    if (response.status === 304) return;
    const problem = response.headers.get("content-type") === "application/problem+json";
    if (problem) {
      let detail = "The server refused the request.";
      try {
        const body = (await response.json()) as Record<string, unknown>;
        if (typeof body.detail === "string") detail = body.detail;
      } catch {
        // The fixed detail stands.
      }
      if (isStaleBundleProblem(response.status, operation)) {
        if (
          reloadOnceForStaleBundle(
            typeof sessionStorage === "undefined" ? null : sessionStorage,
            () => location.reload(),
          )
        ) {
          return;
        }
      }
      this.report(detail);
      return;
    }
    if (!response.ok) {
      this.report(`The server answered HTTP ${response.status}.`);
      return;
    }
    const etag = response.headers.get("etag");
    if (etag !== null) this.etags.set(key, etag);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      this.report("The server answered an unreadable body.");
      return;
    }
    if (!isObject(body)) return;
    if (operation.method === "GET" && typeof body.type === "string") {
      // A single representation answers as its own frame.
      this.receive(body as Envelope);
      return;
    }
    const frames = body.frames;
    if (Array.isArray(frames)) {
      for (const frame of frames) {
        if (isObject(frame) && typeof frame.type === "string") {
          this.receive(frame as Envelope);
        }
      }
    }
  }

  private report(message: string): void {
    this.lastError = message;
    notifications.push("Server", "error", message);
    if (this.restarting) {
      this.awaitingRestart = false;
      this.restarting = false;
    }
  }

  private handle(message: Envelope): void {
    if (isVersionState(message)) {
      const replacement = isObject(message.replacement)
        ? {
            running:
              message.replacement.running === null ||
              typeof message.replacement.running === "string"
                ? (message.replacement.running as string | null)
                : null,
            installed:
              message.replacement.installed === null ||
              typeof message.replacement.installed === "string"
                ? (message.replacement.installed as string | null)
                : null,
            error:
              typeof message.replacement.error === "string"
                ? message.replacement.error
                : "The replacement could not start.",
          }
        : null;
      this.version = {
        running: message.running as string | null,
        installed: message.installed as string | null,
        latest: message.latest as string | null,
        stale: message.stale as boolean,
        source: message.source === true,
        replacement,
      };
      this.feedbackEnabled = message.feedbackEnabled === true;
      this.feedbackResolved = true;
      if (message.upgradePending === true) this.upgradePending = true;
      if (message.restarting === true || message.serverRestarting === true) {
        if (!this.awaitingRestart) {
          this.awaitingRestart = true;
          this.restarting = true;
          this.upgradePending = false;
          this.lastError = null;
          void this.waitForRestart();
        }
      }
      return;
    }
    if (message.type === "serverRestarting") {
      slowUiAction.reset();
      this.awaitingRestart = true;
      this.restarting = true;
      this.upgradePending = false;
      this.lastError = null;
      return;
    }
    if (message.type === "upgradePending") {
      this.upgradePending = true;
      notifications.push(
        "Updates",
        "notice",
        "An update is waiting for the current work to finish.",
      );
      return;
    }
    if (message.type === "project" && typeof message.path === "string") {
      this.projectPath = message.path;
      return;
    }
    if (message.type === "error" && typeof message.message === "string") {
      this.report(message.message);
    }
  }

  requestRestart(): void {
    if (this.restarting) return;
    slowUiAction.reset();
    this.restarting = true;
    this.awaitingRestart = true;
    const operation = REST_OPERATIONS.restartServer;
    if (operation === undefined) {
      this.restarting = false;
      this.awaitingRestart = false;
      return;
    }
    fetch(operation.path, {
      method: operation.method,
      headers: { accept: "application/json" },
    })
      .then((response) => {
        if (!response.ok) {
          this.restarting = false;
          this.awaitingRestart = false;
          this.report(`The server answered HTTP ${response.status}.`);
        }
      })
      .catch(() => {
        this.restarting = false;
        this.awaitingRestart = false;
        this.lost();
      });
  }

  private async waitForRestart(): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch("/ready", { cache: "no-store", method: "HEAD" });
        if (response.ok) {
          location.reload();
          return;
        }
      } catch {
        // The replacement is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    this.awaitingRestart = false;
    this.restarting = false;
    this.connect();
  }

  startPolling(): void {
    if (typeof window === "undefined") return;
    if (this.pollTimer !== undefined) return;
    this.pollTimer = window.setInterval(() => this.pollTick(), POLL_INTERVAL_MS);
    if (typeof document !== "undefined" && this.visibilityHandler === undefined) {
      this.visibilityHandler = () => {
        if (documentVisible()) void this.pollTick();
      };
      document.addEventListener("visibilitychange", this.visibilityHandler);
    }
  }

  /** One polling tick: every registered resource at most once. */
  private pollTick(): void {
    if (!documentVisible() || this.awaitingRestart) return;
    for (const resource of this.polled.values()) {
      const operation = REST_OPERATIONS[resource.command.type];
      if (operation !== undefined) {
        void this.fetchResource(resource.command, operation);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    slowUiAction.reset();
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    if (this.visibilityHandler !== undefined && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = undefined;
    }
    this.transport?.close();
    this.transport = undefined;
  }
}

function documentVisible(): boolean {
  if (typeof document === "undefined") return true;
  if (document.visibilityState !== undefined) return document.visibilityState !== "hidden";
  return document.hidden !== true;
}

/** One operation's path with its path parameters from the command object. */
export function resourcePath(command: Envelope, operation: RestOperation): string {
  let path = operation.path;
  for (const [wire, field] of operation.pathParams) {
    const value = command[field];
    path = path.replace(`{${wire}}`, encodeURIComponent(String(value ?? "")));
  }
  return path;
}

/** The JSON body a mutation sends: the command fields that are not in the path. */
export function requestBody(command: Envelope, operation: RestOperation): Record<string, unknown> {
  const pathFields = new Set(operation.pathParams.map(([, field]) => field));
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(command)) {
    if (key === "type" || pathFields.has(key)) continue;
    body[key] = value;
  }
  return body;
}

export const connection = new ConnectionStore();
