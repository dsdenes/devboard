import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const HARNESS = join(import.meta.dir, "..");
const INSTALLER = join(HARNESS, "install.sh");
const OMP_SOURCE = join(HARNESS, "omp");
const FIXTURES = join(HARNESS, ".tmp");
const MANAGED_SKILLS = [
  "devboard-ui-ux",
  "devboard-restful-api-implementation",
  "devboard-single-responsibility-principle",
  "devboard-consistent-naming",
  "devboard-architectural-layering",
] as const;

let root: string;

beforeEach(() => {
  mkdirSync(FIXTURES, { recursive: true });
  root = mkdtempSync(join(FIXTURES, "install-test-"));
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

/** Writes one skill directory under a `.omp/skills` root. */
function writeSkill(skillsRoot: string, name: string, description: string): void {
  mkdirSync(join(skillsRoot, name), { recursive: true });
  writeFileSync(
    join(skillsRoot, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n`,
  );
}

function ignoreLines(host: string): string[] {
  return readFileSync(join(host, ".gitignore"), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("/.omp/skills/devboard-"));
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
  /**
   * Every case runs the installer twice and snapshots the copied tree. On a
   * shared host that is six times the serial cost, so the 5-second default
   * measures the machine rather than the installer.
   */
  const installerTest = (name: string, body: () => void) => test(name, body, 60_000);

  installerTest("copies every harness wrapper into the host .omp directory", () => {
    const host = makeHost();
    const result = install([host]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(filesUnder(join(host, ".omp"))).toEqual(
      filesUnder(OMP_SOURCE),
    );
    expect(snapshot(join(host, ".omp"))).toEqual(snapshot(OMP_SOURCE));
  });

  installerTest("leaves unrelated host files and matching files alone on a rerun", () => {
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

  installerTest("refuses a host without a .devboard directory", () => {
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

  installerTest("refuses differing files without --force and changes nothing", () => {
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

  installerTest("overwrites differing files with --force and keeps unrelated files", () => {
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

  installerTest("defaults to the git repository root of the working directory", () => {
    const host = makeHost();
    const init = Bun.spawnSync(["git", "init", "-q", host], { stdout: "pipe", stderr: "pipe" });
    expect(init.exitCode).toBe(0);

    const result = install([], join(host, ".devboard"));
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(snapshot(join(host, ".omp"))).toEqual(snapshot(OMP_SOURCE));
  });

  installerTest("restores a tampered managed skill, prunes an omitted one, and keeps unmarked skills", () => {
    const host = makeHost();
    expect(install([host]).code).toBe(0);
    const skills = join(host, ".omp", "skills");
    writeFileSync(join(skills, "devboard-ui-ux", "SKILL.md"), "tampered\n");
    writeFileSync(join(skills, "devboard-ui-ux", "extra.md"), "extra\n");
    writeSkill(skills, "devboard-retired", "retired");
    writeSkill(skills, "house-style", "host owned");
    writeSkill(skills, "behavior-first-testing", "prepare family");
    writeSkill(skills, "discover-testing-strategy", "discover family");
    const unmarked = new Map(
      ["house-style", "behavior-first-testing", "discover-testing-strategy"].map(
        (name) => [name, readFileSync(join(skills, name, "SKILL.md"), "utf8")] as const,
      ),
    );

    const result = install([host]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    for (const name of MANAGED_SKILLS) {
      expect(snapshot(join(skills, name))).toEqual(snapshot(join(OMP_SOURCE, "skills", name)));
    }
    expect(existsSync(join(skills, "devboard-ui-ux", "extra.md"))).toBe(false);
    expect(existsSync(join(skills, "devboard-retired"))).toBe(false);
    for (const [name, contents] of unmarked) {
      expect(readFileSync(join(skills, name, "SKILL.md"), "utf8")).toBe(contents);
    }
  });

  installerTest("replaces a symlinked managed skill with a real directory without writing its target", () => {
    const host = makeHost();
    expect(install([host]).code).toBe(0);
    const skills = join(host, ".omp", "skills");
    const target = join(root, "outside-target");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "sentinel.md"), "outside\n");
    rmSync(join(skills, "devboard-ui-ux"), { recursive: true, force: true });
    symlinkSync(target, join(skills, "devboard-ui-ux"));

    const result = install([host]);
    expect(result.code).toBe(0);
    expect(lstatSync(join(skills, "devboard-ui-ux")).isSymbolicLink()).toBe(false);
    expect(snapshot(join(skills, "devboard-ui-ux"))).toEqual(
      snapshot(join(OMP_SOURCE, "skills", "devboard-ui-ux")),
    );
    expect(readdirSync(target)).toEqual(["sentinel.md"]);
  });

  installerTest("ignores one line per shipped skill and adds nothing on a rerun", () => {
    const host = makeHost();
    expect(install([host]).code).toBe(0);
    expect(ignoreLines(host).sort()).toEqual(
      MANAGED_SKILLS.map((name) => `/.omp/skills/${name}`).sort(),
    );
    const before = readFileSync(join(host, ".gitignore"), "utf8");
    expect(install([host]).code).toBe(0);
    expect(readFileSync(join(host, ".gitignore"), "utf8")).toBe(before);
    expect(ignoreLines(host)).toHaveLength(MANAGED_SKILLS.length);
  });
});
