import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  harnessDirectory,
  isLinkedWorktree,
  originRepository,
  realDirectory,
  topLevel,
} from "./repository";
import {
  requireLinger,
  requirePushPermission,
  renderUnit,
  systemctl,
  uniqueDirectories,
  unitPaths,
  writeUnit,
  SERVICE_NAME,
} from "./systemd";

/**
 * Installs and starts the user service. It refuses a worktree and any root
 * other than the canonical checkout, proves the machine can reach the tracker
 * and the agent, and renders the unit's host-specific values from what it
 * finds at runtime. Rerunning rewrites the same unit and starts nothing new.
 */

function fail(message: string): never {
  console.error(`orchestrator:install: ${message}`);
  process.exit(1);
}

const harness = resolve(import.meta.dir, "..");
const root = topLevel(harness);
if (root === undefined) fail("missing prerequisite: the harness is not inside a git checkout");
if (isLinkedWorktree(root)) fail("install runs from the canonical checkout, not a worktree");

const canonicalHarness = harnessDirectory(root);
const harnessReal = realDirectory(harness);
const canonicalReal = realDirectory(canonicalHarness);
if (harnessReal === undefined || canonicalReal === undefined || harnessReal !== canonicalReal) {
  fail(`the harness must be ${canonicalHarness}`);
}

const repository = originRepository(root);
if (repository === undefined) fail("the canonical checkout's origin does not name a repository");

try {
  requireLinger();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const bun = Bun.which("bun") ?? process.execPath;
const omp = Bun.which("omp");
const gh = Bun.which("gh");
const git = Bun.which("git");
if (omp === undefined) fail("missing prerequisite: omp is not on PATH");
if (gh === undefined) fail("missing prerequisite: gh is not on PATH");
if (git === undefined) fail("missing prerequisite: git is not on PATH");

const commandNames = [
  join(homedir(), ".omp", "agent", "commands", "implement-all-issues.md"),
  join(homedir(), ".omp", "commands", "implement-all-issues.md"),
];
if (!commandNames.some((path) => existsSync(path))) {
  fail(
    "missing prerequisite: the /implement-all-issues command is not installed for omp " +
      `(looked in ${commandNames.join(" and ")})`,
  );
}

try {
  requirePushPermission(repository);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const absoluteBun = realDirectory(bun) ?? resolve(bun);
const values = {
  ROOT: root,
  HARNESS: canonicalHarness,
  REPO: repository,
  BUN: absoluteBun,
  PATH: uniqueDirectories([bun, omp, gh, git]),
};
const paths = unitPaths();
writeUnit(
  paths.service,
  renderUnit(join(import.meta.dir, "units", "devboard-orchestrator.service"), values),
);

const before = systemctl("show", "-p", "MainPID", "--value", SERVICE_NAME).stdout;
const reload = systemctl("daemon-reload");
if (reload.code !== 0) fail(`daemon-reload failed: ${reload.stderr || reload.stdout}`);
const enabled = systemctl("enable", "--now", SERVICE_NAME);
if (enabled.code !== 0) fail(`could not enable the service: ${enabled.stderr || enabled.stdout}`);

const isEnabled = systemctl("is-enabled", SERVICE_NAME);
if (isEnabled.stdout !== "enabled") {
  fail(`the service is ${isEnabled.stdout || "not enabled"}`);
}
const isActive = systemctl("is-active", SERVICE_NAME);
if (isActive.stdout !== "active") fail(`the service is ${isActive.stdout || "not active"}`);
const after = systemctl("show", "-p", "MainPID", "--value", SERVICE_NAME).stdout;
if (!/^\d+$/.test(after) || Number(after) <= 0) fail("the service reported no MainPID");

console.log(`orchestrator:install: wrote ${paths.service}`);
console.log(`orchestrator:install: ${repository} at ${root}`);
console.log(`orchestrator:install: service enabled, active, MainPID ${after}`);
if (before === after) console.log("orchestrator:install: the running service was left untouched");
