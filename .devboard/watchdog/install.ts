import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  requireLinger,
  renderUnit,
  systemctl,
  uniqueDirectories,
  unitPaths,
  writeUnit,
} from "./systemd";

/**
 * Installs and starts the user timer. Idempotent: rerunning replaces the two
 * units and re-enables the timer without duplicating anything.
 */

const harness = resolve(import.meta.dir, "..");
const top = Bun.spawnSync({
  cmd: ["git", "-C", harness, "rev-parse", "--show-toplevel"],
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
});
const root = top.stdout.toString().trim();
if (top.exitCode !== 0 || root.length === 0) {
  fail("missing prerequisite: the harness is not inside a git checkout");
}

function fail(message: string): never {
  console.error(`watchdog:install: ${message}`);
  process.exit(1);
}

const absoluteGitDir = Bun.spawnSync({
  cmd: ["git", "-C", harness, "rev-parse", "--absolute-git-dir"],
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
}).stdout.toString().trim();
const commonGitDir = Bun.spawnSync({
  cmd: ["git", "-C", harness, "rev-parse", "--path-format=absolute", "--git-common-dir"],
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
}).stdout.toString().trim();
if (absoluteGitDir.length > 0 && absoluteGitDir !== commonGitDir) {
  fail("install runs from the canonical checkout, not a worktree");
}
const canonicalHarness = join(root, ".devboard");
try {
  if (realpathSync(harness) !== realpathSync(canonicalHarness)) {
    fail(`the harness must be ${canonicalHarness}`);
  }
} catch {
  fail(`missing prerequisite: ${canonicalHarness} is not readable`);
}

try {
  requireLinger();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const bun = process.execPath;
const omp = Bun.which("omp");
const git = Bun.which("git");
if (omp === undefined) fail("missing prerequisite: omp is not on PATH");
if (git === undefined) fail("missing prerequisite: git is not on PATH");

const values = {
  ROOT: root,
  HARNESS: canonicalHarness,
  BUN: bun,
  PATH: uniqueDirectories([bun, omp, git]),
};
const paths = unitPaths();
writeUnit(
  paths.service,
  renderUnit(join(import.meta.dir, "units", "devboard-watchdog.service"), values),
);
writeUnit(
  paths.timer,
  renderUnit(join(import.meta.dir, "units", "devboard-watchdog.timer"), values),
);

const reload = systemctl("daemon-reload");
if (reload.code !== 0) fail(`daemon-reload failed: ${reload.stderr || reload.stdout}`);
const enabled = systemctl("enable", "--now", "devboard-watchdog.timer");
if (enabled.code !== 0) fail(`could not enable the timer: ${enabled.stderr || enabled.stdout}`);

const isEnabled = systemctl("is-enabled", "devboard-watchdog.timer");
if (isEnabled.stdout !== "enabled") fail(`the timer is ${isEnabled.stdout || "not enabled"}`);
const isActive = systemctl("is-active", "devboard-watchdog.timer");
if (isActive.stdout !== "active") fail(`the timer is ${isActive.stdout || "not active"}`);
const linger = requireLinger();
const timers = systemctl("list-timers", "devboard-watchdog.timer", "--all");
if (!/devboard-watchdog\.timer/.test(timers.stdout)) {
  fail("the timer did not appear in list-timers");
}

console.log(`watchdog:install: installed ${paths.service} and ${paths.timer}`);
console.log(`watchdog:install: timer enabled, active, ${linger}`);
console.log(timers.stdout);
