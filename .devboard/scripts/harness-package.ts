import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Stages and packs the complete Devboard package. npm carries the same
 * package; `npm pack` also produces the fallback tarball the canonical Gitea
 * release keeps, and the manifest's version is set in the staging copy so the
 * checked-in package metadata never records a release number.
 */

export const harnessRoot = resolve(import.meta.dir, "..");
export const repoRoot = resolve(harnessRoot, "..");
export const HARNESS_PACKAGE = "@dsdenes/devboard";

const FILE_ALLOWLIST = [
  "package.json",
  "AGENTS.md",
  "README.md",
  "install.sh",
  "bin",
  "templates",
  "server",
  "client",
  "public",
  "lib",
  "watchdog",
  "coach",
  "release-train",
  "mcp",
  "issues",
  "prompts",
  "omp",
  "extensions",
  "scripts/forge-auth.ts",
  "dist",
  "index.html",
  "vite.config.ts",
  "svelte.config.js",
  "tsconfig.json",
];

export function releaseTarballName(version: string): string {
  return `devboard-${version}.tgz`;
}

function assertTemplateMatches(): void {
  const root = join(repoRoot, "AGENTS.md");
  const template = join(harnessRoot, "templates", "host-AGENTS.md");
  if (!existsSync(template)) {
    throw new Error(`release: ${template} is missing`);
  }
  if (!readFileSync(root).equals(readFileSync(template))) {
    throw new Error("release: templates/host-AGENTS.md differs from the repository-root AGENTS.md");
  }
}

/** Copies the allowlisted harness into `staging` and writes the release version. */
export async function stageHarness(staging: string, version: string): Promise<void> {
  assertTemplateMatches();
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  for (const entry of FILE_ALLOWLIST) {
    const source = join(harnessRoot, entry);
    if (!existsSync(source)) throw new Error(`release: cannot pack missing ${entry}`);
    const target = join(staging, entry);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true });
  }
  const manifestPath = join(staging, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Packs the staged harness under a stable release asset name. */
export async function packHarness(
  version: string,
  destination: string,
): Promise<{ tarball: string; version: string }> {
  destination = resolve(destination);
  await mkdir(destination, { recursive: true });
  const staging = join(destination, `.staging-${version}`);
  try {
    await stageHarness(staging, version);
    const packed = Bun.spawnSync({
      cmd: ["npm", "pack", "--json", "--pack-destination", destination],
      cwd: staging,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        NODE_AUTH_TOKEN: "",
        NPM_TOKEN: "",
        npm_config_cache: join(destination, ".npm-cache"),
      },
    });
    if (packed.exitCode !== 0) {
      throw new Error(`release: npm pack failed: ${packed.stderr.toString().trim()}`);
    }
    const output: unknown = JSON.parse(packed.stdout.toString());
    const entries =
      Array.isArray(output) ? output : output !== null && typeof output === "object" ? Object.values(output) : [];
    const filename = entries
      .map((entry) =>
        entry !== null && typeof entry === "object" && "filename" in entry
          ? entry.filename
          : undefined,
      )
      .find((name): name is string => typeof name === "string");
    if (filename === undefined) throw new Error("release: npm pack reported no tarball");
    const tarball = join(destination, releaseTarballName(version));
    await rename(join(destination, filename), tarball);
    return { tarball, version };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function writeChecksum(tarball: string): Promise<string> {
  const digest = createHash("sha256").update(await readFile(tarball)).digest("hex");
  const checksum = `${tarball}.sha256`;
  await writeFile(checksum, `${digest}  ${basename(tarball)}\n`);
  return checksum;
}

/** Builds a local release directory: one tarball and its `.sha256`. */
export async function createReleaseDirectory(
  version: string,
  directory: string,
): Promise<{ tarball: string; checksum: string }> {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const { tarball } = await packHarness(version, directory);
  const checksum = await writeChecksum(tarball);
  return { tarball, checksum };
}

/** A list of files a packed tarball actually contains, for verification. */
export async function packedPaths(tarball: string): Promise<string[]> {
  const result = Bun.spawnSync({
    cmd: ["tar", "-tzf", tarball],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`cannot list ${tarball}`);
  return result.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^package\//, ""));
}

/** All regular files under a release directory, for size checks. */
export async function directoryFileSize(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) total += await directoryFileSize(join(directory, entry.name));
    else total += (await readFile(join(directory, entry.name))).byteLength;
  }
  return total;
}
