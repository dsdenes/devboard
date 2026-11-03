import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * The UI/UX preflight gate must keep "this DESIGN.md is invalid" and "I could not check"
 * apart: an unavailable lint is reported as unverified and never as a missing prerequisite,
 * a lint that runs and reports errors still fails the gate, and no run writes outside the
 * root it was given.
 */

const harnessRoot = resolve(import.meta.dir, "..");
const preflightScript = join(
  harnessRoot,
  "omp",
  "skills",
  "devboard-ui-ux",
  "scripts",
  "preflight.mjs",
);
const testRoot = join(harnessRoot, ".tmp");
const temporaryDirectories: string[] = [];

const validDesignMd = `# Design

## Layout

Base unit 8px. Component padding and gaps follow the 8px rhythm, and the container is
max-width 1280px with 24px gutters.

Spacing tokens: \`{spacing.sm}\` 8px, \`{spacing.md}\` 16px.
`;

async function sandbox(name: string): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  const directory = join(testRoot, `${name}-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  temporaryDirectories.push(directory);
  return directory;
}

function writeFixtureFile(root: string, path: string, content: string) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/** A project whose DESIGN.md, DTCG tokens, OpenUI catalog, and Storybook are all present. */
function writeCompleteProject(root: string) {
  writeFixtureFile(root, "DESIGN.md", validDesignMd);
  writeFixtureFile(
    root,
    "design/tokens.json",
    JSON.stringify({ spacing: { sm: { $type: "dimension", $value: "8px" } } }),
  );
  writeFixtureFile(
    root,
    "openui.json",
    JSON.stringify({
      name: "Fixture",
      version: "0.1.0",
      description: "Fixture catalog",
      components: { Card: { description: "Card", props: {} } },
    }),
  );
  writeFixtureFile(root, ".storybook/main.js", "export default {};\n");
  writeFixtureFile(root, "src/Card.stories.ts", "export default {};\n");
}

function writeLocalLint(root: string, stdout: string) {
  writeFixtureFile(
    root,
    "node_modules/@google/design.md/package.json",
    JSON.stringify({ name: "@google/design.md", version: "0.4.0", bin: { "design-md": "cli.js" } }),
  );
  writeFixtureFile(
    root,
    "node_modules/@google/design.md/cli.js",
    `process.stdout.write(${JSON.stringify(stdout)});\n`,
  );
}

function runPreflight(root: string, env: Record<string, string> = {}) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, preflightScript, root],
    cwd: resolve(root, ".."),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function preflightResult(root: string, env: Record<string, string> = {}) {
  const run = runPreflight(root, env);
  expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: "" });
  return JSON.parse(run.stdout) as {
    applicable: boolean;
    checks: Record<string, { status: string }>;
    missing: Array<{ id: string; detail: string }>;
    unverified: Array<{ id: string; requirement: string; detail: string; command: string }>;
  };
}

afterAll(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("UI/UX preflight DESIGN.md lint", () => {
  test("reports an unavailable lint as unverified and keeps the gate applicable", async () => {
    const project = join(await sandbox("preflight-unverified"), "project");
    writeCompleteProject(project);

    const result = preflightResult(project);

    expect(result.missing).toEqual([]);
    expect(result.applicable).toBe(true);
    expect(result.checks.designMd.status).toBe("unverified");
    expect(result.unverified).toHaveLength(1);
    expect(result.unverified[0].id).toBe("designMd");
    expect(result.unverified[0].command).toContain("design-md lint");
    expect(result.unverified[0].detail).toContain("could not run");
  });

  test("keeps a lint that reports errors invalid and missing", async () => {
    const project = join(await sandbox("preflight-invalid"), "project");
    writeCompleteProject(project);
    writeLocalLint(
      project,
      JSON.stringify({
        summary: { errors: 1, warnings: 0 },
        findings: [{ severity: "error", path: "tokens.color", message: "unknown token" }],
      }),
    );

    const result = preflightResult(project);

    expect(result.checks.designMd.status).toBe("invalid");
    expect(result.applicable).toBe(false);
    expect(result.missing.map((entry) => entry.id)).toEqual(["designMd"]);
    expect(result.missing[0].detail).toContain("tokens.color: unknown token");
    expect(result.unverified).toEqual([]);
  });

  test("writes nothing outside the root it was given", async () => {
    const sandboxRoot = await sandbox("preflight-containment");
    const project = join(sandboxRoot, "project");
    const home = join(sandboxRoot, "home");
    writeCompleteProject(project);
    mkdirSync(home, { recursive: true });

    const result = preflightResult(project, {
      HOME: home,
      npm_config_cache: join(home, "npm-cache"),
      XDG_CACHE_HOME: join(home, "cache"),
    });

    expect(result.applicable).toBe(true);
    expect(readdirSync(sandboxRoot).sort()).toEqual(["home", "project"]);
    expect(existsSync(join(home, "npm-cache"))).toBe(false);
    expect(existsSync(join(sandboxRoot, "node_modules"))).toBe(false);
  });
});
