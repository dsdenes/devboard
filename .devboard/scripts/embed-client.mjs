/**
 * Refreshes the client build the Rust binary embeds.
 *
 * The committed copy under crates/devboard/assets lets a fresh checkout build
 * and test without Node, Bun, or npm. A release build runs this after
 * `bun run build` so the binary serves the client that was just built.
 *
 * The copy is staged beside the committed tree and swapped in only once it is
 * complete, so an interrupted or failed copy leaves the previous client — the
 * one a Node-free build embeds — byte-identical on disk. A leftover staging or
 * backup directory from a killed run is recovered or removed by the next run.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const source = join(root, "dist");
const target = join(root, "crates", "devboard", "assets");
const parent = dirname(target);
const name = basename(target);
const staging = `${target}.tmp-${process.pid}`;
const backup = `${target}.prev-${process.pid}`;

function fail(message) {
  console.error(`embed-client: ${message}`);
  process.exit(1);
}

/** Staging and backup trees a killed run left beside the committed client. */
function leftovers() {
  return readdirSync(parent).filter((entry) => {
    if (!entry.startsWith(`${name}.`)) {
      return false;
    }
    const kind = entry.slice(name.length + 1);
    return kind.startsWith("tmp-") || kind.startsWith("prev-");
  });
}

/**
 * Restores a backup a killed swap left behind and removes every other leftover,
 * so the committed client is on disk before this run copies anything.
 */
function recover() {
  mkdirSync(parent, { recursive: true });
  let stale;
  try {
    stale = leftovers();
  } catch (error) {
    fail(`reading ${parent} failed: ${error.message}`);
  }
  if (stale.length === 0) {
    return;
  }
  if (!existsSync(target)) {
    const backups = stale
      .filter((entry) => entry.slice(name.length + 1).startsWith("prev-"))
      .sort(
        (left, right) =>
          statSync(join(parent, right)).mtimeMs -
          statSync(join(parent, left)).mtimeMs,
      );
    if (backups.length > 0) {
      renameSync(join(parent, backups[0]), target);
      stale = stale.filter((entry) => entry !== backups[0]);
    }
  }
  for (const entry of stale) {
    rmSync(join(parent, entry), { recursive: true, force: true });
  }
}

/**
 * Replaces the committed client with the staged copy.
 *
 * The previous tree moves aside first and comes back if the new one cannot be
 * installed, so a failed swap never leaves a partial or absent client.
 */
function swap() {
  let moved = false;
  try {
    renameSync(target, backup);
    moved = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      fail(`moving ${target} aside failed: ${error.message}`);
    }
  }
  try {
    renameSync(staging, target);
  } catch (error) {
    if (moved) {
      renameSync(backup, target);
    }
    rmSync(staging, { recursive: true, force: true });
    fail(`installing ${staging} as ${target} failed: ${error.message}`);
  }
  rmSync(backup, { recursive: true, force: true });
}

recover();

if (!existsSync(source)) {
  fail("dist is missing; run `bun run build` first");
}
let entries;
try {
  entries = readdirSync(source);
} catch (error) {
  fail(`reading ${source} failed: ${error.message}`);
}
if (entries.length === 0) {
  fail("dist is empty; run `bun run build` first");
}

rmSync(staging, { recursive: true, force: true });
try {
  mkdirSync(parent, { recursive: true });
  cpSync(source, staging, { recursive: true });
} catch (error) {
  rmSync(staging, { recursive: true, force: true });
  fail(`copying ${source} to ${staging} failed: ${error.message}`);
}
swap();
console.log(`embed-client: copied ${source} to ${target}`);
