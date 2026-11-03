import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
} from "node:fs";
import { cp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { supervisedDetach } from "../watchdog/supervision";

/**
 * Shared fixtures for the launcher and update verification scripts. Every
 * path lives under `.devboard/.tmp`; nothing is written into a host project or
 * outside the repository.
 */

export const harnessRoot = resolve(import.meta.dir, "..");
export const repoRoot = resolve(harnessRoot, "..");
export const launcherBin = join(harnessRoot, "bin", "devboard.mjs");
export const templateAgents = join(harnessRoot, "templates", "host-AGENTS.md");

/**
 * The credential every verification dashboard requires. The variable is put
 * back into the environment so every spawned dashboard inherits it, and a
 * programmatic socket or fetch presents the same value as a bearer token.
 */
export const VERIFY_DASHBOARD_TOKEN =
  process.env.DEVBOARD_DASHBOARD_TOKEN?.trim() || "verify-dashboard-token";
process.env.DEVBOARD_DASHBOARD_TOKEN = VERIFY_DASHBOARD_TOKEN;
/**
 * The fetch options that present the dashboard credential. Bun's fetch reads a
 * credential only from `headers`, never from a top-level `authorization`
 * option, so every verification probe spreads this object into its request
 * init instead of a bare header map.
 */
export const VERIFY_DASHBOARD_AUTHORIZATION = {
  headers: { authorization: `Bearer ${VERIFY_DASHBOARD_TOKEN}` },
};

/**
 * The document credential every verification dashboard accepts. The variable
 * is put back into the environment so each spawned dashboard inherits it, and
 * `dashboardPageUrl` is the address a verification browser opens.
 */
export const VERIFY_DASHBOARD_BOOTSTRAP =
  process.env.DEVBOARD_BOOTSTRAP_TOKEN?.trim() || "verify-dashboard-bootstrap";
process.env.DEVBOARD_BOOTSTRAP_TOKEN = VERIFY_DASHBOARD_BOOTSTRAP;

/**
 * The address a browser opens for the dashboard on `port`. The document hands
 * out the page's HttpOnly cookie only to a request that presents a credential,
 * so every navigation carries the bootstrap value; the bare address stays for
 * a fetch that presents the token itself.
 */
export function dashboardPageUrl(port: number): string {
  return `http://127.0.0.1:${port}/?bootstrap=${VERIFY_DASHBOARD_BOOTSTRAP}`;
}

/**
 * Opens a dashboard socket with the verification credential. Bun's WebSocket
 * takes handshake headers, but the DOM declaration that `lib.dom` supplies has
 * only the protocols argument, so this is the one place the extension is cast.
 */
export function dashboardSocket(url: string): WebSocket {
  return new WebSocket(url, {
    headers: VERIFY_DASHBOARD_AUTHORIZATION.headers,
  } as unknown as string[]);
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface HostFixture {
  root: string;
  directory: string;
}

export function assertEquals(actual: unknown, expected: unknown, description: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${description}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertTrue(value: boolean, description: string): void {
  if (!value) throw new Error(description);
}

export async function makeRoot(name: string): Promise<string> {
  await mkdir(join(harnessRoot, ".tmp"), { recursive: true });
  const root = join(harnessRoot, ".tmp", `${name}-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
}

export function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: 15 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** A git host with one tracked file and one untracked dashboard area. */
export async function makeHost(root: string, name: string): Promise<HostFixture> {
  const directory = join(root, name);
  await mkdir(join(directory, "adrs"), { recursive: true });
  await writeFile(join(directory, "GOAL.md"), "# Goal\n");
  await writeFile(join(directory, "tracked.txt"), "original\n");
  await mkdir(join(directory, ".omp"), { recursive: true });
  const init = run("git", ["init", "-q", directory]);
  assertTrue(init.code === 0, `git init failed: ${init.stderr}`);
  run("git", ["-C", directory, "config", "user.email", "devboard@example.test"]);
  run("git", ["-C", directory, "config", "user.name", "Devboard Verify"]);
  run("git", ["-C", directory, "add", "-A"]);
  run("git", ["-C", directory, "commit", "-q", "-m", "fixture"]);
  return { root, directory };
}

/** Points every harness path at the canonical worktree, as a legacy host did. */
export async function linkCanonicalHost(host: string): Promise<void> {
  await symlink(join(harnessRoot), join(host, ".devboard"));
  await mkdir(join(host, ".omp"), { recursive: true });
  await symlink(join(harnessRoot, "omp", "commands"), join(host, ".omp", "commands"));
  await symlink(join(harnessRoot, "omp", "extensions"), join(host, ".omp", "extensions"));
  await rm(join(host, "AGENTS.md"), { force: true });
  await symlink(join(repoRoot, "AGENTS.md"), join(host, "AGENTS.md"));
}

export function launcher(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): CommandResult {
  return run(process.execPath, [launcherBin, ...args], {
    env: { ...process.env, ...env },
  });
}

export function releaseDirectory(root: string, version: string): string {
  return join(root, `release-${version}`);
}

export function installedPackage(prefix: string): string {
  return join(prefix, "node_modules", "@dsdenes", "devboard");
}

export function installedVersion(prefix: string): string | null {
  try {
    return JSON.parse(readFileSync(join(installedPackage(prefix), "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

export function installState(prefix: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(prefix, ".tmp", "install.json"), "utf8"));
}

export function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readEnviron(pid: number): Record<string, string> {
  const values: Record<string, string> = {};
  for (const entry of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
    const split = entry.indexOf("=");
    if (split > 0) values[entry.slice(0, split)] = entry.slice(split + 1);
  }
  return values;
}

export function dashboardsFor(host: string): Array<{ pid: number; port: number }> {
  const found: Array<{ pid: number; port: number }> = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const pid = Number(entry);
    let cmdline = "";
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    } catch {
      continue;
    }
    if (!cmdline.includes("server/index.ts")) continue;
    let env: Record<string, string>;
    try {
      env = readEnviron(pid);
    } catch {
      continue;
    }
    if (env.REPO_DIR !== host) continue;
    const port = Number(env.PORT);
    found.push({ pid, port: Number.isInteger(port) ? port : 0 });
  }
  return found;
}

export function freePort(): Promise<number> {
  return new Promise((settle, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => settle(port));
    });
  });
}

/** The status of the dashboard's readiness probe, which requires its token. */
export function httpStatus(port: number): number {
  const result = run("curl", [
    "-s",
    "-o",
    "/dev/null",
    "-w",
    "%{http_code}",
    "-H",
    `Authorization: ${VERIFY_DASHBOARD_AUTHORIZATION.headers.authorization}`,
    `http://127.0.0.1:${port}/ready`,
  ]);
  return Number(result.stdout);
}

export async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  description: string,
  timeoutMs = 60_000,
  intervalMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${description}`);
}

export interface DashboardProcess {
  pid: number;
  port: number;
  log: string;
}

/** Starts the installed harness directly, the way a launcher would. */
export async function startInstalledDashboard(
  host: string,
  env: NodeJS.ProcessEnv = {},
  port?: number,
): Promise<DashboardProcess> {
  const prefix = join(host, ".devboard");
  const harness = installedPackage(prefix);
  const chosen = port ?? (await freePort());
  const log = join(prefix, ".tmp", `verify-${randomUUID()}.log`);
  await mkdir(join(prefix, ".tmp"), { recursive: true });
  const out = openSync(log, "a");
  const stateDir = join(prefix, ".tmp");
  const pid = supervisedDetach(["bun", join(harness, "server", "index.ts")], {
    cwd: harness,
    stateDir,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      ...env,
      HOST: "127.0.0.1",
      PORT: String(chosen),
      ADRS_DIR: join(host, "adrs"),
      REPO_DIR: host,
      GOAL_FILE: join(host, "GOAL.md"),
      STATIC_DIR: join(harness, "dist"),
      STATE_DIR: stateDir,
      AGENT_COMMAND: env.AGENT_COMMAND ?? "omp acp",
    },
  });
  closeSync(out);
  await waitFor(
    () => (httpStatus(chosen) === 200 ? chosen : undefined),
    `the dashboard on port ${chosen}`,
  ).catch(async (error: unknown) => {
    const tail = readFileSync(log, "utf8").split("\n").slice(-12).join("\n");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${tail}`);
  });
  return { pid: pid ?? 0, port: chosen, log };
}

export function stopPid(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
}

export async function stopDashboard(host: string): Promise<void> {
  for (const dashboard of dashboardsFor(host)) stopPid(dashboard.pid);
  await waitFor(
    () => (dashboardsFor(host).length === 0 ? true : undefined),
    "the dashboard to stop",
    15_000,
  );
}

export interface VersionState {
  running: string | null;
  installed: string | null;
  latest: string | null;
  stale: boolean;
  /** True when the dashboard serves a harness source checkout. */
  source?: boolean;
  replacement?: {
    running: string | null;
    installed: string | null;
    error: string;
  } | null;
}

/** Sends one command over the dashboard websocket and returns the reply. */
export function websocketCommand(
  port: number,
  command: unknown,
  expectedType: string,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const { promise, resolve: settle, reject } = Promise.withResolvers<Record<string, unknown>>();
  const socket = dashboardSocket(`ws://127.0.0.1:${port}/ws`);
  const timer = setTimeout(() => {
    try {
      socket.close();
    } catch {
      // Already closed.
    }
    reject(new Error(`no ${expectedType} reply within ${timeoutMs}ms`));
  }, timeoutMs);
  socket.onopen = () => socket.send(JSON.stringify(command));
  socket.onerror = () => {
    clearTimeout(timer);
    reject(new Error("websocket error"));
  };
  const finish = (message: Record<string, unknown>) => {
    clearTimeout(timer);
    settle(message);
  };
  socket.onmessage = (event) => {
    let message: unknown;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null || !("type" in message)) return;
    if (message.type !== expectedType) return;
    try {
      socket.close();
    } catch {
      // Already closed.
    }
    finish(message as Record<string, unknown>);
  };
  // A restart exits before every reply is flushed; the closed socket means the
  // command was accepted and the replacement is starting.
  socket.onclose = () => finish({ type: expectedType });
  return promise;
}

export async function readVersion(port: number): Promise<VersionState> {
  const reply = await websocketCommand(port, { type: "getVersion" }, "versionState");
  const replacement = reply.replacement;
  return {
    running: (reply.running as string | null) ?? null,
    installed: (reply.installed as string | null) ?? null,
    latest: (reply.latest as string | null) ?? null,
    stale: reply.stale === true,
    source: reply.source === true,
    ...(typeof replacement === "object" && replacement !== null
      ? {
          replacement: {
            running:
              (replacement as Record<string, unknown>).running === null ||
              typeof (replacement as Record<string, unknown>).running === "string"
                ? ((replacement as Record<string, unknown>).running as string | null)
                : null,
            installed:
              (replacement as Record<string, unknown>).installed === null ||
              typeof (replacement as Record<string, unknown>).installed === "string"
                ? ((replacement as Record<string, unknown>).installed as string | null)
                : null,
            error:
              typeof (replacement as Record<string, unknown>).error === "string"
                ? ((replacement as Record<string, unknown>).error as string)
                : "The replacement could not start.",
          },
        }
      : {}),
  };
}

export function journalKey(repoDir: string): string {
  return createHash("sha256").update(repoDir).digest("hex").slice(0, 24);
}

export function journalFile(prefix: string, host: string): string {
  return join(prefix, ".tmp", "journal", `${journalKey(host)}.jsonl`);
}

export function readJournal(prefix: string, host: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(journalFile(prefix, host), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const parsed: unknown = JSON.parse(line);
          return typeof parsed === "object" && parsed !== null ? [parsed as Record<string, unknown>] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export async function waitForInstalledVersion(
  prefix: string,
  version: string,
  timeoutMs = 60_000,
): Promise<void> {
  await waitFor(
    () => (installedVersion(prefix) === version ? true : undefined),
    `installed version ${version}`,
    timeoutMs,
  );
}

export function recursiveFiles(directory: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...recursiveFiles(join(directory, entry.name), name));
    else files.push(name);
  }
  return files.sort();
}

export function treesMatch(left: string, right: string): boolean {
  const expected = recursiveFiles(left);
  const actual = recursiveFiles(right);
  if (expected.length !== actual.length) return false;
  return expected.every(
    (name, index) =>
      name === actual[index] &&
      readFileSync(join(left, name)).equals(readFileSync(join(right, name))),
  );
}

/** Writes a fake tool directory that omits or replaces selected commands. */
export async function toolPath(
  root: string,
  options: { omit?: string[]; gh?: string; omitGh?: boolean } = {},
): Promise<string> {
  const directory = join(root, `bin-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  for (const tool of ["node", "npm", "git", "bun", "omp", "gh", "curl"]) {
    if (options.omit?.includes(tool)) continue;
    if (tool === "gh" && options.omitGh === true) continue;
    const which = run("bash", ["-lc", `command -v ${tool}`]);
    if (which.code !== 0) continue;
    const target = which.stdout.trim();
    if (tool === "gh" && options.gh !== undefined) {
      await writeFile(join(directory, "gh"), `#!/bin/sh\n${options.gh}\n`);
      chmodSync(join(directory, "gh"), 0o755);
      continue;
    }
    await symlink(target, join(directory, tool));
  }
  return directory;
}

export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function symlinkTargetsUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        found.push(`${path} -> ${readlinkSync(path)}`);
        continue;
      }
      if (entry.isDirectory()) walk(path);
    }
  };
  if (existsSync(root)) walk(root);
  return found;
}

export async function copyRelease(
  source: string,
  destination: string,
  version: string,
  options: { checksum?: string; omitChecksum?: boolean } = {},
): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const names = await readdir(source);
  const tarball = names.find((name) => name.endsWith(".tgz"));
  if (tarball === undefined) throw new Error(`no tarball in ${source}`);
  const target = `devboard-${version}.tgz`;
  await cp(join(source, tarball), join(destination, target));
  if (options.omitChecksum === true) return;
  const checksum =
    options.checksum ??
    `${createHash("sha256").update(readFileSync(join(destination, target))).digest("hex")}  ${target}\n`;
  await writeFile(join(destination, `${target}.sha256`), checksum);
}

/**
 * Starts the MCP server exactly as `<host>/.omp/mcp.json` declares it, with the
 * installed prefix as the harness environment, and returns `tools/list`'s
 * names. The declaration's own relative resolution is exercised: no
 * DEVBOARD_HARNESS_DIR is set, so an installed host must find its package.
 */
export async function declaredMcpTools(
  host: string,
  prefix: string,
  timeoutMs = 30_000,
): Promise<string[]> {
  const config = JSON.parse(readFileSync(join(host, ".omp", "mcp.json"), "utf8")) as {
    mcpServers?: Record<string, { command?: string; args?: string[] }>;
  };
  const server = config.mcpServers?.devboard;
  if (server === undefined || typeof server.command !== "string") {
    throw new Error("the installed .omp/mcp.json declares no devboard server");
  }
  // The installed server must resolve from the host's own prefix, never from
  // the verifying process's agent directory or a source-checkout override.
  const environment: Record<string, string | undefined> = { ...process.env };
  delete environment.PI_CODING_AGENT_DIR;
  delete environment.DEVBOARD_HARNESS_DIR;
  const child = spawn(server.command, server.args ?? [], {
    cwd: host,
    env: {
      ...environment,
      REPO_DIR: host,
      STATE_DIR: join(prefix, ".tmp"),
      HOME: host,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
    );
    const tools = await new Promise<string[]>((settle, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const lines = output.split("\n");
        for (const line of lines) {
          if (line.trim().length === 0) continue;
          try {
            const message = JSON.parse(line) as {
              id?: number;
              result?: { tools?: Array<{ name?: string }> };
            };
            if (message.id === 2 && Array.isArray(message.result?.tools)) {
              settle(
                message.result.tools
                  .map((tool) => tool.name)
                  .filter((name): name is string => typeof name === "string"),
              );
              return;
            }
          } catch {
            // A diagnostic line on stdout is a failure the timeout reports.
          }
        }
      });
      child.on("error", reject);
      child.on("exit", () => reject(new Error(`the MCP server exited: ${output}`)));
    });
    return tools;
  } finally {
    clearTimeout(timer);
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
}
