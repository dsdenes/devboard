import { notifications } from "./notifications.svelte";
import type { OrchestratorState, OrchestratorStatus, VersionState } from "./types";

type ConnectionState = "connecting" | "open" | "closed";

interface Envelope {
  type: string;
  [key: string]: unknown;
}

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

function isOrchestratorState(value: Record<string, unknown>): boolean {
  if (value.type !== "orchestratorState") return false;
  if (value.present === false) return true;
  if (value.present !== true) return false;
  return (
    typeof value.repo === "string" &&
    (value.status === "idle" || value.status === "running" || value.status === "failed") &&
    typeof value.open === "number"
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
  orchestrator = $state<OrchestratorState | null>(null);
  restarting = $state(false);
  awaitingRestart = $state(false);
  upgradePending = $state(false);
  lastError = $state<string | null>(null);

  private socket: WebSocket | undefined;
  private retryTimer: number | undefined;
  private disposed = false;
  private notifiedLoss = false;
  private handlers: Array<(message: Envelope) => void> = [];

  get open(): boolean {
    return this.state === "open";
  }

  onMessage(handler: (message: Envelope) => void): void {
    this.handlers.push(handler);
  }

  send(command: unknown): boolean {
    if (this.socket === undefined || this.socket.readyState !== WebSocket.OPEN) {
      this.lastError = "Not connected to the server.";
      notifications.push("error", this.lastError);
      return false;
    }
    this.lastError = null;
    this.socket.send(JSON.stringify(command));
    return true;
  }

  connect(): void {
    if (typeof window === "undefined") return;
    this.state = "connecting";
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const current = new WebSocket(`${protocol}//${location.host}/ws`);
    this.socket = current;

    current.onopen = () => {
      this.state = "open";
      this.lastError = null;
      this.notifiedLoss = false;
      this.upgradePending = false;
      current.send(JSON.stringify({ type: "listRecords" }));
      current.send(JSON.stringify({ type: "getGoal" }));
      current.send(JSON.stringify({ type: "getSkills" }));
      current.send(JSON.stringify({ type: "getProject" }));
      current.send(JSON.stringify({ type: "getVersion" }));
      current.send(JSON.stringify({ type: "getOrchestrator" }));
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
      for (const handler of this.handlers) handler(envelope);
    };

    current.onerror = () => {
      if (this.awaitingRestart) return;
      this.lastError = "Could not reach the server.";
      if (!this.notifiedLoss) {
        this.notifiedLoss = true;
        notifications.push("warning", "Connection lost. Reconnecting…");
      }
    };

    current.onclose = () => {
      this.state = "closed";
      if (this.awaitingRestart) {
        void this.waitForRestart();
        return;
      }
      if (!this.disposed) this.retryTimer = window.setTimeout(() => this.connect(), 1000);
    };
  }

  private handle(message: Envelope): void {
    if (isVersionState(message)) {
      this.version = {
        running: message.running as string | null,
        installed: message.installed as string | null,
        latest: message.latest as string | null,
        stale: message.stale as boolean,
      };
      return;
    }
    if (isOrchestratorState(message)) {
      this.orchestrator =
        message.present === false
          ? { present: false }
          : {
              present: true,
              repo: message.repo as string,
              status: message.status as OrchestratorStatus,
              open: message.open as number,
              startedAt: (message.startedAt as string | null) ?? null,
              finishedAt: (message.finishedAt as string | null) ?? null,
              lastExitCode: (message.lastExitCode as number | null) ?? null,
              lastError: (message.lastError as string | null) ?? null,
              nextAttemptAt: (message.nextAttemptAt as string | null) ?? null,
              updatedAt: typeof message.updatedAt === "string" ? message.updatedAt : "",
            };
      return;
    }
    if (message.type === "serverRestarting") {
      this.awaitingRestart = true;
      this.restarting = true;
      this.upgradePending = false;
      this.lastError = null;
      this.socket?.close();
      return;
    }
    if (message.type === "upgradePending") {
      this.upgradePending = true;
      notifications.push("notice", "An update is waiting for the current work to finish.");
      return;
    }
    if (message.type === "project" && typeof message.path === "string") {
      this.projectPath = message.path;
      return;
    }
    if (message.type === "error" && typeof message.message === "string") {
      this.lastError = message.message;
      notifications.push("error", message.message);
      if (this.restarting) {
        this.awaitingRestart = false;
        this.restarting = false;
      }
    }
  }

  requestRestart(): void {
    if (this.restarting) return;
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
        this.socket.send(JSON.stringify({ type: "getOrchestrator" }));
      }
    }, 3000);
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.socket?.close();
  }
}

export const connection = new ConnectionStore();
