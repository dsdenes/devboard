import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AcpActivity, AcpQuestion } from "../server/acp";
import {
  GoalDraftError,
  GoalDraftManager,
  goalDraftHeading,
  listGoalDrafts,
  readGoalDraft,
  resolveGoalDraft,
  type GoalDraftPeer,
  type GoalDraftPeerOptions,
} from "../server/goal-drafts";

/**
 * Draft reads and the one elaboration peer. Every fixture lives under
 * `.devboard/.tmp`; the peer is a controllable fake and no agent, GitHub
 * object, or file outside the fixture is touched.
 */

const harnessRoot = resolve(import.meta.dir, "..");
const testRoot = join(harnessRoot, ".tmp");
const temporaryDirectories: string[] = [];
const managers: GoalDraftManager[] = [];

afterAll(async () => {
  for (const manager of managers) manager.dispose();
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ root: string; drafts: string }> {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "goal-drafts-"));
  temporaryDirectories.push(root);
  const drafts = join(root, ".devboard", "goal-proposals");
  await mkdir(drafts, { recursive: true });
  return { root, drafts };
}

function draftText(heading: string, body: string): string {
  return `# ${heading}\n\n> Unprocessed draft.\n\n${body}\n`;
}

class FakePeer implements GoalDraftPeer {
  private static nextPid = 4300;
  readonly pid = FakePeer.nextPid++;
  readonly argv = ["stub-acp"];
  readonly prompts: string[] = [];
  readonly answers: Array<{ id: number | string; value: string }> = [];
  readonly options: GoalDraftPeerOptions;
  closed = false;
  closes = 0;
  private settle: { resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;

  constructor(options: GoalDraftPeerOptions) {
    this.options = options;
  }

  run(prompt: string): Promise<unknown> {
    this.prompts.push(prompt);
    const deferred = Promise.withResolvers<unknown>();
    this.settle = { resolve: deferred.resolve, reject: deferred.reject };
    return deferred.promise;
  }

  answer(id: number | string, value: string): boolean {
    if (this.lastQuestion === undefined || String(this.lastQuestion.id) !== String(id)) return false;
    this.answers.push({ id, value });
    this.options.onActivity({ text: `answered ${value}`, append: false });
    return true;
  }

  private lastQuestion: AcpQuestion | undefined;

  close(): void {
    this.closes += 1;
    this.closed = true;
    this.settle?.reject(new Error("Agent process exited before answering."));
  }

  emit(text: string, append = false): void {
    this.options.onActivity({ text, append } satisfies AcpActivity);
  }

  ask(question: AcpQuestion): void {
    this.lastQuestion = question;
    this.options.onQuestion(question);
  }

  succeed(): void {
    this.settle?.resolve({});
    this.settle = undefined;
  }

  fail(message: string): void {
    this.options.onStderr(`${message}\n`);
    this.settle?.reject(new Error(message));
    this.settle = undefined;
  }
}

function managerFor(root: string, peers: FakePeer[]): { manager: GoalDraftManager; events: unknown[] } {
  const events: unknown[] = [];
  const manager = new GoalDraftManager({
    repoDir: root,
    command: "omp acp",
    send: (event) => events.push(event),
    connect: (options) => {
      const peer = new FakePeer(options);
      peers.push(peer);
      return peer;
    },
  });
  managers.push(manager);
  return { manager, events };
}

function isEventType(event: unknown, type: string): boolean {
  return typeof event === "object" && event !== null && "type" in event && event.type === type;
}

async function waitFor<T>(read: () => T | undefined, description: string, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await Bun.sleep(10);
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
  test("runs two drafts at once with one peer and one snapshot per path", async () => {
    const { root, drafts } = await fixture();
    const one = ".devboard/goal-proposals/one.md";
    const two = ".devboard/goal-proposals/two.md";
    writeFileSync(join(drafts, "one.md"), draftText("One", "body"));
    writeFileSync(join(drafts, "two.md"), draftText("Two", "body"));
    const peers: FakePeer[] = [];
    const { manager, events } = managerFor(root, peers);

    expect(manager.start(one).ok).toBe(true);
    const first = await waitFor(() => peers[0], "the first peer");
    expect(manager.start(two).ok).toBe(true);
    const second = await waitFor(() => peers[1], "the second peer");

    expect(peers).toHaveLength(2);
    expect(first.prompts).toEqual([`/goal-draft ${one}`]);
    expect(second.prompts).toEqual([`/goal-draft ${two}`]);
    expect(manager.running).toBe(true);
    expect(manager.snapshots().map((run) => ({ path: run.path, status: run.status }))).toEqual([
      { path: one, status: "running" },
      { path: two, status: "running" },
    ]);
    expect(manager.snapshotFor(one).status).toBe("running");
    expect(manager.snapshotFor(two).path).toBe(two);
    expect(manager.snapshotFor(".devboard/goal-proposals/never.md").status).toBe("idle");

    first.emit("first draft only");
    second.emit("second draft only");
    expect(manager.snapshotFor(one).activity).toEqual(["first draft only"]);
    expect(manager.snapshotFor(two).activity).toEqual(["second draft only"]);
    expect(events.some((event) => isEventType(event, "issuesDraftState"))).toBe(true);
  });

  test("refuses a duplicate start for the same path and keeps streaming the first peer", async () => {
    const { root, drafts } = await fixture();
    const one = ".devboard/goal-proposals/one.md";
    writeFileSync(join(drafts, "one.md"), draftText("One", "body"));
    const peers: FakePeer[] = [];
    const { manager } = managerFor(root, peers);

    expect(manager.start(one).ok).toBe(true);
    const peer = await waitFor(() => peers[0], "the peer");
    peer.emit("streaming");
    const refused = manager.start(one);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toBe("This draft is being elaborated.");
    expect(peers).toHaveLength(1);
    expect(peer.closes).toBe(0);
    peer.emit("still streaming");
    expect(manager.snapshotFor(one).activity).toEqual(["streaming", "still streaming"]);
  });

  test("answers one draft's question without reaching another peer", async () => {
    const { root, drafts } = await fixture();
    const one = ".devboard/goal-proposals/one.md";
    const two = ".devboard/goal-proposals/two.md";
    writeFileSync(join(drafts, "one.md"), draftText("One", "body"));
    writeFileSync(join(drafts, "two.md"), draftText("Two", "body"));
    const peers: FakePeer[] = [];
    const { manager } = managerFor(root, peers);

    manager.start(one);
    const first = await waitFor(() => peers[0], "the first peer");
    manager.start(two);
    const second = await waitFor(() => peers[1], "the second peer");
    first.ask({
      id: 11,
      message: "Which scope for one?",
      options: [{ label: "One", recommended: true }],
      properties: {},
      required: undefined,
    });
    second.ask({
      id: 22,
      message: "Which scope for two?",
      options: [{ label: "Two", recommended: true }],
      properties: {},
      required: undefined,
    });
    await waitFor(
      () => (manager.snapshotFor(one).question === null ? undefined : true),
      "the first question",
    );
    await waitFor(
      () => (manager.snapshotFor(two).question === null ? undefined : true),
      "the second question",
    );

    expect(manager.answer(one, 11, "One")).toBe(true);
    expect(manager.snapshotFor(one).question).toBeNull();
    expect(manager.snapshotFor(one).activity).toContain("answered One");
    expect(manager.snapshotFor(two).question?.message).toBe("Which scope for two?");
    expect(first.answers).toEqual([{ id: 11, value: "One" }]);
    expect(second.answers).toEqual([]);

    expect(manager.answer(one, 11, "Again")).toBe(false);
    expect(manager.answer(two, 11, "Wrong draft")).toBe(false);
    expect(first.answers).toHaveLength(1);
    expect(second.answers).toEqual([]);
  });

  test("stops only the selected draft and leaves another running", async () => {
    const { root, drafts } = await fixture();
    const one = ".devboard/goal-proposals/one.md";
    const two = ".devboard/goal-proposals/two.md";
    writeFileSync(join(drafts, "one.md"), draftText("One", "body"));
    writeFileSync(join(drafts, "two.md"), draftText("Two", "body"));
    const peers: FakePeer[] = [];
    const { manager } = managerFor(root, peers);

    manager.start(one);
    const first = await waitFor(() => peers[0], "the first peer");
    manager.start(two);
    const second = await waitFor(() => peers[1], "the second peer");
    second.ask({
      id: 7,
      message: "Keep this?",
      options: [{ label: "Yes", recommended: true }],
      properties: {},
      required: undefined,
    });
    await waitFor(
      () => (manager.snapshotFor(two).question === null ? undefined : true),
      "the other draft's question",
    );
    first.emit("one line");

    expect(manager.stop(one)).toBe(true);
    expect(first.closed).toBe(true);
    expect(first.closes).toBe(1);
    expect(manager.snapshotFor(one).status).toBe("stopped");
    expect(manager.snapshotFor(two).status).toBe("running");
    expect(manager.snapshotFor(two).question?.id).toBe(7);
    expect(second.closed).toBe(false);
    expect(manager.stop(one)).toBe(false);

    expect(manager.start(one).ok).toBe(true);
    const retried = await waitFor(() => peers[2], "the restarted peer");
    expect(retried.prompts).toEqual([`/goal-draft ${one}`]);
    expect(manager.snapshotFor(one).status).toBe("running");
    expect(manager.snapshotFor(two).status).toBe("running");
  });

  test("one draft succeeds and one fails while another keeps running", async () => {
    const { root, drafts } = await fixture();
    const one = ".devboard/goal-proposals/one.md";
    const two = ".devboard/goal-proposals/two.md";
    const three = ".devboard/goal-proposals/three.md";
    writeFileSync(join(drafts, "one.md"), draftText("One", "body"));
    writeFileSync(join(drafts, "two.md"), draftText("Two", "body"));
    writeFileSync(join(drafts, "three.md"), draftText("Three", "body"));
    const peers: FakePeer[] = [];
    const { manager } = managerFor(root, peers);

    manager.start(one);
    const first = await waitFor(() => peers[0], "the first peer");
    manager.start(two);
    const second = await waitFor(() => peers[1], "the second peer");
    manager.start(three);
    const third = await waitFor(() => peers[2], "the third peer");
    third.ask({
      id: 9,
      message: "Still here?",
      options: [{ label: "Yes", recommended: true }],
      properties: {},
      required: undefined,
    });
    third.emit("third draft only");
    await waitFor(
      () => (manager.snapshotFor(three).question === null ? undefined : true),
      "the third question",
    );

    await unlink(join(drafts, "one.md"));
    first.succeed();
    second.fail("goal label missing from the created issue");

    const succeeded = await waitFor(
      () => (manager.snapshotFor(one).status === "succeeded" ? manager.snapshotFor(one) : undefined),
      "the successful draft",
    );
    expect(succeeded.error).toBeNull();
    expect(first.closed).toBe(true);
    const failed = await waitFor(
      () => (manager.snapshotFor(two).status === "failed" ? manager.snapshotFor(two) : undefined),
      "the failed draft",
    );
    expect(failed.error).toBe("goal label missing from the created issue");
    expect(second.closed).toBe(true);

    const running = manager.snapshotFor(three);
    expect(running.status).toBe("running");
    expect(running.activity).toEqual(["third draft only"]);
    expect(running.question?.message).toBe("Still here?");
    expect(third.closed).toBe(false);
    expect(listGoalDrafts(root).map((draft) => draft.name)).toEqual(["three.md", "two.md"]);
  });

  test("dispose closes every live peer", async () => {
    const { root, drafts } = await fixture();
    for (const name of ["one", "two", "three"]) {
      writeFileSync(join(drafts, `${name}.md`), draftText(name, "body"));
    }
    const peers: FakePeer[] = [];
    const { manager } = managerFor(root, peers);

    for (const name of ["one", "two", "three"]) {
      expect(manager.start(`.devboard/goal-proposals/${name}.md`).ok).toBe(true);
    }
    expect(peers).toHaveLength(3);

    manager.dispose();
    expect(peers.every((peer) => peer.closed)).toBe(true);
    expect(peers.every((peer) => peer.closes === 1)).toBe(true);
    expect(manager.running).toBe(false);
    expect(manager.snapshots().every((run) => run.status === "stopped")).toBe(true);
    expect(manager.children()).toEqual([]);
  });

  test("children returns every live peer's pid, argv, and cwd", async () => {
    const { root, drafts } = await fixture();
    const one = ".devboard/goal-proposals/one.md";
    const two = ".devboard/goal-proposals/two.md";
    writeFileSync(join(drafts, "one.md"), draftText("One", "body"));
    writeFileSync(join(drafts, "two.md"), draftText("Two", "body"));
    const peers: FakePeer[] = [];
    const { manager } = managerFor(root, peers);

    manager.start(one);
    manager.start(two);
    expect(manager.children()).toEqual([
      { pid: peers[0]!.pid, argv: ["stub-acp"], cwd: root },
      { pid: peers[1]!.pid, argv: ["stub-acp"], cwd: root },
    ]);
    manager.stop(two);
    expect(manager.children()).toEqual([
      { pid: peers[0]!.pid, argv: ["stub-acp"], cwd: root },
    ]);
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
