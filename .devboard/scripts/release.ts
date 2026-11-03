#!/usr/bin/env bun
/**
 * Publishes one Devboard release from a `main` commit.
 *
 * The version is semver derived from the newest release tag reachable from
 * `HEAD` and the Conventional Commits after it: `1.0.0` while no release has
 * reached that baseline, then the highest bump the range carries. The release
 * step checks the same grammar before it packs anything, so a malformed commit
 * that reached `main` through `--no-verify` cannot release. One public npm
 * package carries the launcher, server, client sources, built bundle, prompts,
 * wrappers, extensions, templates, and installer. The canonical Gitea release
 * records the same tag with notes plus the npm tarball and its `.sha256`, kept
 * as a fallback when npm cannot serve the artifact. Re-running the same commit
 * is a no-op.
 *
 * Two rules keep a reported release honest. First, the checkout's release tags
 * are refreshed from the forge before anything is derived, and when the derived
 * version is not newer than the forge's newest published release the range is
 * re-derived from that release's commit: a checkout that predates the newest
 * tag publishes the next version instead of re-deriving one that is already
 * out. Second, a tag the step would report must name `HEAD` or contain it; a
 * tag made for an unrelated commit is a refusal, never a success line.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configuredGiteaToken, configuredGiteaUrl, parseForgeRemote } from "../lib/forge";
import {
  GiteaError,
  giteaCreateRelease,
  giteaListReleases,
  giteaReleaseByTag,
  giteaTagRefCommit,
  giteaUploadAsset,
  type CreateReleaseInput,
  type GiteaReleaseDocument,
  type GiteaTarget,
} from "../lib/gitea";
import { acquireLock } from "../issues/lock";
import {
  commitNamesOrContains,
  deriveReleaseVersion,
  nextReleaseVersion,
  readCommits,
  releaseLevel,
  tagBinding,
  tagCommit,
  type ReleaseDerivation,
} from "../lib/commit-gate";
import { compareReleaseVersions, highestReleaseVersion, publishTagFor } from "../lib/release";
import {
  createReleaseDirectory,
  harnessRoot as defaultHarnessRoot,
  repoRoot as defaultRepoRoot,
} from "./harness-package";

const RELEASE_REPO = "dsdenes/devboard";
const PACKAGE_NAME = "@dsdenes/devboard";

/**
 * Serialisation across concurrent jobs of one runner. The release step mutates
 * one npm package and one Gitea release list, so two jobs publishing at once
 * must take turns. The path is host-provided; without it the step still works,
 * but a runner that executes releases in parallel must set it.
 */
const releaseLockVariable = "DEVBOARD_RELEASE_LOCK";
const releaseLockWaitMs = 10 * 60_000;

/**
 * How long the step waits for npm to serve the version it just published. npm
 * acknowledges a publish with "Your package is being processed and may take a
 * few minutes to become available" and serves it minutes later, so the release
 * is verified, not assumed, before the forge release is created.
 */
const publishVisibilityMs = 15 * 60_000;

export interface ReleaseCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one external command; injected by the tests so npm and git are stubs. */
export type ReleaseRun = (
  command: string,
  args: string[],
  cwd?: string,
) => ReleaseCommandResult;

/** The forge reads and writes one release needs. */
export interface ReleaseForge {
  /** Every published release version this repository records. */
  publishedVersions(): Promise<string[]>;
  releaseByTag(tag: string): Promise<GiteaReleaseDocument | undefined>;
  createRelease(input: CreateReleaseInput): Promise<GiteaReleaseDocument>;
  uploadAsset(id: number, name: string, bytes: Uint8Array): Promise<void>;
  /** The commit a tag names on the forge, for a tag this checkout never fetched. */
  tagCommit(tag: string): Promise<string | undefined>;
}

export interface ReleaseStepOptions {
  /** The host repository the release is cut from; defaults to the checkout. */
  repoDir?: string;
  /** The harness tree that is packed; defaults to this script's parent. */
  harnessRoot?: string;
  /** Where the tarball is built; defaults to `<harness>/.tmp/release`. */
  releaseRoot?: string;
  /** npm's private cache; defaults to `<harness>/.tmp/npm-cache`. */
  npmCache?: string;
  environment?: Record<string, string | undefined>;
  run?: ReleaseRun;
  pack?: (version: string, directory: string) => Promise<{ tarball: string; checksum: string }>;
  forge?: ReleaseForge;
  log?: (line: string) => void;
}

export interface ReleaseStepResult {
  version: string;
  tag: string;
  /** False when an existing release already covered this commit. */
  published: boolean;
}

/** A refusal the step reports as `release: <message>` and a nonzero exit. */
export class ReleaseFailure extends Error {}

function defaultRun(command: string, args: string[], cwd: string): ReleaseCommandResult {
  const child = Bun.spawnSync({
    cmd: [command, ...args],
    cwd,
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  return {
    code: child.exitCode ?? 1,
    stdout: child.stdout.toString().trim(),
    stderr: child.stderr.toString().trim(),
  };
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

function releaseTarget(
  run: ReleaseRun,
  repoDir: string,
  environment: Record<string, string | undefined>,
): GiteaTarget {
  let baseUrl = configuredGiteaUrl(environment);
  if (baseUrl === undefined) {
    const origin = run("git", ["remote", "get-url", "origin"], repoDir);
    if (origin.code === 0) baseUrl = parseForgeRemote(origin.stdout)?.originUrl;
  }
  if (baseUrl === undefined) {
    throw new ReleaseFailure("the Gitea address is not configured; set DEVBOARD_GITEA_URL");
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    project: environment.DEVBOARD_RELEASE_REPO ?? RELEASE_REPO,
    ...(configuredGiteaToken(environment) === undefined
      ? {}
      : { token: configuredGiteaToken(environment) }),
  };
}

/** Every release version the forge records, with the `v` stripped. */
async function forgePublishedVersions(target: GiteaTarget): Promise<string[]> {
  const versions: string[] = [];
  for (const release of await giteaListReleases(target)) {
    if (/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(release.tag)) versions.push(release.tag.slice(1));
  }
  return versions;
}

function giteaForge(target: GiteaTarget): ReleaseForge {
  return {
    publishedVersions: () => forgePublishedVersions(target),
    releaseByTag: (tag) => giteaReleaseByTag(target, tag),
    createRelease: (input) => giteaCreateRelease(target, input),
    async uploadAsset(id, name, bytes) {
      await giteaUploadAsset(target, id, name, bytes);
    },
    tagCommit: (tag) => giteaTagRefCommit(target, tag),
  };
}

/**
 * Re-derives the release from the forge's newest published version. The
 * checkout's own tags are missing it — it predates the tag — so its commit
 * comes from the local tag when the refresh brought one, and from the forge's
 * tag ref otherwise. The range is that commit exclusive, so this run publishes
 * the commits after the release the checkout could not see.
 */
async function rederiveFromPublished(options: {
  repoDir: string;
  head: string;
  newest: string;
  forge: ReleaseForge;
  refreshProblem: string | undefined;
}): Promise<ReleaseDerivation> {
  const tag = `v${options.newest}`;
  const local = tagCommit(options.repoDir, tag);
  const commit =
    local ?? (await options.forge.tagCommit(tag).catch(() => undefined));
  if (commit === undefined) {
    throw new ReleaseFailure(
      `the newest published release ${tag} is not in this checkout and its commit could not ` +
        `be read; ${options.refreshProblem ?? "fetch the release tags and run the release again"}`,
    );
  }
  const range = `${commit}..${options.head}`;
  let commits;
  try {
    commits = readCommits(options.repoDir, range);
  } catch {
    throw new ReleaseFailure(
      `the newest published release ${tag} names ${commit.slice(0, 7)}, which this checkout ` +
        `cannot read; ` +
        (options.refreshProblem ?? "fetch the release tags and run the release again"),
    );
  }
  const level = releaseLevel(commits);
  return {
    version: nextReleaseVersion(options.newest, level),
    previous: { tag, version: options.newest },
    level,
    range,
    commits,
  };
}

/**
 * Runs one release while holding the cross-job lock, when one is configured.
 * The lock covers the npm publish and the release creation together, so the
 * next queued release sees this version before it chooses its dist-tag.
 */
async function withReleaseLock<T>(options: {
  run: ReleaseRun;
  repoDir: string;
  harnessRoot: string;
  environment: Record<string, string | undefined>;
  log: (line: string) => void;
  work: () => Promise<T>;
}): Promise<T> {
  const path = options.environment[releaseLockVariable]?.trim();
  if (path === undefined || path.length === 0) return await options.work();
  const deadline = Date.now() + releaseLockWaitMs;
  let announced = false;
  for (;;) {
    const lock = acquireLock(path, {
      repo: options.repoDir,
      stateDir: options.harnessRoot,
      harnessVersion: null,
      argv: process.argv,
    });
    if (lock.acquired) {
      try {
        return await options.work();
      } finally {
        lock.release();
      }
    }
    if (Date.now() >= deadline) {
      throw new ReleaseFailure(`timed out waiting for the release lock at ${path}`);
    }
    if (!announced) {
      options.log(`release: waiting for the release lock at ${path}`);
      announced = true;
    }
    await Bun.sleep(500);
  }
}

/** One release, from the derived version to the reported line. */
export async function releaseStep(options: ReleaseStepOptions = {}): Promise<ReleaseStepResult> {
  const repoDir = options.repoDir ?? defaultRepoRoot;
  const harnessRoot = options.harnessRoot ?? defaultHarnessRoot;
  const releaseRoot = options.releaseRoot ?? join(harnessRoot, ".tmp", "release");
  const npmCache = options.npmCache ?? join(harnessRoot, ".tmp", "npm-cache");
  const environment = options.environment ?? process.env;
  const run: ReleaseRun =
    options.run ?? ((command, args, cwd) => defaultRun(command, args, cwd ?? harnessRoot));
  const log = options.log ?? ((line: string) => console.log(line));
  const pack = options.pack ?? createReleaseDirectory;
  const token = configuredGiteaToken(environment);

  /** True when npm already serves this exact version. */
  const packageExists = (version: string): boolean => {
    const result = run(
      "npm",
      [
        "view",
        `${PACKAGE_NAME}@${version}`,
        "version",
        "--cache",
        npmCache,
        "--prefer-online",
      ],
      harnessRoot,
    );
    return result.code === 0 && result.stdout === version;
  };

  /** npm's `latest` dist-tag, or undefined while the package has none. */
  const npmLatestTag = (): string | undefined => {
    const result = run(
      "npm",
      ["view", PACKAGE_NAME, "dist-tags.latest", "--cache", npmCache, "--prefer-online"],
      harnessRoot,
    );
    if (result.code !== 0) return undefined;
    const lines = result.stdout.trim().split("\n").filter((line) => line.trim().length > 0);
    const latest = lines.at(-1)?.trim() ?? "";
    return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(latest) ? latest : undefined;
  };

  const forge = options.forge ?? giteaForge(releaseTarget(run, repoDir, environment));
  /** The highest version already published to npm or recorded as a release. */
  const newestPublishedVersion = async (): Promise<string | undefined> => {
    const versions = await forge.publishedVersions();
    const latest = npmLatestTag();
    if (latest !== undefined) versions.push(latest);
    return highestReleaseVersion(versions);
  };

  const head = run("git", ["rev-parse", "HEAD"], repoDir);
  if (head.code !== 0) throw new ReleaseFailure("could not read HEAD");
  const headSha = head.stdout;

  // Refresh the release tags before deriving anything: a checkout that never
  // fetched the newest tag would otherwise re-derive a version that is already
  // out and report it for a commit it does not carry. A failed refresh is not
  // fatal by itself; it is reported when it leaves the newest release
  // unreachable.
  const refreshed = run("git", ["fetch", "--quiet", "--tags", "--force", "origin"], repoDir);
  const refreshProblem =
    refreshed.code === 0
      ? undefined
      : `could not refresh the release tags: ${firstLine(refreshed.stderr || refreshed.stdout)}`;

  const newest = await newestPublishedVersion();
  let derivation: ReleaseDerivation;
  try {
    derivation = deriveReleaseVersion(repoDir, headSha);
  } catch (error) {
    throw new ReleaseFailure(error instanceof Error ? error.message : String(error));
  }
  if (newest !== undefined) {
    const order = compareReleaseVersions(derivation.version, newest);
    if (order === undefined) {
      throw new ReleaseFailure(`cannot order ${derivation.version} against ${newest}`);
    }
    // The checkout derives a version the forge already published: its tags are
    // stale. Re-derive from that release's commit so this run publishes the
    // next version instead.
    if (order <= 0) {
      derivation = await rederiveFromPublished({
        repoDir,
        head: headSha,
        newest,
        forge,
        refreshProblem,
      });
    }
  }

  const version = derivation.version;
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    throw new ReleaseFailure(`computed an invalid version: ${version}`);
  }
  const tag = `v${version}`;

  // The reported release must be this commit's: the tag has to name `HEAD` or
  // contain it, and a tag made for an unrelated commit is a refusal before
  // anything is packed or published.
  const binding = tagBinding(repoDir, tag, headSha);
  if (binding === "unrelated") {
    const named = tagCommit(repoDir, tag) ?? "";
    throw new ReleaseFailure(
      `${tag} already names ${named.slice(0, 7)}, which neither names nor contains ` +
        `${headSha.slice(0, 7)}; refusing to report a release for another commit`,
    );
  }
  if (binding !== "absent") {
    log(
      `release: nothing to release; ${tag} already ${
        binding === "behind" ? "covers" : "names or contains"
      } ${headSha.slice(0, 7)}`,
    );
    return { version, tag, published: false };
  }
  // The tag may exist only on the forge: a stale checkout cannot see it. A
  // release that already answers for this version and carries this commit is
  // the same no-op, and one made for another commit is the same refusal.
  const forgeCommit = await forge.tagCommit(tag).catch(() => undefined);
  if (forgeCommit !== undefined) {
    if (!commitNamesOrContains(repoDir, forgeCommit, headSha)) {
      throw new ReleaseFailure(
        `${tag} already names ${forgeCommit.slice(0, 7)}, which neither names nor contains ` +
          `${headSha.slice(0, 7)}; refusing to report a release for another commit`,
      );
    }
    log(`release: nothing to release; ${tag} already names or contains ${headSha.slice(0, 7)}`);
    return { version, tag, published: false };
  }

  // The gate runs over exactly the range this release would publish, before the
  // tarball is packed and before anything reaches npm or Gitea. A push made with
  // --no-verify therefore cannot release.
  const gate = run(
    "bun",
    [join(harnessRoot, "scripts", "commit-gate.ts"), "check", derivation.range],
    repoDir,
  );
  if (gate.code !== 0) {
    if (gate.stdout.length > 0) console.error(gate.stdout);
    if (gate.stderr.length > 0) console.error(gate.stderr);
    throw new ReleaseFailure(`the commits in ${derivation.range} are not Conventional Commits`);
  }

  log(`release: ${tag} at ${headSha.slice(0, 7)}`);

  await rm(releaseRoot, { recursive: true, force: true });
  await mkdir(releaseRoot, { recursive: true });
  const { tarball, checksum } = await pack(version, releaseRoot);
  log(`release: packed ${tarball}`);

  await withReleaseLock({
    run,
    repoDir,
    harnessRoot,
    environment,
    log,
    work: async () => {
      const newestNow = await newestPublishedVersion();
      if (packageExists(version)) {
        log(`release: ${PACKAGE_NAME}@${version} already exists on npm; skipping publish`);
      } else {
        if (environment.NPM_TOKEN === undefined && environment.NODE_AUTH_TOKEN === undefined) {
          throw new ReleaseFailure(
            "no npm token in NPM_TOKEN or NODE_AUTH_TOKEN; cannot publish the package",
          );
        }
        // npm refuses to move `latest` backwards, so a release with a newer one
        // already published must name a side tag instead of taking the default.
        const distTag = publishTagFor(version, newestNow);
        log(`release: publishing ${PACKAGE_NAME}@${version} under the ${distTag} tag`);
        // npm reads ~/.npmrc, which can hold a stale token that shadows the
        // release credential. Use an explicit, private userconfig for this
        // publish instead.
        const npmToken = environment.NPM_TOKEN ?? environment.NODE_AUTH_TOKEN ?? "";
        const npmrc = join(releaseRoot, "npmrc");
        await writeFile(npmrc, `//registry.npmjs.org/:_authToken=${npmToken}\n`, { mode: 0o600 });
        const published = run(
          "npm",
          ["publish", tarball, "--access", "public", "--tag", distTag, "--userconfig", npmrc],
          harnessRoot,
        );
        await rm(npmrc, { force: true });
        if (published.code !== 0) {
          const detail = published.stderr.split("\n").slice(-3).join(" ");
          if (!/previously published version|cannot publish over/i.test(detail)) {
            throw new ReleaseFailure(`npm publish failed: ${detail}`);
          }
          log(`release: ${PACKAGE_NAME}@${version} is already in npm's registry`);
        } else {
          // npm keeps its notices on stderr and its exit code is the only other
          // signal, so the last line records what the publish actually did.
          const note = published.stderr
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .at(-1);
          log(`release: npm answered ${note === undefined ? "with no output" : note}`);
        }
      }

      // The release is only real when npm serves the version. Verifying before
      // the forge record keeps a publish that never reached the registry from
      // producing a release no install can resolve.
      const visibleBy = Date.now() + publishVisibilityMs;
      let waiting = false;
      while (!packageExists(version)) {
        if (!waiting) {
          log(`release: npm is still processing ${PACKAGE_NAME}@${version}; waiting for it`);
          waiting = true;
        }
        if (Date.now() >= visibleBy) {
          throw new ReleaseFailure(`npm does not serve ${PACKAGE_NAME}@${version} after the publish`);
        }
        await Bun.sleep(2_000);
      }

      let existing: GiteaReleaseDocument | undefined;
      try {
        existing = await forge.releaseByTag(tag);
      } catch (error) {
        throw new ReleaseFailure(error instanceof GiteaError ? error.message : String(error));
      }
      const assets = new Set((existing?.assets ?? []).map((asset) => asset.name));
      const names = [tarball, checksum].map((path) => path.split("/").pop() ?? "");

      if (existing !== undefined) {
        // A release that already carries this tag may have been made for
        // another commit. Reusing it is only honest when its tag names `HEAD`
        // or contains it.
        const named = await forge.tagCommit(tag).catch(() => undefined);
        if (!commitNamesOrContains(repoDir, named, headSha)) {
          throw new ReleaseFailure(
            `${tag} already names ${
              named === undefined ? "a commit this step cannot read" : named.slice(0, 7)
            }, which neither names nor contains ${headSha.slice(0, 7)}; the existing release ` +
              "does not carry this commit",
          );
        }
        const missing = names.filter((name) => !assets.has(name));
        if (missing.length > 0) {
          if (token === undefined) {
            throw new ReleaseFailure("GITEA_TOKEN is required to add a missing release asset");
          }
          if (existing.id === undefined) throw new ReleaseFailure(`release ${tag} has no identifier`);
          for (const name of missing) {
            const path = name === names[0] ? tarball : checksum;
            await forge.uploadAsset(existing.id, name, await readFile(path));
            log(`release: uploaded missing asset ${name}`);
          }
        } else {
          log(`release: ${tag} already exists; its assets are intact`);
        }
      } else {
        if (token === undefined) throw new ReleaseFailure("GITEA_TOKEN is required to create a release");
        const created = await forge.createRelease({
          tag,
          title: `Devboard ${version}`,
          notes:
            `Devboard ${version}\n\n` +
            `npm: ${PACKAGE_NAME}@${version}\n` +
            `Fallback: the attached tarball and its .sha256`,
          // The tag names the commit this release packed, never whatever `main`
          // points at when the record is created; a concurrent push must not
          // move the release to another commit.
          targetCommitish: headSha,
        });
        if (created.id === undefined) throw new ReleaseFailure("the created release has no identifier");
        await forge.uploadAsset(created.id, names[0] ?? "", await readFile(tarball));
        await forge.uploadAsset(created.id, names[1] ?? "", await readFile(checksum));
        log(`release: created ${tag} with the tarball and checksum`);
      }
    },
  });

  log(`release: v${version} is published`);
  return { version, tag, published: true };
}

if (import.meta.main) {
  try {
    await releaseStep();
  } catch (error) {
    console.error(`release: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
