#!/usr/bin/env node
/**
 * @dsdenes/devboard launcher.
 *
 * Bootstrap only: this package resolves and installs the private harness
 * package, keeps a host's npm prefix and wrapper copies in sync, and reports
 * diagnostics. The harness server, client, prompts, and omp wrappers live in
 * the separately released @dsdenes/devboard-harness tarball and never in this
 * package.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createWriteStream,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_PACKAGE = "@dsdenes/devboard-harness";
const HARNESS_SCOPE = "@dsdenes";
const RELEASE_REPO = process.env.DEVBOARD_RELEASE_REPO ?? "dsdenes/devboard";
const RELEASE_PREFIX = "devboard-harness-";
const UPDATE_INTERVAL_MS = 60_000;
const DEFAULT_PORT = 8080;
const START_TIMEOUT_MS = 30_000;

const usage = `Usage: devboard <command> [options]

Commands:
  install   Install or refresh the harness for a host and start its dashboard.
  update    Install the newest harness release without touching the dashboard.
  doctor    Check one host installation and print one PASS or FAIL line per check.

Options:
  --host <path>   Host repository root; defaults to the git root of the cwd.
  --port <n>      Dashboard port for install; defaults to the existing or first free port.
  -h, --help      Show this text.

Examples:
  npx @dsdenes/devboard install
  npx @dsdenes/devboard update
  npx @dsdenes/devboard doctor`;

function ownVersion() {
  try {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const parsed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function redact(text) {
  let value = String(text ?? "");
  for (const name of ["NPM_TOKEN", "NODE_AUTH_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    const secret = process.env[name];
    if (secret !== undefined && secret.length >= 8) value = value.split(secret).join("<redacted>");
  }
  return value
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "<redacted>")
    .replace(/npm_[A-Za-z0-9]{20,}/g, "<redacted>");
}

function firstLine(text) {
  const line = redact(text).trim().split("\n")[0] ?? "";
  return line.length > 0 ? line : "no output";
}

class LauncherError extends Error {}

function safeCwd(cwd) {
  if (cwd !== undefined) return cwd;
  try {
    const current = process.cwd();
    return existsSync(current) ? current : homedir();
  } catch {
    return homedir();
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: safeCwd(options.cwd),
    env: { ...process.env, ...options.env, GH_PROMPT_DISABLED: "1" },
    encoding: "utf8",
    timeout: options.timeoutMs ?? 120_000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function mustRun(command, args, description, options = {}) {
  const result = run(command, args, options);
  if (result.code !== 0) {
    throw new LauncherError(`${description}: ${firstLine(result.stderr || result.stdout)}`);
  }
  return result.stdout;
}

function parseArgs(argv) {
  const options = { command: undefined, host: undefined, port: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "--host") options.host = argv[++index];
    else if (argument === "--port") options.port = argv[++index];
    else if (argument.startsWith("-")) throw new LauncherError(`unknown option: ${argument}`);
    else if (options.command === undefined) options.command = argument;
    else throw new LauncherError(`unexpected argument: ${argument}`);
  }
  return options;
}

function resolveHost(option) {
  if (typeof option === "string" && option.length > 0) return resolve(option);
  const top = run("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() });
  if (top.code === 0 && top.stdout.trim().length > 0) return top.stdout.trim();
  return process.cwd();
}

async function realOrUndefined(path) {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

function lstatOrUndefined(path) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function readDashboardProcesses(host) {
  const wanted = resolve(host);
  const found = [];
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let cmdline;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    } catch {
      continue;
    }
    if (!cmdline.includes("server/index.ts")) continue;
    const env = readEnviron(pid);
    if (env.REPO_DIR === undefined || resolve(env.REPO_DIR) !== wanted) continue;
    const port = Number(env.PORT ?? "");
    found.push({ pid, port: Number.isInteger(port) && port > 0 ? port : undefined, cmdline, env });
  }
  return found;
}

function readEnviron(pid) {
  const values = {};
  try {
    for (const entry of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
      const split = entry.indexOf("=");
      if (split > 0) values[entry.slice(0, split)] = entry.slice(split + 1);
    }
  } catch {
    // The process exited while it was being inspected.
  }
  return values;
}

function processRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms) {
  await new Promise((settle) => setTimeout(settle, ms));
}

async function stopDashboardProcesses(host) {
  const stopped = [];
  for (const dashboard of readDashboardProcesses(host)) {
    try {
      process.kill(dashboard.pid, "SIGTERM");
    } catch {
      continue;
    }
    stopped.push(dashboard.pid);
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && stopped.some(processRunning)) await sleep(100);
  for (const pid of stopped) {
    if (!processRunning(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It exited between the check and the signal.
    }
  }
  return stopped;
}

function portFree(port) {
  return new Promise((settle) => {
    const probe = createServer();
    probe.once("error", () => settle(false));
    probe.once("listening", () => probe.close(() => settle(true)));
    probe.listen(port, "127.0.0.1");
  });
}

async function choosePort(preferred) {
  if (Number.isInteger(preferred) && preferred > 0 && (await portFree(preferred))) return preferred;
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + 200; port += 1) {
    if (await portFree(port)) return port;
  }
  throw new LauncherError("no free port between 8080 and 8279");
}

async function httpOk(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "HEAD",
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHttp(port, timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await httpOk(port)) return true;
    await sleep(200);
  }
  return false;
}

function releaseSourceFromEnv() {
  if (process.env.DEVBOARD_RELEASE_DIR !== undefined && process.env.DEVBOARD_RELEASE_DIR.length > 0) {
    return { kind: "dir", directory: resolve(process.env.DEVBOARD_RELEASE_DIR) };
  }
  return { kind: "gh", repo: RELEASE_REPO };
}

function tarballName(version) {
  return `${RELEASE_PREFIX}${version}.tgz`;
}

function checksumName(version) {
  return `${tarballName(version)}.sha256`;
}

function newerVersion(candidate, installed) {
  const left = candidate.split("-")[0].split(".").map(Number);
  const right = installed.split("-")[0].split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    if (a !== b) return a > b;
  }
  return false;
}

function versionFromTarball(name) {
  const match = new RegExp(`^(?:dsdenes-)?${RELEASE_PREFIX}(.+)\\.tgz$`).exec(name);
  return match?.[1];
}

async function latestRelease(source) {
  if (source.kind === "dir") return directoryRelease(source.directory);
  return githubRelease(source.repo);
}

async function directoryRelease(directory) {
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    throw new LauncherError(
      `release directory is unreadable: ${redact(error.message ?? String(error))}`,
    );
  }
  const tarballs = names
    .filter((name) => name.endsWith(".tgz") && versionFromTarball(name) !== undefined)
    .map((name) => ({ name, version: versionFromTarball(name) }))
    .sort((left, right) => (newerVersion(left.version, right.version) ? -1 : 1));
  if (tarballs.length === 0) throw new LauncherError("no release tarball available");
  const newest = tarballs[0];
  const checksum = `${newest.name}.sha256`;
  if (!existsSync(join(directory, checksum))) {
    throw new LauncherError(`release checksum is missing: ${checksum}`);
  }
  return {
    version: newest.version,
    tag: `v${newest.version}`,
    assets: [{ name: newest.name }, { name: checksum }],
  };
}

function githubRelease(repo) {
  const parsed = JSON.parse(mustRun("gh", ["api", `repos/${repo}/releases/latest`], "gh release"));
  if (typeof parsed.tag_name !== "string") throw new LauncherError("the latest release has no tag");
  const assets = Array.isArray(parsed.assets)
    ? parsed.assets
        .filter((asset) => asset !== null && typeof asset === "object" && typeof asset.name === "string")
        .map((asset) => ({ name: asset.name, id: asset.id, size: asset.size }))
    : [];
  return { version: parsed.tag_name.replace(/^v/, ""), tag: parsed.tag_name, assets };
}

async function downloadRelease(source, release, destination) {
  const tarball = join(destination, tarballName(release.version));
  const checksum = join(destination, checksumName(release.version));
  const names = new Set(release.assets.map((asset) => asset.name));
  if (!names.has(basename(tarball)) || !names.has(basename(checksum))) {
    throw new LauncherError(`release ${release.tag} lacks a tarball or checksum asset`);
  }
  await mkdir(destination, { recursive: true });
  if (source.kind === "dir") {
    await cp(join(source.directory, basename(tarball)), tarball);
    await cp(join(source.directory, basename(checksum)), checksum);
    return { tarball, checksum };
  }
  for (const name of [basename(tarball), basename(checksum)]) {
    mustRun(
      "gh",
      ["release", "download", release.tag, "--repo", source.repo, "--pattern", name,
        "--dir", destination, "--clobber"],
      `gh release download ${name}`,
      { timeoutMs: 10 * 60_000 },
    );
  }
  return { tarball, checksum };
}

function parseChecksum(text) {
  return /^([0-9a-fA-F]{64})\b/.exec(text.trim())?.[1]?.toLowerCase();
}

function fileDigest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function verifyChecksum(tarball, checksumFile) {
  const expected = parseChecksum(readFileSync(checksumFile, "utf8"));
  if (expected === undefined) throw new LauncherError(`unreadable checksum: ${basename(checksumFile)}`);
  const actual = fileDigest(tarball);
  if (actual !== expected) {
    throw new LauncherError(
      `checksum mismatch for ${basename(tarball)}: expected ${expected}, got ${actual}`,
    );
  }
}

function harnessDir(prefix) {
  return join(prefix, "node_modules", HARNESS_SCOPE, "devboard-harness");
}

function installedVersion(prefix) {
  try {
    const parsed = JSON.parse(readFileSync(join(harnessDir(prefix), "package.json"), "utf8"));
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

async function writePrefixManifest(prefix, version) {
  const path = join(prefix, "package.json");
  let existing = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed !== null && typeof parsed === "object") existing = parsed;
  } catch {
    existing = {};
  }
  const dependencies =
    existing.dependencies !== null && typeof existing.dependencies === "object"
      ? { ...existing.dependencies }
      : {};
  dependencies[HARNESS_PACKAGE] = version;
  await writeFile(
    path,
    `${JSON.stringify(
      {
        ...existing,
        name: typeof existing.name === "string" ? existing.name : "devboard-host",
        private: true,
        dependencies,
      },
      null,
      2,
    )}\n`,
  );
}

async function installTarball(prefix, tarball, version) {
  const updates = join(prefix, ".tmp", "updates");
  await mkdir(updates, { recursive: true });
  const staging = join(updates, `stage-${version}-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  try {
    mustRun(
      "npm",
      ["install", "--prefix", staging, "--ignore-scripts", "--no-audit", "--no-fund",
        "--no-save", tarball],
      "npm install",
      { cwd: staging, timeoutMs: 10 * 60_000 },
    );
    const staged = harnessDir(staging);
    const stagedVersion = installedVersion(staging);
    if (stagedVersion !== version) {
      throw new LauncherError(
        `npm installed ${stagedVersion ?? "no version"}, expected ${version}`,
      );
    }
    const parent = join(prefix, "node_modules", HARNESS_SCOPE);
    await mkdir(parent, { recursive: true });
    const target = join(parent, "devboard-harness");
    const backup = join(updates, `previous-${Date.now()}-${randomUUID()}`);
    let moved = false;
    if (existsSync(target)) {
      await rename(target, backup);
      moved = true;
    }
    try {
      await rename(staged, target);
    } catch (error) {
      if (moved) await rename(backup, target).catch(() => undefined);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
    return target;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function installRelease(source, release, prefix, stateDir) {
  const downloadDir = join(stateDir, "updates", `download-${randomUUID()}`);
  try {
    const files = await downloadRelease(source, release, downloadDir);
    verifyChecksum(files.tarball, files.checksum);
    const target = await installTarball(prefix, files.tarball, release.version);
    await writePrefixManifest(prefix, release.version);
    return target;
  } finally {
    await rm(downloadDir, { recursive: true, force: true });
  }
}

function journalKey(repoDir) {
  return createHash("sha256").update(repoDir).digest("hex").slice(0, 24);
}

async function captureTemporaryState(prefix, host) {
  const captured = [];
  const stateDir = join(prefix, ".tmp");
  const state = join(stateDir, "state");
  if (existsSync(state)) {
    for (const name of await readdir(state)) {
      const path = join(state, name);
      if (existsSync(path)) captured.push({ path: join("state", name), data: await readFile(path) });
    }
  }
  const journal = join(stateDir, "journal");
  const key = journalKey(resolve(host));
  if (existsSync(journal)) {
    for (const name of await readdir(journal)) {
      if (!name.startsWith(key)) continue;
      const path = join(journal, name);
      if (existsSync(path)) captured.push({ path: join("journal", name), data: await readFile(path) });
    }
  }
  const install = join(stateDir, "install.json");
  if (existsSync(install)) captured.push({ path: "install.json", data: await readFile(install) });
  return captured;
}

async function restoreTemporaryState(prefix, captured) {
  for (const entry of captured) {
    const path = join(prefix, ".tmp", entry.path);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, entry.data);
  }
}

async function replacePathWithDirectory(path) {
  const info = lstatOrUndefined(path);
  if (info === undefined) {
    await mkdir(path, { recursive: true });
    return;
  }
  if (info.isDirectory()) return;
  if (info.isSymbolicLink()) {
    await unlink(path);
    await mkdir(path, { recursive: true });
    return;
  }
  throw new LauncherError(`${path} exists and is not a directory`);
}

async function ensureFixedDirectory(path) {
  const info = lstatOrUndefined(path);
  if (info === undefined) {
    await mkdir(path, { recursive: true });
    return;
  }
  if (info.isDirectory()) return;
  if (info.isSymbolicLink()) {
    await unlink(path);
    await mkdir(path, { recursive: true });
    return;
  }
  throw new LauncherError(`${path} exists and is not a directory`);
}

function trackedPaths(host, paths) {
  const result = run("git", ["-C", host, "ls-files", "-z", "--", ...paths], { cwd: host });
  if (result.code !== 0) return new Set();
  return new Set(
    result.stdout
      .split("\0")
      .filter((path) => path.length > 0)
      .map((path) => resolve(host, path)),
  );
}

async function syncTree(source, destination, skip) {
  await ensureFixedDirectory(destination);
  const present = new Set();
  for (const entry of await readdir(source, { withFileTypes: true })) {
    present.add(entry.name);
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (skip?.has(to) ?? false) continue;
    if (entry.isDirectory()) {
      await syncTree(from, to, skip);
      continue;
    }
    const target = lstatOrUndefined(to);
    if (target?.isDirectory()) await rm(to, { recursive: true, force: true });
    else if (target?.isSymbolicLink()) await unlink(to);
    await cp(from, to);
  }
  for (const name of await readdir(destination)) {
    const to = join(destination, name);
    if (present.has(name)) continue;
    if (skip?.has(to) ?? false) continue;
    await rm(to, { recursive: true, force: true });
  }
}

async function syncWrappers(host, harness, skip) {
  for (const name of ["commands", "extensions"]) {
    await syncTree(join(harness, "omp", name), join(host, ".omp", name), skip);
  }
}

async function syncAgents(host, harness, skip) {
  const source = join(harness, "templates", "host-AGENTS.md");
  const target = join(host, "AGENTS.md");
  const info = lstatOrUndefined(target);
  if (info === undefined) {
    if (skip?.has(target) ?? false) return "tracked-missing";
    await cp(source, target);
    return "installed";
  }
  if (info.isSymbolicLink()) {
    await unlink(target);
    await cp(source, target);
    return "installed";
  }
  if (!info.isFile()) return "unchanged";
  const current = readFileSync(target);
  const template = readFileSync(source);
  return current.equals(template) ? "current" : "drift";
}

async function ensureGitignore(host) {
  const path = join(host, ".gitignore");
  let source = "";
  try {
    source = readFileSync(path, "utf8");
  } catch {
    source = "";
  }
  const lines = source.split("\n");
  const wanted = ["/.devboard", "/.omp/commands", "/.omp/extensions"];
  const missing = wanted.filter((entry) => !lines.includes(entry));
  if (missing.length === 0) return [];
  const prefix = source.length > 0 && !source.endsWith("\n") ? `${source}\n` : source;
  await writeFile(path, `${prefix}${missing.map((entry) => `${entry}\n`).join("")}`);
  return missing;
}

function findBinary(name) {
  const path = process.env.PATH ?? "";
  for (const directory of path.split(":")) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function startDashboard(host, harness, port, stateDir) {
  const bun = findBinary("bun");
  if (bun === undefined) throw new LauncherError("bun is required to start the dashboard");
  const log = join(stateDir, "dashboard.log");
  await mkdir(stateDir, { recursive: true });
  const fd = openSync(log, "a");
  const child = spawn(bun, [join(harness, "server", "index.ts")], {
    // Keep the dashboard out of the replaceable package directory: an update
    // renames and removes it, leaving a deleted cwd that child processes
    // cannot start from.
    cwd: host,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      HOST: process.env.HOST ?? "127.0.0.1",
      PORT: String(port),
      ADRS_DIR: join(host, "adrs"),
      REPO_DIR: host,
      GOAL_FILE: join(host, "GOAL.md"),
      STATIC_DIR: join(harness, "dist"),
      STATE_DIR: stateDir,
      AGENT_COMMAND: process.env.AGENT_COMMAND ?? "omp acp",
    },
  });
  closeSync(fd);
  child.unref();
  if (!(await waitForHttp(port))) {
    let tail = "";
    try {
      tail = readFileSync(log, "utf8").split("\n").slice(-8).join("\n");
    } catch {
      tail = "";
    }
    throw new LauncherError(
      `the dashboard did not answer on port ${port}${tail.length > 0 ? `: ${firstLine(tail)}` : ""}`,
    );
  }
  return child.pid;
}

function installStatePath(prefix) {
  return join(prefix, ".tmp", "install.json");
}

function readInstallState(prefix) {
  try {
    const parsed = JSON.parse(readFileSync(installStatePath(prefix), "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeInstallState(prefix, state) {
  await mkdir(join(prefix, ".tmp"), { recursive: true });
  await writeFile(installStatePath(prefix), `${JSON.stringify(state, null, 2)}\n`);
}

function isDashboardFrom(pid, harness) {
  const entry = processInfo(pid);
  if (entry === undefined) return false;
  const script = join(harness, "server", "index.ts");
  return entry.cmdline.includes(script);
}

function processInfo(pid) {
  try {
    return {
      cmdline: readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim(),
      env: readEnviron(pid),
    };
  } catch {
    return undefined;
  }
}

function canonicalSource(host) {
  const prefix = join(host, ".devboard");
  const info = lstatOrUndefined(prefix);
  if (info === undefined || info.isSymbolicLink()) return false;
  try {
    const parsed = JSON.parse(readFileSync(join(prefix, "package.json"), "utf8"));
    if (parsed.name !== HARNESS_PACKAGE) return false;
  } catch {
    return false;
  }
  const tracked = run("git", ["-C", host, "ls-files", "--error-unmatch", ".devboard/package.json"], {
    cwd: host,
  });
  return tracked.code === 0;
}

async function ensureOneDashboard(host, harness, version, requestedPort) {
  const prefix = join(host, ".devboard");
  const stateDir = join(prefix, ".tmp");
  const state = readInstallState(prefix);
  const dashboards = readDashboardProcesses(host);
  if (dashboards.length > 0) {
    const kept = dashboards.filter(
      (dashboard) =>
        dashboard.pid === state.pid &&
        processRunning(dashboard.pid) &&
        dashboard.port !== undefined &&
        isDashboardFrom(dashboard.pid, harness),
    );
    for (const dashboard of dashboards) {
      if (kept.includes(dashboard)) continue;
      try {
        process.kill(dashboard.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    if (
      kept.length === 1 &&
      state.version === version &&
      kept[0].port !== undefined &&
      (await httpOk(kept[0].port))
    ) {
      await writeInstallState(prefix, {
        ...state,
        host,
        version,
        harness,
        port: kept[0].port,
        pid: kept[0].pid,
        url: `http://127.0.0.1:${kept[0].port}/`,
        stateDir,
      });
      return { port: kept[0].port, pid: kept[0].pid, reused: true };
    }
    await stopDashboardProcesses(host);
  }
  const preferred = Number.isInteger(requestedPort)
    ? requestedPort
    : Number.isInteger(state.port)
      ? state.port
      : undefined;
  const port = await choosePort(preferred);
  const pid = await startDashboard(host, harness, port, stateDir);
  await writeInstallState(prefix, {
    version,
    host,
    harness,
    port,
    pid,
    url: `http://127.0.0.1:${port}/`,
    stateDir,
    installedAt: new Date().toISOString(),
  });
  const remaining = readDashboardProcesses(host);
  if (remaining.length !== 1 || remaining[0].pid !== pid) {
    await stopDashboardProcesses(host);
    throw new LauncherError(`expected one dashboard process, found ${remaining.length}`);
  }
  return { port, pid, reused: false };
}

async function installCommand(options) {
  const host = resolveHost(options.host);
  if (canonicalSource(host)) {
    throw new LauncherError(
      `${host} is the canonical harness source checkout; install runs in a host project instead`,
    );
  }
  const source = releaseSourceFromEnv();
  const release = await latestRelease(source);
  const prefix = join(host, ".devboard");
  const skip = trackedPaths(host, [".omp/commands", ".omp/extensions", "AGENTS.md"]);
  const trackedHarness = [...trackedPaths(host, [".devboard"])].filter(
    (path) => path === prefix || path.startsWith(`${prefix}${sep}`),
  );
  if (trackedHarness.length > 0) {
    throw new LauncherError(
      `${host} tracks files under .devboard; refusing to replace a tracked harness tree`,
    );
  }
  const captured = (lstatOrUndefined(prefix)?.isSymbolicLink() ?? false)
    ? await captureTemporaryState(prefix, host)
    : [];
  await replacePathWithDirectory(prefix);
  if (captured.length > 0) await restoreTemporaryState(prefix, captured);
  await ensureFixedDirectory(join(prefix, ".tmp"));
  const harness = await installRelease(source, release, prefix, join(prefix, ".tmp"));
  await syncWrappers(host, harness, skip);
  const agents = await syncAgents(host, harness, skip);
  const ignored = await ensureGitignore(host);
  const portOption = Number(options.port);
  const dashboard = await ensureOneDashboard(
    host,
    harness,
    release.version,
    Number.isInteger(portOption) ? portOption : undefined,
  );
  console.log(`devboard: installed ${HARNESS_PACKAGE}@${release.version} in ${prefix}`);
  if (agents === "drift") {
    console.log("devboard: AGENTS.md differs from the harness template; left unchanged (drift)");
  } else if (agents === "installed") {
    console.log("devboard: installed AGENTS.md from the harness template");
  } else if (agents === "tracked-missing") {
    console.log("devboard: AGENTS.md is tracked and deleted; left absent (drift)");
  }
  if (ignored.length > 0) console.log(`devboard: added ${ignored.join(", ")} to .gitignore`);
  console.log(
    `devboard: dashboard ${dashboard.reused ? "already running" : "running"} at ` +
      `http://127.0.0.1:${dashboard.port}/ (pid ${dashboard.pid})`,
  );
}

async function updateCommand(options) {
  const host = resolveHost(options.host);
  const prefix = join(host, ".devboard");
  if (lstatOrUndefined(prefix)?.isSymbolicLink() ?? false) {
    throw new LauncherError(`${prefix} is a symlink; run install first`);
  }
  const before = installedVersion(prefix);
  if (before === null) {
    throw new LauncherError(`no harness is installed in ${prefix}; run install`);
  }
  const source = releaseSourceFromEnv();
  const release = await latestRelease(source);
  if (!newerVersion(release.version, before) && release.version !== before) {
    // An older latest release is still installed as asked, never downgraded.
    console.log(`devboard: installed ${before}; latest release is ${release.version}`);
    return;
  }
  const harness = await installRelease(source, release, prefix, join(prefix, ".tmp"));
  const skip = trackedPaths(host, [".omp/commands", ".omp/extensions"]);
  await syncWrappers(host, harness, skip);
  console.log(`devboard: harness ${before} -> ${release.version}`);
  console.log("devboard: the dashboard keeps running; reload it to restart on the new version");
}

function recursiveFiles(directory, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...recursiveFiles(join(directory, entry.name), name));
    else files.push(name);
  }
  return files.sort();
}

function wrapperMismatches(host, harness) {
  const failures = [];
  const drift = [];
  const tracked = trackedPaths(host, [".omp/commands", ".omp/extensions"]);
  for (const name of ["commands", "extensions"]) {
    const expectedRoot = join(harness, "omp", name);
    const actualRoot = join(host, ".omp", name);
    let expected;
    let actual;
    try {
      expected = recursiveFiles(expectedRoot);
      actual = recursiveFiles(actualRoot);
    } catch {
      failures.push(`.omp/${name} is missing`);
      continue;
    }
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    for (const path of expected) {
      const target = join(actualRoot, path);
      if (actualSet.has(path) && readFileSync(join(expectedRoot, path)).equals(readFileSync(target))) {
        continue;
      }
      const label = `.omp/${name}/${path}`;
      if (tracked.has(target)) drift.push(label);
      else failures.push(label);
    }
    for (const path of actual) {
      if (expectedSet.has(path)) continue;
      const target = join(actualRoot, path);
      const label = `.omp/${name}/${path}`;
      if (tracked.has(target)) drift.push(label);
      else failures.push(label);
    }
  }
  return { failures, drift };
}

function readJournal(prefix, host) {
  const path = join(prefix, ".tmp", "journal", `${journalKey(resolve(host))}.jsonl`);
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const record = JSON.parse(line);
          return record !== null && typeof record === "object" ? [record] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function lastUpdateFailure(prefix, host) {
  const records = readJournal(prefix, host).filter(
    (record) => record.kind === "update" || record.kind === "update-error",
  );
  const last = records.at(-1);
  if (last === undefined || last.kind !== "update-error") return undefined;
  return typeof last.text === "string" ? last.text : "update failed";
}

async function readReleaseDigest(source, release, prefix) {
  await mkdir(join(prefix, ".tmp"), { recursive: true });
  const scratch = join(prefix, ".tmp", `release-check-${randomUUID()}`);
  try {
    const files = await downloadRelease(source, release, scratch);
    verifyChecksum(files.tarball, files.checksum);
    return true;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const CHECKS = [
  {
    name: "node 20+",
    run: () => {
      const major = Number(process.versions.node.split(".")[0]);
      if (major < 20) throw new LauncherError(`Node ${process.versions.node} is older than 20`);
      return `Node ${process.versions.node}`;
    },
  },
  {
    name: "bun",
    run: () => firstLine(mustRun("bun", ["--version"], "bun --version", { timeoutMs: 15_000 })),
  },
  {
    name: "npm",
    run: () => firstLine(mustRun("npm", ["--version"], "npm --version", { timeoutMs: 15_000 })),
  },
  {
    name: "git root",
    run: async (host) => {
      const top = await realOrUndefined(resolveHost(host));
      const root = run("git", ["-C", host, "rev-parse", "--show-toplevel"], { cwd: host });
      if (root.code !== 0 || root.stdout.trim().length === 0) {
        throw new LauncherError("the host is not a git work tree");
      }
      const found = await realOrUndefined(root.stdout.trim());
      if (top !== undefined && found !== undefined && top !== found) {
        throw new LauncherError(`git root is ${found}, host is ${top}`);
      }
      return found ?? root.stdout.trim();
    },
  },
  {
    name: "gh auth",
    run: () => {
      mustRun("gh", ["auth", "status"], "gh auth status", { timeoutMs: 30_000 });
      mustRun("gh", ["api", `repos/${RELEASE_REPO}`], "gh repository access", {
        timeoutMs: 30_000,
      });
      return `can read ${RELEASE_REPO}`;
    },
  },
  {
    name: "release",
    run: async (_host, prefix) => {
      const source = releaseSourceFromEnv();
      const release = await latestRelease(source);
      await readReleaseDigest(source, release, prefix);
      return `${release.tag} with a matching digest`;
    },
  },
  {
    name: "harness install",
    run: async (_host, prefix) => {
      const version = installedVersion(prefix);
      if (version === null) {
        throw new LauncherError(`${harnessDir(prefix)} is missing; run install`);
      }
      return `${HARNESS_PACKAGE}@${version}`;
    },
  },
  {
    name: "version",
    run: async (_host, prefix) => {
      const version = installedVersion(prefix);
      if (version === null) throw new LauncherError("no installed version");
      const release = await latestRelease(releaseSourceFromEnv());
      if (version !== release.version) {
        throw new LauncherError(`stale install: installed ${version}, latest ${release.version}`);
      }
      return `${version} matches the latest release`;
    },
  },
  {
    name: "omp",
    run: () => firstLine(mustRun("omp", ["--version"], "omp --version", { timeoutMs: 15_000 })),
  },
  {
    name: "omp auth",
    run: () => {
      mustRun("omp", ["usage"], "omp usage", { timeoutMs: 30_000 });
      return "authenticated probe succeeded";
    },
  },
  {
    name: "wrappers",
    run: async (host, prefix) => {
      const { failures, drift } = wrapperMismatches(host, harnessDir(prefix));
      if (failures.length > 0) {
        throw new LauncherError(`does not match the installed package: ${failures.join(", ")}`);
      }
      if (drift.length > 0) {
        return `drift: preserved tracked paths (${drift.join(", ")})`;
      }
      return "commands and extensions match the package";
    },
  },
  {
    name: "AGENTS.md",
    run: async (host, prefix) => {
      const target = join(host, "AGENTS.md");
      const info = lstatOrUndefined(target);
      if (info === undefined) throw new LauncherError("AGENTS.md is missing; run install");
      if (info.isSymbolicLink()) throw new LauncherError("AGENTS.md is a symlink; run install");
      const template = join(harnessDir(prefix), "templates", "host-AGENTS.md");
      if (!readFileSync(target).equals(readFileSync(template))) {
        return "drift: AGENTS.md differs from the template (left unchanged)";
      }
      return "current";
    },
  },
  {
    name: "dashboard",
    run: async (host) => {
      const dashboards = readDashboardProcesses(host);
      if (dashboards.length === 0) throw new LauncherError("no dashboard runs for this host");
      if (dashboards.length > 1) {
        throw new LauncherError(`${dashboards.length} dashboards run for this host`);
      }
      const [dashboard] = dashboards;
      const harness = harnessDir(join(host, ".devboard"));
      if (!isDashboardFrom(dashboard.pid, harness)) {
        throw new LauncherError(`pid ${dashboard.pid} does not run the installed package`);
      }
      if (dashboard.port === undefined || !(await httpOk(dashboard.port))) {
        throw new LauncherError("the dashboard does not answer HTTP 200");
      }
      return `pid ${dashboard.pid} on http://127.0.0.1:${dashboard.port}/`;
    },
  },
  {
    name: "no symlink",
    run: (host) => {
      const prefix = join(host, ".devboard");
      const info = lstatOrUndefined(prefix);
      if (info === undefined) throw new LauncherError(`${prefix} is missing`);
      if (info.isSymbolicLink()) throw new LauncherError(`${prefix} is a symlink`);
      for (const name of ["commands", "extensions"]) {
        const path = join(host, ".omp", name);
        if (lstatOrUndefined(path)?.isSymbolicLink() ?? false) {
          throw new LauncherError(`${path} is a symlink`);
        }
      }
      return "the harness paths are real";
    },
  },
  {
    name: "updates",
    run: (host, prefix) => {
      const failure = lastUpdateFailure(prefix, host);
      if (failure !== undefined) throw new LauncherError(failure);
      return "no recorded update failure";
    },
  },
];

async function doctorCommand(options) {
  const host = resolveHost(options.host);
  const prefix = join(host, ".devboard");
  let failures = 0;
  for (const check of CHECKS) {
    try {
      const detail = await check.run(host, prefix);
      console.log(`PASS ${check.name}: ${detail}`);
    } catch (error) {
      failures += 1;
      const detail = error instanceof Error ? error.message : String(error);
      console.log(`FAIL ${check.name}: ${firstLine(detail)}`);
    }
  }
  return failures === 0 ? 0 : 1;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`devboard: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (options.help || options.command === undefined) {
    console.log(usage);
    return options.help ? 0 : 2;
  }
  if (options.command === "install") await installCommand(options);
  else if (options.command === "update") await updateCommand(options);
  else if (options.command === "doctor") return doctorCommand(options);
  else {
    console.error(`devboard: unknown command: ${options.command}`);
    console.error(usage);
    return 2;
  }
  return 0;
}

if (process.argv.includes("--version")) {
  console.log(ownVersion());
  process.exit(0);
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`devboard: ${firstLine(error instanceof Error ? error.message : String(error))}`);
    process.exit(1);
  });
