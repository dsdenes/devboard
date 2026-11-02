import type { AgentDescriptor, AgentSnapshotInput } from "./registry";

/** What every background-agent adapter answers. */
export type AgentCommandResult =
  | { ok: true; notice?: string }
  | { ok: false; message: string };

export interface AgentAdapter {
  readonly descriptor: AgentDescriptor;
  /** Starts observing persisted state; it never starts a worker. */
  begin(): void;
  dispose(): void;
  /** The current projection; must never throw. */
  snapshot(): AgentSnapshotInput;
  /** Replays any agent-specific stream (activity) to one client. */
  replay(target: { send(data: string): unknown }): void;
  /**
   * A view opened this agent: refresh its data now instead of at the next
   * cadence. Only an adapter with a periodic read implements this.
   */
  requestSync?(): void;
  start(): Promise<AgentCommandResult>;
  stop(): AgentCommandResult;
  /** Saves the cadence and both caps as one settings write. */
  setSettings(minutes: unknown, maxPerHour: unknown, maxPending: unknown): AgentCommandResult;
  /** Only the descriptor with a legacy timer gate implements this. */
  disableTimer?(): Promise<AgentCommandResult>;
}

export function agentCommandFailure(message: string): AgentCommandResult {
  return { ok: false, message };
}
