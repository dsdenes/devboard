import { join } from "node:path";
import { readHarnessVersion } from "../server/version";

/**
 * What a running dashboard serves, as an operator needs it: the package it
 * loaded, the package its host prefix now holds, and whether a restart would
 * change code. Publish reports this and never restarts anything.
 */

export interface DashboardInstance {
  pid: number;
  port: number;
  repoDir: string;
  /** Harness directory the process runs from. */
  harness: string;
}

export interface DashboardInventory {
  host: string;
  port: number;
  pid: number;
  running: string | null;
  installed: string | null;
  stale: boolean;
}

export function dashboardInventory(instances: DashboardInstance[]): DashboardInventory[] {
  return instances.map((instance) => {
    const running = readHarnessVersion(instance.harness);
    const installed =
      instance.repoDir.length === 0
        ? running
        : readHarnessVersion(
            join(instance.repoDir, ".devboard", "node_modules", "@dsdenes", "devboard"),
          );
    return {
      host: instance.repoDir.length > 0 ? instance.repoDir : "an unknown host",
      port: instance.port,
      pid: instance.pid,
      running,
      installed,
      stale: running !== null && installed !== null && running !== installed,
    };
  });
}

export function describeInventory(entry: DashboardInventory): string {
  return (
    `publish: ${entry.host} port ${entry.port} (pid ${entry.pid}) ` +
    `running ${entry.running ?? "unknown"} installed ${entry.installed ?? "unknown"}` +
    (entry.stale ? " stale" : "")
  );
}
