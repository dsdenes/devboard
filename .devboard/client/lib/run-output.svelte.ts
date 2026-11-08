import { POLL_INTERVAL_MS } from "./connection.svelte";

/** One live run the dashboard exposes over its own output socket. */
export interface RunSummary {
  id: string;
  kind: string;
  label: string;
  lifecycle: string;
  live: boolean;
  updated_at: string | null;
  self: string;
  output: string;
}

interface RunFrame {
  type: string;
  run?: string;
  cursor?: number;
  [key: string]: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseRuns(body: unknown): RunSummary[] {
  if (!isObject(body) || !Array.isArray(body.runs)) return [];
  const runs: RunSummary[] = [];
  for (const entry of body.runs) {
    if (!isObject(entry)) continue;
    if (typeof entry.id !== "string" || typeof entry.output !== "string") continue;
    runs.push({
      id: entry.id,
      kind: typeof entry.kind === "string" ? entry.kind : "",
      label: typeof entry.label === "string" ? entry.label : entry.id,
      lifecycle: typeof entry.lifecycle === "string" ? entry.lifecycle : "stopped",
      live: entry.live === true,
      updated_at: typeof entry.updated_at === "string" ? entry.updated_at : null,
      self: typeof entry.self === "string" ? entry.self : "",
      output: entry.output,
    });
  }
  return runs;
}

function visible(): boolean {
  if (typeof document === "undefined") return true;
  if (document.visibilityState !== undefined) return document.visibilityState !== "hidden";
  return document.hidden !== true;
}

/**
 * Owns the dashboard's only WebSocket construction. One socket exists for each
 * live run the page sees, replaying that run's retained output and following
 * it live; a stopped run's socket closes and is never reopened.
 */
export class RunOutputStore {
  runs = $state<RunSummary[]>([]);
  /** The last frame per run, for a page that renders the live run it displays. */
  frames = $state<Record<string, RunFrame[]>>({});

  private sockets = new Map<string, WebSocket>();
  private cursors = new Map<string, number>();
  private timer: number | undefined;
  private visibilityHandler: (() => void) | undefined;
  private handlers: Array<(frame: RunFrame) => void> = [];
  private polling = false;
  private reading = false;

  onFrame(handler: (frame: RunFrame) => void): void {
    this.handlers.push(handler);
  }

  start(): void {
    if (typeof window === "undefined" || this.polling) return;
    this.polling = true;
    void this.poll();
    this.timer = window.setInterval(() => {
      if (visible()) void this.poll();
    }, POLL_INTERVAL_MS);
    if (typeof document !== "undefined" && this.visibilityHandler === undefined) {
      this.visibilityHandler = () => {
        if (visible()) void this.poll();
      };
      document.addEventListener("visibilitychange", this.visibilityHandler);
    }
  }

  /** Reads the run collection and reconciles one socket per live run. */
  private async poll(): Promise<void> {
    // One read at a time. A slow answer used to leave a fresh `/agent-runs`
    // request every second, and those stacked reads took a browser connection
    // from an operator action along with the page's polls.
    if (this.reading) return;
    this.reading = true;
    try {
      let body: unknown;
      try {
        const response = await fetch("/agent-runs", {
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        if (!response.ok) return;
        body = await response.json();
      } catch {
        return;
      }
      const runs = parseRuns(body);
      this.runs = runs;
      const live = new Map(runs.filter((run) => run.live).map((run) => [run.id, run] as const));
      for (const [id, socket] of this.sockets) {
        const run = live.get(id);
        if (run === undefined) {
          this.close(id, socket);
        }
      }
      for (const run of live.values()) {
        if (!this.sockets.has(run.id)) this.open(run);
      }
    } finally {
      this.reading = false;
    }
  }

  private open(run: RunSummary): void {
    if (typeof WebSocket === "undefined") return;
    const cursor = this.cursors.get(run.id);
    const link = cursor === undefined ? run.output : `${run.output}?after=${cursor}`;
    const socket = new WebSocket(link);
    this.sockets.set(run.id, socket);
    socket.onmessage = (event) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!isObject(frame) || typeof frame.type !== "string") return;
      if (frame.run !== undefined && frame.run !== run.id) return;
      if (typeof frame.cursor === "number") this.cursors.set(run.id, frame.cursor);
      const existing = this.frames[run.id];
      this.frames = {
        ...this.frames,
        [run.id]: [...(existing ?? []), frame as RunFrame].slice(-500),
      };
      for (const handler of this.handlers) handler(frame as RunFrame);
    };
    socket.onclose = () => {
      if (this.sockets.get(run.id) === socket) this.sockets.delete(run.id);
    };
    socket.onerror = () => {
      socket.close();
    };
  }

  private close(id: string, socket: WebSocket): void {
    this.sockets.delete(id);
    this.cursors.delete(id);
    socket.close();
  }

  stop(): void {
    this.polling = false;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    if (this.visibilityHandler !== undefined && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = undefined;
    }
    for (const [id, socket] of this.sockets) {
      this.close(id, socket);
    }
  }
}

export const runOutput = new RunOutputStore();
