import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HARNESS = join(import.meta.dir, "..");
const INSTALLER = join(HARNESS, "install.sh");
const OMP_SOURCE = join(HARNESS, "omp");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "devboard-install-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function filesUnder(directory: string, prefix = ""): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files = entries.flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(join(directory, entry.name), join(prefix, entry.name))
      : [join(prefix, entry.name)],
  );
  return files.sort();
}

function snapshot(directory: string): Map<string, string> {
  const entries = filesUnder(directory).map(
    (file) => [file, readFileSync(join(directory, file), "utf8")] as const,
  );
  return new Map(entries);
}

function makeHost(name = "host"): string {
  const host = join(root, name);
  mkdirSync(join(host, ".devboard"), { recursive: true });
  cpSync(OMP_SOURCE, join(host, ".devboard", "omp"), { recursive: true });
  return host;
}

function install(args: string[], cwd = root) {
  const result = Bun.spawnSync([INSTALLER, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("install.sh", () => {
  test("copies every harness wrapper into the host .omp directory", () => {
    const host = makeHost();
    const result = install([host]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(filesUnder(join(host, ".omp"))).toEqual(
      filesUnder(OMP_SOURCE),
    );
    expect(snapshot(join(host, ".omp"))).toEqual(snapshot(OMP_SOURCE));
  });

  test("leaves unrelated host files and matching files alone on a rerun", () => {
    const host = makeHost();
    expect(install([host]).code).toBe(0);
    mkdirSync(join(host, ".omp"), { recursive: true });
    writeFileSync(join(host, ".omp", "unrelated.txt"), "host-owned\n");
    const before = snapshot(join(host, ".omp"));

    const result = install([host]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("0 file(s)");
    expect(snapshot(join(host, ".omp"))).toEqual(before);
    expect(readFileSync(join(host, ".omp", "unrelated.txt"), "utf8")).toBe("host-owned\n");
  });

  test("refuses a host without a .devboard directory", () => {
    const host = join(root, "bare");
    mkdirSync(host);

    const result = install([host]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("no .devboard directory");
    expect(existsSync(join(host, ".omp"))).toBe(false);

    const missing = install([join(root, "absent")]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("does not exist");
  });

  test("refuses differing files without --force and changes nothing", () => {
    const host = makeHost();
    expect(install([host]).code).toBe(0);
    const conflict = join(host, ".omp", "commands", "adr-resolve.md");
    writeFileSync(conflict, "host edit\n");
    const before = snapshot(join(host, ".omp"));

    const result = install([host]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("commands/adr-resolve.md");
    expect(snapshot(join(host, ".omp"))).toEqual(before);
    expect(readFileSync(conflict, "utf8")).toBe("host edit\n");
  });

  test("overwrites differing files with --force and keeps unrelated files", () => {
    const host = makeHost();
    expect(install([host]).code).toBe(0);
    writeFileSync(join(host, ".omp", "commands", "adr-resolve.md"), "host edit\n");
    writeFileSync(join(host, ".omp", "unrelated.txt"), "host-owned\n");

    const result = install(["--force", host]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const installed = snapshot(join(host, ".omp"));
    for (const [file, contents] of snapshot(OMP_SOURCE)) {
      expect(installed.get(file)).toBe(contents);
    }
    expect(installed.get("unrelated.txt")).toBe("host-owned\n");
  });

  test("defaults to the git repository root of the working directory", () => {
    const host = makeHost();
    const init = Bun.spawnSync(["git", "init", "-q", host], { stdout: "pipe", stderr: "pipe" });
    expect(init.exitCode).toBe(0);

    const result = install([], join(host, ".devboard"));
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(snapshot(join(host, ".omp"))).toEqual(snapshot(OMP_SOURCE));
  });
});
