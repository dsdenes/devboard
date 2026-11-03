import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { discoverInstances, type Instance } from "../watchdog/discovery";

/**
 * The one live dashboard for a repository. Control tools delegate to its
 * existing WebSocket command surface; they never write a second copy of live
 * state. Zero matches and more than one match are refused, naming the
 * repository and every port that was found.
 */

export interface LiveDashboard {
  pid: number;
  port: number;
  repoDir: string;
  harness: string;
  stateDir: string;
  /** The dashboard's socket credential; empty when the process published none. */
  token?: string;
}

export class DashboardRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DashboardRefusal";
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export interface DiscoverOptions {
  /** Injectable process table for tests. */
  instances?: Instance[];
}

/** Every live dashboard serving exactly this repository. */
export function dashboardsFor(context: {
  repoDir: string;
  dashboards?: LiveDashboard[];
}): LiveDashboard[] {
  return context.dashboards ?? discoverDashboards(context.repoDir);
}

export function discoverDashboards(repoDir: string, options: DiscoverOptions = {}): LiveDashboard[] {
  const target = real(repoDir);
  const instances =
    options.instances ??
    discoverInstances({ selfPids: new Set([process.pid]) });
  return instances
    .filter((instance) => real(instance.repoDir) === target)
    .map((instance) => ({
      pid: instance.pid,
      port: instance.port,
      repoDir: instance.repoDir,
      harness: instance.harness,
      stateDir: instance.stateDir,
      ...(instance.token === undefined ? {} : { token: instance.token }),
    }))
    .sort((left, right) => left.port - right.port);
}

/** The single dashboard, or a refusal naming the repository and ports. */
export function selectDashboard(
  repoDir: string,
  options: DiscoverOptions & { dashboards?: LiveDashboard[] } = {},
): LiveDashboard {
  const found = options.dashboards ?? discoverDashboards(repoDir, options);
  if (found.length === 0) {
    throw new DashboardRefusal(
      `No live dashboard serves ${repoDir}; start one before using a control tool.`,
    );
  }
  if (found.length > 1) {
    throw new DashboardRefusal(
      `${found.length} live dashboards serve ${repoDir} (ports ` +
        `${found.map((entry) => entry.port).join(", ")}); refusing to guess which one to command.`,
    );
  }
  const dashboard = found[0];
  if (dashboard === undefined) {
    throw new DashboardRefusal(`No live dashboard serves ${repoDir}.`);
  }
  return dashboard;
}

export interface DashboardReply {
  type?: string;
  message?: string;
  [key: string]: unknown;
}

const INITIAL_REPLAY_MS = 250;
const COMMAND_TIMEOUT_MS = 20_000;

/**
 * Opens the dashboard's WebSocket, lets its connect-time replay settle, sends
 * one command, and resolves the first reply that `accept` names or an error.
 */
export async function dashboardCommand(
  dashboard: LiveDashboard,
  command: unknown | unknown[],
  accept: (reply: DashboardReply) => boolean,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<DashboardReply> {
  const commands = Array.isArray(command) ? command : [command];
  const { promise, resolve: settle, reject } = Promise.withResolvers<DashboardReply>();
  const token = dashboard.token ?? "";
  const socket =
    token.length === 0
      ? new WebSocket(`ws://127.0.0.1:${dashboard.port}/ws`)
      : new WebSocket(`ws://127.0.0.1:${dashboard.port}/ws`, {
          headers: { authorization: `Bearer ${token}` },
        } as unknown as string[]);
  let opened = false;
  let sent = false;
  const timer = setTimeout(() => {
    try {
      socket.close();
    } catch {
      // Already closed.
    }
    reject(new Error(`the dashboard on port ${dashboard.port} did not answer in time`));
  }, timeoutMs);
  const finish = (reply: DashboardReply) => {
    clearTimeout(timer);
    try {
      socket.close();
    } catch {
      // Already closed.
    }
    if (reply.type === "error") {
      reject(new DashboardRefusal(String(reply.message ?? "the dashboard refused the command")));
      return;
    }
    settle(reply);
  };
  socket.onopen = () => {
    opened = true;
    // The dashboard replays issues, agents, lifecycle, and Flow on connect.
    // Sending after the replay settles keeps a control reply from matching
    // pre-command state.
    setTimeout(() => {
      if (!opened) return;
      sent = true;
      for (const entry of commands) socket.send(JSON.stringify(entry));
    }, INITIAL_REPLAY_MS);
  };
  socket.onerror = () => {
    if (!opened) {
      clearTimeout(timer);
      reject(new Error(`the dashboard on port ${dashboard.port} refused the connection`));
    }
  };
  let accepted: DashboardReply | undefined;
  let acceptedTimer: Timer | undefined;
  socket.onmessage = (event) => {
    if (!sent) return;
    let reply: unknown;
    try {
      reply = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (typeof reply !== "object" || reply === null || !("type" in reply)) return;
    const record = reply as DashboardReply;
    if (record.type === "error") {
      if (acceptedTimer !== undefined) clearTimeout(acceptedTimer);
      finish(record);
      return;
    }
    if (!accept(record)) return;
    accepted = record;
    // The dashboard can publish the new state and then refuse the command;
    // give the refusal a moment to arrive before reporting success.
    acceptedTimer = setTimeout(() => {
      if (accepted !== undefined) finish(accepted);
    }, 50);
  };
  return promise;
}
