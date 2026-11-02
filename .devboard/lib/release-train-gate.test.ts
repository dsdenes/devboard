import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkReleaseTrain,
  releaseTrainGit,
  type GitOutcome,
} from "./release-train-gate";

/**
 * The Release Train gate against real Git repositories: each fixture has a
 * bare `origin`, a `main` branch, and release tags. The cases are the ones the
 * train must distinguish — already released, one fix, merge-only, a whole
 * range, and an unreadable remote or tag.
 */

const harnessRoot = join(import.meta.dir, "..");
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function command(cwd: string, args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Release Train Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Release Train Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString().trim() || result.exitCode}`,
    );
  }
  return result.stdout.toString().trim();
}

interface Fixture {
  root: string;
  repo: string;
  origin: string;
}

function fixture(name: string): Fixture {
  const base = join(harnessRoot, ".tmp");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, `release-train-gate-${name}-`));
  roots.push(root);
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  command(root, ["init", "--bare", "-q", origin]);
  mkdirSync(repo);
  command(repo, ["init", "-q"]);
  command(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync(join(repo, "app.txt"), "one\n");
  command(repo, ["add", "app.txt"]);
  command(repo, ["commit", "-q", "-m", "chore: initial commit"]);
  command(repo, ["tag", "v1.0.0"]);
  command(repo, ["remote", "add", "origin", origin]);
  command(repo, ["push", "-q", "-u", "origin", "main", "--tags"]);
  return { root, repo, origin };
}

function commit(repo: string, subject: string): string {
  writeFileSync(join(repo, "app.txt"), `${subject}\n`);
  command(repo, ["add", "app.txt"]);
  command(repo, ["commit", "-q", "-m", subject]);
  command(repo, ["push", "-q", "origin", "main"]);
  return command(repo, ["rev-parse", "HEAD"]);
}

describe("release train gate", () => {
  test("a newest tag at the branch tip means nothing to release", () => {
    const { repo } = fixture("released");
    const gate = checkReleaseTrain(repo);
    expect(gate.state).toBe("nothing");
    if (gate.state !== "nothing") return;
    expect(gate.previous).toEqual({ tag: "v1.0.0", version: "1.0.0" });
    expect(gate.target).toBe(command(repo, ["rev-parse", "origin/main"]));
    expect(gate.range).toBe(`v1.0.0..${gate.target}`);
  });

  test("one fix commit after the newest tag is unreleased", () => {
    const { repo } = fixture("one-fix");
    const sha = commit(repo, "fix: correct the release gate");
    const gate = checkReleaseTrain(repo);
    expect(gate.state).toBe("unreleased");
    if (gate.state !== "unreleased") return;
    expect(gate.target).toBe(sha);
    expect(gate.version).toBe("1.0.1");
    expect(gate.releaseCommits).toHaveLength(1);
    expect(gate.releaseCommits[0]).toEqual({
      sha,
      subject: "fix: correct the release gate",
      merge: false,
    });
  });

  test("only merge commits after the tag release nothing", () => {
    const { repo } = fixture("merge-only");
    const tree = command(repo, ["rev-parse", "HEAD^{tree}"]);
    const merge = command(repo, [
      "commit-tree",
      tree,
      "-p",
      "HEAD",
      "-p",
      "HEAD",
      "-m",
      "Merge branch 'already-released'",
    ]);
    command(repo, ["reset", "--hard", merge]);
    command(repo, ["push", "-q", "origin", "main"]);
    const gate = checkReleaseTrain(repo);
    expect(gate.state).toBe("nothing");
  });

  test("several commits after an older tag hand over the whole range", () => {
    const { repo } = fixture("range");
    const first = commit(repo, "fix: first correction");
    const second = commit(repo, "feat: add the second behavior");
    const gate = checkReleaseTrain(repo);
    expect(gate.state).toBe("unreleased");
    if (gate.state !== "unreleased") return;
    expect(gate.version).toBe("1.1.0");
    expect(gate.range).toBe(`v1.0.0..${second}`);
    expect(gate.releaseCommits.map((entry) => entry.sha)).toEqual([second, first]);
  });

  test("an unreadable remote is a reported failure, never nothing to release", () => {
    const { repo, root } = fixture("bad-remote");
    command(repo, ["remote", "set-url", "origin", join(root, "missing.git")]);
    const gate = checkReleaseTrain(repo);
    expect(gate.state).toBe("error");
    if (gate.state !== "error") return;
    expect(gate.detail).toContain("could not fetch origin/main");
  });

  test("an unreadable tag list is a reported failure, never nothing to release", () => {
    const { repo } = fixture("bad-tag");
    const real = releaseTrainGit(repo);
    const gate = checkReleaseTrain(repo, {
      run: (args): GitOutcome =>
        args[0] === "tag"
          ? { code: 1, stdout: "", stderr: "fatal: cannot read the tag list" }
          : real(args),
    });
    expect(gate.state).toBe("error");
    if (gate.state !== "error") return;
    expect(gate.detail).toContain("could not read the release tags");
    expect(gate.detail).toContain("cannot read the tag list");
  });
});
