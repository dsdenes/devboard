import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { liveLockOwners, type LockOwner } from "../issues/lock";
import { rootProblem } from "../issues/repository";
import { writeCommand, type ReleaseTrainCommand } from "../release-train/control";
import {
  lockPath,
  releaseTrainDirectory,
  versionedControlDirectory,
} from "../release-train/paths";
import {
  isValidCadence,
  isValidLimit,
  readSettings,
  writeSettings,
} from "../release-train/settings";
import {
  readState,
  type ReleaseTrainState,
  type ReleaseTrainWorkerRecord,
} from "../release-train/state";
import { releaseTrainWorkerStates } from "../release-train/worker";
import type { AgentDescriptor, AgentSnapshotInput } from "./agents/registry";
import type { AgentAdapter, AgentCommandResult } from "./agents/types";

/**
 * The Release Train page's server half. It reads the detached worker's state
 * and activity and starts, stops, pauses, resumes, or re-checks the worker.
 * Opening the page only reads and asks for a gate check; it never starts a
 * release by itself.
 */

export interface ReleaseTrainActivityOptions {
  descriptor: AgentDescriptor;
  repoDir: string;
  /** This dashboard's STATE_DIR; the family lives under its `release-train/`. */
  stateDir: string;
  harnessDir: string;
  runningVersion?: string | null;
  now?: () => number;
  environment?: Record<string, string | undefined>;
  log?: (line: string) => void;
  spawnWorker?: (
    argv: string[],
    environment: Record<string, string | undefined>,
  ) => number | undefined;
}

const START_PROOF_MS = 5_000;

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class ReleaseTrainActivity implements AgentAdapter {
  readonly descriptor: AgentDescriptor;
  private readonly repoDir: string;
  private readonly stateDir: string;
  private readonly directory: string;
  private readonly harnessDir: string;
  private readonly runningVersion: string | null;
  private readonly now: () => number;
  private readonly environment: Record<string, string | undefined>;
  private readonly log: (line: string) => void;
  private readonly spawnWorker: NonNullable<ReleaseTrainActivityOptions["spawnWorker"]>;
  private starting = false;
  private startingSince: number | null = null;
  private stopRequested = false;
  private startError: string | null = null;

  constructor(options: ReleaseTrainActivityOptions) {
    this.descriptor = options.descriptor;
    this.repoDir = resolve(options.repoDir);
    this.stateDir = resolve(options.stateDir);
    this.directory = releaseTrainDirectory(this.stateDir);
    this.harnessDir = options.harnessDir;
    this.runningVersion = options.runningVersion ?? null;
    this.now = options.now ?? (() => Date.now());
    this.environment = options.environment ?? process.env;
    this.log = options.log ?? (() => undefined);
    this.spawnWorker =
      options.spawnWorker ??
      ((argv, environment) => {
        try {
          const child = spawn(argv[0]!, argv.slice(1), {
            cwd: this.repoDir,
            env: environment,
            detached: true,
            stdio: "ignore",
          });
          child.unref();
          return child.pid;
        } catch (error) {
          this.log(
            `could not start the Release Train worker: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return undefined;
        }
      });
  }

  begin(): void {
    // The page reads persisted state; Start owns spawning.
  }

  dispose(): void {}

  settled(): Promise<void> {
    return Promise.resolve();
  }

  replay(_target: { send(data: string): unknown }): void {
    // The detail panel is carried by the snapshot.
  }

  /** Check now: ask every live worker to run its gate on the next tick. */
  requestSync(): void {
    for (const owner of this.owners()) {
      try {
        writeCommand(this.controlFor(owner), { type: "check" });
      } catch (error) {
        this.log(
          `could not ask the Release Train worker to check now: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private owners(): LockOwner[] {
    return liveLockOwners(lockPath(this.directory)).filter(
      (owner) => resolve(owner.stateDir) === this.stateDir,
    );
  }

  private controlFor(owner: LockOwner): string {
    return versionedControlDirectory(this.directory, owner.harnessVersion);
  }

  private workerRecords(): ReleaseTrainWorkerRecord[] {
    return releaseTrainWorkerStates(this.directory);
  }

  snapshot(): AgentSnapshotInput {
    const shared: ReleaseTrainState | undefined = readState(this.directory);
    const owners = this.owners();
    const records = this.workerRecords();
    const attached = owners.some((owner) =>
      records.some(
        (record) => record.pid === owner.pid && record.lifecycle !== "stopped",
      ),
    );
    const active =
      records.find((record) =>
        owners.some(
          (owner) => owner.pid === record.pid && record.lifecycle !== "stopped",
        ),
      ) ?? records[0];
    if (this.starting && attached) {
      this.starting = false;
      this.startingSince = null;
      this.startError = null;
    }
    if (
      this.starting &&
      this.startingSince !== null &&
      this.now() - this.startingSince > START_PROOF_MS
    ) {
      this.starting = false;
      this.startingSince = null;
      this.startError = "the Release Train worker did not publish its state within 5 seconds";
    }
    if (this.stopRequested && !attached) this.stopRequested = false;
    const settings = readSettings(this.directory);
    const lifecycle = this.starting
      ? "starting"
      : this.stopRequested || active?.lifecycle === "stopping"
        ? "stopping"
        : attached
          ? active?.lifecycle === "failed"
            ? "failed"
            : "running"
          : active?.lifecycle === "failed"
            ? "failed"
            : "stopped";
    const activity = shared?.activity ?? [];
    const latestRun = shared?.runs[0];
    const gate = shared?.gate ?? null;
    const workers = owners.map((owner) => ({
      pid: owner.pid,
      version: owner.harnessVersion,
      stateDir: owner.stateDir,
      lifecycle:
        records.find((record) => record.pid === owner.pid)?.lifecycle ?? "running",
    }));
    const error =
      this.startError ??
      (gate?.state === "error" ? gate.detail : null) ??
      active?.lastError ??
      shared?.failure?.detail ??
      null;
    return {
      lifecycle,
      enabled: attached && active?.enabled === true && lifecycle !== "stopped",
      owned: attached,
      attached,
      paused: active?.paused === true,
      cadence: {
        minutes: settings.intervalMinutes,
        lastRunAt: active?.lastRunAt ?? shared?.release?.at ?? null,
        nextRunAt: attached ? (active?.nextRunAt ?? null) : null,
      },
      limits: {
        maxPerHour: settings.maxPerHour,
        maxPending: settings.maxPending,
      },
      issues: [],
      pending: 0,
      sync: {
        state:
          gate === null ? "stale" : gate.state === "error" ? "error" : "ok",
        at: gate?.at ?? null,
        error: gate?.state === "error" ? gate.detail : null,
      },
      detail: {
        panel: "activity",
        scanId: `${latestRun?.id ?? "idle"}:${activity.length}`,
        entries: activity,
      },
      notice: active?.notice ?? null,
      error,
      timer: null,
      workers,
    };
  }

  async start(): Promise<AgentCommandResult> {
    if (this.starting) return { ok: true };
    if (this.owners().length > 0) return { ok: true };
    const problem = rootProblem(this.repoDir);
    if (problem !== undefined) {
      this.startError = problem;
      return { ok: false, message: problem };
    }
    this.starting = true;
    this.startingSince = null;
    this.startError = null;
    try {
      const argv = [
        process.execPath,
        resolve(this.harnessDir, "release-train", "main.ts"),
        "--root",
        this.repoDir,
        "--state-dir",
        this.stateDir,
      ];
      this.startingSince = this.now();
      const pid = this.spawnWorker(argv, {
        ...this.environment,
        REPO_DIR: this.repoDir,
        ...(this.runningVersion === null
          ? {}
          : { DEVBOARD_HARNESS_VERSION: this.runningVersion }),
      });
      if (pid === undefined) {
        this.starting = false;
        this.startingSince = null;
        this.startError = "the Release Train worker could not be started";
        return { ok: false, message: this.startError };
      }
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.starting = false;
      this.startingSince = null;
      this.startError = message;
      return { ok: false, message };
    }
  }

  stop(): AgentCommandResult {
    const owners = this.owners();
    if (owners.length === 0) {
      return { ok: false, message: "No Release Train worker is running for this repository." };
    }
    const failures: string[] = [];
    for (const owner of owners) {
      try {
        writeCommand(this.controlFor(owner), { type: "stop" });
        this.stopRequested = true;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    this.startError = null;
    if (failures.length > 0) {
      return { ok: false, message: `Could not reach every worker: ${failures.join("; ")}` };
    }
    return { ok: true };
  }

  pause(): AgentCommandResult {
    return this.command({ type: "pause" }, "No Release Train worker is running to pause.");
  }

  resume(): AgentCommandResult {
    return this.command({ type: "resume" }, "No Release Train worker is running to resume.");
  }

  setSettings(minutes: unknown, maxPerHour: unknown, maxPending: unknown): AgentCommandResult {
    if (!isValidCadence(minutes)) {
      return { ok: false, message: "The cadence must be an integer from 1 through 1440 minutes." };
    }
    if (!isValidLimit(maxPerHour) || !isValidLimit(maxPending)) {
      return { ok: false, message: "Both limits must be empty or integers from 1 through 100." };
    }
    try {
      writeSettings(this.directory, {
        ...readSettings(this.directory),
        intervalMinutes: minutes,
        maxPerHour,
        maxPending,
      });
    } catch (error) {
      return {
        ok: false,
        message: `Could not save the settings: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    return this.command(
      { type: "settings", intervalMinutes: minutes, maxPerHour, maxPending },
      null,
    );
  }

  private command(
    command: ReleaseTrainCommand,
    missing: string | null,
  ): AgentCommandResult {
    const owners = this.owners();
    if (owners.length === 0 && missing !== null) {
      return { ok: false, message: missing };
    }
    const failures: string[] = [];
    for (const owner of owners) {
      try {
        writeCommand(this.controlFor(owner), command);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failures.length > 0) {
      return { ok: false, message: `Could not reach every worker: ${failures.join("; ")}` };
    }
    return { ok: true };
  }
}

export { releaseTrainDirectory };
