import { readHarnessVersion, serverVersion } from "../server/version";
import type { McpContext } from "./context";
import { dashboardsFor } from "./dashboard";

/** The deterministic harness status: roots, one live dashboard, version state. */

export interface DevboardStatus {
  repositoryRoot: string;
  harnessDirectory: string;
  stateDirectory: string;
  dashboard: { port: number; pid: number } | null;
  version: { running: string | null; installed: string | null; latest: string | null };
  versionState: "running" | "installed" | "latest" | "stale";
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
