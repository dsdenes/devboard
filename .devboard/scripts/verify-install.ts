#!/usr/bin/env bun
/**
 * Verifies the public launcher end to end: install over legacy symlinks, a
 * reinstall, update without a restart, a canonical-checkout refusal, tracked
 * host changes, and every doctor check including its injected failures.
 *
 * Fixture hosts and releases live under `.devboard/.tmp`. Nothing is written
 * into a real host.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createReleaseDirectory } from "./harness-package";
import {
  assertTrue,
  assertEquals,
  dashboardsFor,
  httpStatus,
  installState,
  installedPackage,
  installedVersion,
  isSymlink,
  launcher,
  linkCanonicalHost,
  makeHost,
  makeRoot,
  processRunning,
  readVersion,
  releaseDirectory,
  repoRoot,
  stopDashboard,
  symlinkTargetsUnder,
  templateAgents,
  toolPath,
  treesMatch,
  waitFor,
  type HostFixture,
} from "./verification";

const OLD = "0.1.900";
const NEW = "0.1.901";
const root = await makeRoot("verify-install");
const startedHosts: string[] = [];

function step(message: string): void {
  console.log(`verify:install: ${message}`);
}

function expectFailure(result: { code: number; stdout: string; stderr: string }, name: string): void {
  assertTrue(result.code !== 0, `doctor [${name}] should exit nonzero: ${result.stdout}`);
  assertTrue(
    result.stdout.split("\n").some((line) => line.startsWith(`FAIL ${name}`)),
    `doctor should print FAIL ${name}:\n${result.stdout}`,
  );
}

try {
  const oldRelease = releaseDirectory(root, OLD);
  const newRelease = releaseDirectory(root, NEW);
  await createReleaseDirectory(OLD, oldRelease);
  await createReleaseDirectory(NEW, newRelease);
  const failingNpm = join(root, "failing-npm");
  await writeFile(failingNpm, "#!/bin/sh\ncase \"$1\" in view) echo 'simulated npm outage' >&2; exit 1;; esac\nexec npm \"$@\"\n");
  await chmod(failingNpm, 0o755);
  const oldEnv = { DEVBOARD_RELEASE_DIR: oldRelease, DEVBOARD_NPM: failingNpm };
  const newEnv = { DEVBOARD_RELEASE_DIR: newRelease, DEVBOARD_NPM: failingNpm };

  step("refusing the canonical source checkout");
  const refusal = launcher(["install", "--host", repoRoot], oldEnv);
  assertTrue(refusal.code !== 0, "install into the canonical checkout should fail");
  assertTrue(
    `${refusal.stdout}${refusal.stderr}`.includes("canonical"),
    `refusal should name the canonical checkout:\n${refusal.stderr}`,
  );

  step("installing over symlinked harness paths");
  const host = await makeHost(root, "linked");
  await writeFile(join(host.directory, "tracked.txt"), "modified by the host\n");
  await writeFile(join(host.directory, ".omp", "local.md"), "kept\n");
  await mkdir(join(host.directory, ".omp", "commands"), { recursive: true });
  await writeFile(join(host.directory, ".omp", "commands", "host-local.md"), "tracked\n");
  const git = (args: string[]) => {
    const result = Bun.spawnSync({
      cmd: ["git", "-C", host.directory, ...args],
      stdout: "pipe",
      stderr: "pipe",
    });
    assertTrue(result.exitCode === 0, `git ${args.join(" ")}: ${result.stderr.toString()}`);
  };
  git(["add", ".omp/commands/host-local.md"]);
  git(["commit", "-q", "-m", "track wrapper"]);
  await rm(join(host.directory, ".omp", "commands"), { recursive: true, force: true });
  await linkCanonicalHost(host.directory);

  const installed = launcher(["install", "--host", host.directory], oldEnv);
  startedHosts.push(host.directory);
  assertTrue(installed.code === 0, `install failed:\n${installed.stdout}\n${installed.stderr}`);
  const fallbackLine = installed.stdout
    .split("\n")
    .find((line) => line.includes("used release tarball"));
  assertTrue(
    fallbackLine !== undefined,
    `install did not report the tarball fallback after npm failed:\n${installed.stdout}`,
  );
  step(fallbackLine ?? "tarball fallback used");
  const prefix = join(host.directory, ".devboard");
  assertTrue(!isSymlink(prefix), ".devboard must be a real directory");
  assertTrue(!isSymlink(join(host.directory, ".omp", "commands")), ".omp/commands must be real");
  assertTrue(!isSymlink(join(host.directory, ".omp", "extensions")), ".omp/extensions must be real");
  assertTrue(
    existsSync(join(host.directory, ".omp", "commands", "implement-issue.md")),
    ".omp/commands/implement-issue.md is missing",
  );
  assertTrue(
    existsSync(join(host.directory, ".omp", "extensions", "implement-goal-issue.ts")),
    ".omp/extensions/implement-goal-issue.ts is missing",
  );
  for (const name of ["server", "dist", "templates", "omp"]) {
    assertEquals(symlinkTargetsUnder(join(prefix, name)), [], `no symlinks under ${name}/`);
  }
  assertEquals(
    installedVersion(prefix),
    OLD,
    "the installed package version",
  );
  assertEquals(
    JSON.parse(readFileSync(join(prefix, "package.json"), "utf8")).dependencies[
      "@dsdenes/devboard"
    ],
    OLD,
    "the prefix records the devboard dependency",
  );
  assertTrue(existsSync(join(prefix, ".tmp")) && isDirectory(join(prefix, ".tmp")), ".tmp exists");
  const harness = installedPackage(prefix);
  assertTrue(
    treesMatch(join(harness, "omp", "commands"), join(host.directory, ".omp", "commands")),
    "commands match the installed package",
  );
  assertTrue(
    treesMatch(join(harness, "omp", "extensions"), join(host.directory, ".omp", "extensions")),
    "extensions match the installed package",
  );
  assertTrue(!existsSync(join(host.directory, ".omp", "commands", "host-local.md")), "deleted tracked wrapper stays absent");
  assertTrue(readFileSync(join(host.directory, ".omp", "local.md"), "utf8") === "kept\n", "untracked .omp file is preserved");
  const agents = join(host.directory, "AGENTS.md");
  assertTrue(!isSymlink(agents), "AGENTS.md is a regular file");
  assertTrue(
    readFileSync(agents).equals(readFileSync(templateAgents)),
    "AGENTS.md matches the template",
  );
  const ignore = readFileSync(join(host.directory, ".gitignore"), "utf8").split("\n");
  for (const entry of ["/.devboard", "/.omp/commands", "/.omp/extensions"]) {
    assertTrue(ignore.includes(entry), `.gitignore contains ${entry}`);
  }
  assertEquals(readFileSync(join(host.directory, "tracked.txt"), "utf8"), "modified by the host\n", "tracked change preserved");
  const status = Bun.spawnSync({
    cmd: ["git", "-C", host.directory, "status", "--short"],
    stdout: "pipe",
  }).stdout.toString();
  assertTrue(
    status.split("\n").some((line) => line.includes("D .omp/commands/host-local.md")),
    "the tracked-and-deleted wrapper stays absent",
  );

  const state = installState(prefix);
  const port = Number(state.port);
  assertTrue(httpStatus(port) === 200, "the installed dashboard answers HTTP 200");
  assertEquals(dashboardsFor(host.directory).length, 1, "exactly one dashboard process");
  const runningCmdline = readFileSync(`/proc/${state.pid}/cmdline`, "utf8");
  assertTrue(
    runningCmdline.includes(harness),
    "the dashboard runs the installed package",
  );
  const version = await readVersion(port);
  assertEquals(
    [version.running, version.installed, version.stale],
    [OLD, OLD, false],
    "the fresh dashboard reports its installed version",
  );

  step("reinstalling");
  const reinstalled = launcher(["install", "--host", host.directory], oldEnv);
  assertTrue(reinstalled.code === 0, `reinstall failed: ${reinstalled.stderr}`);
  assertEquals(installedVersion(prefix), OLD, "reinstall keeps the version");
  assertTrue(existsSync(join(prefix, ".tmp")), "reinstall keeps .tmp");
  assertEquals(dashboardsFor(host.directory).length, 1, "reinstall leaves one dashboard");

  step("updating without a restart");
  const pidBefore = Number(installState(prefix).pid);
  const updated = launcher(["update", "--host", host.directory], newEnv);
  assertTrue(updated.code === 0, `update failed: ${updated.stderr}`);
  assertTrue(updated.stdout.includes(OLD) && updated.stdout.includes(NEW), "update prints both versions");
  assertEquals(installedVersion(prefix), NEW, "update installs the newer version");
  assertTrue(processRunning(pidBefore), "update does not restart the dashboard");
  assertEquals(dashboardsFor(host.directory).length, 1, "update leaves one dashboard");
  const stale = await readVersion(port);
  assertEquals(
    [stale.running, stale.installed, stale.latest, stale.stale],
    [OLD, NEW, OLD, true],
    "the running dashboard reports the installed version as stale",
  );

  step("migrating a legacy two-package prefix");
  const legacyHost = await makeHost(root, "legacy");
  const legacyPrefix = join(legacyHost.directory, ".devboard");
  const legacyPackage = join(legacyPrefix, "node_modules", "@dsdenes", "devboard-harness");
  await mkdir(legacyPackage, { recursive: true });
  await writeFile(
    join(legacyPackage, "package.json"),
    `${JSON.stringify({ name: "@dsdenes/devboard-harness", version: OLD })}\n`,
  );
  await writeFile(
    join(legacyPrefix, "package.json"),
    `${JSON.stringify({ name: "devboard-host", private: true, dependencies: { "@dsdenes/devboard-harness": OLD } })}\n`,
  );
  await mkdir(join(legacyPrefix, ".tmp"), { recursive: true });
  await writeFile(join(legacyPrefix, ".tmp", "sentinel"), "state kept\n");
  await writeFile(join(legacyHost.directory, "AGENTS.md"), "host AGENTS sentinel\n");
  await mkdir(join(legacyHost.directory, ".omp", "commands"), { recursive: true });
  await mkdir(join(legacyHost.directory, ".omp", "extensions"), { recursive: true });
  await writeFile(join(legacyHost.directory, ".omp", "commands", "sentinel.md"), "command kept\n");
  await writeFile(join(legacyHost.directory, ".omp", "extensions", "sentinel.ts"), "extension kept\n");
  const migrated = launcher(["update", "--host", legacyHost.directory], newEnv);
  assertTrue(migrated.code === 0, `legacy update failed:\n${migrated.stdout}\n${migrated.stderr}`);
  assertEquals(installedVersion(legacyPrefix), NEW, "migration installs the new package");
  assertTrue(!existsSync(legacyPackage), "migration removes the legacy package directory");
  assertEquals(
    readFileSync(join(legacyPrefix, ".tmp", "sentinel"), "utf8"),
    "state kept\n",
    "migration preserves .tmp",
  );
  assertEquals(
    readFileSync(join(legacyHost.directory, "AGENTS.md"), "utf8"),
    "host AGENTS sentinel\n",
    "migration preserves AGENTS.md",
  );
  assertEquals(
    readFileSync(join(legacyHost.directory, ".omp", "commands", "sentinel.md"), "utf8"),
    "command kept\n",
    "migration preserves omp commands",
  );
  assertEquals(
    readFileSync(join(legacyHost.directory, ".omp", "extensions", "sentinel.ts"), "utf8"),
    "extension kept\n",
    "migration preserves omp extensions",
  );

  step("doctor passing");
  const doctor = launcher(["doctor", "--host", host.directory], newEnv);
  assertTrue(doctor.code === 0, `doctor failed:\n${doctor.stdout}\n${doctor.stderr}`);
  for (const line of doctor.stdout.trim().split("\n")) {
    assertTrue(line.startsWith("PASS "), `unexpected doctor line: ${line}`);
  }

  step("doctor injected failures");
  const staleHost = await makeHost(root, "stale");
  const staleInstall = launcher(["install", "--host", staleHost.directory], oldEnv);
  startedHosts.push(staleHost.directory);
  assertTrue(staleInstall.code === 0, `stale fixture install failed: ${staleInstall.stderr}`);
  expectFailure(launcher(["doctor", "--host", staleHost.directory], newEnv), "version");

  const missing = await makeHost(root, "missing");
  await Bun.spawnSync({ cmd: ["mkdir", "-p", join(missing.directory, ".devboard")] });
  expectFailure(launcher(["doctor", "--host", missing.directory], newEnv), "package install");

  const emptyRelease = join(root, "empty-release");
  await Bun.spawnSync({ cmd: ["mkdir", "-p", emptyRelease] });
  expectFailure(
    launcher(["doctor", "--host", host.directory], {
      DEVBOARD_RELEASE_DIR: emptyRelease,
      DEVBOARD_NPM: failingNpm,
    }),
    "release access",
  );

  const linkedOnly = await makeHost(root, "linked-only");
  await linkCanonicalHost(linkedOnly.directory);
  expectFailure(launcher(["doctor", "--host", linkedOnly.directory], newEnv), "no symlink");

  const noBun = await toolPath(root, { omit: ["bun"] });
  expectFailure(launcher(["doctor", "--host", host.directory], { ...newEnv, PATH: noBun }), "bun");

  const noOmp = await toolPath(root, { omit: ["omp"] });
  expectFailure(launcher(["doctor", "--host", host.directory], { ...newEnv, PATH: noOmp }), "omp");

  expectFailure(
    launcher(["doctor", "--host", host.directory], {
      DEVBOARD_NPM: failingNpm,
      // An ambient harness origin must not stand in for the fixture's feed.
      DEVBOARD_GITEA_URL: "",
      DEVBOARD_RELEASE_DIR: emptyRelease,
    }),
    "release access",
  );

  console.log("verify:install: all checks passed");
} finally {
  for (const host of startedHosts) await stopDashboard(host).catch(() => undefined);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
