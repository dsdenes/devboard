import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * `update` must not stop at "already installed": an automatic update can
 * replace the package while the launcher is not running, leaving the host on
 * the previous release's wrappers and prompts. Running update again re-syncs
 * them from the installed package.
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

test("update re-syncs the host copies when the prefix already holds the newest version", async () => {
  const host = await fixture();
  const packageRoot = join(host, ".devboard", "node_modules", "@dsdenes", "devboard");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "@dsdenes/devboard", version: "1.2.3" })}\n`,
  );
  const files = {
    "omp/commands/example.md": "command\n",
    "omp/extensions/example.ts": "export {};\n",
    "omp/mcp.json": "{}\n",
    "prompts/example.md": "prompt\n",
    "extensions/example.ts": "export {};\n",
    "lib/example.ts": "export {};\n",
    "scripts/forge-auth.ts": "export {};\n",
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = join(packageRoot, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  // Host copies from the previous release, including one the package no
  // longer ships.
  await mkdir(join(host, ".omp", "commands"), { recursive: true });
  await writeFile(join(host, ".omp", "commands", "stale.md"), "stale\n");
  await mkdir(join(host, ".devboard", "prompts"), { recursive: true });
  await writeFile(join(host, ".devboard", "prompts", "stale.md"), "stale\n");

  // npm reports the version the prefix already holds: no reinstall happens.
  const npm = join(host, "fake-npm");
  await writeFile(npm, "#!/bin/sh\necho 1.2.3\n");
  await chmod(npm, 0o755);

  const result = Bun.spawnSync({
    cmd: [process.execPath, launcher, "update", "--host", host],
    env: { ...process.env, DEVBOARD_NPM: npm },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({
    code: 0,
    stderr: "",
  });
  expect(result.stdout.toString()).toContain(
    "devboard: @dsdenes/devboard@1.2.3 is already installed; synced wrappers and harness files",
  );
  for (const relative of Object.keys(files)) {
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
