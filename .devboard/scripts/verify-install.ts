#!/usr/bin/env bun
/**
 * Verifies the public launcher end to end: install over legacy symlinks, a
 * reinstall, update without a restart, a canonical-checkout refusal, tracked
 * host changes, and every doctor check including its injected failures.
 *
 * Fixture hosts and releases live under `.devboard/.tmp`. Nothing is written
 * into a real host.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createReleaseDirectory } from "./harness-package";
import { MCP_TOOL_NAMES } from "../mcp/catalog";
import {
  assertTrue,
  assertEquals,
  dashboardsFor,
  freePort,
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
  waitFor,
  releaseDirectory,
  repoRoot,
  stopDashboard,
  symlinkTargetsUnder,
  templateAgents,
  toolPath,
  treesMatch,
  waitFor,
  declaredMcpTools,
  type HostFixture,
} from "./verification";

const OLD = "0.1.900";
const NEW = "0.1.901";
/** The skill directories every install and update writes into the host. */
const MANAGED_SKILLS = [
  "devboard-ui-ux",
  "devboard-restful-api-implementation",
  "devboard-single-responsibility-principle",
  "devboard-consistent-naming",
  "devboard-architectural-layering",
] as const;
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
  for (const name of MANAGED_SKILLS) {
    assertTrue(
      treesMatch(
        join(harness, "omp", "skills", name),
        join(host.directory, ".omp", "skills", name),
      ),
      `.omp/skills/${name} matches the installed package`,
    );
  }
  step(`installed project skills ${MANAGED_SKILLS.join(", ")}`);
  const installedMcp = join(host.directory, ".omp", "mcp.json");
  assertTrue(existsSync(installedMcp), ".omp/mcp.json is missing");
  assertTrue(!isSymlink(installedMcp), ".omp/mcp.json is a symlink");
  assertTrue(
    readFileSync(installedMcp).equals(readFileSync(join(harness, "omp", "mcp.json"))),
    ".omp/mcp.json matches the installed package",
  );
  assertTrue(
    readFileSync(installedMcp).equals(readFileSync(join(repoRoot, ".devboard", "omp", "mcp.json"))),
    ".omp/mcp.json matches the canonical file",
  );
  assertEquals(
    await declaredMcpTools(host.directory, prefix),
    [...MCP_TOOL_NAMES],
    "the installed MCP server answers tools/list",
  );
  step("installed MCP server answers initialize and tools/list");
  assertTrue(!existsSync(join(host.directory, ".omp", "commands", "host-local.md")), "deleted tracked wrapper stays absent");
  assertTrue(readFileSync(join(host.directory, ".omp", "local.md"), "utf8") === "kept\n", "untracked .omp file is preserved");
  const agents = join(host.directory, "AGENTS.md");
  assertTrue(!isSymlink(agents), "AGENTS.md is a regular file");
  assertTrue(
    readFileSync(agents).equals(readFileSync(templateAgents)),
    "AGENTS.md matches the template",
  );
  const ignore = readFileSync(join(host.directory, ".gitignore"), "utf8").split("\n");
  for (const entry of [
    "/.devboard",
    "/.omp/commands",
    "/.omp/extensions",
    ...MANAGED_SKILLS.map((name) => `/.omp/skills/${name}`),
  ]) {
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

  step("owning managed skills on every install");
  const skills = join(host.directory, ".omp", "skills");
  await writeFile(join(skills, "devboard-ui-ux", "SKILL.md"), "tampered\n");
  await writeFile(join(skills, "devboard-ui-ux", "extra.md"), "extra\n");
  await mkdir(join(skills, "devboard-retired"), { recursive: true });
  await writeFile(
    join(skills, "devboard-retired", "SKILL.md"),
    "---\nname: devboard-retired\ndescription: retired\n---\n",
  );
  await mkdir(join(skills, "house-style"), { recursive: true });
  await writeFile(
    join(skills, "house-style", "SKILL.md"),
    "---\nname: house-style\ndescription: host owned\n---\n",
  );
  const hostSkill = readFileSync(join(skills, "house-style", "SKILL.md"));
  const skillTarget = join(root, "skill-target");
  await mkdir(skillTarget, { recursive: true });
  await writeFile(join(skillTarget, "sentinel.md"), "outside\n");
  await rm(join(skills, "devboard-restful-api-implementation"), { recursive: true, force: true });
  await symlink(skillTarget, join(skills, "devboard-restful-api-implementation"));
  const owned = launcher(["install", "--host", host.directory], oldEnv);
  assertTrue(owned.code === 0, `ownership install failed:\n${owned.stdout}\n${owned.stderr}`);
  for (const name of MANAGED_SKILLS) {
    assertTrue(
      treesMatch(
        join(installedPackage(prefix), "omp", "skills", name),
        join(skills, name),
      ),
      `.omp/skills/${name} is restored to package bytes`,
    );
  }
  assertTrue(
    !existsSync(join(skills, "devboard-ui-ux", "extra.md")),
    "an extra file inside a shipped skill directory is removed",
  );
  assertTrue(
    !existsSync(join(skills, "devboard-retired")),
    "a marked directory the package does not ship is pruned",
  );
  assertTrue(
    !isSymlink(join(skills, "devboard-restful-api-implementation")),
    "a symlinked managed skill becomes a real directory",
  );
  assertEquals(
    readdirSync(skillTarget),
    ["sentinel.md"],
    "the symlinked skill target is never written",
  );
  assertTrue(
    readFileSync(join(skills, "house-style", "SKILL.md")).equals(hostSkill),
    "an unmarked host skill keeps its bytes",
  );
  step("ownership restored a tampered skill, pruned a retired one, and kept house-style");

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

  step("carrying the whole .tmp across a symlinked prefix");
  const shared = join(root, "shared-harness");
  const seeded: Array<[string, string]> = [
    ["providers/credentials.json", `${JSON.stringify({ version: 1, subscriptions: [] })}\n`],
    ["flow/repo/session/session.json", `${JSON.stringify({ id: "session" })}\n`],
    ["coach/settings.json", `${JSON.stringify({ cadenceMinutes: 5 })}\n`],
    ["scout/0123456789abcdef01234567/state.json", `${JSON.stringify({ enabled: true })}\n`],
    ["watchdog/settings.json", `${JSON.stringify({ intervalSeconds: 60 })}\n`],
    ["state/host.json", `${JSON.stringify({ host: "carry" })}\n`],
    ["journal/0123456789abcdef01234567.jsonl", `${JSON.stringify({ event: "started" })}\n`],
  ];
  for (const [path, text] of seeded) {
    await mkdir(dirname(join(shared, ".tmp", path)), { recursive: true });
    await writeFile(join(shared, ".tmp", path), text);
  }
  await writeFile(join(shared, ".tmp", "install.json"), `${JSON.stringify({ version: OLD })}\n`);
  await mkdir(join(shared, ".tmp", "serving", "snapshot"), { recursive: true });
  await writeFile(join(shared, ".tmp", "serving", "snapshot", "index.html"), "old snapshot\n");
  await mkdir(join(shared, ".tmp", "updates", "download-old"), { recursive: true });
  await writeFile(join(shared, ".tmp", "updates", "download-old", "old.tgz"), "old download\n");
  await writeFile(join(shared, ".tmp", "dashboard.log"), "old log\n");
  const carryHost = await makeHost(root, "carry");
  await symlink(shared, join(carryHost.directory, ".devboard"));
  const carried = launcher(["install", "--host", carryHost.directory], oldEnv);
  startedHosts.push(carryHost.directory);
  assertTrue(carried.code === 0, `carried install failed:\n${carried.stdout}\n${carried.stderr}`);
  const carryPrefix = join(carryHost.directory, ".devboard");
  assertTrue(!isSymlink(carryPrefix), "a carried .devboard is a real directory");
  for (const [path, text] of seeded) {
    const target = join(carryPrefix, ".tmp", path);
    assertTrue(existsSync(target), `carried .tmp/${path} is missing`);
    assertEquals(readFileSync(target, "utf8"), text, `carried .tmp/${path} is byte-identical`);
  }
  assertEquals(
    installState(carryPrefix).host,
    carryHost.directory,
    "install writes its own state beside the carried trees",
  );
  for (const path of ["serving/snapshot/index.html", "updates/download-old"]) {
    assertTrue(
      !existsSync(join(carryPrefix, ".tmp", path)),
      `disposable .tmp/${path} is not carried`,
    );
  }
  assertTrue(
    !readFileSync(join(carryPrefix, ".tmp", "dashboard.log"), "utf8").includes("old log"),
    "the old dashboard log is not carried",
  );
  assertEquals(
    readdirSync(carryHost.directory).filter((name) => name.startsWith(".devboard-install-")),
    [],
    "install removes its staging directory",
  );
  step("carried provider keys, flow, coach, scout, watchdog, state, and journal");

  step("installing into a fresh host without a linked checkout");
  const fresh = await makeHost(root, "fresh");
  assertTrue(
    !existsSync(join(fresh.directory, ".devboard")),
    "the fresh host starts without a .devboard directory",
  );
  const freshInstall = launcher(["install", "--host", fresh.directory], oldEnv);
  startedHosts.push(fresh.directory);
  assertTrue(
    freshInstall.code === 0,
    `fresh install failed:\n${freshInstall.stdout}\n${freshInstall.stderr}`,
  );
  const freshPrefix = join(fresh.directory, ".devboard");
  const freshHarness = installedPackage(freshPrefix);
  for (const name of ["prompts", "extensions", "lib"]) {
    assertTrue(
      treesMatch(join(freshHarness, name), join(freshPrefix, name)),
      `.devboard/${name} matches the installed package`,
    );
  }
  for (const name of MANAGED_SKILLS) {
    assertTrue(
      treesMatch(
        join(freshHarness, "omp", "skills", name),
        join(fresh.directory, ".omp", "skills", name),
      ),
      `.omp/skills/${name} arrived in the fresh host`,
    );
  }
  step(`fresh install wrote ${MANAGED_SKILLS.join(", ")}`);
  const installedPrompt = join(freshPrefix, "prompts", "implement-issue.md");
  assertTrue(
    existsSync(installedPrompt) && readFileSync(installedPrompt, "utf8").length > 0,
    ".devboard/prompts/implement-issue.md is missing or empty",
  );
  // The shipped prompts invoke this exact path; it imports `../lib/*.ts` from
  // the installed prefix, so running it proves the whole tree arrived.
  const installedWrapper = join(freshPrefix, "scripts", "forge-auth.ts");
  const wrapperHelp = Bun.spawnSync({
    cmd: ["bun", installedWrapper, "--help"],
    cwd: fresh.directory,
    stdout: "pipe",
    stderr: "pipe",
  });
  assertTrue(
    wrapperHelp.exitCode === 0,
    `the installed forge-auth wrapper does not run:\n${wrapperHelp.stderr.toString()}`,
  );
  // The probe's specifier is the installed host's path, not a module this
  // file can import statically: it exercises the wrapper's own resolution.
  const extensionLoad = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `await import(${JSON.stringify(join(fresh.directory, ".omp", "extensions", "implement-next-epic.ts"))});`,
    ],
    cwd: fresh.directory,
    stdout: "pipe",
    stderr: "pipe",
  });
  assertTrue(
    extensionLoad.exitCode === 0,
    `the installed omp extension does not load:\n${extensionLoad.stderr.toString()}`,
  );
  step("fresh install serves prompts, extensions, and their lib imports");

  step("re-copying prompts and extensions on update");
  await writeFile(join(freshPrefix, "prompts", "implement-issue.md"), "stale prompt\n");
  await writeFile(join(freshPrefix, "extensions", "implement-next-epic.ts"), "stale extension\n");
  await writeFile(
    join(fresh.directory, ".omp", "skills", "devboard-single-responsibility-principle", "SKILL.md"),
    "stale skill\n",
  );
  const freshUpdate = launcher(["update", "--host", fresh.directory], newEnv);
  assertTrue(freshUpdate.code === 0, `fresh update failed:\n${freshUpdate.stderr}`);
  assertEquals(installedVersion(freshPrefix), NEW, "the fresh host updates");
  for (const name of ["prompts", "extensions", "lib"]) {
    assertTrue(
      treesMatch(join(installedPackage(freshPrefix), name), join(freshPrefix, name)),
      `update re-copies .devboard/${name} from the installed package`,
    );
  }
  assertTrue(
    readFileSync(join(installedPackage(freshPrefix), "scripts", "forge-auth.ts")).equals(
      readFileSync(join(freshPrefix, "scripts", "forge-auth.ts")),
    ),
    "update re-copies .devboard/scripts/forge-auth.ts from the installed package",
  );
  for (const name of MANAGED_SKILLS) {
    assertTrue(
      treesMatch(
        join(installedPackage(freshPrefix), "omp", "skills", name),
        join(fresh.directory, ".omp", "skills", name),
      ),
      `update re-copies .omp/skills/${name} from the installed package`,
    );
  }

  step("reinstalling over a tracked nested wrapper");
  const nestedTracked = join(host.directory, ".omp", "commands", "custom", "deploy.md");
  await mkdir(join(host.directory, ".omp", "commands", "custom"), { recursive: true });
  await writeFile(nestedTracked, "host customization\n");
  git(["add", "-f", ".omp/commands/custom/deploy.md"]);
  git(["commit", "-q", "-m", "track nested wrapper"]);

  step("reinstalling");
  const reinstalled = launcher(["install", "--host", host.directory], oldEnv);
  assertTrue(reinstalled.code === 0, `reinstall failed: ${reinstalled.stderr}`);
  assertEquals(installedVersion(prefix), OLD, "reinstall keeps the version");
  assertTrue(existsSync(join(prefix, ".tmp")), "reinstall keeps .tmp");
  assertEquals(dashboardsFor(host.directory).length, 1, "reinstall leaves one dashboard");
  assertTrue(existsSync(nestedTracked), "reinstall preserves a tracked nested wrapper");
  assertEquals(
    readFileSync(nestedTracked, "utf8"),
    "host customization\n",
    "reinstall leaves the tracked nested wrapper byte-identical",
  );
  const nestedStatus = Bun.spawnSync({
    cmd: ["git", "-C", host.directory, "status", "--short"],
    stdout: "pipe",
  }).stdout.toString();
  assertTrue(
    !nestedStatus.split("\n").some((line) => line.includes("D .omp/commands/custom/deploy.md")),
    "reinstall reports no deletion of the tracked nested wrapper",
  );

  step("updating without a restart");
  const pidBefore = Number(installState(prefix).pid);
  const updated = launcher(["update", "--host", host.directory], newEnv);
  assertTrue(updated.code === 0, `update failed: ${updated.stderr}`);
  assertTrue(updated.stdout.includes(OLD) && updated.stdout.includes(NEW), "update prints both versions");
  assertEquals(installedVersion(prefix), NEW, "update installs the newer version");
  assertTrue(processRunning(pidBefore), "update does not restart the dashboard");
  assertEquals(dashboardsFor(host.directory).length, 1, "update leaves one dashboard");
  assertTrue(existsSync(nestedTracked), "update preserves a tracked nested wrapper");
  assertEquals(
    readFileSync(nestedTracked, "utf8"),
    "host customization\n",
    "update leaves the tracked nested wrapper byte-identical",
  );
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
  for (const name of MANAGED_SKILLS) {
    assertTrue(
      treesMatch(
        join(installedPackage(legacyPrefix), "omp", "skills", name),
        join(legacyHost.directory, ".omp", "skills", name),
      ),
      `migration writes .omp/skills/${name}`,
    );
  }

  step("doctor passing");
  const doctor = launcher(["doctor", "--host", host.directory], newEnv);
  assertTrue(doctor.code === 0, `doctor failed:\n${doctor.stdout}\n${doctor.stderr}`);
  for (const line of doctor.stdout.trim().split("\n")) {
    assertTrue(line.startsWith("PASS "), `unexpected doctor line: ${line}`);
  }
  const skillLines = doctor.stdout.split("\n").filter((line) => line.startsWith("PASS skills:"));
  assertTrue(skillLines.length === 1, `doctor did not print one PASS skills line:\n${doctor.stdout}`);
  for (const name of MANAGED_SKILLS) {
    assertTrue(
      skillLines[0]?.includes(name) ?? false,
      `doctor does not report ${name}:\n${skillLines[0]}`,
    );
  }
  step("doctor passes with the managed skills and the unmarked host skill");

  step("doctor failing on one differing skill byte");
  await writeFile(join(skills, "devboard-ui-ux", "SKILL.md"), "tampered\n");
  expectFailure(launcher(["doctor", "--host", host.directory], newEnv), "skills");
  await writeFile(
    join(skills, "devboard-ui-ux", "SKILL.md"),
    readFileSync(join(installedPackage(prefix), "omp", "skills", "devboard-ui-ux", "SKILL.md")),
  );

  step("doctor failing on a missing harness tree");
  await rm(join(prefix, "prompts"), { recursive: true, force: true });
  expectFailure(launcher(["doctor", "--host", host.directory], newEnv), "harness files");

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

  step("the source checkout never installs and restarts only from a publish request");
  assertTrue(
    !existsSync(join(repoRoot, ".devboard", "node_modules", "@dsdenes", "devboard")),
    "the canonical source checkout has no installed harness package",
  );
  const sourcePort = await freePort();
  const sourceState = join(root, "source-state");
  await mkdir(sourceState, { recursive: true });
  const source = spawn("bun", ["run", "server/index.ts"], {
    cwd: join(repoRoot, ".devboard"),
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(sourcePort),
      ADRS_DIR: join(repoRoot, "adrs"),
      REPO_DIR: repoRoot,
      GOAL_FILE: join(repoRoot, "GOAL.md"),
      STATE_DIR: sourceState,
      DEVBOARD_RELEASE_DIR: newRelease,
      DEVBOARD_UPDATE_INTERVAL_MS: "300",
    },
  });
  const sourcePid = source.pid ?? 0;
  source.unref();
  try {
    await waitFor(
      () => (httpStatus(sourcePort) === 200 ? true : undefined),
      "the source dashboard",
    );
    const first = await readVersion(sourcePort);
    await Bun.sleep(900);
    const second = await readVersion(sourcePort);
    assertEquals(
      [second.running, second.installed, second.stale, second.source],
      [first.running, first.installed, false, true],
      "the source checkout reports the source version a restart would load",
    );
    assertTrue(second.replacement === undefined, "the source checkout never reports a replacement");
    assertTrue(
      !existsSync(join(repoRoot, ".devboard", "node_modules", "@dsdenes", "devboard")),
      "the update check installed a harness package into the source checkout",
    );
    assertTrue(processRunning(sourcePid), "the source server is not restarted by the update check");
    assertEquals(
      dashboardsFor(repoRoot).filter((entry) => entry.port === sourcePort).length,
      1,
      "the source dashboard keeps one process, because only a publish request restarts it",
    );
    step("the canonical checkout refused install and never restarted on the update check");
  } finally {
    try {
      process.kill(sourcePid, "SIGTERM");
    } catch {
      // Already exited.
    }
  }

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
