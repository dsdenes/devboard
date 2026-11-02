import { readHarnessVersion, serverVersion } from "../server/version";
import type { McpContext } from "./context";
import { dashboardCommand, dashboardsFor, type LiveDashboard } from "./dashboard";

/** The deterministic harness status: roots, one live dashboard, version and git state. */

export interface DevboardGitState {
  /** The checked-out branch; null on a detached HEAD. */
  branch: string | null;
  /** The branch's upstream ref, such as `origin/main`; null when it has none. */
  upstream: string | null;
  /** Commits HEAD holds that its upstream lacks. */
  ahead: number;
  /** Commits the upstream holds that HEAD lacks. */
  behind: number;
}

export interface DevboardStatus {
  repositoryRoot: string;
  harnessDirectory: string;
  stateDirectory: string;
  git: DevboardGitState;
  dashboard: { port: number; pid: number } | null;
  version: {
    running: string | null;
    installed: string | null;
    latest: string | null;
    /** True when the live dashboard serves a harness source checkout. */
    source: boolean;
  };
  versionState: "running" | "installed" | "latest" | "stale";
}

function emptyGitState(): DevboardGitState {
  return { branch: null, upstream: null, ahead: 0, behind: 0 };
}

/**
 * The checkout's branch, upstream, and ahead/behind counts from one porcelain
 * v2 status read. A non-repository, or a git failure, reports the neutral state
 * instead of failing the whole status call.
 */
export function gitState(repoDir: string): DevboardGitState {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", repoDir, "status", "--porcelain=v2", "--branch"],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return emptyGitState();
  const state = emptyGitState();
  for (const line of result.stdout.toString().split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      state.branch = head.length === 0 || head === "(detached)" ? null : head;
    } else if (line.startsWith("# branch.upstream ")) {
      const upstream = line.slice("# branch.upstream ".length).trim();
      state.upstream = upstream.length === 0 ? null : upstream;
    } else if (line.startsWith("# branch.ab ")) {
      const counts = /^\+(\d+) -(\d+)$/.exec(line.slice("# branch.ab ".length).trim());
      if (counts !== null) {
        state.ahead = Number(counts[1]);
        state.behind = Number(counts[2]);
      }
    }
  }
  return state;
}

interface LiveVersion {
  running: string | null;
  installed: string | null;
  latest: string | null;
  stale: boolean;
  source: boolean;
}

/**
 * The live dashboard's own version state. `running` is the version that
 * process loaded, which no file on disk can answer for it; the status tool
 * therefore agrees with the WebSocket frame rather than recomputing it.
 */
async function liveVersion(dashboard: LiveDashboard): Promise<LiveVersion | undefined> {
  try {
    const reply = await dashboardCommand(
      dashboard,
      { type: "getVersion" },
      (message) => message.type === "versionState",
      5_000,
    );
    return {
      running: typeof reply.running === "string" ? reply.running : null,
      installed: typeof reply.installed === "string" ? reply.installed : null,
      latest: typeof reply.latest === "string" ? reply.latest : null,
      stale: reply.stale === true,
      source: reply.source === true,
    };
  } catch {
    return undefined;
  }
}

export async function devboardStatus(context: McpContext): Promise<DevboardStatus> {
  const dashboards = dashboardsFor(context);
  const dashboard = dashboards.length === 1 ? dashboards[0] : undefined;
  const live = dashboard === undefined ? undefined : await liveVersion(dashboard);
  const fallback = serverVersion(
    context.repoDir,
    readHarnessVersion(context.harnessDir),
    null,
  );
  const version: LiveVersion =
    live ?? {
      running: fallback.running,
      installed: fallback.installed,
      latest: fallback.latest,
      stale: fallback.stale,
      source: fallback.source === true,
    };
  const versionState = version.stale
    ? "stale"
    : version.installed !== null && version.running === version.installed
      ? "latest"
      : version.installed !== null
        ? "installed"
        : "running";
  return {
    repositoryRoot: context.repoDir,
    harnessDirectory: context.harnessDir,
    stateDirectory: context.stateDir,
    git: gitState(context.repoDir),
    dashboard:
      dashboard === undefined ? null : { port: dashboard.port, pid: dashboard.pid },
    version: {
      running: version.running,
      installed: version.installed,
      latest: version.latest,
      source: version.source,
    },
    versionState,
  };
}
