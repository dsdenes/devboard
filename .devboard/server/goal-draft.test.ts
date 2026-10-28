import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  GoalDraftError,
  GoalDraftManager,
  goalDraftHeading,
  listGoalDrafts,
  readGoalDraft,
  resolveGoalDraft,
} from "../server/goal-drafts";
import { goalDraftStateDirectory, readGoalDraftOwnerState } from "../server/goal-draft-owner";

/**
 * Draft reads and the one detached elaboration owner. Every fixture lives
 * under `.devboard/.tmp`; the peer is the deterministic stub agent and no
 * agent, GitHub object, or file outside the fixture is touched.
 */

const harnessRoot = resolve(import.meta.dir, "..");
const testRoot = join(harnessRoot, ".tmp");
const stubAgent = join(harnessRoot, "server", "fixtures", "stub-agent.ts");
const temporaryDirectories: string[] = [];
const managers: GoalDraftManager[] = [];

afterAll(async () => {
  for (const manager of managers) manager.dispose();
  // Give each interrupted owner its check interval to end its peer.
  await Bun.sleep(750);
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ root: string; drafts: string; stateDir: string; log: string }> {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "goal-drafts-"));
  temporaryDirectories.push(root);
  const drafts = join(root, ".devboard", "goal-proposals");
  await mkdir(drafts, { recursive: true });
  const stateDir = join(root, "state");
  await mkdir(stateDir, { recursive: true });
  return { root, drafts, stateDir, log: join(root, "agent.log") };
}

function draftText(heading: string, body: string): string {
  return `# ${heading}\n\n> Unprocessed draft.\n\n${body}\n`;
}

function managerFor(
  root: string,
  stateDir: string,
  log: string,
  environment: () => Promise<Record<string, string | undefined>> = async () => ({
    ...process.env,
  }),
): GoalDraftManager {
  const manager = new GoalDraftManager({
    repoDir: root,
    stateDir,
    command: `bun ${stubAgent} --log=${log} --goal-draft`,
    environment,
    send: () => undefined,
  });
  managers.push(manager);
  return manager;
}

function logLines(log: string): string[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

function startPids(log: string): number[] {
  return logLines(log)
    .filter((line) => line.startsWith("goal-draft-start "))
    .map((line) => Number(line.slice("goal-draft-start ".length)));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(
  read: () => T | undefined,
  description: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await Bun.sleep(20);
  }
}

describe("draft listing and reading", () => {
  test("lists regular direct .md files sorted by name with their first heading", async () => {
    const { root, drafts } = await fixture();
    writeFileSync(join(drafts, "beta.md"), draftText("Beta heading", "Beta body"));
    writeFileSync(join(drafts, "alpha.md"), draftText("Alpha heading", "Alpha body"));
    writeFileSync(join(drafts, "notes.txt"), "not a draft\n");
    await mkdir(join(drafts, "nested.md"), { recursive: true });

    const listed = listGoalDrafts(root);
    expect(listed.map((draft) => draft.name)).toEqual(["alpha.md", "beta.md"]);
    expect(listed[0]).toEqual({
      path: ".devboard/goal-proposals/alpha.md",
      name: "alpha.md",
      heading: "Alpha heading",
    });
    expect(goalDraftHeading("no heading\n## Second\n")).toBe("Second");

    const read = readGoalDraft(root, ".devboard/goal-proposals/alpha.md");
    expect(read.text).toBe(draftText("Alpha heading", "Alpha body"));
    expect(read.heading).toBe("Alpha heading");
  });

  test("refuses traversal, absolute paths, directories, symlink escapes, and missing files", async () => {
    const { root, drafts } = await fixture();
    writeFileSync(join(drafts, "ok.md"), draftText("Ok", "body"));
    writeFileSync(join(root, ".devboard", "secret.md"), "secret\n");
    await mkdir(join(drafts, "folder.md"), { recursive: true });
    symlinkSync(join(root, ".devboard", "secret.md"), join(drafts, "escape.md"));

    for (const path of [
      "../secret.md",
      ".devboard/goal-proposals/../../secret.md",
      "/etc/passwd",
      ".devboard/goal-proposals",
      ".devboard/goal-proposals/folder.md",
      ".devboard/goal-proposals/escape.md",
      ".devboard/goal-proposals/missing.md",
      "goal-proposals/ok.md",
    ]) {
      let error: unknown;
      try {
        readGoalDraft(root, path);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(GoalDraftError);
      expect((error as GoalDraftError).message.length).toBeGreaterThan(0);
    }
    expect(readGoalDraft(root, ".devboard/goal-proposals/ok.md").text).toContain("Ok");
    expect(() => resolveGoalDraft(root, 42)).toThrow(GoalDraftError);
  });
});

describe("elaboration", () => {
  test("sends exactly one /goal-draft prompt and streams activity and questions", async () => {
    const { root, drafts, stateDir, log } = await fixture();
    writeFileSync(join(drafts, "elaborate-me.md"), draftText("Elaborate me", "STUB-QUESTION body"));
    const manager = managerFor(root, stateDir, log);

    const started = await manager.start(".devboard/goal-proposals/elaborate-me.md");
    expect(started.ok).toBe(true);
    const pid = await waitFor(() => startPids(log)[0], "the stub peer's start line");
    expect(alive(pid)).toBe(true);
    expect(logLines(log).filter((line) => line.startsWith("goal-draft "))).toEqual([
      "goal-draft .devboard/goal-proposals/elaborate-me.md",
    ]);

    const asked = await waitFor(
      () => (manager.snapshot().question === null ? undefined : manager.snapshot()),
      "the question",
    );
    expect(manager.snapshot().status).toBe("running");
    expect(manager.snapshot().path).toBe(".devboard/goal-proposals/elaborate-me.md");
    expect(manager.snapshot().activity.join("\n")).toContain("Reading the draft");
    expect(asked.question?.message).toBe("Choose an answer");
    expect(asked.question?.options.map((option) => option.label)).toEqual(["Alpha", "Beta"]);
    expect(asked.question?.options[0]?.description).toBe("Alpha leads to the first outcome.");
    expect(asked.question?.options[0]?.recommended).toBe(true);

    const questionId = asked.question?.id;
    expect(questionId).toBeDefined();
    expect(manager.answer(questionId!, "Alpha")).toBe(true);
    await waitFor(
      () => (logLines(log).includes("answer Alpha") ? true : undefined),
      "the answer reaching the peer",
    );
    expect(logLines(log).filter((line) => line === "answer Alpha")).toHaveLength(1);
    await waitFor(
      () => (manager.snapshot().status === "succeeded" ? true : undefined),
      "the successful elaboration",
    );
    expect(manager.snapshot().question).toBeNull();
    expect(existsSync(join(drafts, "elaborate-me.md"))).toBe(false);
    expect(existsSync(join(root, ".devboard", "goals", "elaborate-me.md"))).toBe(true);
    expect(startPids(log)).toHaveLength(1);
    await waitFor(() => (alive(pid) ? undefined : true), "the peer to exit");
    const stored = await waitFor(
      () => readGoalDraftOwnerState(stateDir, root),
      "the terminal owner state",
    );
    expect(stored.run.status).toBe("succeeded");
    expect(stored.peer).toBeNull();
  });

  test("runs one elaboration at a time and stop keeps the draft", async () => {
    const { root, drafts, stateDir, log } = await fixture();
    writeFileSync(join(drafts, "one.md"), draftText("One", "STUB-HANG body"));
    writeFileSync(join(drafts, "two.md"), draftText("Two", "body"));
    const manager = managerFor(root, stateDir, log);

    expect((await manager.start(".devboard/goal-proposals/one.md")).ok).toBe(true);
    const firstPid = await waitFor(() => startPids(log)[0], "the first peer");
    const refused = await manager.start(".devboard/goal-proposals/two.md");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.message).toContain("An elaboration is already running for");
      expect(refused.message).toContain(".devboard/goal-proposals/one.md");
    }

    expect(manager.stop()).toBe(true);
    await waitFor(
      () => (manager.snapshot().status === "stopped" ? true : undefined),
      "the stopped elaboration",
    );
    expect(existsSync(join(drafts, "one.md"))).toBe(true);
    await waitFor(() => (alive(firstPid) ? undefined : true), "the stopped peer to exit");

    expect((await manager.start(".devboard/goal-proposals/two.md")).ok).toBe(true);
    await waitFor(() => (startPids(log).length === 2 ? true : undefined), "the retried peer");
    await waitFor(
      () =>
        logLines(log).includes("goal-draft .devboard/goal-proposals/two.md") ? true : undefined,
      "the second prompt",
    );
    expect(logLines(log).filter((line) => line.startsWith("goal-draft ")).at(-1)).toBe(
      "goal-draft .devboard/goal-proposals/two.md",
    );
    expect(manager.snapshot().status).toBe("running");
  });

  test("a stop while the provider environment resolves spawns no owner", async () => {
    const { root, drafts, stateDir, log } = await fixture();
    writeFileSync(join(drafts, "late.md"), draftText("Late", "body"));
    const environment = Promise.withResolvers<Record<string, string | undefined>>();
    const manager = managerFor(root, stateDir, log, () => environment.promise);

    const starting = manager.start(".devboard/goal-proposals/late.md");
    expect(manager.snapshot().status).toBe("running");
    expect(manager.stop()).toBe(true);
    expect(manager.snapshot().status).toBe("stopped");
    environment.resolve({ ...process.env });

    const result = await starting;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stopped).toBe(true);
    expect(manager.snapshot().status).toBe("stopped");
    expect(manager.snapshot().error).toBeNull();
    expect(existsSync(join(drafts, "late.md"))).toBe(true);
    expect(startPids(log)).toEqual([]);
    expect(readGoalDraftOwnerState(stateDir, root)?.run.status).toBe("stopped");
  });

  test("an environment failure records failed with no owner and no draft loss", async () => {
    const { root, drafts, stateDir, log } = await fixture();
    writeFileSync(join(drafts, "unavailable.md"), draftText("Unavailable", "body"));
    const manager = managerFor(root, stateDir, log, async () => {
      throw new Error("no subscription can serve this peer");
    });

    const result = await manager.start(".devboard/goal-proposals/unavailable.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("no subscription");
    const failed = await waitFor(
      () => (manager.snapshot().status === "failed" ? manager.snapshot() : undefined),
      "the failed elaboration",
    );
    expect(failed.error).toContain("no subscription");
    expect(existsSync(join(drafts, "unavailable.md"))).toBe(true);
    expect(startPids(log)).toEqual([]);
    expect(readGoalDraftOwnerState(stateDir, root)?.run.status).toBe("failed");
  });

  test("a failed peer keeps the draft and retry starts exactly one new peer", async () => {
    const { root, drafts, stateDir, log } = await fixture();
    writeFileSync(join(drafts, "fail.md"), draftText("Fail", "STUB-FAIL body"));
    const manager = managerFor(root, stateDir, log);

    expect((await manager.start(".devboard/goal-proposals/fail.md")).ok).toBe(true);
    const failed = await waitFor(
      () => (manager.snapshot().status === "failed" ? manager.snapshot() : undefined),
      "the failure",
    );
    expect(failed.error).toContain("goal label verification failed");
    expect(existsSync(join(drafts, "fail.md"))).toBe(true);
    const firstPid = startPids(log)[0]!;
    await waitFor(() => (alive(firstPid) ? undefined : true), "the failed peer to exit");

    expect((await manager.start(".devboard/goal-proposals/fail.md")).ok).toBe(true);
    await waitFor(() => (startPids(log).length === 2 ? true : undefined), "the retry peer");
    await waitFor(
      () =>
        logLines(log).filter((line) => line.startsWith("goal-draft ")).length === 2
          ? true
          : undefined,
      "the retry prompt",
    );
    expect(logLines(log).filter((line) => line.startsWith("goal-draft "))).toEqual([
      "goal-draft .devboard/goal-proposals/fail.md",
      "goal-draft .devboard/goal-proposals/fail.md",
    ]);
  });

  test("the owner state names only this repository's directory", async () => {
    const { root, stateDir } = await fixture();
    const directory = goalDraftStateDirectory(stateDir, root);
    expect(directory.startsWith(resolve(stateDir))).toBe(true);
    expect(directory.includes("goal-drafts")).toBe(true);
    expect(readGoalDraftOwnerState(stateDir, root)).toBeUndefined();
  });
});

describe("goal-draft prompt contract", () => {
  const prompt = readFileSync(join(harnessRoot, "prompts", "goal-draft.md"), "utf8");

  test("declares the five sections in order", () => {
    const headings = ["## Objective", "## Success criteria", "## Verification", "## Boundaries", "## Stop conditions"];
    const positions = headings.map((heading) => prompt.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });

  test("requires research, a three-option interview, and forbids effort questions", () => {
    expect(prompt).toContain("`ask`");
    expect(prompt).toContain("exactly one question");
    expect(prompt).toContain("three mutually exclusive");
    expect(prompt).toContain("exactly one recommended");
    expect(prompt.toLowerCase()).toContain("effort");
    expect(prompt.toLowerCase()).toContain("token budget");
  });

  test("files the spec with the goal label and deletes the draft only after verification", () => {
    expect(prompt).toContain(".devboard/goals/<slug>.md");
    expect(prompt).toContain("--label goal");
    expect(prompt).toContain("--body-file");
    expect(prompt).toContain(`gh issue view <number> --json number,url,labels,body`);
    const verification = prompt.indexOf("gh issue view");
    const deletion = prompt.indexOf("delete the draft");
    expect(deletion).toBeGreaterThan(verification);
    expect(prompt).toContain("forge-auth.ts");
  });
});
