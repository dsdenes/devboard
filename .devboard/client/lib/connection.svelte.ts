import { notifications } from "./notifications.svelte";
import { slowUiAction, type SlowUiActionOrigin, type SlowUiActionTicket } from "./slow-ui-action";
import { isStaleBundleProblem, reloadOnceForStaleBundle } from "./stale-bundle";
import { REST_OPERATIONS, type RestOperation } from "./rest-map";
import { cadenceFor, type PollScope } from "./cadence";
import { READY_ENDPOINT } from "../../lib/endpoints.ts";
import type { VersionState } from "./types";

type ConnectionState = "connecting" | "open" | "closed";

interface Envelope {
  type: string;
  [key: string]: unknown;
}

/**
 * How often the scheduler checks which planned resource is due. The cadences
 * themselves are the table in `cadence.ts`; this is only their resolution.
 */
const SCHEDULER_TICK_MS = 1000;

/** A reconnect retry after the transport closed under a live page. */
const RETRY_INTERVAL_MS = 1000;

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

/** One planned read: the owners showing it, its interval, and its due time. */
interface PlannedRead {
  command: Envelope;
  /** Every surface claiming the resource, with the scope it earns there. */
  scopes: Map<string, PollScope>;
  /** The finest cadence those scopes earn; 0 while no surface shows it. */
  interval: number;
  /** When the scheduler may read it again. */
  dueAt: number;
}

/** One read this page issues for itself, waiting for a reserved connection. */
interface BackgroundRead {
  command: Envelope;
  key: string;
  origin: SlowUiActionOrigin;
}

/** The owner prefix the surfaces on screen claim reads under. */
const SURFACE_OWNER = "surface";

/** One claim owner per scope, so a resource can earn two cadences at once. */
const SURFACE_SCOPES: readonly PollScope[] = ["background", "body", "live"];

/** The finest cadence the given scopes earn for one operation. */
function effectiveInterval(type: string, scopes: Map<string, PollScope>): number {
  let interval = 0;
  for (const scope of scopes.values()) {
    const cadence = cadenceFor(type, scope);
    if (cadence === 0) continue;
    if (interval === 0 || cadence < interval) interval = cadence;
  }
  return interval;
}

/**
 * Owns every dashboard read and action. The scheduler below is the page's one
 * timer: it reads each planned resource at the cadence its claiming surfaces
 * earn in `cadence.ts`, and reads nothing no surface shows. A surface declares
 * what it displays through `setSurfaceClaims` (the whole plan, from the active
 * layout) or `claim`/`release` (one overlay's own follow). An action is one
 * HTTP request whose reply frames still reach the registered handlers. The
 * interface opens no socket: every read, poll, and action is an HTTP request.
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
  private claims = new Map<string, PlannedRead>();
  private inFlight = new Set<string>();
  /** Page reads a due tick or an open has not started yet. */
  private queue: BackgroundRead[] = [];
  /** Page reads this page currently holds a connection for. */
  private backgroundReads = 0;
  private etags = new Map<string, string>();
  /** True while one replacement watch runs; a later frame joins it. */
  private restartWatch = false;
  /** The pid that answered before the restart; the replacement's differs. */
  private restartPid: number | null = null;
  /** First open is the initial read; later opens are reconnects. */
  private hasOpened = false;

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
   * path the command maps to; a GET a page's own poll repeats is planned
   * through `setSurfaceClaims`, never by sending it again. The test runtime
   * may install a transport double.
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
        if (resolved === "refresh" || resolved === "reconnect") {
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
          this.startRestartWatch();
          return;
        }
        if (!this.disposed) this.retryTimer = window.setTimeout(() => this.connect(), RETRY_INTERVAL_MS);
      };
      return;
    }
    this.opened();
    this.startPolling();
  }

  /**
   * One open, first connect or reconnect: the once-per-connect project read,
   * then one read of every planned resource. The read decisions themselves
   * live in `cadence.ts`; this method only says "the page is here, read what
   * is on it".
   */
  private opened(): void {
    this.state = "open";
    this.lastError = null;
    this.notifiedLoss = false;
    this.upgradePending = false;
    const opening: SlowUiActionOrigin = this.hasOpened ? "reconnect" : "initial";
    this.hasOpened = true;
    for (const handler of this.openHandlers) handler();
    const project = REST_OPERATIONS.getProject;
    if (project !== undefined) this.enqueue({ type: "getProject" }, project, opening);
    this.readAll(opening);
    this.pump();
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

  /**
   * Replaces every read the surfaces on screen claim. The whole plan arrives
   * at once, so a tab that closed, a mode that hid, or a run that settled is
   * gone from the plan by construction — there is no per-surface bookkeeping
   * left behind to keep reading it. One resource can be claimed by more than
   * one scope, and the finest cadence among them wins.
   */
  setSurfaceClaims(claims: ReadonlyArray<{ command: Envelope; scope: PollScope }>): void {
    const desired = new Map<string, { command: Envelope; scopes: PollScope[] }>();
    for (const claim of claims) {
      const operation = REST_OPERATIONS[claim.command.type];
      if (operation === undefined || operation.method !== "GET") continue;
      const key = `${claim.command.type}:${resourcePath(claim.command, operation)}`;
      const entry = desired.get(key);
      if (entry === undefined) {
        desired.set(key, { command: claim.command, scopes: [claim.scope] });
      } else {
        entry.command = claim.command;
        if (!entry.scopes.includes(claim.scope)) entry.scopes.push(claim.scope);
      }
    }
    for (const [key, entry] of this.claims) {
      const wanted = desired.get(key);
      for (const scope of SURFACE_SCOPES) {
        const owner = `${SURFACE_OWNER}:${scope}`;
        if (entry.scopes.has(owner) && wanted?.scopes.includes(scope) !== true) {
          entry.scopes.delete(owner);
        }
      }
      if (wanted !== undefined) {
        entry.command = wanted.command;
        for (const scope of wanted.scopes) entry.scopes.set(`${SURFACE_OWNER}:${scope}`, scope);
      }
      this.schedule(key, entry);
    }
    for (const [key, wanted] of desired) {
      if (this.claims.has(key)) continue;
      const entry: PlannedRead = {
        command: wanted.command,
        scopes: new Map(),
        interval: 0,
        dueAt: 0,
      };
      for (const scope of wanted.scopes) entry.scopes.set(`${SURFACE_OWNER}:${scope}`, scope);
      this.claims.set(key, entry);
      this.schedule(key, entry);
    }
  }

  /**
   * Claims one read for an overlay with a lifetime of its own — the Ask
   * conversation while its turn runs — and reads it immediately if it is new.
   * `release` drops every claim the owner made.
   */
  claim(owner: string, command: Envelope, scope: PollScope): void {
    const operation = REST_OPERATIONS[command.type];
    if (operation === undefined || operation.method !== "GET") return;
    const key = `${command.type}:${resourcePath(command, operation)}`;
    const entry = this.claims.get(key) ?? { command, scopes: new Map(), interval: 0, dueAt: 0 };
    entry.command = command;
    entry.scopes.set(owner, scope);
    this.claims.set(key, entry);
    this.schedule(key, entry);
  }

  /** Drops every claim one owner made; nothing it claimed is read again. */
  release(owner: string): void {
    for (const [key, entry] of this.claims) {
      if (!entry.scopes.delete(owner)) continue;
      this.schedule(key, entry);
    }
  }

  /**
   * Reads one resource once. A refresh or a reconnect revalidates state the
   * page still holds, conditional on the ETag last seen and deduped against a
   * read already in flight. An operator or first-open read asks for the
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
    if (this.transport !== undefined) {
      // A test runtime's double stands in for every wire, page reads included.
      this.transport.send(JSON.stringify(command));
      action?.complete();
      return;
    }
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
        this.awaitingRestart = true;
        this.restarting = true;
        this.upgradePending = false;
        this.lastError = null;
        this.startRestartWatch();
      } else if (this.awaitingRestart && replacement !== null) {
        // The failure frame is the restart's other outcome: clearing the flags
        // ends the wait and lets a later poll read the version again.
        this.awaitingRestart = false;
        this.restarting = false;
        this.report(replacement.error);
      }
      return;
    }
    if (message.type === "serverRestarting") {
      slowUiAction.reset();
      this.awaitingRestart = true;
      this.restarting = true;
      this.upgradePending = false;
      this.lastError = null;
      this.startRestartWatch();
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
    this.restartPid = null;
    const operation = REST_OPERATIONS.restartServer;
    if (operation === undefined) {
      this.restarting = false;
      this.awaitingRestart = false;
      return;
    }
    void this.performRestart(operation);
  }

  /**
   * One operator restart: record the pid that answered, ask the server for the
   * replacement, and watch for the handoff. The accepted answer starts the
   * watch, so the outcome never depends on a frame the process being replaced
   * may stop serving mid-handoff, and the `/version` poll keeps running so a
   * refusal or a replacement failure still reaches the page.
   */
  private async performRestart(operation: RestOperation): Promise<void> {
    this.restartPid = await this.answeringPid();
    if (!this.restarting) return;
    try {
      const response = await fetch(operation.path, {
        method: operation.method,
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        this.report(`The server answered HTTP ${response.status}.`);
        return;
      }
      this.startRestartWatch();
    } catch {
      this.restarting = false;
      this.awaitingRestart = false;
      this.lost();
    }
  }

  /** The pid `/ready` names, or `null` when no process answered it. */
  private async answeringPid(): Promise<number | null> {
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

  /** Starts the handoff watch once; every later frame joins the running one. */
  private startRestartWatch(): void {
    if (this.restartWatch) return;
    this.restartWatch = true;
    void this.waitForRestart().finally(() => {
      this.restartWatch = false;
    });
  }

  /**
   * Waits for the replacement to answer `/ready` under a pid other than the
   * pre-restart one. `/ready` answers from whichever process holds the port,
   * so an answer from the process being replaced is not the handoff: the watch
   * reloads only once the answering pid changes. A version frame naming a
   * replacement failure clears `restarting`, which ends the watch with no
   * reload and reports the failure through the frame handler.
   */
  private async waitForRestart(): Promise<void> {
    const before = this.restartPid ?? (await this.answeringPid());
    this.restartPid = before;
    const deadline = Date.now() + 30_000;
    while (this.restarting && Date.now() < deadline) {
      if (await this.replacementAnswers(before)) {
        location.reload();
        return;
      }
      const retry = Promise.withResolvers<void>();
      setTimeout(retry.resolve, 250);
      await retry.promise;
    }
    if (!this.restarting) return;
    this.report("The replacement did not answer within 30 seconds.");
    this.connect();
  }

  /** True when the process answering `/ready` is not the one being replaced. */
  private async replacementAnswers(before: number | null): Promise<boolean> {
    try {
      const response = await fetch(READY_ENDPOINT, { cache: "no-store", method: "HEAD" });
      if (!response.ok) return false;
    } catch {
      return false;
    }
    const pid = await this.answeringPid();
    if (pid === null) return before === null;
    return before === null || pid !== before;
  }

  startPolling(): void {
    if (typeof window === "undefined") return;
    if (this.pollTimer !== undefined) return;
    this.pollTimer = window.setInterval(() => this.pollTick(), SCHEDULER_TICK_MS);
    if (typeof document !== "undefined" && this.visibilityHandler === undefined) {
      this.visibilityHandler = () => {
        if (documentVisible()) this.readAll("refresh");
      };
      document.addEventListener("visibilitychange", this.visibilityHandler);
    }
  }

  /**
   * One scheduler tick: queues every planned resource whose cadence is due.
   * Nothing is read while the document is hidden, and nothing is read that no
   * surface claims, so a closed page and a hidden tab issue no request at all.
   */
  private pollTick(): void {
    if (!this.open || !documentVisible()) return;
    const now = Date.now();
    for (const entry of this.claims.values()) {
      if (entry.interval === 0 || entry.dueAt > now) continue;
      entry.dueAt = now + entry.interval;
      const operation = REST_OPERATIONS[entry.command.type];
      if (operation !== undefined) this.enqueue(entry.command, operation, "refresh");
    }
    this.pump();
  }

  /** Reads every planned resource once: an open, or a visible document. */
  private readAll(origin: SlowUiActionOrigin): void {
    if (!this.open) return;
    const now = Date.now();
    for (const entry of this.claims.values()) {
      if (entry.interval === 0) continue;
      const operation = REST_OPERATIONS[entry.command.type];
      if (operation === undefined) continue;
      entry.dueAt = now + entry.interval;
      const key = `${entry.command.type}:${resourcePath(entry.command, operation)}`;
      // A read this open already started is the read; a read queued before the
      // open is replaced by this one instead of being dispatched twice.
      if (this.inFlight.has(key)) continue;
      this.queue = this.queue.filter((queued) => queued.key !== key);
      this.enqueue(entry.command, operation, origin);
    }
    this.pump();
  }

  /**
   * Recomputes one resource's interval from the scopes that claim it, and
   * reads it now when a surface just opened — before the first cadence tick.
   * A surface that stopped showing it is read a full new cadence from now, so
   * a settled run never keeps its live interval for one more tick. A plan
   * reapplied with the same scopes changes nothing: its due time stands, so a
   * frequently updating snapshot never pushes another resource's read back.
   */
  private schedule(key: string, entry: PlannedRead): void {
    if (entry.scopes.size === 0) {
      this.queue = this.queue.filter((queued) => queued.key !== key);
      this.claims.delete(key);
      return;
    }
    const interval = effectiveInterval(entry.command.type, entry.scopes);
    if (interval === entry.interval) return;
    const faster = entry.interval === 0 || interval < entry.interval;
    const now = Date.now();
    entry.interval = interval;
    if (interval === 0) {
      entry.dueAt = 0;
      this.queue = this.queue.filter((queued) => queued.key !== key);
      return;
    }
    entry.dueAt = faster ? now : now + interval;
    if (!this.open || !documentVisible() || entry.dueAt > now) return;
    entry.dueAt = now + interval;
    const operation = REST_OPERATIONS[entry.command.type];
    if (operation !== undefined) this.enqueue(entry.command, operation, "refresh");
  }

  /**
   * Queues one read this page issues for itself — a due tick, an open's read,
   * or a refresh — under its own key, so the same resource never waits twice.
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
   * Starts queued page reads while a connection this page may hold is free:
   * at most `MAX_BACKGROUND_READS` of the origin's six, so a foreground read
   * always finds a slot. Nothing starts before the connection is open or while
   * the document is hidden.
   */
  private pump(): void {
    if (!this.open || !documentVisible()) return;
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
    this.claims.clear();
    this.inFlight.clear();
    this.backgroundReads = 0;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    clearInterval(this.pollTimer);
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
