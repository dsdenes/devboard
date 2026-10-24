import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installHarnessTarball } from "./release";

/** Release transport behaviour that needs a real npm install. */

const testRoot = join(import.meta.dir, "..", ".tmp", "release-tests");
const cleanup: string[] = [];

afterAll(() => {
  for (const directory of cleanup) rmSync(directory, { recursive: true, force: true });
});

function workspace(name: string): string {
  const directory = join(testRoot, `${name}-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  cleanup.push(directory);
  return directory;
}

function harnessTarball(directory: string): string {
  const packageDirectory = join(directory, "package");
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    join(packageDirectory, "package.json"),
    `${JSON.stringify({ name: "@dsdenes/devboard-harness", version: "9.9.9" })}\n`,
  );
  const tarball = join(directory, "devboard-harness-9.9.9.tgz");
  const packed = Bun.spawnSync({
    cmd: ["tar", "-czf", tarball, "-C", directory, "package"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(packed.exitCode).toBe(0);
  return tarball;
}

describe("installHarnessTarball", () => {
  test("installs with an explicit cwd after the process cwd is deleted", async () => {
    const root = workspace("deleted-cwd");
    const tarball = harnessTarball(root);
    const prefix = join(root, "prefix");
    mkdirSync(prefix, { recursive: true });
    const script = join(root, "install.ts");
    writeFileSync(
      script,
      `import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { installHarnessTarball } from ${JSON.stringify(join(import.meta.dir, "release.ts"))};

const gone = join(import.meta.dir, "gone");
mkdirSync(gone, { recursive: true });
process.chdir(gone);
rmSync(gone, { recursive: true, force: true });
const installed = await installHarnessTarball({
  prefix: process.argv[2] ?? "",
  tarball: process.argv[3] ?? "",
  version: "9.9.9",
});
console.log(installed);
`,
    );

    const child = Bun.spawnSync({
      cmd: [process.execPath, script, prefix, tarball],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(
      child.exitCode,
      `${child.stderr.toString()}${child.stdout.toString()}`,
    ).toBe(0);
    const target = join(prefix, "node_modules", "@dsdenes", "devboard-harness");
    expect(existsSync(target)).toBe(true);
    expect(JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version).toBe("9.9.9");
  }, 60_000);
});
