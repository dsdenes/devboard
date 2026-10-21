import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

/**
 * Adopts the replacement in a TypeScript application that already uses
 * msgpack-javascript. The application's own source is written against the
 * library's published types: the option generics, the context generic on the
 * encoder, decoder and extension codec, and annotations adapting those types
 * to the application's own values.
 *
 * The check installs the original library, builds and runs the application,
 * then installs the replacement, builds and runs it again, without touching
 * the application's source. Both builds must succeed, both runs must produce
 * identical output, and the source must stay byte-for-byte identical.
 */

const root = dirname(import.meta.dir);
const appDir = join(root, "examples/typed");
const packageFile = join(appDir, "package.json");
const ORIGINAL_SPEC = "npm:@msgpack/msgpack@3.1.3";
const REPLACEMENT_SPEC = "file:../../packages/msgpack";

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

/** Hashes every source file of the application, relative to its directory. */
async function sourceHashes(): Promise<Record<string, string>> {
  const entries = await readdir(appDir, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(appDir, join(entry.parentPath, entry.name)))
    .filter((file) => file === "tsconfig.json" || file.startsWith("src/"))
    .sort();
  const hashes: Record<string, string> = {};
  for (const file of files) {
    hashes[file] = await sha256(join(appDir, file));
  }
  return hashes;
}

async function install(spec: string): Promise<void> {
  await rm(join(appDir, "node_modules"), { recursive: true, force: true });
  await rm(join(appDir, "bun.lock"), { force: true });
  const manifest = JSON.parse(await readFile(packageFile, "utf8"));
  manifest.dependencies["@msgpack/msgpack"] = spec;
  await writeFile(packageFile, JSON.stringify(manifest, null, 2) + "\n");
  const result = Bun.spawnSync(["bun", "install", "--silent"], {
    cwd: appDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`bun install failed for ${spec}: ${result.stderr.toString()}`);
  }
}

function build(): { exitCode: number; output: string } {
  const result = Bun.spawnSync(
    [join(appDir, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
    { cwd: appDir, stdout: "pipe", stderr: "pipe" },
  );
  return {
    exitCode: result.exitCode ?? -1,
    output: `${result.stdout.toString()}${result.stderr.toString()}`.trim(),
  };
}

function execute(): { exitCode: number; output: string } {
  const result = Bun.spawnSync(["bun", "run", "src/app.ts"], {
    cwd: appDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode ?? -1,
    output: `${result.stdout.toString()}${result.stderr.toString()}`.trim(),
  };
}

interface AdoptedRun {
  spec: string;
  build: { exitCode: number; output: string };
  run: { exitCode: number; output: string };
}

async function runWith(spec: string): Promise<AdoptedRun> {
  await install(spec);
  const buildResult = build();
  const runResult = buildResult.exitCode === 0 ? execute() : { exitCode: -1, output: "" };
  return { spec, build: buildResult, run: runResult };
}

const originalManifest = await readFile(packageFile);
const hashesBefore = await sourceHashes();

let baseline: AdoptedRun;
let replacement: AdoptedRun;
try {
  baseline = await runWith(ORIGINAL_SPEC);
  replacement = await runWith(REPLACEMENT_SPEC);
} finally {
  await writeFile(packageFile, originalManifest);
  await rm(join(appDir, "node_modules"), { recursive: true, force: true });
  await rm(join(appDir, "bun.lock"), { force: true });
}

const hashesAfter = await sourceHashes();
const sourcesUnchanged = JSON.stringify(hashesBefore) === JSON.stringify(hashesAfter);
const baselineBuildOk = baseline.build.exitCode === 0 && baseline.build.output === "";
const replacementBuildOk = replacement.build.exitCode === 0 && replacement.build.output === "";
const baselineRunOk = baseline.run.exitCode === 0;
const replacementRunOk = replacement.run.exitCode === 0;
const identicalOutput = baseline.run.output === replacement.run.output;

const report = {
  sourcesUnchanged,
  sourceHashes: hashesAfter,
  baseline: {
    spec: baseline.spec,
    buildOk: baselineBuildOk,
    buildOutput: baseline.build.output,
    runOk: baselineRunOk,
    runOutput: baseline.run.output,
  },
  replacement: {
    spec: replacement.spec,
    buildOk: replacementBuildOk,
    buildOutput: replacement.build.output,
    runOk: replacementRunOk,
    runOutput: replacement.run.output,
  },
  identicalOutput,
};

console.log(JSON.stringify(report, null, 2));

if (
  !sourcesUnchanged ||
  !baselineBuildOk ||
  !replacementBuildOk ||
  !baselineRunOk ||
  !replacementRunOk ||
  !identicalOutput
) {
  process.exitCode = 1;
}
