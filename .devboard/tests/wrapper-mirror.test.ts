import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * The canonical checkout runs the omp CLI against its tracked `.omp/` mirror.
 * No install, update, or dashboard path refreshes that mirror because this
 * checkout is not an install target, so `.devboard/omp/` stays canonical and a
 * wrapper change and its mirror land in the same commit. Without this check a
 * wrapper that is missing from the mirror stays invisible until a background
 * agent refuses to start on its missing prerequisite.
 *
 * `.omp/skills/<name>` outside the package-owned `devboard-` namespace is
 * host-local content and is never compared.
 */

const HARNESS = resolve(import.meta.dir, "..");
const CANONICAL = join(HARNESS, "omp");
const MIRROR = resolve(HARNESS, "..", ".omp");
const MANAGED_SKILL_PREFIX = "devboard-";

function filesUnder(root: string, prefix = ""): string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(prefix, entry.name);
      if (entry.isDirectory()) return filesUnder(join(root, entry.name), path);
      return entry.isFile() ? [path] : [];
    })
    .sort();
}

/** True for a mirror file the harness does not own: a host-local skill. */
function hostLocal(path: string): boolean {
  const [first, second] = path.split(sep);
  return first === "skills" && second !== undefined && !second.startsWith(MANAGED_SKILL_PREFIX);
}

describe("the checkout's tracked .omp mirror", () => {
  test("exists as a real copy of the canonical wrappers", () => {
    if (!existsSync(MIRROR)) {
      throw new Error(`${MIRROR} is missing; run .devboard/install.sh and commit the result`);
    }
  });

  test("carries every file the canonical wrappers ship", () => {
    const missing: string[] = [];
    const differing: string[] = [];
    for (const path of filesUnder(CANONICAL)) {
      const mirrored = join(MIRROR, path);
      if (!existsSync(mirrored)) {
        missing.push(path);
        continue;
      }
      if (!readFileSync(mirrored).equals(readFileSync(join(CANONICAL, path)))) {
        differing.push(path);
      }
    }
    expect({ missing, differing }).toEqual({ missing: [], differing: [] });
  });

  test("carries no wrapper the canonical tree does not ship", () => {
    const shipped = new Set(filesUnder(CANONICAL));
    const stray = filesUnder(MIRROR).filter((path) => !shipped.has(path) && !hostLocal(path));
    expect(stray).toEqual([]);
  });
});
