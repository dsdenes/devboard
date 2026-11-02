import { readHarnessVersion, serverVersion } from "../server/version";
import type { McpContext } from "./context";
import { dashboardsFor } from "./dashboard";

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
  version: { running: string | null; installed: string | null; latest: string | null };
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

export function devboardStatus(context: McpContext): DevboardStatus {
  const dashboards = dashboardsFor(context);
  const running = readHarnessVersion(context.harnessDir);
  const version = serverVersion(context.repoDir, running, null);
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
      dashboards.length === 1
        ? { port: dashboards[0]?.port ?? 0, pid: dashboards[0]?.pid ?? 0 }
        : null,
    version: {
      running: version.running,
      installed: version.installed,
      latest: version.latest,
    },
    versionState,
  };
}
