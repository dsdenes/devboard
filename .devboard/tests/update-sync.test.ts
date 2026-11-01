import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * `update` must not stop at "already installed": an automatic update can
 * replace the package while the launcher is not running, leaving the host on
 * the previous release's wrappers and prompts. Running update again re-syncs
 * them from the installed package, and it leaves git-tracked host files in a
 * harness tree alone instead of deleting or overwriting them.
 */

const harnessRoot = resolve(import.meta.dir, "..");
const testRoot = join(harnessRoot, ".tmp");
const launcher = join(harnessRoot, "bin", "devboard.mjs");
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  const host = join(testRoot, `update-sync-${crypto.randomUUID()}`);
  await mkdir(host, { recursive: true });
  roots.push(host);
  return host;
}

const packageFiles = {
  "omp/commands/example.md": "command\n",
  "omp/extensions/example.ts": "export {};\n",
  "omp/mcp.json": "{}\n",
  "prompts/example.md": "prompt\n",
  "extensions/example.ts": "export {};\n",
  "lib/example.ts": "export {};\n",
  "scripts/forge-auth.ts": "export {};\n",
};

async function writePackage(packageRoot: string, version: string): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "@dsdenes/devboard", version })}\n`,
  );
  for (const [relative, content] of Object.entries(packageFiles)) {
    const target = join(packageRoot, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

function launcherRun(host: string, command: string, npm: string) {
  return Bun.spawnSync({
    cmd: [process.execPath, launcher, command, "--host", host],
    env: { ...process.env, DEVBOARD_NPM: npm },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function git(host: string, ...args: string[]): string {
  const result = Bun.spawnSync({
    cmd: [
      "git",
      "-C",
      host,
      "-c",
      "user.name=devboard",
      "-c",
      "user.email=devboard@example.invalid",
      ...args,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect({ args, code: result.exitCode, stderr: result.stderr.toString() }).toEqual({
    args,
    code: 0,
    stderr: "",
  });
  return result.stdout.toString();
}

async function fakeNpm(root: string, version: string): Promise<string> {
  const npm = join(root, "fake-npm");
  await writeFile(npm, `#!/bin/sh\necho ${version}\n`);
  await chmod(npm, 0o755);
  return npm;
}

test("update re-syncs the host copies when the prefix already holds the newest version", async () => {
  const host = await fixture();
  const packageRoot = join(host, ".devboard", "node_modules", "@dsdenes", "devboard");
  await writePackage(packageRoot, "1.2.3");
  // Host copies from the previous release, including one the package no
  // longer ships.
  await mkdir(join(host, ".omp", "commands"), { recursive: true });
  await writeFile(join(host, ".omp", "commands", "stale.md"), "stale\n");
  await mkdir(join(host, ".devboard", "prompts"), { recursive: true });
  await writeFile(join(host, ".devboard", "prompts", "stale.md"), "stale\n");

  // npm reports the version the prefix already holds: no reinstall happens.
  const npm = await fakeNpm(host, "1.2.3");

  const result = launcherRun(host, "update", npm);
  expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({
    code: 0,
    stderr: "",
  });
  expect(result.stdout.toString()).toContain(
    "devboard: @dsdenes/devboard@1.2.3 is already installed; synced wrappers and harness files",
  );
  for (const relative of Object.keys(packageFiles)) {
    const hostCopy = relative.startsWith("omp/")
      ? join(host, ".omp", relative.slice("omp/".length))
      : join(host, ".devboard", relative);
    expect({ relative, content: await readFile(hostCopy, "utf8") }).toEqual({
      relative,
      content: await readFile(join(packageRoot, relative), "utf8"),
    });
  }
  expect(existsSync(join(host, ".omp", "commands", "stale.md"))).toBe(false);
  expect(existsSync(join(host, ".devboard", "prompts", "stale.md"))).toBe(false);
}, 30_000);

test("update leaves a git-tracked harness file byte-identical", async () => {
  await mkdir(testRoot, { recursive: true });
  const root = join(testRoot, `update-tracked-${crypto.randomUUID()}`);
  const host = join(root, "host");
  await mkdir(host, { recursive: true });
  roots.push(root);

  const packageRoot = join(host, ".devboard", "node_modules", "@dsdenes", "devboard");
  await writePackage(packageRoot, "1.2.3");

  // A tracked host prompt the way a host tracks one after install: `install`
  // refuses such a tree, but content tracked later still reaches `update`.
  const local = join(host, ".devboard", "prompts", "local.md");
  await mkdir(dirname(local), { recursive: true });
  await writeFile(local, "local prompt\n");
  await writeFile(join(host, ".gitignore"), "/.devboard\n/.omp\n");
  git(host, "init", "-q");
  git(host, "add", ".gitignore");
  git(host, "add", "-f", ".devboard/prompts/local.md");
  git(host, "commit", "-q", "-m", "fixture");

  const npm = await fakeNpm(root, "1.2.3");
  const result = launcherRun(host, "update", npm);
  expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({
    code: 0,
    stderr: "",
  });
  expect(await readFile(local, "utf8")).toBe("local prompt\n");
  // The rest of the tree still syncs from the installed package.
  expect(await readFile(join(host, ".devboard", "prompts", "example.md"), "utf8")).toBe(
    "prompt\n",
  );
  expect(git(host, "status", "--porcelain")).toBe("");

  const install = launcherRun(host, "install", npm);
  expect(install.exitCode).not.toBe(0);
  expect(install.stderr.toString()).toContain(
    `${host} tracks files under .devboard; refusing to replace a tracked harness tree`,
  );
}, 30_000);
