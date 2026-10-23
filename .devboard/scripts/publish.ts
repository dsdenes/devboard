#!/usr/bin/env bun
/**
 * Publishes the harness to every dashboard that serves this checkout.
 *
 * Run from the integration checkout on `main` after the worktree commit is
 * pushed. The script refuses to run ahead of or behind the remote, rebuilds
 * the client bundle, proves the bundle is newer than its sources, and asks
 * every running dashboard that serves this harness to restart. A dashboard
 * with live work records `upgradePending` and restarts itself when the work
 * ends instead of losing the run.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Instance {
  pid: number;
  port: number;
  repoDir: string;
  host: string;
}

type RefreshResult =
  | { status: "restarted"; instance: Instance }
  | { status: "deferred"; instance: Instance }
  | { status: "failed"; instance: Instance; detail: string };

const harnessRoot = resolve(import.meta.dir, "..");
const distDir = join(harnessRoot, "dist");
const args = process.argv.slice(2);

function option(name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function optionValue(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  args.splice(index, value === undefined ? 1 : 2);
  return value;
}

const noRestart = option("--no-restart");
const waitForDeferred = option("--wait");
const allowWorktree = option("--allow-worktree");
const waitSeconds = Number(optionValue("--wait-timeout") ?? "1800");
if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) {
  fail("--wait-timeout needs positive seconds");
}
const waitTimeoutMs = waitSeconds * 1000;

function usage(): never {
  console.log(`Usage: bun run publish [options]

Verifies main matches the remote, rebuilds the client, and refreshes every
running dashboard that serves this checkout.

  --no-restart        Rebuild only; leave running dashboards untouched.
  --wait              Block until deferred dashboards restart, up to the timeout.
  --wait-timeout N    Seconds to wait with --wait (default 1800).
  --allow-worktree    Permit a run from a worktree; no dashboard serves one.
  -h, --help          Show this text.`);
  process.exit(0);
}

if (args.includes("-h") || args.includes("--help")) usage();
if (args.length > 0) {
  console.error(`publish: unknown option ${args.join(" ")}`);
  usage();
}

function fail(message: string): never {
  console.error(`publish: ${message}`);
  process.exit(1);
}

function run(argv: string[], cwd = harnessRoot): CommandResult {
  const child = Bun.spawnSync({
    cmd: argv,
    cwd,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", GIT_TERMINAL_PROMPT: "0" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: child.exitCode ?? 1,
    stdout: child.stdout.toString().trim(),
    stderr: child.stderr.toString().trim(),
  };
}

function git(argv: string[]): CommandResult {
  return run(["git", "-C", repoRoot, ...argv]);
}

function mustGit(argv: string[], description: string): string {
  const result = git(argv);
  if (result.code !== 0) {
    fail(`${description}: ${result.stderr || result.stdout || `exit ${result.code}`}`);
  }
  return result.stdout;
}

function real(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function walkNewest(directory: string): number {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, walkNewest(path));
    else if (entry.isFile()) newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

function readEnviron(pid: number): Map<string, string> {
  const values = new Map<string, string>();
  try {
    const source = readFileSync(`/proc/${pid}/environ`, "utf8");
    for (const entry of source.split("\0")) {
      const split = entry.indexOf("=");
      if (split > 0) values.set(entry.slice(0, split), entry.slice(split + 1));
    }
  } catch {
    // The process exited or is not readable.
  }
  return values;
}

function linuxInstances(): Instance[] | undefined {
  if (!existsSync("/proc/self/environ")) return undefined;
  const expected = real(distDir);
  const instances: Instance[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let cmdline: string;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue;
    }
    if (!cmdline.includes("server/index.ts")) continue;
    const env = readEnviron(pid);
    const port = Number(env.get("PORT") ?? "");
    if (!Number.isInteger(port) || port <= 0) continue;
    const harness = real(`/proc/${pid}/cwd`);
    const staticDir = env.get("STATIC_DIR");
    const servesThis =
      harness === real(harnessRoot) ||
      (staticDir !== undefined && real(staticDir) === expected);
    if (!servesThis) continue;
    instances.push({
      pid,
      port,
      repoDir: env.get("REPO_DIR") ?? "",
      host: env.get("HOST") ?? "127.0.0.1",
    });
  }
  return instances;
}

/** Best-effort fallback for platforms without `/proc` (macOS `ps eww`). */
function psInstances(): Instance[] {
  const result = run(["ps", "eww", "-axo", "pid=,command="], harnessRoot);
  if (result.code !== 0) return [];
  const expected = real(distDir);
  const instances: Instance[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.includes("server/index.ts")) continue;
    const match = /^\s*([0-9]+)\s/.exec(line);
    if (match === null) continue;
    const port = /(?:^|\s)PORT=([0-9]+)/.exec(line)?.[1];
    const staticDir = /(?:^|\s)STATIC_DIR=(\S+)/.exec(line)?.[1];
    if (port === undefined || staticDir === undefined) continue;
    if (real(staticDir) !== expected) continue;
    instances.push({
      pid: Number(match[1]),
      port: Number(port),
      repoDir: /(?:^|\s)REPO_DIR=(\S+)/.exec(line)?.[1] ?? "",
      host: /(?:^|\s)HOST=(\S+)/.exec(line)?.[1] ?? "127.0.0.1",
    });
  }
  return instances;
}

function discoverInstances(): Instance[] {
  const found = linuxInstances() ?? psInstances();
  const byPort = new Map<number, Instance>();
  for (const instance of found) if (!byPort.has(instance.port)) byPort.set(instance.port, instance);
  return [...byPort.values()].sort((left, right) => left.port - right.port);
}

function address(host: string): string {
  const normalized = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return normalized.includes(":") && !normalized.startsWith("[") ? `[${normalized}]` : normalized;
}

function openSocket(port: number, host: string): WebSocket {
  return new WebSocket(`ws://${address(host)}:${port}/ws`);
}

async function requestRefresh(instance: Instance): Promise<RefreshResult> {
  const { promise, resolve: settle } = Promise.withResolvers<RefreshResult>();
  let done = false;
  const finish = (result: RefreshResult) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try {
      socket?.close();
    } catch {
      // Already closed.
    }
    settle(result);
  };
  let socket: WebSocket | undefined;
  const timer = setTimeout(
    () => finish({ status: "restarted", instance }),
    15_000,
  );

  try {
    socket = openSocket(instance.port, instance.host);
  } catch (error) {
    return {
      status: "failed",
      instance,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  socket.onopen = () => socket?.send(JSON.stringify({ type: "restartServer", whenIdle: true }));
  socket.onerror = () => finish({ status: "failed", instance, detail: "websocket error" });
  // The launcher replaces the process before it can flush every reply; the
  // readiness check after this settles is the real proof.
  socket.onclose = () => finish({ status: "restarted", instance });
  socket.onmessage = (event) => {
    let message: unknown;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null || !("type" in message)) return;
    if (message.type === "serverRestarting") {
      finish({ status: "restarted", instance });
    } else if (message.type === "upgradePending") {
      finish({ status: "deferred", instance });
    } else if (message.type === "error") {
      finish({
        status: "failed",
        instance,
        detail: "message" in message ? String(message.message) : "restart refused",
      });
    }
  };
  return promise;
}

async function readVersion(instance: Instance, timeoutMs = 8000): Promise<{ stale?: boolean }> {
  const { promise, resolve: settle } = Promise.withResolvers<{ stale?: boolean }>();
  const socket = openSocket(instance.port, instance.host);
  const timer = setTimeout(() => {
    try {
      socket.close();
    } catch {
      // Already closed.
    }
    settle({});
  }, timeoutMs);
  socket.onopen = () => socket.send(JSON.stringify({ type: "getVersion" }));
  socket.onerror = () => {
    clearTimeout(timer);
    settle({});
  };
  socket.onmessage = (event) => {
    let message: unknown;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "versionState" &&
      "stale" in message
    ) {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      settle({ stale: message.stale === true });
    }
  };
  return promise;
}

async function waitForRevision(instance: Instance, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`http://${address(instance.host)}:${instance.port}/`, {
      method: "HEAD",
      signal: AbortSignal.timeout(2000),
    }).catch(() => undefined);
    if (response?.ok === true) {
      const version = await readVersion(instance);
      if (version.stale === false) return true;
    }
    await Bun.sleep(250);
  }
  return false;
}

function describe(instance: Instance): string {
  const repo = instance.repoDir.length > 0 ? instance.repoDir : "an unknown host";
  return `port ${instance.port} (${repo}, pid ${instance.pid})`;
}

const top = run(["git", "-C", harnessRoot, "rev-parse", "--show-toplevel"]);
if (top.code !== 0) fail("the harness is not inside a git checkout");
const repoRoot = top.stdout;

const gitDir = real(mustGit(["rev-parse", "--absolute-git-dir"], "could not read the git dir"));
const commonDir = real(
  mustGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    "could not read the common git dir",
  ),
);
if (gitDir !== undefined && commonDir !== undefined && gitDir !== commonDir && !allowWorktree) {
  fail("run publish from the integration checkout, not a worktree (or pass --allow-worktree)");
}

const branch = mustGit(["symbolic-ref", "--short", "HEAD"], "the checkout is not on a branch");
if (branch !== "main") fail(`the integration line is main, not ${branch}`);

const remotes = mustGit(["remote"], "could not list remotes").split("\n").filter(Boolean);
const remote = remotes.includes("origin")
  ? "origin"
  : remotes.length === 1
    ? remotes[0]
    : undefined;
if (remote === undefined) {
  fail("could not determine the canonical remote (origin, or the only remote)");
}

console.log(`publish: fetching ${remote}/main`);
const fetched = git(["fetch", "--prune", remote, `+refs/heads/main:refs/remotes/${remote}/main`]);
if (fetched.code !== 0) {
  fail(`could not fetch ${remote}/main: ${fetched.stderr || fetched.stdout}`);
}

const head = mustGit(["rev-parse", "HEAD"], "could not read HEAD");
const tip = mustGit(["rev-parse", `${remote}/main`], `could not read ${remote}/main`);
if (head !== tip) {
  const ancestor = git(["merge-base", "--is-ancestor", "HEAD", `${remote}/main`]);
  if (ancestor.code !== 0) {
    fail(
      `local main is ahead of or diverged from ${remote}/main; ` +
        "integrate and push the worktree first",
    );
  }
  const dirty = git(["diff", "--name-only"]).stdout.split("\n").filter(Boolean);
  const incoming = git(["diff", "--name-only", "HEAD", `${remote}/main`])
    .stdout.split("\n")
    .filter(Boolean);
  const blocking = dirty.filter((path) => incoming.includes(path));
  if (blocking.length > 0) {
    fail(
      `uncommitted changes would block the fast-forward: ${blocking.join(", ")}. ` +
        "Keep those edits, apply the published revision, then rerun.",
    );
  }
  console.log(`publish: fast-forwarding main to ${tip.slice(0, 7)}`);
  const merged = git(["merge", "--ff-only", `${remote}/main`]);
  if (merged.code !== 0) {
    fail(`could not fast-forward main: ${merged.stderr || merged.stdout}`);
  }
} else {
  console.log(`publish: main is at ${head.slice(0, 7)}`);
}

console.log("publish: installing harness dependencies");
const install = run(["bun", "install", "--frozen-lockfile"]);
if (install.code !== 0) {
  fail(`bun install failed: ${install.stderr || install.stdout}`);
}

console.log("publish: building the client bundle");
const built = run(["bun", "run", "build"]);
if (built.code !== 0) {
  fail(`bun run build failed: ${built.stderr || built.stdout}`);
}
console.log(built.stdout);

const indexPath = join(distDir, "index.html");
if (!existsSync(indexPath)) fail("the build produced no dist/index.html");
const builtAt = statSync(indexPath).mtimeMs;
const sources = [
  join(harnessRoot, "client"),
  join(harnessRoot, "index.html"),
  join(harnessRoot, "vite.config.ts"),
  join(harnessRoot, "svelte.config.js"),
  join(harnessRoot, "package.json"),
  join(harnessRoot, "bun.lock"),
].filter((path) => existsSync(path));
const newestSource = Math.max(
  ...sources.map((path) =>
    statSync(path).isDirectory() ? walkNewest(path) : statSync(path).mtimeMs,
  ),
);
if (builtAt + 1000 < newestSource) {
  fail("dist/index.html is older than its sources; the bundle is stale");
}
const html = readFileSync(indexPath, "utf8");
for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
  const asset = join(distDir, match[1].slice(1));
  if (!existsSync(asset)) fail(`dist/index.html references a missing asset: ${asset}`);
}

if (noRestart) {
  console.log("publish: --no-restart; running dashboards were left untouched");
  process.exit(0);
}

const instances = discoverInstances();
if (instances.length === 0) {
  console.log("publish: no running dashboard serves this checkout; the rebuilt bundle is ready");
  process.exit(0);
}

console.log(`publish: refreshing ${instances.length} dashboard(s)`);
const results = await Promise.all(instances.map((instance) => requestRefresh(instance)));
let failed = 0;
const deferred: Instance[] = [];

for (const result of results) {
  if (result.status === "failed") {
    failed += 1;
    console.error(`publish: ${describe(result.instance)} failed: ${result.detail}`);
  } else if (result.status === "deferred") {
    deferred.push(result.instance);
    console.log(
      `publish: ${describe(result.instance)} has active work; it restarts when the work ends`,
    );
  } else {
    const ready = await waitForRevision(result.instance, 20_000);
    if (ready) console.log(`publish: ${describe(result.instance)} is on ${tip.slice(0, 7)}`);
    else {
      failed += 1;
      console.error(`publish: ${describe(result.instance)} did not report the published revision`);
    }
  }
}

if (waitForDeferred && deferred.length > 0) {
  console.log(`publish: waiting up to ${waitTimeoutMs / 1000}s for deferred dashboards`);
  for (const instance of deferred) {
    const ready = await waitForRevision(instance, waitTimeoutMs);
    if (ready) console.log(`publish: ${describe(instance)} is on ${tip.slice(0, 7)}`);
    else {
      failed += 1;
      console.error(`publish: ${describe(instance)} was still busy after the wait timeout`);
    }
  }
}

if (failed > 0) fail(`${failed} dashboard(s) could not be refreshed`);
const suffix = deferred.length > 0 ? ` (${deferred.length} deferred until idle)` : "";
console.log(`publish: complete at ${tip.slice(0, 7)}${suffix}`);
