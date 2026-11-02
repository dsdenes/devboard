import {
  AgentRegistryError,
  defineAgentRegistry,
  projectAgentSnapshot,
  type AgentRegistry,
  type AgentSnapshot,
} from "./registry";
import type { AgentAdapter, AgentCommandResult } from "./types";

export interface AgentBridgeSocket {
  send(data: string): unknown;
}

export interface AgentBridgeOptions {
  registry: AgentRegistry;
  adapters: AgentAdapter[];
  /** Sends an event to every connected client. */
  broadcast: (event: unknown) => void;
  /** The shared poll cadence; a changed snapshot is pushed within it. */
  pollMs?: number;
  log?: (line: string) => void;
}

export type AgentCommand =
  | { type: "getAgents" }
  | { type: "getAgent"; id?: unknown }
  | { type: "refreshAgent"; id?: unknown }
  | { type: "startAgent"; id?: unknown }
  | { type: "stopAgent"; id?: unknown }
  | { type: "pauseAgent"; id?: unknown }
  | { type: "resumeAgent"; id?: unknown }
  | {
      type: "setAgentSettings";
      id?: unknown;
      minutes?: unknown;
      maxPerHour?: unknown;
      maxPending?: unknown;
    }
  | { type: "disableAgentTimer"; id?: unknown };

/**
 * The one control plane behind both background agents. Every command carries
 * the descriptor id, every reply is projected by the registry, and a changed
 * snapshot is broadcast to every client. The bridge never knows an id by name.
 */
export class BackgroundAgentBridge {
  readonly registry: AgentRegistry;
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly broadcast: (event: unknown) => void;
  private readonly pollMsValue: number;
  private readonly log: (line: string) => void;
  private timer: Timer | undefined;
  private readonly signatures = new Map<string, string>();
  private begun = false;

  constructor(options: AgentBridgeOptions) {
    this.registry = options.registry;
    this.broadcast = options.broadcast;
    this.pollMsValue = Math.max(50, options.pollMs ?? 250);
    this.log = options.log ?? (() => undefined);
    for (const adapter of options.adapters) {
      if (!this.registry.get(adapter.descriptor.id)) {
        throw new AgentRegistryError(
          `adapter ${adapter.descriptor.id} has no registry descriptor`,
        );
      }
      if (this.adapters.has(adapter.descriptor.id)) {
        throw new AgentRegistryError(`duplicate adapter for ${adapter.descriptor.id}`);
      }
      this.adapters.set(adapter.descriptor.id, adapter);
    }
  }

  begin(): void {
    if (this.begun) return;
    this.begun = true;
    for (const adapter of this.adapters.values()) adapter.begin();
    this.timer = setInterval(() => this.poll(), this.pollMsValue);
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const adapter of this.adapters.values()) adapter.dispose();
  }

  private adapter(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  private project(adapter: AgentAdapter): AgentSnapshot {
    return projectAgentSnapshot(adapter.descriptor, adapter.snapshot());
  }

  snapshotAll(): AgentSnapshot[] {
    const snapshots: AgentSnapshot[] = [];
    for (const descriptor of this.registry.descriptors) {
      const adapter = this.adapter(descriptor.id);
      if (adapter !== undefined) {
        snapshots.push(this.project(adapter));
        continue;
      }
      // A registry entry whose engine is unavailable still appears in the
      // shared surface, so adding a descriptor never blanks the page.
      snapshots.push(
        projectAgentSnapshot(descriptor, {
          lifecycle: "stopped",
          enabled: false,
          owned: false,
          attached: false,
          cadence: {
            minutes: descriptor.cadence.defaultMinutes,
            lastRunAt: null,
            nextRunAt: null,
          },
          limits: { ...descriptor.limits.default },
          issues: [],
          pending: 0,
          sync: { state: "stale", at: null, error: null },
          detail:
            descriptor.detail.panel === "activity"
              ? { panel: "activity", scanId: null, entries: [] }
              : { panel: "cycles", cycles: [] },
          notice: null,
          error: null,
          timer: null,
        }),
      );
    }
    return snapshots;
  }

  /** Sends both agents' current snapshots to one client. */
  replay(target: AgentBridgeSocket): void {
    this.send(target, { type: "agentsState", agents: this.snapshotAll() });
    for (const adapter of this.adapters.values()) {
      try {
        adapter.replay(target);
      } catch (error) {
        this.log(
          `${adapter.descriptor.id}: activity replay failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private send(target: AgentBridgeSocket, event: unknown): void {
    try {
      target.send(JSON.stringify(event));
    } catch {
      // The socket closed.
    }
  }

  private publishAgent(id: string): void {
    const adapter = this.adapter(id);
    if (adapter === undefined) return;
    const agent = this.project(adapter);
    this.signatures.set(id, JSON.stringify(agent));
    this.broadcast({ type: "agentState", agent });
  }

  private poll(): void {
    for (const descriptor of this.registry.descriptors) {
      const adapter = this.adapter(descriptor.id);
      if (adapter === undefined) continue;
      let snapshot: AgentSnapshot;
      try {
        snapshot = this.project(adapter);
      } catch (error) {
        this.log(
          `${descriptor.id}: snapshot failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      const signature = JSON.stringify(snapshot);
      if (this.signatures.get(descriptor.id) === signature) continue;
      this.signatures.set(descriptor.id, signature);
      this.broadcast({ type: "agentState", agent: snapshot });
    }
  }

  /** Routes one browser command; an unknown id is refused and spawns nothing. */
  async handle(target: AgentBridgeSocket, command: AgentCommand): Promise<void> {
    if (command.type === "getAgents") {
      this.replay(target);
      return;
    }
    if (typeof command.id !== "string" || command.id.length === 0) {
      this.send(target, { type: "error", message: "An agent command needs its agent id." });
      return;
    }
    const descriptor = this.registry.get(command.id);
    const adapter = this.adapter(command.id);
    if (descriptor === undefined || adapter === undefined) {
      this.send(target, {
        type: "error",
        message: `Unknown background agent: ${command.id}.`,
      });
      return;
    }
    if (command.type === "getAgent") {
      this.send(target, { type: "agentState", agent: this.project(adapter) });
      return;
    }
    if (command.type === "refreshAgent") {
      adapter.requestSync?.();
      this.send(target, { type: "agentState", agent: this.project(adapter) });
      return;
    }
    if (command.type === "startAgent") {
      const pending = adapter.start();
      this.publishAgent(command.id);
      const result = await pending;
      this.finish(target, command.id, result);
      return;
    }
    if (command.type === "stopAgent") {
      this.finish(target, command.id, adapter.stop());
      return;
    }
    if (command.type === "pauseAgent" || command.type === "resumeAgent") {
      const action = command.type === "pauseAgent" ? "pause" : "resume";
      const handler = command.type === "pauseAgent" ? adapter.pause : adapter.resume;
      if (handler === undefined) {
        this.send(target, {
          type: "error",
          message: `${descriptor.label} has no ${action} control.`,
        });
        return;
      }
      this.finish(target, command.id, handler.call(adapter));
      return;
    }
    if (command.type === "setAgentSettings") {
      this.finish(
        target,
        command.id,
        adapter.setSettings(command.minutes, command.maxPerHour, command.maxPending),
      );
      return;
    }
    if (command.type === "disableAgentTimer") {
      if (adapter.disableTimer === undefined) {
        this.send(target, {
          type: "error",
          message: `${descriptor.label} has no legacy timer to disable.`,
        });
        return;
      }
      const result = await adapter.disableTimer();
      this.publishAgent(command.id);
      if (!result.ok) this.send(target, { type: "error", message: result.message });
      return;
    }
  }

  private finish(target: AgentBridgeSocket, id: string, result: AgentCommandResult): void {
    this.publishAgent(id);
    if (!result.ok) this.send(target, { type: "error", message: result.message });
  }
}

export { defineAgentRegistry };
