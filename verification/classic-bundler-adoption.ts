import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Adopts the replacement in an application bundled by traditional build
 * tooling. Browserify resolves dependencies through a package's `main` field
 * and ignores its `exports` map, exactly as it resolved msgpack-javascript, so
 * the package must keep working for a resolver that never reads `exports`.
 *
 * The check installs the original library, bundles and runs the application,
 * then installs the replacement, bundles and runs it again, without touching
 * the application's source or build command. Both builds must succeed, both
 * runs must produce identical output, and the source must stay byte-for-byte
 * identical.
 */

const root = dirname(import.meta.dir);
const appDir = join(root, "examples/classic-bundler");
const packageFile = join(appDir, "package.json");
const ORIGINAL_SPEC = "npm:@msgpack/msgpack@3.1.3";
const REPLACEMENT_SPEC = "file:../../packages/msgpack";
const PAYLOAD_NAMES = [
  "null",
  "boolean true",
  "float",
  "max safe integer",
  "non-ASCII text",
  "binary",
  "array",
  "map",
  "nested",
  "timestamp epoch",
  "timestamp recent",
  "timestamp before epoch",
  "registered extension",
];
const FAILURE_NAMES = ["malformed message", "truncated message", "unsupported option", "length limit"];

async function sourceHashes(): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const file of ["src/app.js"]) {
    hashes[file] = createHash("sha256").update(await readFile(join(appDir, file))).digest("hex");
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

async function build(): Promise<{ exitCode: number; output: string }> {
  await rm(join(appDir, "dist"), { recursive: true, force: true });
  await mkdir(join(appDir, "dist"), { recursive: true });
  const result = Bun.spawnSync(
    [join(appDir, "node_modules", ".bin", "browserify"), "src/app.js", "-o", "dist/app.js"],
    { cwd: appDir, stdout: "pipe", stderr: "pipe" },
  );
  return {
    exitCode: result.exitCode ?? -1,
    output: `${result.stdout.toString()}${result.stderr.toString()}`.trim(),
  };
}

function execute(): { exitCode: number; output: string } {
  const result = Bun.spawnSync(["node", "dist/app.js"], {
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
  const buildResult = await build();
  const runResult = buildResult.exitCode === 0 ? execute() : { exitCode: -1, output: "" };
  return { spec, build: buildResult, run: runResult };
}

interface Report {
  encodedCases: Array<{ name: string; hex: string; decoded: unknown }>;
  failures: Array<{ name: string; ok: boolean; error?: { type: string; message: string } }>;
}

function inspect(report: Report): string[] {
  const problems: string[] = [];
  const names = new Set(report.encodedCases.map((item) => item.name));
  for (const name of PAYLOAD_NAMES) {
    if (!names.has(name)) {
      problems.push(`missing payload: ${name}`);
    }
  }
  const failures = new Map(report.failures.map((item) => [item.name, item]));
  for (const name of FAILURE_NAMES) {
    const failure = failures.get(name);
    if (!failure || failure.ok || !failure.error?.type || !failure.error.message) {
      problems.push(`missing failure: ${name}`);
    }
  }
  return problems;
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
  await rm(join(appDir, "dist"), { recursive: true, force: true });
}

const hashesAfter = await sourceHashes();
const sourcesUnchanged = JSON.stringify(hashesBefore) === JSON.stringify(hashesAfter);
const baselineBuildOk = baseline.build.exitCode === 0;
const replacementBuildOk = replacement.build.exitCode === 0;
const baselineRunOk = baseline.run.exitCode === 0;
const replacementRunOk = replacement.run.exitCode === 0;
const identicalOutput = baseline.run.output === replacement.run.output;

let coverage: string[] = [];
if (baselineRunOk && replacementRunOk) {
  try {
    coverage = inspect(JSON.parse(replacement.run.output) as Report);
  } catch (error) {
    coverage = [`unparseable report: ${error instanceof Error ? error.message : String(error)}`];
  }
}

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
  coverage,
};

console.log(JSON.stringify(report, null, 2));

if (
  !sourcesUnchanged ||
  !baselineBuildOk ||
  !replacementBuildOk ||
  !baselineRunOk ||
  !replacementRunOk ||
  !identicalOutput ||
  coverage.length > 0
) {
  process.exitCode = 1;
}
