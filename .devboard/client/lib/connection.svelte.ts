import { notifications } from "./notifications.svelte";
import { slowUiAction, type SlowUiActionOrigin, type SlowUiActionTicket } from "./slow-ui-action";
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

/**
 * Connections a browser opens to one origin. Every request beyond it queues in
 * dispatch order, so a page's own background reads can hold every slot in
 * front of a read or action the operator waits on.
 */
const ORIGIN_CONNECTIONS = 6;

/**
 * Origin connections this page's own reads may hold, whether a poll tick or an
 * open's replay issued them. The rest stay free for a foreground read: a
 * provider read the server answers in 5 ms waited 842 ms behind a poll burst
 * that had taken all six.
 */
const MAX_BACKGROUND_READS = ORIGIN_CONNECTIONS - 3;

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

/** One read this page issues for itself, waiting for a reserved connection. */
interface BackgroundRead {
  command: Envelope;
  key: string;
  origin: SlowUiActionOrigin;
}

/**
 * Owns every dashboard read and action. A mounted page registers its own GET
 * resource, which is polled once a second while the document is visible; an
 * action is one HTTP request whose reply frames still reach the registered
 * handlers. The interface opens no socket: every read, poll, and action is an
 * HTTP request.
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
  /** Page reads an open replay or a poll tick has not started yet. */
  private queue: BackgroundRead[] = [];
  /** Page reads this page currently holds a connection for. */
  private backgroundReads = 0;
  /** The page's six first-paint reads still unanswered; the replay waits. */
  private startingReads = 0;
  /** False while those six own the page's six origin connections. */
  private replayReady = true;
  /** Wakes the replay when a first-paint read never answers. */
  private replayTimer: number | undefined;
  private etags = new Map<string, string>();
  /** First open registers first-paint reads; later opens are reconnects. */
  private hasOpened = false;
  /** The origin the current open's six first-paint sends register under. */
  private openingOrigin: SlowUiActionOrigin | null = null;
  /** True while `opened` dispatches those six reads. */
  private dispatchingStartingReads = false;

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
      const envelope = command as Envelope;
      const missing = missingPathField(envelope, operation);
      if (missing !== null) {
        // An empty path parameter would address no operation: the server would
        // answer it as a missing file and the page as a stale bundle.
        this.lastError = `This action is missing its ${missing}.`;
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
      const action = slowUiAction.dispatch(command, resolved);
      if (operation.method === "GET") {
        this.register(envelope);
        if (this.dispatchingStartingReads) {
          this.startingReads += 1;
          void this.fetchResource(envelope, operation, resolved, action).finally(() => {
            this.startingReadAnswered();
            this.pump();
          });
        } else if (resolved === "refresh" || resolved === "reconnect") {
          this.enqueue(envelope, operation, resolved);
        } else {
          void this.fetchResource(envelope, operation, resolved, action);
        }
      } else {
        void this.perform(envelope, operation, action);
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
    // The six first-paint reads take the page's first six connections. A
    // browser opens six per origin, so a read dispatched after the surfaces'
    // reads waits for a slot behind them: a 2 ms records read queued behind a
    // slow issues, agents, or goal-drafts read and breached its 1000 ms
    // first-paint budget. The surfaces' replay reads are queued behind the
    // page's own reads instead of being issued after these six, in order.
    this.openingOrigin = opening;
    this.dispatchingStartingReads = true;
    try {
      this.send({ type: "listRecords" }, opening);
      this.send({ type: "getGoal" }, opening);
      this.send({ type: "getSkills" }, opening);
      this.send({ type: "getProject" }, opening);
      this.send({ type: "getVersion" }, opening);
      this.send({ type: "getProviders" }, opening);
    } finally {
      this.dispatchingStartingReads = false;
    }
    this.holdReplay();
    try {
      this.openingOrigin = "reconnect";
      for (const handler of this.openHandlers) handler();
    } finally {
      this.openingOrigin = null;
    }
    this.pump();
  }

  /**
   * Keeps the open's replay reads queued while the page's first-paint reads
   * own the six connections, and never longer than one cadence: a read that
   * never answers must not keep the page's modes unread for the session.
   */
  private holdReplay(): void {
    if (this.startingReads === 0) {
      this.replayReady = true;
      return;
    }
    this.replayReady = false;
    if (this.replayTimer !== undefined) return;
    if (typeof window === "undefined") return;
    this.replayTimer = window.setTimeout(() => {
      this.replayTimer = undefined;
      this.replayReady = true;
      this.pump();
    }, POLL_INTERVAL_MS);
  }

  /** One first-paint read answered; the replay may start with the last one. */
  private startingReadAnswered(): void {
    this.startingReads -= 1;
    if (this.startingReads > 0) return;
    if (this.replayTimer !== undefined) {
      clearTimeout(this.replayTimer);
      this.replayTimer = undefined;
    }
    this.replayReady = true;
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

  /**
   * Stops polling one registered read. A surface that followed a resource only
   * while it had a subject — an Ask conversation while its turn runs — drops
   * the registration the moment the subject settles, and a queued read of it
   * never starts afterwards.
   */
  forget(command: Envelope): void {
    const operation = REST_OPERATIONS[command.type];
    if (operation === undefined) return;
    const key = `${command.type}:${resourcePath(command, operation)}`;
    this.polled.delete(key);
    this.queue = this.queue.filter((queued) => queued.key !== key);
    this.inFlight.delete(key);
    this.etags.delete(key);
  }

  /**
   * Reads one resource once. A refresh or a reconnect revalidates state the
   * page still holds, conditional on the ETag last seen and deduped against a
   * read already in flight. An operator or first-paint read asks for the
   * representation itself — the surface may have dropped what it held — so it
   * carries no validator and is never dropped. Either way the action's own
   * response is its answer, so the ticket completes when that response lands.
   */
  private async fetchResource(
    command: Envelope,
    operation: RestOperation,
    origin: SlowUiActionOrigin,
    action: SlowUiActionTicket | null,
  ): Promise<void> {
    const key = `${command.type}:${resourcePath(command, operation)}`;
    const revalidate = origin === "refresh" || origin === "reconnect";
    if (revalidate) {
      if (this.inFlight.has(key)) return;
      this.inFlight.add(key);
    }
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (revalidate) {
        const etag = this.etags.get(key);
        if (etag !== undefined) headers["if-none-match"] = etag;
      }
      const response = await fetch(resourcePath(command, operation), {
        method: "GET",
        headers,
        cache: "no-store",
      });
      await this.answer(response, operation, key);
    } catch {
      this.lost();
    } finally {
      if (revalidate) this.inFlight.delete(key);
      action?.complete();
    }
  }

  /** Performs one mutating REST operation. */
  private async perform(
    command: Envelope,
    operation: RestOperation,
    action: SlowUiActionTicket | null,
  ): Promise<void> {
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
    } finally {
      action?.complete();
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
    let payload: string;
    try {
      payload = await response.text();
    } catch {
      // A body cut short is a server that stopped serving mid-answer — a
      // replacement handing over the port, or an exit — so it takes the same
      // path as a request that never answered. The next poll reads the state
      // again; reporting an unreadable body would turn a reconnect into an
      // error the page cannot act on.
      this.lost();
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(payload);
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

  /**
   * One polling tick: queues every registered resource once. The queue drains
   * through `pump`, which keeps at most `MAX_BACKGROUND_READS` page reads in
   * flight so a foreground read always finds a free origin connection.
   */
  private pollTick(): void {
    if (!documentVisible() || this.awaitingRestart) return;
    for (const resource of this.polled.values()) {
      const operation = REST_OPERATIONS[resource.command.type];
      if (operation !== undefined) this.enqueue(resource.command, operation, "refresh");
    }
  }

  /**
   * Queues one read this page issues for itself — a poll tick's refresh or an
   * open's replay — under its own key, so the same resource never waits twice.
   */
  private enqueue(
    command: Envelope,
    operation: RestOperation,
    origin: SlowUiActionOrigin,
  ): void {
    const key = `${command.type}:${resourcePath(command, operation)}`;
    if (this.queue.some((queued) => queued.key === key)) return;
    this.queue.push({ command, key, origin });
    this.pump();
  }

  /**
   * Starts queued page reads while a connection this page may hold is free,
   * and never before the six first-paint reads have answered: until then the
   * browser's six connections belong to them, and a read the page dispatches
   * at mount — the Resources tab's own budget read — must not wait behind the
   * whole replay. Nothing starts before the connection is open either: a
   * surface subscribes as it mounts, ahead of `connect`, and a read issued
   * there would take a first-paint slot — a live /goal-drafts read measured
   * 4469 ms while /records needs 2 ms.
   */
  private pump(): void {
    if (!this.open || !this.replayReady) return;
    while (!this.disposed && this.backgroundReads < MAX_BACKGROUND_READS) {
      const next = this.queue.shift();
      if (next === undefined) return;
      const operation = REST_OPERATIONS[next.command.type];
      if (operation === undefined) continue;
      this.backgroundReads += 1;
      void this.fetchResource(next.command, operation, next.origin, null).finally(() => {
        this.backgroundReads -= 1;
        this.pump();
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    slowUiAction.reset();
    this.queue = [];
    if (this.replayTimer !== undefined) clearTimeout(this.replayTimer);
    this.replayTimer = undefined;
    this.replayReady = true;
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

/** The first path field a command leaves out, or `null` when it carries all. */
function missingPathField(command: Envelope, operation: RestOperation): string | null {
  for (const [, field] of operation.pathParams) {
    const value = command[field];
    if (typeof value === "number") continue;
    if (typeof value !== "string" || value.length === 0) return field;
  }
  return null;
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
