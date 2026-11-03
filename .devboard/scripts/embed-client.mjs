/**
 * Refreshes the client build the Rust binary embeds.
 *
 * The committed copy under crates/devboard/assets lets a fresh checkout build
 * and test without Node, Bun, or npm. A release build runs this after
 * `bun run build` so the binary serves the client that was just built.
 */
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const source = join(root, "dist");
const target = join(root, "crates", "devboard", "assets");
if (readdirSync(source).length === 0) {
  console.error("embed-client: dist is empty; run `bun run build` first");
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
mkdirSync(dirname(target), { recursive: true });
cpSync(source, target, { recursive: true });
console.log(`embed-client: copied ${join(source, "..")}/dist to ${target}`);
