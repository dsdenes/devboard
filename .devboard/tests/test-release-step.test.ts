import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative as relativePath, resolve } from "node:path";

/**
 * The suite step as the workflow runs it: `bun run test:release` drives a real
 * bun suite against the stub forge, quarantines the failing test, files one
 * issue, and leaves the checkout's file byte-identical. A second run comments
 * on the same issue instead of filing another.
 */

const harnessRoot = resolve(import.meta.dir, "..");
const testRoot = join(harnessRoot, ".tmp");
const stubPath = join(harnessRoot, "tests", "fixtures", "quarantine-stub-forge.ts");
const roots: string[] = [];
const stubs: Bun.Subprocess[] = [];

afterAll(() => {
  for (const stub of stubs) stub.kill();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function startStub(statePath: string): Promise<number> {
  const stub = Bun.spawn({
    cmd: [process.execPath, stubPath],
    env: { ...process.env, PORT: "0", QUARANTINE_STUB_FORGE_STATE: statePath },
    stdout: "pipe",
    stderr: "pipe",
  });
  stubs.push(stub);
  const reader = stub.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (!output.includes("quarantine-stub-forge ")) {
      const { value, done } = await reader.read();
      if (done) break;
      output += decoder.decode(value);
    }
  } finally {
    reader.releaseLock();
  }
  const match = /quarantine-stub-forge (\d+)/.exec(output);
  if (match?.[1] === undefined) throw new Error(`the stub forge did not start: ${output}`);
  return Number(match[1]);
}

interface StubIssue {
  number: number;
  title: string;
  body: string;
  comments: { body: string }[];
}

test(
  "the release suite step quarantines a persistent failure, files once, and restores its copy",
  async () => {
    const root = join(testRoot, `quarantine-integration-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    mkdirSync(root, { recursive: true });
    const statePath = join(root, "state.json");
    const suitePath = join(root, "always.test.ts");
    const source = [
      'import { expect, test } from "bun:test";',
      "",
      'test("always fails: integration fixture", () => {',
      "  expect(1).toBe(2);",
      "});",
      "",
      'test("always passes: integration fixture", () => {',
      "  expect(1).toBe(1);",
      "});",
      "",
    ].join("\n");
    writeFileSync(suitePath, source);
    const port = await startStub(statePath);
    const suiteFile = relativePath(harnessRoot, suitePath);
    const suiteArgument = `./${suiteFile}`;
    const commit = Bun.spawnSync({
      cmd: ["git", "-C", harnessRoot, "rev-parse", "HEAD"],
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
    const environment = {
      ...process.env,
      DEVBOARD_GITEA_URL: `http://127.0.0.1:${port}`,
      DEVBOARD_GITEA_TOKEN: "fixture",
      GITHUB_SERVER_URL: "http://forge.test",
      GITHUB_REPOSITORY: "dsdenes/devboard",
      GITHUB_RUN_ID: "77",
    };
    const first = Bun.spawnSync({
      cmd: [process.execPath, "run", "test:release", "--", suiteArgument],
      cwd: harnessRoot,
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const firstOutput = `${first.stdout.toString()}\n${first.stderr.toString()}`;
    expect(first.exitCode).toBe(0);
    expect(firstOutput).toContain("attempt 1/9: 1 fail, 1 pass, 0 skip");
    expect(firstOutput).toContain(`quarantined: ${suiteFile} :: always fails: integration fixture`);
    expect(firstOutput).toContain("attempt 4/9: 0 fail, 1 pass, 1 skip");
    expect(firstOutput).toContain("release suite: 4 attempt(s), 1 quarantined, 0 fail");
    expect(firstOutput).toContain("filed issue #1");
    expect(readFileSync(suitePath, "utf8")).toBe(source);

    const afterFirst = JSON.parse(readFileSync(statePath, "utf8")) as { issues: StubIssue[] };
    expect(afterFirst.issues.length).toBe(1);
    const issue = afterFirst.issues[0]!;
    expect(issue.title).toContain("always fails: integration fixture");
    expect(issue.title.length).toBeLessThanOrEqual(200);
    expect(issue.body).toContain(suiteFile);
    expect(issue.body).toContain("always fails: integration fixture");
    expect(issue.body).toContain("AssertionError");
    expect(issue.body).toContain("http://forge.test/dsdenes/devboard/actions/runs/77");
    expect(issue.body.match(/### attempt/g)?.length).toBe(3);
    expect(issue.body).toContain(commit);

    const second = Bun.spawnSync({
      cmd: [process.execPath, "run", "test:release", "--", suiteArgument],
      cwd: harnessRoot,
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const secondOutput = `${second.stdout.toString()}\n${second.stderr.toString()}`;
    expect(second.exitCode).toBe(0);
    expect(secondOutput).toContain("commented on issue #1");
    expect(secondOutput).not.toContain("filed issue #2");
    const afterSecond = JSON.parse(readFileSync(statePath, "utf8")) as { issues: StubIssue[] };
    expect(afterSecond.issues.length).toBe(1);
    expect(afterSecond.issues[0]?.comments.length).toBe(1);
    expect(afterSecond.issues[0]?.comments[0]?.body).toContain(
      "http://forge.test/dsdenes/devboard/actions/runs/77",
    );
    expect(readFileSync(suitePath, "utf8")).toBe(source);
  },
  120_000,
);
