import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalSource, trackedPaths as launcherTrackedPaths } from "../bin/devboard.mjs";
import { syncHostCopies, trackedPaths as syncTrackedPaths } from "../lib/host-sync.mjs";

/**
 * Both the source-checkout decision and the tracked-path protection fail
 * closed: a git probe that cannot answer never turns the canonical checkout
 * into an install target, and never becomes an empty protection set that lets
 * an install or a sync overwrite files git tracks.
 */

const harnessRoot = resolve(import.meta.dir, "..");
const testRoot = join(harnessRoot, ".tmp");
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(name: string): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, `${name}-`));
  roots.push(root);
  return root;
}

function git(host: string, ...args: string[]): void {
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
}

/** A host whose `.devboard` is exactly the canonical source-checkout layout. */
async function sourceCheckout(root: string): Promise<string> {
  const host = join(root, "checkout");
  const prefix = join(host, ".devboard");
  await mkdir(join(prefix, "prompts"), { recursive: true });
  await mkdir(join(prefix, "lib"), { recursive: true });
  await writeFile(
    join(prefix, "package.json"),
    `${JSON.stringify({ name: "@dsdenes/devboard", version: "0.0.0" }, null, 2)}\n`,
  );
  await writeFile(join(prefix, "prompts", "keep.md"), "prompt\n");
  await writeFile(join(prefix, "lib", "keep.mjs"), "export {};\n");
  git(host, "init", "-q");
  git(host, "add", "-A");
  git(host, "commit", "-q", "-m", "fixture");
  return host;
}

/** A `git` first on PATH that cannot answer `ls-files`, like dubious ownership. */
async function failingGit(root: string): Promise<string> {
  const real = Bun.which("git");
  if (real === null) throw new Error("git is not installed");
  const directory = join(root, "git-stub");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "git");
  await writeFile(
    path,
    "#!/bin/sh\n" +
      'case " $* " in\n' +
      '  *" ls-files "*) echo "fatal: detected dubious ownership in repository" >&2; exit 128;;\n' +
      "esac\n" +
      `exec "${real}" "$@"\n`,
  );
  await chmod(path, 0o755);
  return directory;
}

/** Every file under `directory`, byte for byte, keyed by relative path. */
function snapshot(directory: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const child = relative.length === 0 ? entry.name : join(relative, entry.name);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      files.set(child, readFileSync(join(directory, child)).toString("base64"));
    }
  };
  walk("");
  return files;
}

function install(host: string, pathPrefix: string) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, join(harnessRoot, "bin", "devboard.mjs"), "install", "--host", host],
    env: { ...process.env, PATH: `${pathPrefix}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode ?? 1,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

test("install refuses the source checkout when git cannot list files", async () => {
  const root = await fixture("canonical-git-failure");
  const host = await sourceCheckout(root);
  const prefix = join(host, ".devboard");
  const before = snapshot(prefix);
  const stub = await failingGit(root);

  const result = install(host, stub);

  expect(result.code).not.toBe(0);
  expect(result.output).toContain("canonical devboard source checkout");
  expect(snapshot(prefix)).toEqual(before);
  expect(existsSync(join(prefix, "node_modules"))).toBe(false);
  expect(existsSync(join(prefix, ".tmp"))).toBe(false);
});

test("install aborts before installing when git cannot list tracked files", async () => {
  const root = await fixture("install-git-failure");
  const host = join(root, "host");
  const prefix = join(host, ".devboard");
  await mkdir(join(prefix, "prompts"), { recursive: true });
  await writeFile(
    join(prefix, "package.json"),
    `${JSON.stringify({ name: "devboard-host", private: true })}\n`,
  );
  await writeFile(join(prefix, "prompts", "keep.md"), "prompt\n");
  git(host, "init", "-q");
  git(host, "add", "-A");
  git(host, "commit", "-q", "-m", "fixture");
  const before = snapshot(prefix);
  const stub = await failingGit(root);

  const result = install(host, stub);

  expect(result.code).not.toBe(0);
  expect(result.output).toContain("git could not list the files it tracks");
  expect(snapshot(prefix)).toEqual(before);
  expect(existsSync(join(prefix, "node_modules"))).toBe(false);
  expect(existsSync(join(host, ".omp"))).toBe(false);
});

test("canonicalSource reads the package name, not a git probe", async () => {
  const root = await fixture("canonical-source");
  const host = await sourceCheckout(root);
  expect(canonicalSource(host)).toBe(true);

  const installed = join(root, "installed");
  await mkdir(join(installed, ".devboard"), { recursive: true });
  await writeFile(
    join(installed, ".devboard", "package.json"),
    `${JSON.stringify({ name: "devboard-host", private: true })}\n`,
  );
  expect(canonicalSource(installed)).toBe(false);
  expect(canonicalSource(join(root, "absent"))).toBe(false);
  expect(canonicalSource(resolve(harnessRoot, ".."))).toBe(true);
});

test("launcher trackedPaths reports tracked files and throws when git cannot answer", async () => {
  const root = await fixture("launcher-tracked-paths");
  const host = join(root, "host");
  await mkdir(host, { recursive: true });
  await writeFile(join(host, "tracked.md"), "tracked\n");
  git(host, "init", "-q");
  git(host, "add", "tracked.md");
  git(host, "commit", "-q", "-m", "fixture");

  expect([...launcherTrackedPaths(host, ["."])]).toEqual([join(host, "tracked.md")]);

  const stub = await failingGit(root);
  const saved = process.env.PATH;
  process.env.PATH = `${stub}:${saved ?? ""}`;
  try {
    expect(() => launcherTrackedPaths(host, ["."])).toThrow(
      /git could not list the files it tracks/,
    );
  } finally {
    process.env.PATH = saved;
  }
});

test("syncHostCopies rejects and copies nothing when git cannot answer", async () => {
  const root = await fixture("sync-git-failure");
  const host = join(root, "host");
  await mkdir(join(host, ".devboard", "prompts"), { recursive: true });
  await mkdir(join(host, ".omp", "commands"), { recursive: true });
  await writeFile(join(host, ".devboard", "prompts", "local.md"), "local\n");
  await writeFile(join(host, ".omp", "commands", "local.md"), "local\n");
  git(host, "init", "-q");
  const harness = join(root, "package");
  await mkdir(join(harness, "omp", "commands"), { recursive: true });
  await mkdir(join(harness, "prompts"), { recursive: true });
  await writeFile(join(harness, "omp", "commands", "example.md"), "command\n");
  await writeFile(join(harness, "prompts", "example.md"), "prompt\n");

  const stub = await failingGit(root);
  const saved = process.env.PATH;
  process.env.PATH = `${stub}:${saved ?? ""}`;
  try {
    await expect(syncTrackedPaths(host, [".devboard"])).rejects.toThrow(
      /git could not list the files it tracks/,
    );
    await expect(syncHostCopies(host, harness)).rejects.toThrow(
      /git could not list the files it tracks/,
    );
  } finally {
    process.env.PATH = saved;
  }

  expect(existsSync(join(host, ".devboard", "prompts", "example.md"))).toBe(false);
  expect(existsSync(join(host, ".omp", "commands", "example.md"))).toBe(false);
  expect(readFileSync(join(host, ".devboard", "prompts", "local.md"), "utf8")).toBe("local\n");
  expect(readFileSync(join(host, ".omp", "commands", "local.md"), "utf8")).toBe("local\n");
});
