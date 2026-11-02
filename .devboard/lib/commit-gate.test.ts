import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  checkCommitRange,
  commitLevel,
  commitViolations,
  deriveReleaseVersion,
  isMergeCommit,
  nextReleaseVersion,
  parsePrePush,
  parseSubject,
  previousReleaseTag,
  pushedCommits,
  readCommits,
  releaseLevel,
  subjectRule,
  tagBinding,
  tagCommit,
  type CommitRecord,
} from "./commit-gate";

const testRoot = join(import.meta.dir, "..", ".tmp");
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(name: string): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, `gate-${name}-`));
  roots.push(directory);
  return directory;
}

function git(directory: string, args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Gate Test",
      "-c",
      "user.email=gate@example.test",
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

async function repository(name: string): Promise<string> {
  const directory = await temporaryDirectory(name);
  git(directory, ["init", "-q"]);
  return directory;
}

function commit(directory: string, message: string, body?: string): string {
  const args = ["commit", "--allow-empty", "-q", "-m", message];
  if (body !== undefined) args.push("-m", body);
  git(directory, args);
  return git(directory, ["rev-parse", "HEAD"]);
}

function record(sha: string, subject: string, parents: string[] = ["p"]): CommitRecord {
  return { sha, subject, body: "", parents };
}

describe("subject grammar", () => {
  test("accepts every allowed type, scope, and breaking marker", () => {
    for (const type of [
      "feat",
      "fix",
      "docs",
      "style",
      "refactor",
      "perf",
      "test",
      "build",
      "ci",
      "chore",
      "revert",
    ]) {
      expect(subjectRule(`${type}: describe the change`)).toBeNull();
      expect(subjectRule(`${type}(ui): describe the change`)).toBeNull();
    }
    expect(subjectRule("feat(ui)!: drop the old control")).toBeNull();
    expect(subjectRule("fix(a.b-c_1): scope characters")).toBeNull();
    expect(subjectRule("refactor(api)!: break the shape")).toBeNull();
    expect(parseSubject("feat(ui)!: drop the old control")).toEqual({
      type: "feat",
      scope: "ui",
      breaking: true,
      description: "drop the old control",
    });
  });

  test("rejects every malformed shape and names the broken rule", () => {
    expect(subjectRule("Added export control")).toContain("is not");
    expect(subjectRule("UI(discover): remove it")).toContain("lowercase");
    expect(subjectRule("update(ui): remove it")).toContain("is not one of");
    expect(subjectRule("feat(UI): scope")).toContain("[a-z0-9._-]+");
    expect(subjectRule("feat(): empty scope")).toContain("[a-z0-9._-]+");
    expect(subjectRule("feat(ui):no space")).toContain("is not");
    expect(subjectRule("feat(ui): ")).toContain("non-empty");
    expect(subjectRule("feat(ui): trailing ")).toContain("leading or trailing");
    expect(subjectRule("feat(ui):  leading")).toContain("leading or trailing");
    expect(subjectRule("")).toContain("empty");
  });
});

describe("bump mapping", () => {
  const merge = record("m", "Merge origin/main into issue-1", ["a", "b"]);

  test("a merge commit is exempt from the grammar and the mapping", () => {
    expect(isMergeCommit(merge)).toBe(true);
    expect(commitLevel(merge)).toBeNull();
    expect(commitViolations([merge])).toEqual([]);
  });

  test("major on a bang or a breaking footer, minor on feat, patch otherwise", () => {
    expect(commitLevel(record("1", "feat(api)!: move the prefix"))).toBe("major");
    expect(
      commitLevel({ sha: "2", subject: "fix: keep it", body: "BREAKING CHANGE: moved", parents: ["p"] }),
    ).toBe("major");
    expect(
      commitLevel({ sha: "3", subject: "fix: keep it", body: "BREAKING-CHANGE: moved", parents: ["p"] }),
    ).toBe("major");
    expect(commitLevel(record("4", "feat: add it"))).toBe("minor");
    expect(commitLevel(record("5", "fix: correct it"))).toBe("patch");
    expect(commitLevel(record("6", "Added it"))).toBe("patch");
    expect(releaseLevel([record("7", "fix: one"), record("8", "feat: two")])).toBe("minor");
    expect(releaseLevel([merge])).toBeNull();
  });

  test("version advances the previous release by the highest level", () => {
    expect(nextReleaseVersion("1.2.3", "major")).toBe("2.0.0");
    expect(nextReleaseVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(nextReleaseVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(nextReleaseVersion("1.2.3", null)).toBe("1.2.3");
    expect(nextReleaseVersion(undefined, "major")).toBe("1.0.0");
    expect(nextReleaseVersion("0.1.1176", "minor")).toBe("1.0.0");
    expect(nextReleaseVersion("0.1.1176", null)).toBe("1.0.0");
    expect(() => nextReleaseVersion("1.0", "patch")).toThrow();
  });
});

describe("ranges and release tags", () => {
  test("checks only non-merge commits and derives the version from reachable tags", async () => {
    const directory = await repository("range");
    const base = commit(directory, "feat: first");
    git(directory, ["tag", "v0.1.7", base]);
    const second = commit(directory, "fix: second");

    expect(checkCommitRange(directory, `${base}..${second}`)).toEqual([]);
    const baseline = deriveReleaseVersion(directory, "HEAD");
    expect(baseline.previous).toEqual({ tag: "v0.1.7", version: "0.1.7" });
    expect(baseline.range).toBe("v0.1.7..HEAD");
    expect(baseline.level).toBe("patch");
    expect(baseline.version).toBe("1.0.0");

    git(directory, ["tag", "v1.0.0", second]);
    expect(deriveReleaseVersion(directory, "HEAD").version).toBe("1.0.0");
    expect(previousReleaseTag(directory, "HEAD")).toEqual({ tag: "v1.0.0", version: "1.0.0" });

    const third = commit(directory, "feat(ui): third");
    const minor = deriveReleaseVersion(directory, "HEAD");
    expect(minor.range).toBe("v1.0.0..HEAD");
    expect(minor.version).toBe("1.1.0");
    git(directory, ["tag", "v1.1.0", third]);

    const breaking = commit(
      directory,
      "feat(api): move the prefix",
      "BREAKING CHANGE: installed prefixes move",
    );
    expect(deriveReleaseVersion(directory, "HEAD").version).toBe("2.0.0");

    const merge = git(directory, [
      "commit-tree",
      "HEAD^{tree}",
      "-p",
      "HEAD",
      "-p",
      "HEAD",
      "-m",
      "Merge origin/main into issue-1",
    ]);
    expect(checkCommitRange(directory, `${breaking}..${merge}`)).toEqual([]);
    expect(releaseLevel(readCommits(directory, `${breaking}..${merge}`))).toBeNull();
  });

  test("names each offending commit and the rule it broke", async () => {
    const directory = await repository("bad");
    commit(directory, "chore: base");
    const bad = git(directory, [
      "commit-tree",
      "HEAD^{tree}",
      "-p",
      "HEAD",
      "-m",
      "Added export control",
    ]);
    const violations = checkCommitRange(directory, `HEAD..${bad}`);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.sha).toBe(bad);
    expect(violations[0]?.subject).toBe("Added export control");
    expect(violations[0]?.rule.length).toBeGreaterThan(0);
  });
});

describe("release tag binding", () => {
  test("a tag at HEAD names it, and a tag ahead of HEAD contains it", async () => {
    const directory = await repository("binding");
    const head = commit(directory, "fix: one");
    expect(tagBinding(directory, "v1.0.0")).toBe("absent");
    expect(tagCommit(directory, "v1.0.0")).toBeUndefined();

    git(directory, ["tag", "v1.0.0", head]);
    expect(tagBinding(directory, "v1.0.0")).toBe("names");
    expect(tagCommit(directory, "v1.0.0")).toBe(head);

    // A concurrent landing released this commit inside a later one.
    const later = commit(directory, "feat: two");
    git(directory, ["tag", "v1.1.0", later]);
    expect(tagBinding(directory, "v1.1.0", head)).toBe("contains");
    // A tag behind HEAD is the ordinary older release a new version follows.
    expect(tagBinding(directory, "v1.0.0", "HEAD")).toBe("behind");
  });

  test("a tag made for an unrelated commit is neither a name nor a containment", async () => {
    const directory = await repository("binding-unrelated");
    const main = commit(directory, "fix: main");
    git(directory, ["checkout", "-q", "--orphan", "elsewhere"]);
    const orphan = commit(directory, "fix: elsewhere");
    git(directory, ["checkout", "-q", "main"]);
    git(directory, ["tag", "v1.0.1", orphan]);

    expect(tagCommit(directory, "v1.0.1")).toBe(orphan);
    expect(tagBinding(directory, "v1.0.1", main)).toBe("unrelated");
    expect(tagBinding(directory, "v1.0.1", "HEAD")).toBe("unrelated");
  });
});

describe("pre-push candidates", () => {
  test("checks the commits the push adds that no remote already has", async () => {
    const root = await temporaryDirectory("push");
    const remote = join(root, "remote.git");
    git(root, ["init", "--bare", "-q", remote]);
    const directory = join(root, "work");
    await mkdir(directory, { recursive: true });
    git(directory, ["init", "-q"]);
    const base = commit(directory, "chore: base");
    git(directory, ["remote", "add", "origin", remote]);
    git(directory, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    git(directory, ["fetch", "-q", "origin"]);

    const bad = commit(directory, "Bad message");
    const refs = parsePrePush(
      `refs/heads/main ${bad} refs/heads/main ${base}\n` +
        `${"0".repeat(40)} ${"0".repeat(40)} refs/heads/gone ${"0".repeat(40)}\n`,
    );
    expect(refs).toHaveLength(2);
    const candidates = pushedCommits(directory, refs);
    expect(candidates.map((candidate) => candidate.sha)).toEqual([bad]);
    expect(commitViolations(candidates)).toHaveLength(1);

    const good = git(directory, [
      "commit-tree",
      "HEAD^{tree}",
      "-p",
      base,
      "-m",
      "fix(gate): accept the subject",
    ]);
    const rewritten = parsePrePush(
      `refs/heads/main ${good} refs/heads/main ${base}\n`,
    );
    expect(commitViolations(pushedCommits(directory, rewritten))).toEqual([]);
  });

  test("a new destination ref still excludes commits a remote already has", async () => {
    const root = await temporaryDirectory("new-ref");
    const remote = join(root, "remote.git");
    git(root, ["init", "--bare", "-q", remote]);
    const directory = join(root, "work");
    await mkdir(directory, { recursive: true });
    git(directory, ["init", "-q"]);
    commit(directory, "chore: already published");
    git(directory, ["remote", "add", "origin", remote]);
    git(directory, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    git(directory, ["fetch", "-q", "origin"]);
    const added = commit(directory, "feat: new work");

    const refs = parsePrePush(
      `refs/heads/topic ${added} refs/heads/main ${"0".repeat(40)}\n`,
    );
    expect(
      pushedCommits(directory, refs).map((candidate) => candidate.sha),
    ).toEqual([added]);
  });
});
