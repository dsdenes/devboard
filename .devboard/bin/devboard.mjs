#!/usr/bin/env node
/**
 * @dsdenes/devboard command line: install, update, and doctor.
 *
 * npm is the authority for the version and artifact. The package installed
 * into a host prefix is this same package, so it carries the server, client,
 * built bundle, prompts, wrappers, and templates. When npm cannot resolve or
 * serve the artifact and a Gitea release address is configured, the release
 * tarball and its `.sha256` are used instead. The CLI never reads another
 * checkout, another local installation, or a running dashboard belonging to
 * a different host.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOST_HARNESS_PATHS,
  MANAGED_SKILL_PREFIX,
  syncHarnessTrees,
  syncHostCopies,
  syncSkills,
  syncWrappers,
} from "../lib/host-sync.mjs";

// The sync helpers moved to lib/host-sync.mjs so the dashboard updater runs the
// same code; they stay re-exported here for the launcher's tests.
export {
  HOST_HARNESS_PATHS,
  MANAGED_SKILL_PREFIX,
  syncHarnessTrees,
  syncSkills,
  syncTree,
} from "../lib/host-sync.mjs";
// The guards are exported for the same tests: the installer's refusal of the
// source checkout and its tracked-path protection.
export { canonicalSource, trackedPaths };

const PACKAGE_NAME = "@dsdenes/devboard";
const PACKAGE_SCOPE = "@dsdenes";
const PACKAGE_DIR = "devboard";
/** The package directory the old two-package layout used; migration removes it. */
const LEGACY_DIR = "devboard-harness";
const RELEASE_REPO = process.env.DEVBOARD_RELEASE_REPO ?? "dsdenes/devboard";
const RELEASE_PREFIX = "devboard-";
const UPDATE_INTERVAL_MS = 60_000;
const DEFAULT_PORT = 8080;
/** How long a freshly spawned dashboard has to answer before install fails. */
const START_TIMEOUT_MS = (() => {
  const value = Number(process.env.DEVBOARD_START_TIMEOUT_MS);
  return Number.isInteger(value) && value > 0 ? value : 30_000;
})();
/** How long a dashboard gets to exit after SIGTERM before it is killed. */
const STOP_GRACE_MS = 10_000;

const usage = `Usage: devboard <command> [options]

Commands:
  install   Install or refresh Devboard for a host and start its dashboard.
  update    Install the newest npm version without touching the dashboard.
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
  for (const name of [
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITEA_TOKEN",
    "DEVBOARD_GITEA_TOKEN",
  ]) {
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

/** The spawned dashboard died before it answered; another port may still work. */
class DashboardExitError extends LauncherError {}

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
  const deadline = Date.now() + STOP_GRACE_MS;
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

/**
 * Stops the dashboard this install spawned. The pid is signalled only while
 * `/proc` still shows the harness entry point there, so a recycled pid is
 * never touched, and the caller does not report failure before it exited.
 */
async function stopSpawnedDashboard(pid, harness) {
  if (!isDashboardFrom(pid, harness)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline && processRunning(pid)) await sleep(100);
  if (!processRunning(pid) || !isDashboardFrom(pid, harness)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  const killed = Date.now() + 5_000;
  while (Date.now() < killed && processRunning(pid)) await sleep(50);
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

/**
 * The pid the dashboard on `port` reports for itself, or undefined when
 * nothing answers there. Another server on the port — a concurrent install
 * or a leftover process — reports a different pid, so install never mistakes
 * it for the dashboard it spawned.
 */
async function readyPid(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/ready`, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return undefined;
    const body = await response.json();
    return typeof body === "object" && body !== null && Number.isInteger(body.pid)
      ? body.pid
      : undefined;
  } catch {
    return undefined;
  }
}

async function httpOk(port, expectedPid) {
  const pid = await readyPid(port);
  return pid !== undefined && (expectedPid === undefined || pid === expectedPid);
}

async function waitForHttp(port, expectedPid, timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await httpOk(port, expectedPid)) return true;
    await sleep(200);
  }
  return false;
}

function npmBinary() {
  return process.env.DEVBOARD_NPM ?? "npm";
}

function npmCache(prefix) {
  return join(prefix, ".tmp", "npm-cache");
}

function npmEnv(prefix) {
  const cache = npmCache(prefix);
  mkdirSync(cache, { recursive: true });
  return { npm_config_cache: cache };
}

function configuredReleaseUrl() {
  for (const name of ["DEVBOARD_RELEASE_URL", "DEVBOARD_GITEA_URL", "GITEA_URL"]) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim().replace(/\/+$/, "");
    }
  }
  return undefined;
}

/**
 * The optional release fallback. npm is tried first; this source is used only
 * when npm cannot resolve or serve the artifact. Without one of these
 * variables there is no fallback and npm failure is final.
 */
function releaseSourceFromEnv() {
  const directory = process.env.DEVBOARD_RELEASE_DIR;
  if (typeof directory === "string" && directory.length > 0) {
    return { kind: "dir", directory: resolve(directory) };
  }
  const baseUrl = configuredReleaseUrl();
  if (baseUrl === undefined) return undefined;
  const repo = process.env.DEVBOARD_RELEASE_REPO ?? RELEASE_REPO;
  const token = process.env.GITEA_TOKEN ?? process.env.DEVBOARD_GITEA_TOKEN;
  return { kind: "gitea", baseUrl, repo, ...(token === undefined ? {} : { token }) };
}

function describeSource(source) {
  return source.kind === "dir" ? source.directory : `${source.baseUrl}/${source.repo}`;
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

function versionFromTag(tag) {
  return tag.replace(/^v/, "");
}

async function npmLatest(prefix) {
  const result = run(
    npmBinary(),
    ["view", PACKAGE_NAME, "version", "--prefer-online"],
    { env: npmEnv(prefix), timeoutMs: 120_000 },
  );
  if (result.code !== 0) {
    throw new LauncherError(
      `npm could not resolve ${PACKAGE_NAME}: ${firstLine(result.stderr || result.stdout)}`,
    );
  }
  const lines = result.stdout.trim().split("\n").filter((line) => line.trim().length > 0);
  const version = lines.at(-1)?.trim() ?? "";
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new LauncherError(`npm returned an unreadable version: ${firstLine(result.stdout)}`);
  }
  return version;
}

async function npmArtifact(prefix, version) {
  const result = run(
    npmBinary(),
    ["view", `${PACKAGE_NAME}@${version}`, "dist.tarball", "--prefer-online"],
    { env: npmEnv(prefix), timeoutMs: 120_000 },
  );
  if (result.code !== 0) {
    throw new LauncherError(
      `npm could not serve ${PACKAGE_NAME}@${version}: ${firstLine(result.stderr || result.stdout)}`,
    );
  }
  const value = result.stdout.trim().split("\n").filter((line) => line.length > 0).at(-1) ?? "";
  if (!/^https?:\/\//.test(value)) {
    throw new LauncherError(`npm returned no tarball for ${PACKAGE_NAME}@${version}`);
  }
  return value;
}

async function latestRelease(source) {
  return source.kind === "dir" ? directoryRelease(source.directory) : giteaLatest(source);
}

async function releaseForVersion(source, version) {
  if (source.kind === "dir") {
    const tarball = join(source.directory, tarballName(version));
    const checksum = join(source.directory, checksumName(version));
    if (!existsSync(tarball) || !existsSync(checksum)) {
      throw new LauncherError(
        `the release directory has no ${tarballName(version)} and checksum for ${version}`,
      );
    }
    return {
      version,
      tag: `v${version}`,
      assets: [{ name: tarballName(version) }, { name: checksumName(version) }],
    };
  }
  const release = await giteaReleaseByTag(source, version);
  if (release === undefined) {
    throw new LauncherError(`the release feed has no ${PACKAGE_NAME}@${version}`);
  }
  return release;
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

function apiPath(project, suffix) {
  return project.split("/").map(encodeURIComponent).join("/") + suffix;
}

function apiHeaders(source, accept) {
  return {
    Accept: accept,
    ...(typeof source.token === "string" && source.token.length > 0
      ? { Authorization: `token ${source.token}` }
      : {}),
  };
}

async function giteaLatest(source) {
  if (typeof source.baseUrl !== "string" || source.baseUrl.length === 0) {
    throw new LauncherError("the Gitea release address is not configured; set DEVBOARD_GITEA_URL");
  }
  const url = `${source.baseUrl}/api/v1/repos/${apiPath(source.repo, "/releases/latest")}`;
  const response = await fetch(url, { headers: apiHeaders(source, "application/json") });
  if (!response.ok) {
    const detail = firstLine(await response.text().catch(() => ""));
    throw new LauncherError(`the release feed answered HTTP ${response.status}: ${detail}`);
  }
  return releaseFromDocument(await response.json());
}

async function giteaReleaseByTag(source, version) {
  const url =
    `${source.baseUrl}/api/v1/repos/${apiPath(source.repo, "/releases/tags")}/` +
    encodeURIComponent(`v${version}`);
  const response = await fetch(url, { headers: apiHeaders(source, "application/json") });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    const detail = firstLine(await response.text().catch(() => ""));
    throw new LauncherError(`the release feed answered HTTP ${response.status}: ${detail}`);
  }
  return releaseFromDocument(await response.json());
}

function releaseFromDocument(parsed) {
  if (typeof parsed.tag_name !== "string") throw new LauncherError("the release has no tag");
  const assets = Array.isArray(parsed.assets)
    ? parsed.assets
        .filter((asset) => asset !== null && typeof asset === "object" && typeof asset.name === "string")
        .map((asset) => ({
          name: asset.name,
          id: asset.id,
          size: asset.size,
          browser_download_url: asset.browser_download_url,
        }))
    : [];
  return { version: versionFromTag(parsed.tag_name), tag: parsed.tag_name, assets };
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
    const asset = release.assets.find((entry) => entry.name === name);
    if (asset === undefined) throw new LauncherError(`release ${release.tag} lacks ${name}`);
    const url =
      typeof asset.browser_download_url === "string"
        ? asset.browser_download_url
        : asset.id === undefined
          ? undefined
          : `${source.baseUrl}/api/v1/repos/${apiPath(
              source.repo,
              `/releases/assets/${asset.id}`,
            )}`;
    if (url === undefined) throw new LauncherError(`release asset ${name} has no address`);
    const response = await fetch(url, {
      headers: apiHeaders(
        source,
        typeof asset.browser_download_url === "string" ? "*/*" : "application/octet-stream",
      ),
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!response.ok) {
      const detail = firstLine(await response.text().catch(() => ""));
      throw new LauncherError(`downloading ${name} failed (HTTP ${response.status}): ${detail}`);
    }
    if (response.body === null) throw new LauncherError(`downloading ${name} returned no body`);
    try {
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(join(destination, name)),
      );
    } catch (error) {
      await rm(join(destination, name), { force: true }).catch(() => undefined);
      throw error;
    }
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

function packageDir(prefix) {
  return join(prefix, "node_modules", PACKAGE_SCOPE, PACKAGE_DIR);
}

function legacyPackageDir(prefix) {
  return join(prefix, "node_modules", PACKAGE_SCOPE, LEGACY_DIR);
}

function installedVersion(prefix) {
  try {
    const parsed = JSON.parse(readFileSync(join(packageDir(prefix), "package.json"), "utf8"));
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/** The version the old two-package layout left in the prefix, if any. */
function legacyInstalledVersion(prefix) {
  try {
    const parsed = JSON.parse(readFileSync(join(legacyPackageDir(prefix), "package.json"), "utf8"));
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
  delete dependencies[`${PACKAGE_SCOPE}/${LEGACY_DIR}`];
  dependencies[PACKAGE_NAME] = version;
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

/**
 * Replaces the prefix's whole dependency tree with the staged one. The package
 * and its runtime dependencies move together, so the installed server never
 * depends on modules that were discarded with the staging directory.
 */
async function swapNodeModules(prefix, stagedNodeModules) {
  const target = join(prefix, "node_modules");
  const backup = join(prefix, ".tmp", "updates", `previous-${Date.now()}-${randomUUID()}`);
  let moved = false;
  if (existsSync(target)) {
    await rename(target, backup);
    moved = true;
  }
  try {
    await rename(stagedNodeModules, target);
  } catch (error) {
    if (moved) await rename(backup, target).catch(() => undefined);
    throw error;
  }
  await rm(backup, { recursive: true, force: true });
}

async function stagedInstall(prefix, spec, version) {
  const updates = join(prefix, ".tmp", "updates");
  await mkdir(updates, { recursive: true });
  const staging = join(updates, `stage-${version}-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  try {
    mustRun(
      npmBinary(),
      [
        "install",
        "--prefix",
        staging,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-save",
        spec,
      ],
      "npm install",
      { cwd: staging, env: npmEnv(prefix), timeoutMs: 10 * 60_000 },
    );
    const staged = packageDir(staging);
    let stagedVersion = null;
    try {
      stagedVersion = JSON.parse(readFileSync(join(staged, "package.json"), "utf8")).version;
    } catch {
      stagedVersion = null;
    }
    if (stagedVersion !== version) {
      throw new LauncherError(
        `npm installed ${stagedVersion ?? "no version"}, expected ${version}`,
      );
    }
    await swapNodeModules(prefix, join(staging, "node_modules"));
    await writePrefixManifest(prefix, version);
    return packageDir(prefix);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function installFromNpm(prefix, version) {
  return stagedInstall(prefix, `${PACKAGE_NAME}@${version}`, version);
}

async function installFromRelease(source, release, prefix, stateDir) {
  const downloadDir = join(stateDir, "updates", `download-${randomUUID()}`);
  try {
    const files = await downloadRelease(source, release, downloadDir);
    verifyChecksum(files.tarball, files.checksum);
    const target = await stagedInstall(prefix, files.tarball, release.version);
    console.log(`devboard: used release tarball ${files.tarball} from ${describeSource(source)}`);
    return target;
  } finally {
    await rm(downloadDir, { recursive: true, force: true });
  }
}

function journalKey(repoDir) {
  return createHash("sha256").update(repoDir).digest("hex").slice(0, 24);
}

/**
 * `.tmp` children the next install recreates from scratch: a serving snapshot
 * of the replaced release, update downloads and their backups, and the
 * dashboard log. Everything else is operator data the cleanup protects.
 */
const DISPOSABLE_TEMP_ENTRIES = new Set(["serving", "updates", "dashboard.log"]);

/**
 * Copies one staged `.tmp` child. `cp` refuses a destination below its source,
 * which is what a host living under the shared state directory makes of the
 * stage, so the walk prunes the stage itself. Symlinks stay links, modes are
 * preserved, and a FIFO or socket is never opened.
 */
async function copyTemporaryEntry(source, destination, outsideStage) {
  if (!outsideStage(source)) return;
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), destination);
    return;
  }
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const name of await readdir(source)) {
      await copyTemporaryEntry(join(source, name), join(destination, name), outsideStage);
    }
    await chmod(destination, info.mode & 0o7777);
    return;
  }
  if (!info.isFile()) return;
  await copyFile(source, destination);
  await chmod(destination, info.mode & 0o7777);
}

/**
 * Stages every non-disposable child of the symlinked prefix's `.tmp` before the
 * prefix is replaced. Providers, issues, flow, coach, scout, design, watchdog,
 * orchestrator, mcp, state, journal, and `install.json` are unrecreatable
 * operator data, so the replacement carries them; a fresh prefix would
 * otherwise start without provider keys and without any history.
 */
async function captureTemporaryState(prefix, stage) {
  const stateDir = join(prefix, ".tmp");
  if (!existsSync(stateDir)) return [];
  const source = await realpath(stateDir);
  const staged = await realpath(stage);
  const outsideStage = (path) => path !== staged && !path.startsWith(`${staged}${sep}`);
  const carried = [];
  for (const name of (await readdir(source)).sort()) {
    if (DISPOSABLE_TEMP_ENTRIES.has(name)) continue;
    await copyTemporaryEntry(join(source, name), join(staged, name), outsideStage);
    carried.push(name);
  }
  return carried;
}

async function restoreTemporaryState(prefix, stage, carried) {
  const stateDir = join(prefix, ".tmp");
  await mkdir(stateDir, { recursive: true });
  for (const name of carried) {
    await rename(join(stage, name), join(stateDir, name));
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
  await replacePathWithDirectory(path);
}

/**
 * The host paths under `paths` that git tracks. A probe that cannot answer
 * throws: an empty set would let an install or a sync replace files git
 * tracks, so "unknown" is never treated as "none".
 */
function trackedPaths(host, paths) {
  const result = run("git", ["-C", host, "ls-files", "-z", "--", ...paths], { cwd: host });
  if (result.code !== 0) {
    const reason =
      result.error instanceof Error && result.error.message.length > 0
        ? result.error.message
        : firstLine(result.stderr || result.stdout || `exit code ${result.code}`);
    throw new LauncherError(
      `${host}: git could not list the files it tracks (${reason}); ` +
        "refusing to replace files it cannot protect",
    );
  }
  return new Set(
    result.stdout
      .split("\0")
      .filter((path) => path.length > 0)
      .map((path) => resolve(host, path)),
  );
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

/** The skill directories the installed package owns, in stable order. */
function managedSkillNames(harness) {
  try {
    return readdirSync(join(harness, "omp", "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(MANAGED_SKILL_PREFIX))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function ensureGitignore(host, harness) {
  const path = join(host, ".gitignore");
  let source = "";
  try {
    source = readFileSync(path, "utf8");
  } catch {
    source = "";
  }
  const lines = source.split("\n");
  const wanted = [
    "/.devboard",
    "/.omp/commands",
    "/.omp/extensions",
    "/.omp/mcp.json",
    ...managedSkillNames(harness).map((name) => `/.omp/skills/${name}`),
  ];
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
  if (!(await waitForHttp(port, child.pid))) {
    const exited = child.exitCode !== null || !processRunning(child.pid);
    await stopSpawnedDashboard(child.pid, harness);
    let tail = "";
    try {
      tail = readFileSync(log, "utf8").split("\n").slice(-8).join("\n");
    } catch {
      tail = "";
    }
    throw new (exited ? DashboardExitError : LauncherError)(
      `the dashboard ${exited ? "exited before answering" : "did not answer"} on port ${port}` +
        `${tail.length > 0 ? `: ${firstLine(tail)}` : ""}`,
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

/**
 * True when `host` is the canonical devboard source checkout. The package name
 * in `.devboard/package.json` is the whole signal: it answers without git, and
 * a git probe that cannot answer must never turn the source tree into an
 * install target. An installed host names its prefix `devboard-host` instead.
 */
function canonicalSource(host) {
  const prefix = join(host, ".devboard");
  const info = lstatOrUndefined(prefix);
  if (info === undefined || info.isSymbolicLink()) return false;
  try {
    const parsed = JSON.parse(readFileSync(join(prefix, "package.json"), "utf8"));
    return parsed.name === PACKAGE_NAME;
  } catch {
    return false;
  }
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
      (await httpOk(kept[0].port, kept[0].pid))
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
  let port = await choosePort(preferred);
  let pid = 0;
  for (let attempt = 1; ; attempt += 1) {
    try {
      pid = await startDashboard(host, harness, port, stateDir);
      break;
    } catch (error) {
      // A concurrent install may claim the port between the free check and
      // the bind. That is not a broken dashboard: start again on a free port.
      if (!(error instanceof DashboardExitError) || attempt >= 5) throw error;
      port = await choosePort(undefined);
    }
  }
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

/**
 * Installs one version. npm is tried first; a configured release source is
 * used only after npm resolution or installation fails.
 */
async function installResolved(prefix, version, fallback, stateDir, npmFailure) {
  if (npmFailure === undefined) {
    try {
      await installFromNpm(prefix, version);
      return { version, via: "npm" };
    } catch (error) {
      if (fallback === undefined) throw error;
      console.log(`devboard: npm could not install ${version}: ${firstLine(error.message)}`);
    }
  } else {
    if (fallback === undefined) {
      throw new LauncherError(
        `${npmFailure.message}; set DEVBOARD_GITEA_URL to enable the release-tarball fallback`,
      );
    }
    console.log(`devboard: npm could not resolve a version: ${firstLine(npmFailure.message)}`);
  }
  const release =
    version === undefined
      ? await latestRelease(fallback)
      : await releaseForVersion(fallback, version);
  await installFromRelease(fallback, release, prefix, stateDir);
  return { version: release.version, via: "release" };
}

async function installCommand(options) {
  const host = resolveHost(options.host);
  if (canonicalSource(host)) {
    throw new LauncherError(
      `${host} is the canonical devboard source checkout; install runs in a host project instead`,
    );
  }
  const prefix = join(host, ".devboard");
  const fallback = releaseSourceFromEnv();
  const skip = trackedPaths(host, [
    ".omp/commands",
    ".omp/extensions",
    ".omp/mcp.json",
    "AGENTS.md",
  ]);
  const trackedHarness = [...trackedPaths(host, [".devboard"])].filter(
    (path) => path === prefix || path.startsWith(`${prefix}${sep}`),
  );
  if (trackedHarness.length > 0) {
    throw new LauncherError(
      `${host} tracks files under .devboard; refusing to replace a tracked harness tree`,
    );
  }
  const linked = lstatOrUndefined(prefix)?.isSymbolicLink() ?? false;
  const stage = linked ? join(host, `.devboard-install-${randomUUID()}`) : undefined;
  let carried = [];
  if (stage !== undefined) {
    try {
      await mkdir(stage, { recursive: true });
      carried = await captureTemporaryState(prefix, stage);
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    }
  }
  try {
    await replacePathWithDirectory(prefix);
    if (carried.length > 0) await restoreTemporaryState(prefix, stage, carried);
  } finally {
    if (stage !== undefined) await rm(stage, { recursive: true, force: true });
  }
  await ensureFixedDirectory(join(prefix, ".tmp"));

  let version;
  let npmFailure;
  try {
    version = await npmLatest(prefix);
  } catch (error) {
    npmFailure = error;
    version = undefined;
    if (fallback === undefined) {
      throw new LauncherError(
        `${error.message}; set DEVBOARD_GITEA_URL to enable the release-tarball fallback`,
      );
    }
  }
  const resolved = await installResolved(
    prefix,
    version,
    fallback,
    join(prefix, ".tmp"),
    npmFailure,
  );
  const installed = installedVersion(prefix);
  if (installed !== resolved.version) {
    throw new LauncherError(
      `installed ${installed ?? "no version"}, expected ${resolved.version}`,
    );
  }
  const harness = packageDir(prefix);
  await syncWrappers(host, harness, skip);
  await syncSkills(host, harness);
  await syncHarnessTrees(host, harness);
  const agents = await syncAgents(host, harness, skip);
  const ignored = await ensureGitignore(host, harness);
  const portOption = Number(options.port);
  const dashboard = await ensureOneDashboard(
    host,
    harness,
    resolved.version,
    Number.isInteger(portOption) ? portOption : undefined,
  );
  console.log(
    `devboard: installed ${PACKAGE_NAME}@${resolved.version} in ${prefix} (${resolved.via})`,
  );
  if (agents === "drift") {
    console.log("devboard: AGENTS.md differs from the template; left unchanged (drift)");
  } else if (agents === "installed") {
    console.log("devboard: installed AGENTS.md from the package template");
  } else if (agents === "tracked-missing") {
    console.log("devboard: AGENTS.md is tracked and deleted; left absent (drift)");
  }
  if (ignored.length > 0) console.log(`devboard: added ${ignored.join(", ")} to .gitignore`);
  console.log(
    `devboard: dashboard ${dashboard.reused ? "already running" : "running"} at ` +
      `http://127.0.0.1:${dashboard.port}/ (pid ${dashboard.pid})`,
  );
}

/**
 * Copies the installed package's wrappers and harness trees into the host,
 * preserving git-tracked files in both trees. `update` runs it after a
 * reinstall and also when the prefix already holds the target version: an
 * automatic update may have replaced the package while this code was not
 * running, and returning early would leave the host on the previous release's
 * copies.
 */
async function syncInstalledCopies(host, prefix) {
  await syncHostCopies(host, packageDir(prefix));
}

async function updateCommand(options) {
  const host = resolveHost(options.host);
  const prefix = join(host, ".devboard");
  if (lstatOrUndefined(prefix)?.isSymbolicLink() ?? false) {
    throw new LauncherError(`${prefix} is a symlink; run install first`);
  }
  const current = installedVersion(prefix);
  const legacy = current === null ? legacyInstalledVersion(prefix) : null;
  const before = current ?? legacy;
  if (before === null) {
    throw new LauncherError(`no devboard is installed in ${prefix}; run install`);
  }
  if (legacy !== null) {
    console.log(`devboard: migrating the legacy ${legacy} install to ${PACKAGE_NAME}`);
  }
  const fallback = releaseSourceFromEnv();
  let latest;
  let npmFailure;
  try {
    latest = await npmLatest(prefix);
  } catch (error) {
    npmFailure = error;
    if (fallback === undefined) {
      throw new LauncherError(
        `${error.message}; set DEVBOARD_GITEA_URL to enable the release-tarball fallback`,
      );
    }
  }
  const targetVersion = latest ?? (await latestRelease(fallback)).version;
  if (legacy === null) {
    if (!newerVersion(targetVersion, before) && targetVersion !== before) {
      // An older latest release is still installed as asked, never downgraded.
      console.log(`devboard: installed ${before}; newest version is ${targetVersion}`);
      return;
    }
    if (targetVersion === before) {
      await syncInstalledCopies(host, prefix);
      console.log(
        `devboard: ${PACKAGE_NAME}@${before} is already installed; synced wrappers and harness files`,
      );
      return;
    }
  }
  const resolved = await installResolved(
    prefix,
    latest,
    fallback,
    join(prefix, ".tmp"),
    npmFailure,
  );
  const harness = packageDir(prefix);
  if (legacy === null) {
    await syncHostCopies(host, harness);
  } else {
    // A legacy host keeps its wrapper copies and AGENTS.md; migration only
    // replaces the package and leaves local content byte-for-byte intact. The
    // package-owned skills are new content, so they arrive like any install.
    console.log("devboard: kept the existing omp wrappers and AGENTS.md");
    await syncSkills(host, harness);
    await syncHarnessTrees(host, harness, trackedPaths(host, [".devboard"]));
  }
  console.log(`devboard: ${PACKAGE_NAME} ${before} -> ${resolved.version} (${resolved.via})`);
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

/** Relative paths that are missing, different, or extra in `actualRoot`. */
function treeMismatches(expectedRoot, actualRoot) {
  const expected = recursiveFiles(expectedRoot);
  const actual = recursiveFiles(actualRoot);
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const mismatches = [];
  for (const path of expected) {
    if (
      actualSet.has(path) &&
      readFileSync(join(expectedRoot, path)).equals(readFileSync(join(actualRoot, path)))
    ) {
      continue;
    }
    mismatches.push(path);
  }
  for (const path of actual) {
    if (!expectedSet.has(path)) mismatches.push(path);
  }
  return mismatches;
}

function wrapperMismatches(host, harness) {
  const failures = [];
  const drift = [];
  const tracked = trackedPaths(host, [".omp/commands", ".omp/extensions"]);
  const mcpSource = join(harness, "omp", "mcp.json");
  const mcpTarget = join(host, ".omp", "mcp.json");
  if (existsSync(mcpSource)) {
    try {
      if (!readFileSync(mcpSource).equals(readFileSync(mcpTarget))) {
        failures.push(".omp/mcp.json differs from the installed package");
      }
    } catch {
      failures.push(".omp/mcp.json is missing");
    }
  }
  for (const name of ["commands", "extensions"]) {
    const actualRoot = join(host, ".omp", name);
    let mismatches;
    try {
      mismatches = treeMismatches(join(harness, "omp", name), actualRoot);
    } catch {
      failures.push(`.omp/${name} is missing`);
      continue;
    }
    for (const path of mismatches) {
      const target = join(actualRoot, path);
      const label = `.omp/${name}/${path}`;
      if (tracked.has(target)) drift.push(label);
      else failures.push(label);
    }
  }
  return { failures, drift };
}

/**
 * The package-owned skill directories compared with the installed package. An
 * unmarked host skill is never inspected, so it can never fail this check.
 */
function skillMismatches(host, harness) {
  const failures = [];
  for (const name of managedSkillNames(harness)) {
    const expected = join(harness, "omp", "skills", name);
    const actual = join(host, ".omp", "skills", name);
    const info = lstatOrUndefined(actual);
    if (info === undefined) {
      failures.push(`.omp/skills/${name} is missing`);
      continue;
    }
    if (!info.isDirectory()) {
      failures.push(`.omp/skills/${name} is not a real directory`);
      continue;
    }
    for (const path of treeMismatches(expected, actual)) {
      failures.push(`.omp/skills/${name}/${path}`);
    }
  }
  return failures;
}

/** The host copies of the paths the wrappers open by repo-root-relative path. */
function harnessTreeMismatches(host, harness) {
  const failures = [];
  for (const name of HOST_HARNESS_PATHS) {
    const expected = join(harness, name);
    if (!existsSync(expected)) continue;
    const actual = join(host, ".devboard", name);
    if (!(lstatOrUndefined(expected)?.isDirectory() ?? false)) {
      try {
        if (!readFileSync(expected).equals(readFileSync(actual))) {
          failures.push(`.devboard/${name} differs from the installed package`);
        }
      } catch {
        failures.push(`.devboard/${name} is missing`);
      }
      continue;
    }
    let mismatches;
    try {
      mismatches = treeMismatches(expected, actual);
    } catch {
      failures.push(`.devboard/${name} is missing`);
      continue;
    }
    for (const path of mismatches) failures.push(`.devboard/${name}/${path}`);
  }
  return failures;
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

async function latestForDoctor(prefix) {
  try {
    return { version: await npmLatest(prefix), via: "npm" };
  } catch (error) {
    const fallback = releaseSourceFromEnv();
    if (fallback === undefined) throw error;
    const release = await latestRelease(fallback);
    return { version: release.version, via: describeSource(fallback) };
  }
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
    name: "release access",
    run: async (_host, prefix) => {
      const latest = await latestForDoctor(prefix);
      return `${latest.via} serves ${PACKAGE_NAME}@${latest.version}`;
    },
  },
  {
    name: "release",
    run: async (_host, prefix) => {
      try {
        const version = await npmLatest(prefix);
        const tarball = await npmArtifact(prefix, version);
        return `${PACKAGE_NAME}@${version} is served by npm (${tarball})`;
      } catch (error) {
        const fallback = releaseSourceFromEnv();
        if (fallback === undefined) throw error;
        const release = await latestRelease(fallback);
        await readReleaseDigest(fallback, release, prefix);
        return `${release.tag} with a matching digest`;
      }
    },
  },
  {
    name: "package install",
    run: async (_host, prefix) => {
      const version = installedVersion(prefix);
      if (version === null) {
        throw new LauncherError(`${packageDir(prefix)} is missing; run install`);
      }
      return `${PACKAGE_NAME}@${version}`;
    },
  },
  {
    name: "version",
    run: async (_host, prefix) => {
      const version = installedVersion(prefix);
      if (version === null) throw new LauncherError("no installed version");
      const latest = await latestForDoctor(prefix);
      if (version !== latest.version) {
        throw new LauncherError(`stale install: installed ${version}, latest ${latest.version}`);
      }
      return `${version} matches ${latest.via}`;
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
      const { failures, drift } = wrapperMismatches(host, packageDir(prefix));
      if (failures.length > 0) {
        throw new LauncherError(`does not match the installed package: ${failures.join(", ")}`);
      }
      if (drift.length > 0) {
        return `drift: preserved tracked paths (${drift.join(", ")})`;
      }
      return "commands, extensions, and mcp.json match the package";
    },
  },
  {
    name: "harness files",
    run: async (host, prefix) => {
      const failures = harnessTreeMismatches(host, packageDir(prefix));
      if (failures.length > 0) {
        throw new LauncherError(`does not match the installed package: ${failures.join(", ")}`);
      }
      return "prompts, extensions, and lib match the package";
    },
  },
  {
    name: "skills",
    run: async (host, prefix) => {
      const harness = packageDir(prefix);
      const failures = skillMismatches(host, harness);
      if (failures.length > 0) {
        throw new LauncherError(`does not match the installed package: ${failures.join(", ")}`);
      }
      const names = managedSkillNames(harness);
      return names.length > 0
        ? `${names.join(", ")} match the package`
        : "the package ships no managed skills";
    },
  },
  {
    name: "AGENTS.md",
    run: async (host, prefix) => {
      const target = join(host, "AGENTS.md");
      const info = lstatOrUndefined(target);
      if (info === undefined) throw new LauncherError("AGENTS.md is missing; run install");
      if (info.isSymbolicLink()) throw new LauncherError("AGENTS.md is a symlink; run install");
      const template = join(packageDir(prefix), "templates", "host-AGENTS.md");
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
      const harness = packageDir(join(host, ".devboard"));
      if (!isDashboardFrom(dashboard.pid, harness)) {
        throw new LauncherError(`pid ${dashboard.pid} does not run the installed package`);
      }
      if (dashboard.port === undefined || !(await httpOk(dashboard.port, dashboard.pid))) {
        throw new LauncherError(
          `the dashboard does not answer on port ${dashboard.port ?? "?"} for pid ${dashboard.pid}`,
        );
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
      for (const name of ["commands", "extensions", "skills"]) {
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

/** True when this file is the script the runtime was asked to execute. */
function executedDirectly() {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry.length === 0) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (executedDirectly()) {
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
}
