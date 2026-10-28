import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
  readonly pid = 4242;
  readonly argv = ["stub-acp"];
  readonly prompts: string[] = [];
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

function managerFor(
  root: string,
  peers: FakePeer[],
  environment: () => Promise<Record<string, string | undefined>> = async () => ({}),
): { manager: GoalDraftManager; events: unknown[] } {
  const events: unknown[] = [];
  const manager = new GoalDraftManager({
    repoDir: root,
    command: "omp acp",
    send: (event) => events.push(event),
    environment,
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
  test("sends exactly one /goal-draft prompt and streams activity and questions", async () => {
    const { root, drafts } = await fixture();
    writeFileSync(join(drafts, "elaborate-me.md"), draftText("Elaborate me", "body"));
    const peers: FakePeer[] = [];
    const { manager, events } = managerFor(root, peers);

    const started = await manager.start(".devboard/goal-proposals/elaborate-me.md");
    expect(started.ok).toBe(true);
    const peer = await waitFor(() => peers[0], "the peer");
    expect(peer.prompts).toEqual(["/goal-draft .devboard/goal-proposals/elaborate-me.md"]);
    expect(peer.options.command).toBe("omp acp");
    expect(peer.options.cwd).toBe(root);
    expect(manager.snapshot().status).toBe("running");
    expect(manager.snapshot().path).toBe(".devboard/goal-proposals/elaborate-me.md");

    peer.emit("Reading the goal proposals");
    expect(manager.snapshot().activity).toEqual(["Reading the goal proposals"]);
    peer.ask({
      id: 3,
      message: "Which scope?",
      options: [{ label: "One", description: "First", recommended: true }],
      properties: {},
      required: undefined,
    });
    const asked = await waitFor(
      () => (manager.snapshot().question === null ? undefined : manager.snapshot()),
      "the question",
    );
    expect(asked.question?.message).toBe("Which scope?");
    expect(asked.question?.options[0]?.recommended).toBe(true);
    expect(manager.answer(3, "One")).toBe(true);
    expect(manager.snapshot().question).toBeNull();
    expect(manager.snapshot().activity).toContain("answered One");

    expect(events.some((event) => isEventType(event, "issuesDraftState"))).toBe(true);
  });

  test("runs one elaboration at a time and stop keeps the draft", async () => {
    const { root, drafts } = await fixture();
    writeFileSync(join(drafts, "one.md"), draftText("One", "body"));
    writeFileSync(join(drafts, "two.md"), draftText("Two", "body"));
    const peers: FakePeer[] = [];
    const { manager } = managerFor(root, peers);

    expect((await manager.start(".devboard/goal-proposals/one.md")).ok).toBe(true);
    const first = await waitFor(() => peers[0], "the first peer");
    const refused = await manager.start(".devboard/goal-proposals/two.md");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.message).toContain("An elaboration is already running for");
      expect(refused.message).toContain(".devboard/goal-proposals/one.md");
    }

    expect(manager.stop()).toBe(true);
    expect(first.closed).toBe(true);
    expect(first.closes).toBe(1);
    expect(manager.snapshot().status).toBe("stopped");
    expect(existsSync(join(drafts, "one.md"))).toBe(true);

    expect((await manager.start(".devboard/goal-proposals/two.md")).ok).toBe(true);
    const second = await waitFor(() => peers[1], "the retried peer");
    expect(second.prompts).toEqual(["/goal-draft .devboard/goal-proposals/two.md"]);
  });

  test("a stop while the provider environment resolves closes the late peer without running it", async () => {
    const { root, drafts } = await fixture();
    writeFileSync(join(drafts, "late.md"), draftText("Late", "body"));
    const peers: FakePeer[] = [];
    const environment = Promise.withResolvers<Record<string, string | undefined>>();
    const { manager } = managerFor(root, peers, () => environment.promise);

    const starting = manager.start(".devboard/goal-proposals/late.md");
    expect(manager.snapshot().status).toBe("running");
    expect(manager.stop()).toBe(true);
    environment.resolve({});

    const result = await starting;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stopped).toBe(true);
    expect(manager.snapshot().status).toBe("stopped");
    expect(manager.snapshot().error).toBeNull();
    expect(existsSync(join(drafts, "late.md"))).toBe(true);

    const peer = peers[0];
    expect(peer).toBeDefined();
    expect(peer?.prompts).toEqual([]);
    expect(peer?.closed).toBe(true);
    expect(peer?.closes).toBe(1);
  });

  test("a connect failure after stop leaves the status stopped rather than failed", async () => {
    const { root, drafts } = await fixture();
    writeFileSync(join(drafts, "late-failure.md"), draftText("Late failure", "body"));
    let manager!: GoalDraftManager;
    manager = new GoalDraftManager({
      repoDir: root,
      command: "omp acp",
      send: () => undefined,
      environment: async () => ({}),
      connect: () => {
        // The stop lands while the peer is being constructed; the failure that
        // follows must not replace the operator's `stopped` state with `failed`.
        manager.stop();
        throw new Error("connection refused");
      },
    });
    managers.push(manager);

    const result = await manager.start(".devboard/goal-proposals/late-failure.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stopped).toBe(true);
    expect(manager.snapshot().status).toBe("stopped");
    expect(manager.snapshot().error).toBeNull();
    expect(manager.child()).toBeUndefined();
    expect(existsSync(join(drafts, "late-failure.md"))).toBe(true);
  });

  test("a failed peer keeps the draft and reports the error; retry starts a new peer", async () => {
    const { root, drafts } = await fixture();
    writeFileSync(join(drafts, "fail.md"), draftText("Fail", "body"));
    const peers: FakePeer[] = [];
    const { manager } = managerFor(root, peers);

    await manager.start(".devboard/goal-proposals/fail.md");
    const peer = await waitFor(() => peers[0], "the peer");
    peer.fail("the model is unavailable");
    const failed = await waitFor(
      () => (manager.snapshot().status === "failed" ? manager.snapshot() : undefined),
      "the failure",
    );
    expect(failed.error).toBe("the model is unavailable");
    expect(existsSync(join(drafts, "fail.md"))).toBe(true);

    await manager.start(".devboard/goal-proposals/fail.md");
    const retry = await waitFor(() => peers[1], "the retry peer");
    expect(retry.prompts).toEqual(["/goal-draft .devboard/goal-proposals/fail.md"]);
  });

  test("a successful stub agent removes the draft only after it verifies the issue label", async () => {
    const { root, drafts } = await fixture();
    writeFileSync(join(drafts, "verified.md"), draftText("Verified", "body"));
    writeFileSync(join(drafts, "unverified.md"), draftText("Unverified", "body"));
    const peers: FakePeer[] = [];
    const { manager } = managerFor(root, peers);

    await manager.start(".devboard/goal-proposals/verified.md");
    const verified = await waitFor(() => peers[0], "the verifying peer");
    // The stub stands in for the agent: file the spec, read the issue back,
    // and delete only when that read carries the goal label and same bytes.
    const spec = join(root, ".devboard", "goals", "verified.md");
    await mkdir(join(root, ".devboard", "goals"), { recursive: true });
    writeFileSync(spec, draftText("Verified", "finalized"));
    const verifiedLabel = true;
    if (verifiedLabel) await unlink(join(drafts, "verified.md"));
    verified.succeed();
    await waitFor(
      () => (manager.snapshot().status === "succeeded" ? true : undefined),
      "the verified success",
    );
    expect(existsSync(join(drafts, "verified.md"))).toBe(false);
    expect(existsSync(spec)).toBe(true);
    expect(verified.closed).toBe(true);
    expect(verified.closes).toBe(1);
    expect(manager.child()).toBeUndefined();
    expect(listGoalDrafts(root).map((draft) => draft.name)).toEqual(["unverified.md"]);

    await manager.start(".devboard/goal-proposals/unverified.md");
    const unverified = await waitFor(() => peers[1], "the failing verification peer");
    expect(manager.child()).toEqual({ pid: unverified.pid, argv: ["stub-acp"], cwd: root });
    const verifiedLabelOnCreate = false;
    if (verifiedLabelOnCreate) await unlink(join(drafts, "unverified.md"));
    unverified.fail("goal label missing from the created issue");
    const failed = await waitFor(
      () => (manager.snapshot().status === "failed" ? manager.snapshot() : undefined),
      "the failed verification",
    );
    expect(existsSync(join(drafts, "unverified.md"))).toBe(true);
    expect(failed.error).toContain("goal label missing");
    expect(unverified.closed).toBe(true);
    expect(unverified.closes).toBe(1);
    expect(manager.child()).toBeUndefined();
    expect(peers.filter((peer) => !peer.closed)).toHaveLength(0);
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
