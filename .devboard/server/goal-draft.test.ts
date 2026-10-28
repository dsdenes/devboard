import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AcpActivity, AcpQuestion } from "../server/acp";
import {
  parseGoalProposalSubmission,
  writeGoalProposal,
} from "../server/goal-proposal";
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
 * Draft reads and the per-path elaboration peers. Every fixture lives under
 * `.devboard/.tmp`; each peer is a controllable fake and no agent, GitHub
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

function draftPath(name: string): string {
  return `.devboard/goal-proposals/${name}`;
}

class FakePeer implements GoalDraftPeer {
  readonly pid: number;
  readonly argv = ["stub-acp"];
  readonly prompts: string[] = [];
  readonly options: GoalDraftPeerOptions;
  readonly answered: Array<{ id: number | string; value: string }> = [];
  closed = false;
  closes = 0;
  private settle: { resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;

  constructor(options: GoalDraftPeerOptions, pid = 4242) {
    this.options = options;
    this.pid = pid;
  }

  run(prompt: string): Promise<unknown> {
    this.prompts.push(prompt);
    const deferred = Promise.withResolvers<unknown>();
    this.settle = { resolve: deferred.resolve, reject: deferred.reject };
    return deferred.promise;
  }

  answer(id: number | string, value: string): boolean {
    if (this.lastQuestion === undefined || String(this.lastQuestion.id) !== String(id)) return false;
    this.answered.push({ id, value });
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
      const peer = new FakePeer(options, 4200 + peers.length);
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

describe("parallel elaboration", () => {
  test("starts two distinct drafts at once with one live peer and snapshot per path", async () => {
    const { root, drafts } = await fixture();
    writeFileSync(join(drafts, "alpha.md"), draftText("Alpha", "body"));
    writeFileSync(join(drafts, "beta.md"), draftText("Beta", "body"));
    const peers: FakePeer[] = [];
    const { manager, events } = managerFor(root, peers);

    expect((await manager.start(draftPath("alpha.md"))).ok).toBe(true);
    expect((await manager.start(draftPath("beta.md"))).ok).toBe(true);
    expect(peers).toHaveLength(2);
    const [alpha, beta] = peers as [FakePeer, FakePeer];
    expect(alpha?.prompts).toEqual([`/goal-draft ${draftPath("alpha.md")}`]);
    expect(beta?.prompts).toEqual([`/goal-draft ${draftPath("beta.md")}`]);
    expect(alpha?.options.cwd).toBe(root);
    expect(beta?.options.command).toBe("omp acp");

    const runs = manager.snapshot();
    expect(runs.map((run) => [run.path, run.status])).toEqual([
      [draftPath("alpha.md"), "running"],
      [draftPath("beta.md"), "running"],
    ]);
    expect(manager.snapshot(draftPath("alpha.md"))).toMatchObject({
      status: "running",
      path: draftPath("alpha.md"),
    });
    expect(manager.snapshot(draftPath("beta.md")).status).toBe("running");
    expect(manager.isRunning(draftPath("alpha.md"))).toBe(true);
    expect(manager.isRunning(draftPath("beta.md"))).toBe(true);

    alpha?.emit("Alpha read the draft");
    beta?.emit("Beta read the draft");
    expect(manager.snapshot(draftPath("alpha.md")).activity).toEqual(["Alpha read the draft"]);
    expect(manager.snapshot(draftPath("beta.md")).activity).toEqual(["Beta read the draft"]);
    expect(
      events.some((event) => {
        if (!isEventType(event, "issuesDraftState") || typeof event !== "object" || event === null) {
          return false;
        }
        if (!("draft" in event) || typeof event.draft !== "object" || event.draft === null) {
          return false;
        }
        return "path" in event.draft && event.draft.path === draftPath("beta.md");
      }),
    ).toBe(true);
  });

  test("starts a third and fourth draft without refusing any of them", async () => {
    const { root, drafts } = await fixture();
    const names = ["one.md", "two.md", "three.md", "four.md"];
    for (const name of names) writeFileSync(join(drafts, name), draftText(name, "body"));
    const peers: FakePeer[] = [];
    const { manager } = managerFor(root, peers);

    for (const name of names) {
      const started = await manager.start(draftPath(name));
      expect(started.ok).toBe(true);
    }
    expect(peers).toHaveLength(4);
    expect(manager.snapshot().map((run) => run.status)).toEqual([
      "running",
      "running",
      "running",
      "running",
    ]);
    for (const peer of peers) expect(peer.prompts).toHaveLength(1);
  });

  test("refuses a second peer for the same path with the exact reason", async () => {
    const { root, drafts } = await fixture();
    writeFileSync(join(drafts, "only.md"), draftText("Only", "body"));
    const peers: FakePeer[] = [];
    const { manager } = managerFor(root, peers);

    expect((await manager.start(draftPath("only.md"))).ok).toBe(true);
    const peer = await waitFor(() => peers[0], "the first peer");
    const refused = await manager.start(draftPath("only.md"));
    expect(refused).toEqual({ ok: false, message: "This draft is being elaborated." });
    expect(peers).toHaveLength(1);
    expect(manager.snapshot(draftPath("only.md")).status).toBe("running");

    peer.emit("still streaming");
    expect(manager.snapshot(draftPath("only.md")).activity).toEqual(["still streaming"]);
  });

  test("answers one draft's question without reaching another", async () => {
    const { root, drafts } = await fixture();
    writeFileSync(join(drafts, "alpha.md"), draftText("Alpha", "body"));
    writeFileSync(join(drafts, "beta.md"), draftText("Beta", "body"));
    const peers: FakePeer[] = [];
    const { manager } = managerFor(root, peers);

    await manager.start(draftPath("alpha.md"));
    await manager.start(draftPath("beta.md"));
    const [alpha, beta] = peers as [FakePeer, FakePeer];
    alpha.emit("Alpha activity");
    beta.emit("Beta activity");
    alpha.ask({
      id: 3,
      message: "Alpha scope?",
      options: [{ label: "One", description: "First", recommended: true }],
      properties: {},
      required: undefined,
    });
    beta.ask({
      id: 7,
      message: "Beta scope?",
      options: [{ label: "Two", recommended: true }],
      properties: {},
      required: undefined,
    });
    await waitFor(
      () =>
        manager.snapshot(draftPath("alpha.md")).question !== null &&
        manager.snapshot(draftPath("beta.md")).question !== null
          ? true
          : undefined,
      "both questions",
    );

    expect(manager.answer(draftPath("alpha.md"), 3, "One")).toBe(true);
    expect(manager.snapshot(draftPath("alpha.md")).question).toBeNull();
    expect(manager.snapshot(draftPath("alpha.md")).activity).toContain("answered One");
    expect(manager.snapshot(draftPath("beta.md")).question?.id).toBe(7);
    expect(manager.snapshot(draftPath("beta.md")).activity).toEqual(["Beta activity"]);
    expect(beta.answered).toEqual([]);
    expect(alpha.answered).toEqual([{ id: 3, value: "One" }]);

    expect(manager.answer(draftPath("beta.md"), 3, "Wrong")).toBe(false);
    expect(beta.answered).toEqual([]);
    expect(manager.snapshot(draftPath("beta.md")).question?.id).toBe(7);
  });

  test("refuses an answer when the addressed draft has no pending question", async () => {
    const { root, drafts } = await fixture();
    writeFileSync(join(drafts, "alpha.md"), draftText("Alpha", "body"));
    const peers: FakePeer[] = [];
    const { manager } = managerFor(root, peers);

    await manager.start(draftPath("alpha.md"));
    const peer = await waitFor(() => peers[0], "the peer");
    expect(manager.answer(draftPath("alpha.md"), 1, "Anything")).toBe(false);
    expect(manager.answer(draftPath("missing.md"), 1, "Anything")).toBe(false);
    expect(peer.answered).toEqual([]);
    expect(manager.snapshot(draftPath("alpha.md")).status).toBe("running");
  });

  test("starts two drafts created from the drafts page at the same time", async () => {
    const { root } = await fixture();
    const first = await writeGoalProposal(
      parseGoalProposalSubmission({ report: "Create the first goal from the drafts page." }),
      { repoDir: root },
    );
    const second = await writeGoalProposal(
      parseGoalProposalSubmission({ report: "Create the second goal from the drafts page." }),
      { repoDir: root },
    );
    expect(first.path.startsWith(".devboard/goal-proposals/")).toBe(true);
    expect(second.path).not.toBe(first.path);
    const peers: FakePeer[] = [];
    const { manager } = managerFor(root, peers);

    const started = await manager.start(first.path);
    expect(started).toEqual({ ok: true, path: first.path });
    const firstPeer = await waitFor(() => peers[0], "the first created draft's peer");
    expect(firstPeer.prompts).toEqual([`/goal-draft ${first.path}`]);

    const secondStarted = await manager.start(second.path);
    expect(secondStarted).toEqual({ ok: true, path: second.path });
    const secondPeer = await waitFor(() => peers[1], "the second created draft's peer");
    expect(secondPeer.prompts).toEqual([`/goal-draft ${second.path}`]);
    expect(peers).toHaveLength(2);
    expect(listGoalDrafts(root).map((draft) => draft.path)).toEqual(
      [first.path, second.path].sort(),
    );
    expect(readGoalDraft(root, second.path).text).toContain(
      "Create the second goal from the drafts page.",
    );

    expect(manager.stop(first.path)).toBe(true);
    expect(firstPeer.closed).toBe(true);
    expect(manager.snapshot(second.path).status).toBe("running");
    expect(secondPeer.closed).toBe(false);
    expect(readGoalDraft(root, second.path).text.startsWith("# Proposed goal: ")).toBe(true);
  });

  test("stops only the addressed draft and keeps the other running", async () => {
    const { root, drafts } = await fixture();
    writeFileSync(join(drafts, "alpha.md"), draftText("Alpha", "body"));
    writeFileSync(join(drafts, "beta.md"), draftText("Beta", "body"));
    const peers: FakePeer[] = [];
    const { manager } = managerFor(root, peers);

    await manager.start(draftPath("alpha.md"));
    await manager.start(draftPath("beta.md"));
    const [alpha, beta] = peers as [FakePeer, FakePeer];
    beta.emit("Beta keeps running");

    expect(manager.stop(draftPath("alpha.md"))).toBe(true);
    expect(alpha.closed).toBe(true);
    expect(alpha.closes).toBe(1);
    expect(manager.snapshot(draftPath("alpha.md")).status).toBe("stopped");
    expect(existsSync(join(drafts, "alpha.md"))).toBe(true);
    expect(manager.snapshot(draftPath("beta.md")).status).toBe("running");
    expect(beta.closed).toBe(false);
    expect(manager.snapshot(draftPath("beta.md")).activity).toEqual(["Beta keeps running"]);
    expect(manager.isRunning(draftPath("beta.md"))).toBe(true);

    alpha.emit("a late line from the stopped peer");
    expect(manager.snapshot(draftPath("alpha.md")).activity).toEqual([]);
    expect(manager.stop(draftPath("beta.md"))).toBe(true);
    expect(beta.closes).toBe(1);
  });

  test("records one success and one failure while a third draft keeps running", async () => {
    const { root, drafts } = await fixture();
    writeFileSync(join(drafts, "alpha.md"), draftText("Alpha", "body"));
    writeFileSync(join(drafts, "beta.md"), draftText("Beta", "body"));
    writeFileSync(join(drafts, "gamma.md"), draftText("Gamma", "body"));
    const peers: FakePeer[] = [];
    const { manager } = managerFor(root, peers);

    await manager.start(draftPath("alpha.md"));
    await manager.start(draftPath("beta.md"));
    await manager.start(draftPath("gamma.md"));
    const [alpha, beta, gamma] = peers as [FakePeer, FakePeer, FakePeer];
    gamma.emit("Gamma is researching");
    gamma.ask({
      id: 11,
      message: "Gamma scope?",
      options: [{ label: "Whole", recommended: true }],
      properties: {},
      required: undefined,
    });
    await waitFor(
      () => (manager.snapshot(draftPath("gamma.md")).question === null ? undefined : true),
      "the gamma question",
    );

    await unlink(join(drafts, "alpha.md"));
    alpha.succeed();
    const succeeded = await waitFor(
      () =>
        manager.snapshot(draftPath("alpha.md")).status === "succeeded" ? true : undefined,
      "the alpha success",
    );
    expect(succeeded).toBe(true);
    expect(existsSync(join(drafts, "alpha.md"))).toBe(false);
    expect(manager.snapshot(draftPath("beta.md")).status).toBe("running");
    expect(manager.snapshot(draftPath("gamma.md")).status).toBe("running");

    beta.fail("the model is unavailable");
    const failed = await waitFor(
      () => (manager.snapshot(draftPath("beta.md")).status === "failed" ? true : undefined),
      "the beta failure",
    );
    expect(failed).toBe(true);
    expect(manager.snapshot(draftPath("beta.md")).error).toBe("the model is unavailable");
    expect(existsSync(join(drafts, "beta.md"))).toBe(true);

    const gammaRun = manager.snapshot(draftPath("gamma.md"));
    expect(gammaRun.status).toBe("running");
    expect(gammaRun.error).toBeNull();
    expect(gammaRun.question?.id).toBe(11);
    expect(gammaRun.activity).toEqual(["Gamma is researching"]);
    expect(manager.snapshot().map((run) => run.path)).toEqual([
      draftPath("beta.md"),
      draftPath("gamma.md"),
    ]);
    expect(listGoalDrafts(root).map((draft) => draft.name)).toEqual(["beta.md", "gamma.md"]);
  });

  test("dispose closes every live peer and leaves no run running", async () => {
    const { root, drafts } = await fixture();
    writeFileSync(join(drafts, "alpha.md"), draftText("Alpha", "body"));
    writeFileSync(join(drafts, "beta.md"), draftText("Beta", "body"));
    const peers: FakePeer[] = [];
    const { manager } = managerFor(root, peers);

    await manager.start(draftPath("alpha.md"));
    await manager.start(draftPath("beta.md"));
    expect(peers).toHaveLength(2);

    manager.dispose();
    for (const peer of peers) {
      expect(peer.closed).toBe(true);
      expect(peer.closes).toBe(1);
    }
    expect(manager.children()).toEqual([]);
    expect(manager.snapshot().map((run) => run.status)).toEqual(["stopped", "stopped"]);
    expect(manager.snapshot().some((run) => run.status === "running")).toBe(false);
  });

  test("children lists every live peer's pid, argv, and cwd", async () => {
    const { root, drafts } = await fixture();
    writeFileSync(join(drafts, "alpha.md"), draftText("Alpha", "body"));
    writeFileSync(join(drafts, "beta.md"), draftText("Beta", "body"));
    const peers: FakePeer[] = [];
    const { manager } = managerFor(root, peers);

    await manager.start(draftPath("alpha.md"));
    await manager.start(draftPath("beta.md"));
    expect(manager.children()).toEqual([
      { pid: 4200, argv: ["stub-acp"], cwd: root },
      { pid: 4201, argv: ["stub-acp"], cwd: root },
    ]);

    manager.stop(draftPath("alpha.md"));
    expect(manager.children()).toEqual([{ pid: 4201, argv: ["stub-acp"], cwd: root }]);
  });

  test("a stop while the provider environment resolves closes that late peer without running it", async () => {
    const { root, drafts } = await fixture();
    writeFileSync(join(drafts, "late.md"), draftText("Late", "body"));
    const peers: FakePeer[] = [];
    const environment = Promise.withResolvers<Record<string, string | undefined>>();
    const { manager } = managerFor(root, peers, () => environment.promise);

    const starting = manager.start(draftPath("late.md"));
    expect(manager.snapshot(draftPath("late.md")).status).toBe("running");
    expect(manager.stop(draftPath("late.md"))).toBe(true);
    environment.resolve({});

    const result = await starting;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stopped).toBe(true);
    expect(manager.snapshot(draftPath("late.md")).status).toBe("stopped");
    expect(manager.snapshot(draftPath("late.md")).error).toBeNull();
    expect(existsSync(join(drafts, "late.md"))).toBe(true);

    const peer = peers[0];
    expect(peer).toBeDefined();
    expect(peer?.prompts).toEqual([]);
    expect(peer?.closed).toBe(true);
    expect(peer?.closes).toBe(1);
  });

  test("a connect failure after stop leaves that draft stopped rather than failed", async () => {
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
        manager.stop(draftPath("late-failure.md"));
        throw new Error("connection refused");
      },
    });
    managers.push(manager);

    const result = await manager.start(draftPath("late-failure.md"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stopped).toBe(true);
    expect(manager.snapshot(draftPath("late-failure.md")).status).toBe("stopped");
    expect(manager.snapshot(draftPath("late-failure.md")).error).toBeNull();
    expect(manager.children()).toEqual([]);
    expect(existsSync(join(drafts, "late-failure.md"))).toBe(true);
  });

  test("a failed peer keeps its draft and reports the error; retry starts a new peer", async () => {
    const { root, drafts } = await fixture();
    writeFileSync(join(drafts, "fail.md"), draftText("Fail", "body"));
    const peers: FakePeer[] = [];
    const { manager } = managerFor(root, peers);

    await manager.start(draftPath("fail.md"));
    const peer = await waitFor(() => peers[0], "the peer");
    peer.fail("the model is unavailable");
    const failed = await waitFor(
      () => (manager.snapshot(draftPath("fail.md")).status === "failed" ? true : undefined),
      "the failure",
    );
    expect(failed).toBe(true);
    expect(manager.snapshot(draftPath("fail.md")).error).toBe("the model is unavailable");
    expect(existsSync(join(drafts, "fail.md"))).toBe(true);

    await manager.start(draftPath("fail.md"));
    const retry = await waitFor(() => peers[1], "the retry peer");
    expect(retry.prompts).toEqual([`/goal-draft ${draftPath("fail.md")}`]);
    expect(manager.snapshot(draftPath("fail.md")).status).toBe("running");
  });

  test("a successful stub agent removes only its draft after verifying the issue label", async () => {
    const { root, drafts } = await fixture();
    writeFileSync(join(drafts, "verified.md"), draftText("Verified", "body"));
    writeFileSync(join(drafts, "unverified.md"), draftText("Unverified", "body"));
    const peers: FakePeer[] = [];
    const { manager } = managerFor(root, peers);

    await manager.start(draftPath("verified.md"));
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
      () => (manager.snapshot(draftPath("verified.md")).status === "succeeded" ? true : undefined),
      "the verified success",
    );
    expect(existsSync(join(drafts, "verified.md"))).toBe(false);
    expect(existsSync(spec)).toBe(true);
    expect(verified.closed).toBe(true);
    expect(verified.closes).toBe(1);
    expect(manager.children()).toEqual([]);
    expect(listGoalDrafts(root).map((draft) => draft.name)).toEqual(["unverified.md"]);

    await manager.start(draftPath("unverified.md"));
    const unverified = await waitFor(() => peers[1], "the failing verification peer");
    expect(manager.children()).toEqual([{ pid: 4201, argv: ["stub-acp"], cwd: root }]);
    const verifiedLabelOnCreate = false;
    if (verifiedLabelOnCreate) await unlink(join(drafts, "unverified.md"));
    unverified.fail("goal label missing from the created issue");
    const failed = await waitFor(
      () => (manager.snapshot(draftPath("unverified.md")).status === "failed" ? true : undefined),
      "the failed verification",
    );
    expect(failed).toBe(true);
    expect(existsSync(join(drafts, "unverified.md"))).toBe(true);
    expect(manager.snapshot(draftPath("unverified.md")).error).toContain("goal label missing");
    expect(unverified.closed).toBe(true);
    expect(unverified.closes).toBe(1);
    expect(manager.children()).toEqual([]);
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
