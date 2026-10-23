import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const HARNESS = join(import.meta.dir, "..");
const REPO = realpathSync(join(HARNESS, ".."));
const SCRIPT = join(HARNESS, "setup-devboard.sh");
const TEMP_ROOT = join(HARNESS, ".tmp");

let root: string;

beforeEach(() => {
  mkdirSync(TEMP_ROOT, { recursive: true });
  root = mkdtempSync(join(TEMP_ROOT, "setup-devboard-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function setup(args: string[], cwd = root) {
  const result = Bun.spawnSync([SCRIPT, ...args], {
    cwd,
    env: { ...process.env, DEVBOARD_HOME: REPO },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function makeHost(name = "host"): string {
  const host = join(root, name);
  mkdirSync(host, { recursive: true });
  return host;
}

describe("setup-devboard.sh", () => {
  test("links the harness and wrappers instead of copying them", () => {
    const host = makeHost();

    const result = setup([host, "--no-ui"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const links = [
      [join(host, ".devboard"), join(REPO, ".devboard")],
      [join(host, ".omp", "commands"), join(REPO, ".devboard", "omp", "commands")],
      [join(host, ".omp", "extensions"), join(REPO, ".devboard", "omp", "extensions")],
    ] as const;
    for (const [path, target] of links) {
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(readlinkSync(path)).toBe(target);
      expect(realpathSync(path)).toBe(realpathSync(target));
    }

    expect(existsSync(join(host, ".devboard", "omp", "commands", "setup-devboard.md"))).toBe(true);
    expect(readFileSync(join(host, ".gitignore"), "utf8")).toBe(
      "/.devboard\n/.omp/commands\n/.omp/extensions\n",
    );
  });

  test("is idempotent and preserves an existing gitignore", () => {
    const host = makeHost();
    writeFileSync(join(host, ".gitignore"), "node_modules/");

    expect(setup([host, "--no-ui"]).code).toBe(0);
    const first = readFileSync(join(host, ".gitignore"), "utf8");
    expect(first).toBe("node_modules/\n/.devboard\n/.omp/commands\n/.omp/extensions\n");

    const second = setup([host, "--no-ui"]);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("already linked");
    expect(readFileSync(join(host, ".gitignore"), "utf8")).toBe(first);
  });

  test("refuses real directories without --force and changes nothing", () => {
    const host = makeHost();
    mkdirSync(join(host, ".devboard"));
    writeFileSync(join(host, ".devboard", "marker.txt"), "host copy\n");

    const result = setup([host, "--no-ui"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("refusing to replace");
    expect(readFileSync(join(host, ".devboard", "marker.txt"), "utf8")).toBe("host copy\n");
    expect(existsSync(join(host, ".omp"))).toBe(false);
    expect(existsSync(join(host, ".gitignore"))).toBe(false);
  });

  test("replaces a real directory with --force", () => {
    const host = makeHost();
    mkdirSync(join(host, ".devboard"));
    writeFileSync(join(host, ".devboard", "marker.txt"), "host copy\n");

    const result = setup([host, "--no-ui", "--force"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(lstatSync(join(host, ".devboard")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(host, ".devboard"))).toBe(join(REPO, ".devboard"));
    expect(existsSync(join(host, ".devboard", "marker.txt"))).toBe(false);
  });

  test("repoints a symlink that targets another path", () => {
    const host = makeHost();
    const other = makeHost("other");
    symlinkSync(other, join(host, ".devboard"));

    const result = setup([host, "--no-ui"]);
    expect(result.code).toBe(0);
    expect(readlinkSync(join(host, ".devboard"))).toBe(join(REPO, ".devboard"));
  });

  test("skips linking when the host is the canonical checkout", () => {
    const before = readFileSync(join(REPO, ".gitignore"), "utf8");

    const result = setup([REPO, "--no-ui"], REPO);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no links needed");
    expect(lstatSync(join(REPO, ".devboard")).isDirectory()).toBe(true);
    expect(readFileSync(join(REPO, ".gitignore"), "utf8")).toBe(before);
  });
});
