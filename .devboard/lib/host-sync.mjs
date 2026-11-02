/**
 * Copies the harness files a host runs from its git root into the host, and
 * removes host copies the package no longer ships.
 *
 * The launcher (Node) and the dashboard updater (Bun) both run this sync:
 * `install` and `update` use it directly, and the automatic updater uses it
 * after it commits a newer package so the host never keeps the previous
 * release's wrappers and prompts. Keeping one implementation here means both
 * paths protect git-tracked host files the same way.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readdir, rm, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Paths the host-side wrappers open by repo-root-relative path. A copied
 * command reads `.devboard/prompts/<name>.md`, a copied omp extension
 * re-exports `.devboard/extensions/<name>.ts`, those extensions import
 * `../lib/*.ts`, and the shipped tracker prompts invoke
 * `.devboard/scripts/forge-auth.ts`. The package itself lives under
 * `.devboard/node_modules`, so each entry is copied into the host prefix on
 * install and every update. An entry is a directory or a single file.
 */
export const HOST_HARNESS_PATHS = ["prompts", "extensions", "lib", "scripts/forge-auth.ts"];

/**
 * The name prefix that marks a skill directory as package-owned. The package
 * always wins a marked name: it overwrites every marked file, removes entries
 * it does not ship, and deletes a marked directory a newer release drops. An
 * unmarked skill belongs to the host and is never read, rewritten, or deleted.
 */
export const MANAGED_SKILL_PREFIX = "devboard-";

async function lstatOrUndefined(path) {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

async function replacePathWithDirectory(path) {
  const info = await lstatOrUndefined(path);
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
  throw new Error(`${path} exists and is not a directory`);
}

async function ensureFixedDirectory(path) {
  await replacePathWithDirectory(path);
}

/** True when a tracked path lies strictly inside `path`. */
function holdsTrackedPath(skip, path) {
  if (skip === undefined) return false;
  const prefix = `${path}${sep}`;
  for (const tracked of skip) {
    if (tracked.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Mirrors `source` into `destination`, leaving every git-tracked path in
 * `skip` untouched and deleting destination entries the source does not ship.
 */
export async function syncTree(source, destination, skip) {
  await ensureFixedDirectory(destination);
  const present = new Set();
  for (const entry of await readdir(source, { withFileTypes: true })) {
    present.add(entry.name);
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (skip?.has(to) ?? false) continue;
    if (entry.isDirectory()) {
      // A directory that holds tracked content still receives the package
      // entries inside it; only replacing the directory itself would destroy
      // that content.
      const target = await lstatOrUndefined(to);
      if (holdsTrackedPath(skip, to) && !(target?.isDirectory() ?? false)) {
        continue;
      }
      await syncTree(from, to, skip);
      continue;
    }
    if (holdsTrackedPath(skip, to)) continue;
    const target = await lstatOrUndefined(to);
    if (target?.isDirectory()) await rm(to, { recursive: true, force: true });
    else if (target?.isSymbolicLink()) await unlink(to);
    await cp(from, to);
  }
  for (const name of await readdir(destination)) {
    const to = join(destination, name);
    if (present.has(name)) continue;
    // `trackedPaths` names files, so a directory between here and a tracked
    // file must be kept even though the package does not ship that name.
    if (skip?.has(to) ?? false) continue;
    if (holdsTrackedPath(skip, to)) continue;
    await rm(to, { recursive: true, force: true });
  }
}

/**
 * Copies the harness trees the host-side wrappers open by relative path,
 * leaving every git-tracked path in `skip` untouched like `syncWrappers`.
 */
export async function syncHarnessTrees(host, harness, skip) {
  for (const name of HOST_HARNESS_PATHS) {
    const source = join(harness, name);
    if (!existsSync(source)) continue;
    const target = join(host, ".devboard", name);
    if (skip?.has(target) ?? false) continue;
    if ((await lstatOrUndefined(source))?.isDirectory()) {
      await syncTree(source, target, skip);
      continue;
    }
    await ensureFixedDirectory(dirname(target));
    const current = await lstatOrUndefined(target);
    if (current?.isDirectory()) await rm(target, { recursive: true, force: true });
    else if (current?.isSymbolicLink()) await unlink(target);
    await cp(source, target);
  }
}

/** Copies the omp wrappers and their MCP manifest into the host. */
export async function syncWrappers(host, harness, skip) {
  for (const name of ["commands", "extensions"]) {
    const source = join(harness, "omp", name);
    // A partial fixture package may carry no wrappers; copying nothing is
    // better than failing the install after its dependency tree is in place.
    if (!existsSync(source)) continue;
    await syncTree(source, join(host, ".omp", name), skip);
  }
  const mcpSource = join(harness, "omp", "mcp.json");
  const mcpTarget = join(host, ".omp", "mcp.json");
  if (existsSync(mcpSource) && !(skip?.has(mcpTarget) ?? false)) {
    await ensureFixedDirectory(join(host, ".omp"));
    const current = await lstatOrUndefined(mcpTarget);
    if (current?.isSymbolicLink()) await unlink(mcpTarget);
    await cp(mcpSource, mcpTarget);
  }
}

/**
 * Copies every package-owned skill into `<host>/.omp/skills/<name>/` and
 * deletes a marked directory the package no longer ships. The marked namespace
 * is reserved, so a marked entry is replaced even when it is a symlink or a
 * file and even when git tracks it; only names outside the marked namespace
 * survive untouched.
 */
export async function syncSkills(host, harness) {
  const source = join(harness, "omp", "skills");
  if (!existsSync(source)) return;
  const target = join(host, ".omp", "skills");
  await ensureFixedDirectory(target);
  const shipped = new Set();
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(MANAGED_SKILL_PREFIX)) continue;
    shipped.add(entry.name);
    await syncTree(join(source, entry.name), join(target, entry.name));
  }
  for (const name of await readdir(target)) {
    if (shipped.has(name) || !name.startsWith(MANAGED_SKILL_PREFIX)) continue;
    await rm(join(target, name), { recursive: true, force: true });
  }
}

/**
 * Absolute host paths under `paths` that git tracks. A probe that cannot
 * answer rejects: an empty set would let the sync replace files git tracks,
 * so "unknown" is never treated as "none".
 */
export function trackedPaths(host, paths) {
  return new Promise((finish, fail) => {
    execFile(
      "git",
      ["-C", host, "ls-files", "-z", "--", ...paths],
      { encoding: "utf8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const reason =
            error.message.length > 0
              ? error.message
              : (String(stderr ?? "").trim().split("\n")[0] ?? "");
          fail(
            new Error(
              `${host}: git could not list the files it tracks` +
                `${reason.length > 0 ? ` (${reason})` : ""}; ` +
                "refusing to replace files it cannot protect",
            ),
          );
          return;
        }
        finish(
          new Set(
            stdout
              .split("\0")
              .filter((path) => path.length > 0)
              .map((path) => resolve(host, path)),
          ),
        );
      },
    );
  });
}

/**
 * The full host sync an install, an update, or an automatic update runs after
 * the package is in place: wrappers with tracked-path protection, the
 * package-owned skills, then the harness trees the wrappers import, protected
 * the same way. Rejects before copying anything when git cannot answer, so an
 * unanswerable probe never turns into an empty protection set.
 */
export async function syncHostCopies(host, harness) {
  const wrappers = await trackedPaths(host, [
    ".omp/commands",
    ".omp/extensions",
    ".omp/mcp.json",
  ]);
  await syncWrappers(host, harness, wrappers);
  await syncSkills(host, harness);
  await syncHarnessTrees(host, harness, await trackedPaths(host, [".devboard"]));
}
