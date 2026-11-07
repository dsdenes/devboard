import { notifications } from "./notifications.svelte";
import { slowUiAction, type SlowUiActionOrigin } from "./slow-ui-action";
import { isInvalidFrameError, reloadOnceForStaleBundle } from "./stale-bundle";
import type { VersionState } from "./types";

type ConnectionState = "connecting" | "open" | "closed";

interface Envelope {
  type: string;
  [key: string]: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Commands a surface repeats on a timer; their repeat is never an action. */
const POLL_COMMANDS = new Set(["getVersion", "getMcpTools", "getGoalDrafts"]);

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
 * Owns the single WebSocket. Every parsed frame is also forwarded to the
 * registered mode handlers, so the server contract stays exactly as it was.
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

  private socket: WebSocket | undefined;
  private retryTimer: number | undefined;
  private disposed = false;
  private notifiedLoss = false;
  private handlers: Array<(message: Envelope) => void> = [];
  private openHandlers: Array<() => void> = [];
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
   * Stores reconcile operation flags here so a stop frame lost while the
   * socket was down cannot leave a control disabled for the session.
   */
  onOpen(handler: () => void): void {
    this.openHandlers.push(handler);
  }

  /**
   * Sends one command and registers an operator or first-paint dispatch with
   * the latency guard. A send while the socket is restarting, awaiting a
   * replacement, or reconnecting is a reconnect send and starts no action;
   * polling repeats are refresh sends for the same reason.
   */
  send(command: unknown, origin: SlowUiActionOrigin = "operator"): boolean {
    if (this.socket === undefined || this.socket.readyState !== WebSocket.OPEN) {
      this.lastError = "Not connected to the server.";
      notifications.push("Connection", "error", this.lastError);
      return false;
    }
    const resolved = this.#origin(command, origin);
    this.lastError = null;
    this.socket.send(JSON.stringify(command));
    slowUiAction.dispatch(command, resolved);
    return true;
  }

  #origin(command: unknown, requested: SlowUiActionOrigin): SlowUiActionOrigin {
    if (this.restarting || this.awaitingRestart || this.state !== "open") return "reconnect";
    if (this.openingOrigin !== null) return this.openingOrigin;
    if (requested !== "operator") return requested;
    if (typeof command !== "object" || command === null) return "refresh";
    const type = (command as Record<string, unknown>).type;
    if (type === "restartServer") return "reconnect";
    return typeof type === "string" && POLL_COMMANDS.has(type) ? "refresh" : "operator";
  }

  connect(): void {
    if (typeof window === "undefined") return;
    // An explicit connect revives a store a previous dispose stopped, so a
    // remounted app (and a test file that reuses the singleton) reconnects
    // after its socket drops again.
    this.disposed = false;
    this.state = "connecting";
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const current = new WebSocket(`${protocol}//${location.host}/ws`);
    this.socket = current;

    current.onopen = () => {
      this.state = "open";
      this.lastError = null;
      this.notifiedLoss = false;
      this.upgradePending = false;
      const opening: SlowUiActionOrigin = this.hasOpened ? "reconnect" : "initial";
      this.hasOpened = true;
      // The open handlers reconcile stores after a reconnect; their sends are
      // not operator actions. Only the six first-paint reads are registered.
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
    };

    current.onmessage = (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!isObject(message) || typeof message.type !== "string") return;
      const envelope = message as Envelope;
      this.handle(envelope);
      slowUiAction.observe(envelope);
      for (const handler of this.handlers) handler(envelope);
    };

    current.onerror = () => {
      if (this.awaitingRestart) return;
      this.lastError = "Could not reach the server.";
      if (!this.notifiedLoss) {
        this.notifiedLoss = true;
        notifications.push("Connection", "warning", "Connection lost. Reconnecting…");
      }
    };

    current.onclose = () => {
      this.state = "closed";
      slowUiAction.reset();
      if (this.awaitingRestart) {
        void this.waitForRestart();
        return;
      }
      if (!this.disposed) this.retryTimer = window.setTimeout(() => this.connect(), 1000);
    };
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
      return;
    }
    if (message.type === "serverRestarting") {
      slowUiAction.reset();
      this.awaitingRestart = true;
      this.restarting = true;
      this.upgradePending = false;
      this.lastError = null;
      this.socket?.close();
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
      // A frame the server cannot parse means this page was built against
      // another revision, so the reload below loads the bundle it serves. A
      // refusal after that reload is this bundle's own frame and stays visible.
      if (
        isInvalidFrameError(message) &&
        reloadOnceForStaleBundle(
          typeof sessionStorage === "undefined" ? null : sessionStorage,
          () => location.reload(),
        )
      ) {
        return;
      }
      this.lastError = message.message;
      notifications.push("Server", "error", message.message);
      if (this.restarting) {
        this.awaitingRestart = false;
        this.restarting = false;
      }
    }
  }

  requestRestart(): void {
    if (this.restarting) return;
    slowUiAction.reset();
    this.restarting = true;
    this.awaitingRestart = true;
    if (!this.send({ type: "restartServer" })) {
      this.restarting = false;
      this.awaitingRestart = false;
    }
  }

  private async waitForRestart(): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch("/", { cache: "no-store", method: "HEAD" });
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
    window.setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: "getVersion" }));
      }
    }, 3000);
  }

  dispose(): void {
    this.disposed = true;
    slowUiAction.reset();
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.socket?.close();
  }
}

export const connection = new ConnectionStore();
