import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

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
const packageDir = join(root, "packages/msgpack");
const appName = appDir.slice(appDir.lastIndexOf("/") + 1);
const copyDir = (variant: "baseline" | "replacement") =>
  join(root, ".tmp/adoption", `${appName}-${variant}`);
const ORIGINAL_NAME = "@msgpack/msgpack";
const ORIGINAL_SPEC = "npm:@msgpack/msgpack@3.1.3";
const REPLACEMENT_NAME = "@dsdenes/msgpack";
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

/**
 * Copies the application into a generated directory, rewrites the package
 * specifier in the baseline copy only, and installs the dependency for that
 * variant. The checked-in application is never modified.
 */
async function makeApp(variant: "baseline" | "replacement"): Promise<string> {
  const dir = copyDir(variant);
  await rm(dir, { recursive: true, force: true });
  await cp(appDir, dir, {
    recursive: true,
    filter: (source) => {
      const rel = relative(appDir, source);
      return (
        rel === "" ||
        (!rel.startsWith("node_modules") && !rel.startsWith("dist") && rel !== "bun.lock")
      );
    },
  });

  const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  delete manifest.dependencies[ORIGINAL_NAME];
  delete manifest.dependencies[REPLACEMENT_NAME];
  if (variant === "baseline") {
    manifest.dependencies[ORIGINAL_NAME] = ORIGINAL_SPEC;
    const path = join(dir, "src/app.js");
    const text = await readFile(path, "utf8");
    if (!text.includes(REPLACEMENT_NAME)) {
      throw new Error(`src/app.js does not require ${REPLACEMENT_NAME}`);
    }
    await writeFile(path, text.split(REPLACEMENT_NAME).join(ORIGINAL_NAME));
  } else {
    manifest.dependencies[REPLACEMENT_NAME] = `file:${relative(dir, packageDir)}`;
  }
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

  const result = Bun.spawnSync(["bun", "install", "--silent"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`bun install failed for ${variant}: ${result.stderr.toString()}`);
  }
  return dir;
}

async function build(dir: string): Promise<{ exitCode: number; output: string }> {
  await rm(join(dir, "dist"), { recursive: true, force: true });
  await mkdir(join(dir, "dist"), { recursive: true });
  const result = Bun.spawnSync(
    [join(dir, "node_modules", ".bin", "browserify"), "src/app.js", "-o", "dist/app.js"],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  );
  return {
    exitCode: result.exitCode ?? -1,
    output: `${result.stdout.toString()}${result.stderr.toString()}`.trim(),
  };
}

function execute(dir: string): { exitCode: number; output: string } {
  const result = Bun.spawnSync(["node", "dist/app.js"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode ?? -1,
    output: `${result.stdout.toString()}${result.stderr.toString()}`.trim(),
  };
}

interface AdoptedRun {
  variant: "baseline" | "replacement";
  build: { exitCode: number; output: string };
  run: { exitCode: number; output: string };
}

async function runWith(variant: "baseline" | "replacement"): Promise<AdoptedRun> {
  const dir = await makeApp(variant);
  const buildResult = await build(dir);
  const runResult = buildResult.exitCode === 0 ? execute(dir) : { exitCode: -1, output: "" };
  return { variant, build: buildResult, run: runResult };
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

const hashesBefore = await sourceHashes();
const baseline = await runWith("baseline");
const replacement = await runWith("replacement");
const hashesAfter = await sourceHashes();
await rm(copyDir("baseline"), { recursive: true, force: true });
await rm(copyDir("replacement"), { recursive: true, force: true });
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
    variant: baseline.variant,
    buildOk: baselineBuildOk,
    buildOutput: baseline.build.output,
    runOk: baselineRunOk,
    runOutput: baseline.run.output,
  },
  replacement: {
    variant: replacement.variant,
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
