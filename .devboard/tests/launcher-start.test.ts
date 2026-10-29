import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  dashboardsFor,
  httpStatus,
  installState,
  launcherBin,
  processRunning,
  stopDashboard,
} from "../scripts/verification";

/**
 * Install owns the dashboard it spawns: when the spawned server never answers,
 * the install fails only after that child is gone, and a dashboard that does
 * answer is written to the install state. Both cases run against a minimal
 * release package so no registry install is involved.
 */

const harnessRoot = resolve(import.meta.dir, "..");
const testRoot = join(harnessRoot, ".tmp");
const temporaryDirectories: string[] = [];
const startedHosts: string[] = [];

async function temporaryDirectory(name: string): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  const directory = join(testRoot, `${name}-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  temporaryDirectories.push(directory);
  return directory;
}

function git(args: string[], cwd?: string): void {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
}

/** A host repository without a tracked harness tree. */
async function makeHost(name: string): Promise<string> {
  const directory = join(await temporaryDirectory(name), "host");
  await mkdir(join(directory, "adrs"), { recursive: true });
  await mkdir(join(directory, ".omp"), { recursive: true });
  await writeFile(join(directory, "GOAL.md"), "# Goal\n");
  git(["init", "-q"], directory);
  git(["config", "user.email", "devboard@example.test"], directory);
  git(["config", "user.name", "Devboard Test"], directory);
  git(["add", "-A"], directory);
  git(["commit", "-q", "-m", "fixture"], directory);
  return directory;
}

/** Packs a minimal @dsdenes/devboard release whose server is `server`. */
async function releaseWithServer(version: string, server: string): Promise<string> {
  const directory = await temporaryDirectory(`release-${version}`);
  const packageRoot = join(directory, "package");
  await mkdir(join(packageRoot, "server"), { recursive: true });
  await mkdir(join(packageRoot, "templates"), { recursive: true });
  for (const name of ["commands", "extensions"]) {
    await mkdir(join(packageRoot, "omp", name), { recursive: true });
    await writeFile(join(packageRoot, "omp", name, ".keep"), "");
  }
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "@dsdenes/devboard",
        version,
        engines: { node: ">=20" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(packageRoot, "server", "index.ts"), server);
  await writeFile(join(packageRoot, "templates", "host-AGENTS.md"), "# Test host\n");
  const release = join(directory, "release");
  await mkdir(release, { recursive: true });
  const packed = Bun.spawnSync({
    cmd: ["npm", "pack", "--json", "--pack-destination", release],
    cwd: packageRoot,
    env: {
      ...process.env,
      NODE_AUTH_TOKEN: "",
      NPM_TOKEN: "",
      npm_config_cache: join(testRoot, "npm-cache"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (packed.exitCode !== 0) {
    throw new Error(`npm pack failed: ${packed.stderr.toString()}`);
  }
  const packedName = (await readdir(release)).find((name) => name.endsWith(".tgz"));
  if (packedName === undefined) throw new Error("npm pack produced no tarball");
  const tarball = join(release, `devboard-${version}.tgz`);
  await rename(join(release, packedName), tarball);
  const digest = createHash("sha256").update(await readFile(tarball)).digest("hex");
  await writeFile(`${tarball}.sha256`, `${digest}  ${basename(tarball)}\n`);
  return release;
}

/** Fails `npm view`, as an unreachable registry does, and delegates the rest. */
async function failingNpm(): Promise<string> {
  const path = join(await temporaryDirectory("npm"), "npm");
  await writeFile(
    path,
    '#!/bin/sh\ncase "$1" in view) echo "simulated npm outage" >&2; exit 1;; esac\nexec npm "$@"\n',
  );
  await chmod(path, 0o755);
  return path;
}

/**
 * A `bun` in front of PATH that records the dashboard pid before exec, so the
 * test knows the child even when it dies or never finishes starting.
 */
async function recordingBun(): Promise<string> {
  const directory = await temporaryDirectory("bun");
  const path = join(directory, "bun");
  await writeFile(
    path,
    `#!/bin/sh\necho $$ > "\${STATE_DIR}/dashboard.pid"\nexec "${process.execPath}" "$@"\n`,
  );
  await chmod(path, 0o755);
  return directory;
}

async function install(
  host: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn({
    cmd: [process.execPath, launcherBin, "install", "--host", host],
    cwd: harnessRoot,
    env: { ...process.env, DEVBOARD_START_TIMEOUT_MS: "2000", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

const hangingServer = "await new Promise(() => {});\n";

const answeringServer = [
  "Bun.serve({",
  '  hostname: process.env.HOST ?? "127.0.0.1",',
  "  port: Number(process.env.PORT),",
  '  fetch: () => new Response("ok"),',
  "});",
  "",
].join("\n");

afterAll(async () => {
  for (const host of startedHosts) await stopDashboard(host).catch(() => undefined);
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("dashboard start", () => {
  test(
    "stops the spawned dashboard when it never answers",
    async () => {
      const host = await makeHost("hanging");
      startedHosts.push(host);
      const release = await releaseWithServer("0.1.998", hangingServer);
      const result = await install(host, {
        PATH: `${await recordingBun()}:${process.env.PATH ?? ""}`,
        DEVBOARD_RELEASE_DIR: release,
        DEVBOARD_NPM: await failingNpm(),
      });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("did not answer on port");
      const pid = Number(
        await readFile(join(host, ".devboard", ".tmp", "dashboard.pid"), "utf8"),
      );
      expect(pid).toBeGreaterThan(0);
      expect(processRunning(pid)).toBe(false);
      expect(dashboardsFor(host)).toEqual([]);
    },
    60_000,
  );

  test(
    "writes the install state for a dashboard that answers",
    async () => {
      const host = await makeHost("answering");
      startedHosts.push(host);
      const release = await releaseWithServer("0.1.999", answeringServer);
      const result = await install(host, {
        PATH: `${await recordingBun()}:${process.env.PATH ?? ""}`,
        DEVBOARD_RELEASE_DIR: release,
        DEVBOARD_NPM: await failingNpm(),
      });

      expect(result.code).toBe(0);
      const state = installState(join(host, ".devboard"));
      const pid = Number(
        await readFile(join(host, ".devboard", ".tmp", "dashboard.pid"), "utf8"),
      );
      expect(state.pid).toBe(pid);
      expect(state.port).toBeGreaterThan(0);
      expect(httpStatus(Number(state.port))).toBe(200);
      expect(dashboardsFor(host)).toEqual([{ pid, port: Number(state.port) }]);
    },
    60_000,
  );
});
