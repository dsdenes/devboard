import { notifications } from "./notifications.svelte";
import { slowUiAction, type SlowUiActionOrigin } from "./slow-ui-action";
import { REST_OPERATIONS } from "./rest-map";
import { answeringPid, readResource, replacementAnswers, restartServer } from "./rest-transport";
import { mutationFor } from "./command-mutations";
import type { Command } from "./rest-transport";
import { frameQueryKey } from "./query-keys";
import { queryClient } from "./query-client";
import type { VersionState } from "./types";

type ConnectionState = "connecting" | "open" | "closed";

interface Envelope {
  type: string;
  [key: string]: unknown;
}

/** A reconnect retry after the transport closed under a live page. */
const RETRY_INTERVAL_MS = 1000;

/** The one reason a request that never answered is reported with. */
const UNREACHABLE = "Could not reach the server.";

/** Commands a surface repeats on a timer; their repeat is never an action. */
const POLL_COMMANDS: Record<string, true> = {
  getVersion: true,
  getMcpTools: true,
  getGoalDrafts: true,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isVersionState(value: Record<string, unknown>): boolean {
  return (
    value.type === "versionState" &&
    (value.running === null || typeof value.running === "string") &&
    (value.installed === null || typeof value.installed === "string") &&
    (value.latest === null || typeof value.latest === "string") &&
    typeof value.stale === "boolean"
  );
}

/** The replacement one `versionState` frame reports, with its shown reason. */
type ReplacementState = NonNullable<VersionState["replacement"]>;

/** The replacement a `versionState` frame reports, or `null` when it names none. */
function replacementOf(message: Record<string, unknown>): ReplacementState | null {
  if (!isObject(message.replacement)) return null;
  const replacement = message.replacement;
  return {
    running:
      replacement.running === null || typeof replacement.running === "string"
        ? (replacement.running as string | null)
        : null,
    installed:
      replacement.installed === null || typeof replacement.installed === "string"
        ? (replacement.installed as string | null)
        : null,
    error:
      typeof replacement.error === "string"
        ? replacement.error
        : "The replacement could not start.",
  };
}

/**
 * A test double stands in for the transport when the test runtime installs a
 * WebSocket-shaped constructor with an `instances` array. Production never
 * creates a command socket: every read is a query and every action a mutation.
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

/**
 * Owns the dashboard's connection state and every command dispatch.
 *
 * Reads are `createQuery` observers mounted by the surfaces that show the
 * resource, so this store has no scheduler and no request path of its own.
 * Commands go through the app root's mutations. A pushed frame is written into
 * the query cache before the stores project it.
 */
export class ConnectionStore {
  state = $state<ConnectionState>("connecting");
  projectPath = $state("");
  version = $state<VersionState | null>(null);
  /**
   * Bumped by every accepted `versionState` frame. A control that waits for the
   * server to answer a command reads this instead of `version`: a failed
   * replacement leaves `running` unchanged because the old process keeps
   * serving, so only the frame's arrival distinguishes an answer from silence.
   */
  versionRevision = $state(0);
  /**
   * Bumped by every refusal frame that names the command it refused. The REST
   * layer names the refused command in its `error` frame, so a control reads
   * the revision of the command it dispatched: its own refusal releases the
   * latch at once, and a refusal of another command never changes it.
   */
  refusals = $state<Record<string, number>>({});
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
  private disposed = false;
  private notifiedLoss = false;
  private handlers: Array<(message: Envelope) => void> = [];
  private openHandlers: Array<() => void> = [];
  /** True while one replacement watch runs; a later frame joins it. */
  private restartWatch = false;
  /** The pid that answered before the restart; the replacement's differs. */
  private restartPid: number | null = null;
  /** First open is the initial read; later opens are reconnects. */
  private hasOpened = false;

  get open(): boolean {
    return this.state === "open";
  }

  /**
   * True while the page may issue reads. A degraded transport still reads:
   * the next answer is what reports the connection live again, so gating the
   * plan on `open` would freeze the page in `Disconnected` and nothing would
   * ever read the recovery.
   */
  get readable(): boolean {
    // `state` is read before the short-circuit on `disposed`: the poll plan's
    // effect tracks this getter, and a getter that skipped the reactive field
    // would leave every query disabled the moment the connection opens.
    const connected = this.state !== "connecting";
    return connected && !this.disposed;
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
   * The refusal revision of the commands one control can dispatch. The sum is
   * reactive, so a refusal of either command a toggle dispatches releases its
   * latch, while a refusal of an unrelated command leaves it busy.
   */
  refusalRevision(...commands: readonly string[]): number {
    let revision = 0;
    for (const command of commands) revision += this.refusals[command] ?? 0;
    return revision;
  }

  /**
   * Sends one command. A read re-reads the resource through its mounted query;
   * a command is one `createMutation` that writes its answer into the cache
   * and invalidates the resources it changed. The test runtime may install a
   * transport double, which every send and pushed frame then uses. A refused
   * answer calls `onFailure`, so the store that sent the command can settle it
   * without waiting for an answer frame the failed request never produced.
   */
  send(
    command: unknown,
    origin: SlowUiActionOrigin = "operator",
    onFailure?: (error: Error) => void,
  ): boolean {
    if (this.disposed) return false;
    if (!isObject(command) || typeof command.type !== "string") {
      this.lastError = "This action has no REST operation.";
      notifications.push("Connection", "error", this.lastError);
      return false;
    }
    const operation = REST_OPERATIONS[command.type];
    if (operation === undefined) {
      this.lastError = "This action has no REST operation.";
      notifications.push("Connection", "error", this.lastError);
      return false;
    }
    const envelope = command as Envelope & { type: string };
    const missing = missingPathField(envelope, operation.pathParams);
    if (missing !== null) {
      // An empty path parameter would address no operation: the server would
      // answer it as a missing file and the page as a stale bundle.
      this.lastError = `This action is missing its ${missing}.`;
      notifications.push("Connection", "error", this.lastError);
      return false;
    }
    const resolved = this.#origin(envelope, origin);
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
      void queryClient.refetchQueries({ queryKey: [command.type] });
      action?.complete();
      return true;
    }
    const mutation = mutationFor(command.type);
    if (mutation === undefined) {
      this.lastError = "The command runner is not ready.";
      notifications.push("Connection", "error", this.lastError);
      action?.complete();
      return false;
    }
    mutation.mutate(command as Command, () => action?.complete(), onFailure);
    return true;
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
        const frame = message as Envelope;
        // A pushed frame is backend state: it lands in the same cache entry a
        // fetch of its resource would, then reaches the stores.
        const key = frameQueryKey(frame);
        if (key !== null) queryClient.setQueryData(key, frame);
        this.receiveFrame(frame);
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
  }

  /**
   * One open, first connect or reconnect. The mounted queries revalidate when
   * the connection returns; nothing here starts a read of its own.
   */
  private opened(): void {
    this.state = "open";
    this.lastError = null;
    this.notifiedLoss = false;
    this.upgradePending = false;
    const opening: SlowUiActionOrigin = this.hasOpened ? "reconnect" : "initial";
    this.hasOpened = true;
    for (const handler of this.openHandlers) handler();
    // A reconnect revalidates the resources the page still shows; the first
    // open needs no invalidation, because the plan mounts each query enabled
    // and the query's own mount is the read.
    if (opening === "reconnect") void queryClient.invalidateQueries();
  }

  /** A command settled without reaching the server: the connection is lost. */
  noticeTransportFailure(): void {
    this.lastError = UNREACHABLE;
    this.lost();
  }

  /**
   * A read or a command answered: the transport is live again, so the footer
   * stops saying `Disconnected`. Only a degraded state changes, so an ordinary
   * answer costs an interrupted request nothing.
   */
  noticeTransportAnswer(): void {
    if (this.state === "open") return;
    this.state = "open";
    this.notifiedLoss = false;
    if (this.lastError === UNREACHABLE) this.lastError = null;
  }

  private lost(): void {
    if (this.awaitingRestart) return;
    this.lastError = UNREACHABLE;
    // The footer renders `state`, so a transport that physically failed moves
    // it off `open`; reads keep running through `readable`, and the next
    // answer calls `noticeTransportAnswer`.
    this.state = "closed";
    if (!this.notifiedLoss) {
      this.notifiedLoss = true;
      notifications.push("Connection", "warning", "Connection lost. Reconnecting…");
    }
  }

  /** One pushed frame: handle the connection-owned frames, then every store. */
  receiveFrame(frame: Envelope): void {
    this.handle(frame);
    slowUiAction.observe(frame);
    for (const handler of this.handlers) handler(frame);
  }

  private handle(message: Envelope): void {
    if (typeof message.command === "string") {
      // Only a refusal frame names the command it refused, so this is the
      // answer of the control that dispatched it and of no other control.
      this.refusals[message.command] = (this.refusals[message.command] ?? 0) + 1;
    }
    if (isVersionState(message)) {
      const replacement = replacementOf(message);
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
      this.versionRevision += 1;
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
    void this.performRestart();
  }

  /**
   * One operator restart: record the pid that answered, ask the server for the
   * replacement, and watch for the handoff. The accepted answer starts the
   * watch, so the outcome never depends on a frame the process being replaced
   * may stop serving mid-handoff, and the `/version` query keeps reading so a
   * refusal or a replacement failure still reaches the page.
   */
  private async performRestart(): Promise<void> {
    this.restartPid = await answeringPid();
    if (!this.restarting) return;
    try {
      await restartServer();
      this.startRestartWatch();
    } catch (error) {
      this.restarting = false;
      this.awaitingRestart = false;
      this.report(error instanceof Error ? error.message : String(error));
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
   *
   * The page has no socket, so a failure the server recorded after the last
   * version poll would reach the page only on the next poll, which runs on the
   * same 30 seconds as this deadline. Before the watch reports its timeout it
   * reads `/version` once: a recorded failure is the outcome, and only a
   * server that names none did not answer.
   */
  private async waitForRestart(): Promise<void> {
    const before = this.restartPid ?? (await answeringPid());
    this.restartPid = before;
    const deadline = Date.now() + 30_000;
    while (this.restarting && Date.now() < deadline) {
      if (await replacementAnswers(before)) {
        location.reload();
        return;
      }
      const retry = Promise.withResolvers<void>();
      setTimeout(retry.resolve, 250);
      await retry.promise;
    }
    if (!this.restarting) return;
    const failure = await this.recordedReplacementFailure();
    if (!this.restarting) return;
    this.report(failure ?? "The replacement did not answer within 30 seconds.");
    this.connect();
  }

  /**
   * The replacement failure the server holds, or `null` when it names none.
   * A read that cannot reach the server reports no failure: the watch's own
   * timeout is then the answer.
   */
  private async recordedReplacementFailure(): Promise<string | null> {
    let frames: Envelope[];
    try {
      frames = await readResource({ type: "getVersion" });
    } catch {
      return null;
    }
    for (const frame of frames) {
      if (!isVersionState(frame)) continue;
      const replacement = replacementOf(frame);
      if (replacement !== null) return replacement.error;
    }
    return null;
  }

  private report(message: string): void {
    this.lastError = message;
    notifications.push("Server", "error", message);
    if (this.restarting) {
      this.awaitingRestart = false;
      this.restarting = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.state = "closed";
    this.hasOpened = false;
    slowUiAction.reset();
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.transport?.close();
    this.transport = undefined;
  }
}

/** The first path field a command leaves out, or `null` when it carries all. */
function missingPathField(
  command: Envelope,
  pathParams: ReadonlyArray<readonly [string, string]>,
): string | null {
  for (const [, field] of pathParams) {
    const value = command[field];
    if (typeof value === "number") continue;
    if (typeof value !== "string" || value.length === 0) return field;
  }
  return null;
}

/** Re-exports the REST path helpers the rest of the client used to import here. */
export { resourcePath, requestBody } from "./rest-map";

export const connection = new ConnectionStore();
