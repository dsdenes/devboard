/**
 * The detached owner of one ACP run; the entry point of its own process.
 *
 * It spawns the real peer, appends activity, publishes its question, and
 * consumes the dashboard's answer/stop/pause/resume commands. It outlives a
 * dashboard replacement and ends only when the run ends or no supervisor is
 * left after a handoff window.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { AcpConnection, type AcpActivity, type AcpQuestion } from "./acp";
import {
  DETACHED_HANDOFF_GRACE_MS,
  DETACHED_RUN_INTERRUPTED,
  DETACHED_RUN_VERSION,
  appendDetachedRunActivity,
  appendDetachedRunText,
  detachedRunControlDirectory,
  detachedRunDirectory,
  readDetachedHandoff,
  readDetachedLease,
  readDetachedRunState,
  takeDetachedRunCommands,
  writeDetachedRunState,
  type DetachedRunState,
  type DetachedRunStatus,
} from "./detached-run";
import { pidAlive } from "../issues/lock";
import { readHarnessVersion } from "./version";

const OWNER_CHECK_MS = 100;

function argument(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function selfChild(cwd: string): { pid: number; argv: string[]; cwd: string } {
  let argv: string[] = [];
  try {
    argv = readFileSync("/proc/self/cmdline", "utf8").split("\u0000").filter(Boolean);
  } catch {
    argv = [...process.argv];
  }
  return { pid: process.pid, argv, cwd };
}

function readPrompt(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** The owner's own copy of the state, updated in place and persisted whole. */
class Owner {
  readonly #directory: string;
  readonly #stateDir: string;
  readonly #repoDir: string;
  readonly #state: DetachedRunState;
  readonly #launcherPid: number | null;
  #peer: AcpConnection | undefined;
  #finished = false;
  #timer: Timer | undefined;
  #handoffDeadline: number | undefined;
  #firstStderr = "";
  #generation: string;
  #stale = false;
  readonly #multi: boolean;
  #paused = false;

  constructor(
    directory: string,
    stateDir: string,
    repoDir: string,
    state: DetachedRunState,
  ) {
    this.#directory = directory;
    this.#stateDir = stateDir;
    this.#repoDir = repoDir;
    this.#state = state;
    this.#generation = state.generation;
    this.#launcherPid = state.launcherPid ?? state.owner?.pid ?? null;
    this.#multi = state.multi === true;
    this.#state.owner = selfChild(repoDir);
    this.#persist();
  }

  /** True when a newer run generation replaced this owner's state. */
  #superseded(): boolean {
    const current = readDetachedRunState(this.#directory);
    return current === undefined || current.generation !== this.#generation;
  }

  #persist(): void {
    if (this.#stale) return;
    if (this.#superseded()) {
      this.#stale = true;
      process.exit(0);
    }
    this.#state.updatedAt = new Date().toISOString();
    writeDetachedRunState(this.#directory, this.#state);
  }

  async run(prompt: string, command: string, cwd: string, permission: string | undefined): Promise<void> {
    const control = detachedRunControlDirectory(this.#directory);
    this.#timer = setInterval(() => {
      if (this.#finished) return;
      void this.#processOnce(control);
    }, OWNER_CHECK_MS);
    if (!this.#multi) this.#timer.unref?.();

    try {
      this.#peer = new AcpConnection({
        command,
        cwd,
        stateDir: this.#stateDir,
        permissionPolicy:
          permission === "read-only" || permission === "deny" ? permission : "allow",
        onActivity: (activity: AcpActivity) => {
          if (this.#finished || this.#stale || this.#paused) return;
          if (this.#superseded()) {
            this.#stale = true;
            process.exit(0);
          }
          appendDetachedRunActivity(this.#directory, {
            text: activity.text,
            append: activity.append,
          });
          if (this.#state.status !== "running") {
            this.#state.status = "running";
            this.#persist();
          }
        },
        onText: (text: string) => {
          if (this.#finished) return;
          appendDetachedRunText(this.#directory, text);
        },
        onQuestion: (question: AcpQuestion) => {
          if (this.#finished) return;
          this.#state.question = question;
          this.#persist();
        },
        onStderr: (text: string) => {
          if (this.#finished) return;
          const line = text
            .split("\n")
            .map((entry) => entry.trim())
            .find((entry) => entry.length > 0);
          if (line !== undefined && this.#firstStderr.length === 0) this.#firstStderr = line;
        },
      });
    } catch (error) {
      this.#finish("failed", error instanceof Error ? error.message : String(error));
      return;
    }

    const pid = this.#peer.pid;
    this.#state.peer =
      pid === undefined ? null : { pid, argv: this.#peer.argv, cwd };
    this.#state.status = "running";
    this.#persist();

    try {
      await this.#peer.run(prompt);
      if (!this.#multi) {
        this.#finish("succeeded", null);
        return;
      }
      this.#state.turnSeq = 1;
      this.#state.turnStatus = "succeeded";
      this.#state.turnError = null;
      this.#persist();
      clearInterval(this.#timer);
      this.#timer = undefined;
      await this.#loop(control);
      return;
    } catch (error) {
      const detail =
        error instanceof Error && error.message.length > 0
          ? error.message
          : this.#firstStderr.length > 0
            ? this.#firstStderr
            : "the run ended with an error";
      if (this.#multi) {
        this.#state.turnSeq = 1;
        this.#state.turnStatus = "failed";
        this.#state.turnError = detail;
        this.#persist();
        if (
          this.#peer === undefined ||
          !this.#peer.hasSession ||
          this.#peer.closed ||
          this.#peer.pid === undefined ||
          !pidAlive(this.#peer.pid)
        ) {
          this.#finish("failed", detail);
          return;
        }
        clearInterval(this.#timer);
        this.#timer = undefined;
        await this.#loop(control);
        return;
      }
      this.#finish("failed", detail);
    }
  }

  async #processOnce(control: string): Promise<void> {
    if (this.#finished) return;
    for (const pending of takeDetachedRunCommands(control)) {
      await this.#apply(pending);
      if (this.#finished) return;
    }
    if (
      this.#multi &&
      this.#peer !== undefined &&
      (this.#peer.closed || (this.#peer.pid !== undefined && !pidAlive(this.#peer.pid)))
    ) {
      this.#finish("failed", "The ask agent exited.");
      return;
    }
    this.#checkSupervisor();
  }

  /** A conversation owner stays alive between turns without relying on timers. */
  async #loop(control: string): Promise<void> {
    while (!this.#finished) {
      await Bun.sleep(OWNER_CHECK_MS);
      await this.#processOnce(control);
    }
  }

  async #apply(command: {
    type: string;
    id?: string | number;
    value?: string;
    seq?: number;
    text?: string;
  }): Promise<void> {
    if (this.#finished) return;
    if (command.type === "prompt") {
      if (!this.#multi || this.#peer === undefined) return;
      const seq = command.seq ?? 0;
      const text = command.text ?? "";
      this.#state.turnSeq = seq;
      this.#state.turnStatus = "running";
      this.#state.turnError = null;
      this.#persist();
      try {
        await this.#peer.prompt(text);
        this.#state.turnStatus = "succeeded";
      } catch (error) {
        this.#state.turnStatus = "failed";
        this.#state.turnError = error instanceof Error ? error.message : String(error);
        this.#persist();
        if (!this.#peer.hasSession) this.#finish("failed", this.#state.turnError);
        return;
      }
      this.#persist();
      return;
    }
    if (command.type === "stop") {
      this.#finish("stopped", null);
      return;
    }
    if (command.type === "pause") {
      this.#paused = true;
      this.#peer?.pause();
      return;
    }
    if (command.type === "resume") {
      this.#paused = false;
      this.#peer?.resume();
      return;
    }
    if (command.type !== "answer" || this.#peer === undefined) return;
    if (command.id === undefined || command.value === undefined) return;
    const answered = this.#peer.answer(command.id, command.value);
    if (answered) {
      this.#state.question = null;
      this.#persist();
    }
  }

  /**
   * Keeps the peer alive across a dashboard replacement. The process that
   * started this run supervises it for as long as it lives; several dashboards
   * can serve one repository and share its lease, and the one that holds it
   * did not start this run. Once that process exits, a lease from its
   * replacement and a handoff marker decide the run.
   */
  #checkSupervisor(): void {
    const lease = readDetachedLease(this.#stateDir, this.#repoDir);
    if (this.#launcherPid !== null && pidAlive(this.#launcherPid)) {
      // A successor dashboard in this same process takes the lease and adopts
      // the run without a handoff.
      if (
        lease !== null &&
        lease.pid === this.#launcherPid &&
        lease.instance !== this.#state.instance
      ) {
        this.#state.instance = lease.instance;
        this.#persist();
      }
      this.#handoffDeadline = undefined;
      return;
    }
    if (lease !== null && pidAlive(lease.pid)) {
      if (lease.instance === this.#state.instance) {
        this.#handoffDeadline = undefined;
        return;
      }
      // A different dashboard instance holds the lease. It may adopt this run
      // only when the previous process wrote the replacement's handoff.
      const handoff = readDetachedHandoff(this.#stateDir, this.#repoDir);
      if (handoff !== null) {
        this.#handoffDeadline ??= handoff.at + DETACHED_HANDOFF_GRACE_MS;
        if (Date.now() < this.#handoffDeadline) return;
      }
      if (handoff !== null) {
        this.#state.instance = lease.instance;
        this.#persist();
        this.#handoffDeadline = undefined;
        return;
      }
      this.#finish("failed", DETACHED_RUN_INTERRUPTED);
      return;
    }
    const handoff = readDetachedHandoff(this.#stateDir, this.#repoDir);
    if (handoff !== null) {
      this.#handoffDeadline ??= handoff.at + DETACHED_HANDOFF_GRACE_MS;
      if (Date.now() < this.#handoffDeadline) return;
    }
    this.#finish("failed", DETACHED_RUN_INTERRUPTED);
  }

  #finish(status: DetachedRunStatus, error: string | null): void {
    if (this.#finished) return;
    this.#finished = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    const peer = this.#peer;
    this.#peer = undefined;
    if (peer !== undefined) {
      try {
        peer.close();
      } catch {
        // The peer already exited.
      }
    }
    this.#state.status = status;
    this.#state.finishedAt = new Date().toISOString();
    this.#state.error = error;
    this.#state.question = null;
    this.#persist();
    process.exit(0);
  }

  interrupt(): void {
    this.#finish("failed", DETACHED_RUN_INTERRUPTED);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const repoDir = resolve(argument(argv, "--repo") ?? "");
  const stateDir = resolve(argument(argv, "--state-dir") ?? "");
  const kind = argument(argv, "--kind");
  const key = argument(argv, "--key");
  if (
    argument(argv, "--repo") === undefined ||
    argument(argv, "--state-dir") === undefined ||
    kind === undefined ||
    key === undefined
  ) {
    process.stderr.write("run owner: --repo, --state-dir, --kind, and --key are required.\n");
    process.exit(2);
  }
  const directory = detachedRunDirectory(stateDir, repoDir, kind, key);
  const generation = argument(argv, "--generation");
  const command = argument(argv, "--command") ?? "omp acp";
  const cwd = resolve(argument(argv, "--cwd") ?? repoDir);
  const permission = argument(argv, "--permission");
  const harnessVersion = readHarnessVersion(
    resolve(argument(argv, "--harness-dir") ?? resolve(import.meta.dir, "..")),
  );

  const launchDeadline = Date.now() + 3_000;
  let stored = readDetachedRunState(directory);
  while (
    Date.now() < launchDeadline &&
    (stored === undefined ||
      stored.status !== "starting" ||
      (generation !== undefined && stored.generation !== generation))
  ) {
    await Bun.sleep(20);
    stored = readDetachedRunState(directory);
  }
  if (
    stored === undefined ||
    stored.status !== "starting" ||
    (generation !== undefined && stored.generation !== generation)
  ) {
    process.exit(0);
  }
  stored.harnessVersion = harnessVersion;
  const prompt = readPrompt(join(directory, "prompt.txt"));
  try {
    unlinkSync(join(directory, "prompt.txt"));
  } catch {
    // Already consumed by a concurrent owner.
  }

  const owner = new Owner(directory, stateDir, repoDir, stored);
  process.on("SIGTERM", () => owner.interrupt());
  process.on("SIGINT", () => owner.interrupt());
  await owner.run(prompt, command, cwd, permission);
}

if (import.meta.main) {
  await main();
}
