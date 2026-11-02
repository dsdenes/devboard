import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { CreateReleaseInput, GiteaReleaseDocument } from "../lib/gitea";
import {
  releaseStep,
  ReleaseFailure,
  type ReleaseForge,
  type ReleaseRun,
  type ReleaseStepOptions,
} from "../scripts/release";

/**
 * The release step's two honesty rules, driven as the script runs them: a tag
 * made for another commit is a refusal before anything is packed or published,
 * and a checkout that predates the newest release tag publishes the next
 * version instead of re-deriving the one already out. Every npm, forge, and
 * registry effect is a stub or a local git repository; nothing reaches npmjs or
 * a real forge.
 */

const harnessRoot = resolve(import.meta.dir, "..");
const testRoot = join(harnessRoot, ".tmp");
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const PACKAGE = "@dsdenes/devboard";

function scratch(name: string): string {
  mkdirSync(testRoot, { recursive: true });
  const directory = mkdtempSync(join(testRoot, `release-step-${name}-`));
  roots.push(directory);
  return directory;
}

function git(directory: string, args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Release Test",
      "-c",
      "user.email=release@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd: directory, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function repository(name: string): string {
  const directory = join(scratch(name), "repo");
  mkdirSync(directory, { recursive: true });
  git(directory, ["init", "-q"]);
  return directory;
}

function commit(directory: string, message: string): string {
  git(directory, ["commit", "--allow-empty", "-q", "-m", message]);
  return git(directory, ["rev-parse", "HEAD"]);
}

/** What the step asked npm and the forge to do, in order. */
interface Effects {
  npm: string[][];
  published: Set<string>;
  latest: string | undefined;
}

function commandRunner(effects: Effects): ReleaseRun {
  return (command, args, cwd) => {
    if (command === "npm") {
      effects.npm.push(args);
      if (args[0] === "publish") {
        const version = /devboard-([0-9]+\.[0-9]+\.[0-9]+)\.tgz$/.exec(args[1] ?? "")?.[1];
        if (version !== undefined) effects.published.add(version);
        return { code: 0, stdout: "", stderr: "" };
      }
      const spec = args[1] ?? "";
      if (spec === PACKAGE) {
        return effects.latest === undefined
          ? { code: 1, stdout: "", stderr: "npm error code E404" }
          : { code: 0, stdout: effects.latest, stderr: "" };
      }
      const version = /@([0-9]+\.[0-9]+\.[0-9]+)$/.exec(spec)?.[1];
      return version !== undefined && effects.published.has(version)
        ? { code: 0, stdout: version, stderr: "" }
        : { code: 1, stdout: "", stderr: "npm error code E404" };
    }
    const result = spawnSync(command, args, {
      cwd: cwd ?? harnessRoot,
      encoding: "utf8",
    });
    return {
      code: result.status ?? 1,
      stdout: (result.stdout ?? "").trim(),
      stderr: (result.stderr ?? "").trim(),
    };
  };
}

interface ForgeEffects {
  forge: ReleaseForge;
  created: CreateReleaseInput[];
  uploads: string[];
}

/** A forge that records what it was asked to write; `releases` maps a tag to its commit. */
function forgeAt(
  releases: Map<string, string>,
  assets: Map<string, string[]> = new Map(),
): ForgeEffects {
  const created: CreateReleaseInput[] = [];
  const uploads: string[] = [];
  const forge: ReleaseForge = {
    async publishedVersions() {
      return [...releases.keys()]
        .filter((tag) => /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag))
        .map((tag) => tag.slice(1));
    },
    async releaseByTag(tag): Promise<GiteaReleaseDocument | undefined> {
      if (!releases.has(tag)) return undefined;
      return {
        id: 7,
        tag_name: tag,
        assets: (assets.get(tag) ?? []).map((name) => ({ name })),
      };
    },
    async createRelease(input) {
      created.push(input);
      return { id: 9, tag_name: input.tag, assets: [] };
    },
    async uploadAsset(_id, name) {
      uploads.push(name);
    },
    async tagCommit(tag) {
      return releases.get(tag);
    },
  };
  return { forge, created, uploads };
}

/** A tarball and its checksum, written where the step expects them. */
async function pack(version: string, directory: string) {
  mkdirSync(directory, { recursive: true });
  const tarball = join(directory, `devboard-${version}.tgz`);
  const checksum = `${tarball}.sha256`;
  writeFileSync(tarball, `tarball ${version}\n`);
  writeFileSync(checksum, `checksum ${version}\n`);
  return { tarball, checksum };
}

interface Run {
  options: ReleaseStepOptions;
  log: string[];
  effects: Effects;
  forge: ForgeEffects;
}

function runWith(repoDir: string, overrides: {
  releases?: Map<string, string>;
  assets?: Map<string, string[]>;
  published?: string[];
  latest?: string;
}): Run {
  const base = scratch("run");
  const effects: Effects = {
    npm: [],
    published: new Set(overrides.published ?? []),
    latest: overrides.latest,
  };
  const forgeEffects = forgeAt(overrides.releases ?? new Map(), overrides.assets ?? new Map());
  const log: string[] = [];
  return {
    effects,
    forge: forgeEffects,
    log,
    options: {
      repoDir,
      harnessRoot,
      releaseRoot: join(base, "release"),
      npmCache: join(base, "npm-cache"),
      environment: { NODE_AUTH_TOKEN: "test-token", GITEA_TOKEN: "test-token" },
      run: commandRunner(effects),
      pack,
      forge: forgeEffects.forge,
      log: (line: string) => log.push(line),
    },
  };
}

describe("release step binding", () => {
  test("refuses a derived tag made for an unrelated commit and publishes nothing", async () => {
    const repoDir = repository("unrelated");
    const head = commit(repoDir, "fix: the change under release");
    git(repoDir, ["checkout", "-q", "--orphan", "elsewhere"]);
    const elsewhere = commit(repoDir, "fix: another line of work");
    git(repoDir, ["checkout", "-q", "main"]);
    git(repoDir, ["tag", "v1.0.0", elsewhere]);
    const run = runWith(repoDir, {});

    const refusal = await releaseStep(run.options).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(refusal).toBeInstanceOf(ReleaseFailure);
    expect((refusal as Error).message).toContain("v1.0.0 already names");
    expect((refusal as Error).message).toContain("neither names nor contains");
    expect(run.log.join("\n")).not.toContain("is published");
    expect(run.effects.published.size).toBe(0);
    expect(run.effects.npm.filter((args) => args[0] === "publish")).toEqual([]);
    expect(run.forge.created).toEqual([]);
    expect(run.forge.uploads).toEqual([]);
    expect(head).toBe(git(repoDir, ["rev-parse", "HEAD"]));
  });

  test("a tag at HEAD and a tag containing HEAD are already released", async () => {
    const repoDir = repository("covers");
    const first = commit(repoDir, "feat: first");
    const second = commit(repoDir, "feat: second");
    git(repoDir, ["tag", "v1.0.0", second]);

    const atHead = runWith(repoDir, { releases: new Map([["v1.0.0", second]]) });
    const named = await releaseStep(atHead.options);
    expect(named).toEqual({ version: "1.0.0", tag: "v1.0.0", published: false });
    expect(atHead.log.join("\n")).toContain("nothing to release");
    expect(atHead.effects.npm.filter((args) => args[0] === "publish")).toEqual([]);
    expect(atHead.forge.created).toEqual([]);

    // A concurrent landing released this commit inside a later commit: its tag
    // contains HEAD even though HEAD is not that tag's commit.
    git(repoDir, ["checkout", "-q", first]);
    const containing = new Map([["v1.0.0", second]]);
    const contained = runWith(repoDir, { releases: containing });
    const result = await releaseStep(contained.options);
    expect(result).toEqual({ version: "1.0.0", tag: "v1.0.0", published: false });
    expect(contained.log.join("\n")).toContain("names or contains");
    expect(contained.effects.published.size).toBe(0);
  });
});

describe("release step on a stale checkout", () => {
  test("derives the next version from the forge's release when the tag was never fetched", async () => {
    const repoDir = repository("stale-forge-only");
    commit(repoDir, "feat: base");
    const published = commit(repoDir, "feat: the release the checkout cannot see");
    const head = commit(repoDir, "fix: after that release");
    // This checkout has no origin, so its tag refresh fails and only the
    // forge's published release can name the baseline.
    const releases = new Map([["v1.1.0", published]]);
    const run = runWith(repoDir, { releases });

    const result = await releaseStep(run.options);
    expect(result).toEqual({ version: "1.1.1", tag: "v1.1.1", published: true });
    expect(run.log.join("\n")).toContain("release: v1.1.1 is published");
    const publishCall = run.effects.npm.find((args) => args[0] === "publish");
    expect(publishCall?.[1]).toEndWith("devboard-1.1.1.tgz");
    expect(run.forge.created).toHaveLength(1);
    expect(run.forge.created[0]?.tag).toBe("v1.1.1");
    expect(run.forge.created[0]?.targetCommitish).toBe(head);
    expect(run.forge.uploads).toEqual([
      "devboard-1.1.1.tgz",
      "devboard-1.1.1.tgz.sha256",
    ]);
  });

  test("refreshes its tags from the origin and derives the version after the newest one", async () => {
    const origin = join(scratch("stale-origin"), "origin.git");
    const seed = join(scratch("stale-seed"), "seed");
    mkdirSync(origin, { recursive: true });
    mkdirSync(seed, { recursive: true });
    git(origin, ["init", "-q", "--bare"]);
    git(seed, ["init", "-q"]);
    const base = commit(seed, "feat: base");
    git(seed, ["tag", "v1.0.0", base]);
    git(seed, ["remote", "add", "origin", origin]);
    git(seed, ["push", "-q", "origin", "main", "v1.0.0"]);

    const repoDir = join(scratch("stale-clone"), "repo");
    git(scratch("stale-clone"), ["clone", "-q", "--no-tags", origin, repoDir]);
    const head = commit(repoDir, "fix: after the release");
    expect(git(repoDir, ["tag", "--list"])).toBe("");

    const releases = new Map([["v1.0.0", base]]);
    const run = runWith(repoDir, { releases });
    const result = await releaseStep(run.options);
    expect(result).toEqual({ version: "1.0.1", tag: "v1.0.1", published: true });
    // The refresh brought the tag the checkout was missing.
    expect(git(repoDir, ["tag", "--list"])).toContain("v1.0.0");
    expect(run.forge.created[0]?.targetCommitish).toBe(head);

    // A second run of the same commit publishes nothing new: the version is
    // already on npm and the release already carries both assets.
    const again = runWith(repoDir, {
      releases: new Map([["v1.0.0", base], ["v1.0.1", head]]),
      assets: new Map([
        ["v1.0.1", ["devboard-1.0.1.tgz", "devboard-1.0.1.tgz.sha256"]],
      ]),
      published: ["1.0.1"],
    });
    const repeat = await releaseStep(again.options);
    expect(repeat).toEqual({ version: "1.0.1", tag: "v1.0.1", published: false });
    expect(again.log.join("\n")).toContain(
      "nothing to release; v1.0.1 already names or contains",
    );
    expect(again.effects.npm.filter((args) => args[0] === "publish")).toEqual([]);
    expect(again.forge.created).toEqual([]);
    expect(again.forge.uploads).toEqual([]);
  });
});

describe("release script", () => {
  test("exits nonzero with no is-published line and no publish for an unrelated tag", async () => {
    const base = scratch("script");
    const root = join(base, "checkout");
    mkdirSync(join(root, ".devboard"), { recursive: true });
    for (const entry of ["scripts", "lib", "issues", "server"]) {
      cpSync(join(harnessRoot, entry), join(root, ".devboard", entry), { recursive: true });
    }
    const repoDir = root;
    git(repoDir, ["init", "-q"]);
    commit(repoDir, "fix: the change under release");
    git(repoDir, ["checkout", "-q", "--orphan", "elsewhere"]);
    const elsewhere = commit(repoDir, "fix: another line of work");
    git(repoDir, ["checkout", "-q", "main"]);
    git(repoDir, ["tag", "v1.0.0", elsewhere]);

    const bin = join(base, "bin");
    mkdirSync(bin, { recursive: true });
    const npmLog = join(base, "npm.log");
    writeFileSync(
      join(bin, "npm"),
      `#!/bin/sh\necho "$@" >> ${JSON.stringify(npmLog)}\necho "npm error code E404" >&2\nexit 1\n`,
      { mode: 0o755 },
    );

    const forge = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/releases")) return Response.json([]);
        return Response.json({ message: "not found" }, { status: 404 });
      },
    });
    try {
      // The script must see the same tree it packs and the checkout it
      // releases: it resolves both from its own location.
      const child = Bun.spawn({
        cmd: [process.execPath, join(root, ".devboard", "scripts", "release.ts")],
        cwd: repoDir,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          DEVBOARD_GITEA_URL: `http://127.0.0.1:${forge.port}`,
          GITEA_TOKEN: "test-token",
          DEVBOARD_RELEASE_LOCK: "",
          NPM_TOKEN: "test-token",
        },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode).not.toBe(0);
      expect(stdout).not.toContain("is published");
      expect(stderr).toContain("release: v1.0.0 already names");
      expect(stderr).toContain("refusing to report a release for another commit");
      const npmCalls = existsSync(npmLog) ? readFileSync(npmLog, "utf8") : "";
      expect(npmCalls).not.toContain("publish");
      expect(existsSync(join(root, ".devboard", ".tmp", "release", "devboard-1.0.0.tgz"))).toBe(
        false,
      );
    } finally {
      forge.stop(true);
    }
  }, 60_000);
});
