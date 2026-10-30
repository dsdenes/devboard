#!/usr/bin/env bun
/**
 * Installs the Conventional Commits pre-push gate into this repository's shared
 * hooks directory, so every worktree of the checkout is gated without a
 * per-worktree step.
 *
 *   bun .devboard/hooks/install.ts [--force]
 *
 * Idempotent: the matching hook is left alone. A differing hook is refused
 * unless `--force` is passed. The installer refuses any directory that is not
 * the source harness at `<checkout>/.devboard`, so an installed npm prefix
 * never receives this repository's gate.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const harness = resolve(import.meta.dir, "..");
const checkout = dirname(harness);
const source = join(import.meta.dir, "pre-push");
const args = process.argv.slice(2);
const force = args.includes("--force");

function fail(message: string): never {
  console.error(`hooks: ${message}`);
  process.exit(1);
}

function real(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function manifestName(directory: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    if (parsed === null || typeof parsed !== "object" || !("name" in parsed)) return undefined;
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

function gitDirectory(): string {
  const result = spawnSync(
    "git",
    ["-C", checkout, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error !== undefined || result.status !== 0) {
    fail(`cannot read the git directory of ${checkout}`);
  }
  const common = result.stdout.trim();
  if (common.length === 0) fail(`cannot read the git directory of ${checkout}`);
  return common;
}

if (args.some((arg) => arg !== "--force")) {
  fail("usage: bun .devboard/hooks/install.ts [--force]");
}

/* The gate belongs to this repository's source harness, never to an installed host. */
if (basename(harness) !== ".devboard") {
  fail(`refusing to install: ${harness} is not named .devboard`);
}
if (manifestName(harness) !== "@dsdenes/devboard") {
  fail(
    `refusing to install: ${harness} is not the source harness checkout; ` +
      "an installed npm prefix never receives the commit gate",
  );
}
if (existsSync(join(harness, "node_modules", "@dsdenes", "devboard"))) {
  fail(
    `refusing to install: ${harness} holds an installed harness; ` +
      "an installed npm prefix never receives the commit gate",
  );
}
const top = spawnSync("git", ["-C", checkout, "rev-parse", "--show-toplevel"], {
  encoding: "utf8",
  windowsHide: true,
});
if (top.error !== undefined || top.status !== 0) {
  fail(`refusing to install: ${checkout} is not inside a git checkout`);
}
const topLevel = real(top.stdout.trim());
if (topLevel === undefined || topLevel !== real(checkout)) {
  fail(`refusing to install: ${harness} is not <checkout>/.devboard`);
}
if (!existsSync(source)) fail(`the hook source is missing: ${source}`);

const hooksDirectory = join(gitDirectory(), "hooks");
const target = join(hooksDirectory, "pre-push");
const contents = readFileSync(source);

let existing: Buffer | undefined;
let existingIsLink = false;
if (existsSync(target)) {
  try {
    const stat = lstatSync(target);
    if (stat.isDirectory()) fail(`${target} is a directory, not a hook`);
    existingIsLink = stat.isSymbolicLink();
    existing = readFileSync(target);
  } catch {
    existing = undefined;
  }
}

if (existing !== undefined && existingIsLink === false && existing.equals(contents)) {
  chmodSync(target, 0o755);
  console.log(`hooks: ${target} is current`);
  process.exit(0);
}
if (existing !== undefined && !force) {
  fail(`${target} differs from the checked-in hook; pass --force to replace it`);
}

mkdirSync(hooksDirectory, { recursive: true });
if (existing !== undefined) rmSync(target, { force: true });
writeFileSync(target, contents, { mode: 0o755 });
chmodSync(target, 0o755);
console.log(`hooks: installed ${target}`);
