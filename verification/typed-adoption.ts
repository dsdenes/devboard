import { createHash } from "node:crypto";
import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
const packageDir = join(root, "packages/msgpack");
const appName = appDir.slice(appDir.lastIndexOf("/") + 1);
const copyDir = (variant: "baseline" | "replacement") =>
  join(root, ".tmp/adoption", `${appName}-${variant}`);
const ORIGINAL_NAME = "@msgpack/msgpack";
const ORIGINAL_SPEC = "npm:@msgpack/msgpack@3.1.3";
const REPLACEMENT_NAME = "@dsdenes/msgpack";

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
    const path = join(dir, "src/app.ts");
    const text = await readFile(path, "utf8");
    if (!text.includes(REPLACEMENT_NAME)) {
      throw new Error(`src/app.ts does not import ${REPLACEMENT_NAME}`);
    }
    await writeFile(path, text.split(REPLACEMENT_NAME).join(ORIGINAL_NAME));
  } else {
    manifest.dependencies[REPLACEMENT_NAME] = `file:${relative(dir, packageDir)}`;
  }
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

  const install = Bun.spawnSync(["bun", "install", "--silent"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (install.exitCode !== 0) {
    throw new Error(`bun install failed for ${variant}: ${install.stderr.toString()}`);
  }
  return dir;
}

function build(dir: string): { exitCode: number; output: string } {
  const result = Bun.spawnSync(
    [join(dir, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  );
  return {
    exitCode: result.exitCode ?? -1,
    output: `${result.stdout.toString()}${result.stderr.toString()}`.trim(),
  };
}

function execute(dir: string): { exitCode: number; output: string } {
  const result = Bun.spawnSync(["bun", "run", "src/app.ts"], {
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
  const buildResult = build(dir);
  const runResult = buildResult.exitCode === 0 ? execute(dir) : { exitCode: -1, output: "" };
  return { variant, build: buildResult, run: runResult };
}

const hashesBefore = await sourceHashes();
const baseline = await runWith("baseline");
const replacement = await runWith("replacement");
const hashesAfter = await sourceHashes();
await rm(copyDir("baseline"), { recursive: true, force: true });
await rm(copyDir("replacement"), { recursive: true, force: true });
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
