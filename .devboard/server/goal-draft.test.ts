import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
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
} from "../server/goal-drafts";
import {
  GOAL_DRAFT_OWNER_VERSION,
  goalDraftLeasePath,
  goalDraftOwnerStatePath,
  readGoalDraftHandoff,
  readGoalDraftLease,
  readGoalDraftOwnerState,
  writeGoalDraftLease,
  writeGoalDraftOwnerState,
} from "../server/goal-draft-owner";

/**
 * Draft reads and the per-path detached elaboration owners. Every fixture
 * lives under `.devboard/.tmp`; each peer is the deterministic stub agent and
 * no real agent, GitHub object, or file outside the fixture is touched.
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

function draftPath(name: string): string {
  return `.devboard/goal-proposals/${name}`;
}

function managerFor(
  root: string,
  stateDir: string,
  log: string,
  environment: () => Promise<Record<string, string | undefined>> = async () => ({
    ...process.env,
  }),
  logLine: (line: string) => void = () => undefined,
): { manager: GoalDraftManager; events: unknown[] } {
  const events: unknown[] = [];
  const manager = new GoalDraftManager({
    repoDir: root,
    stateDir,
    command: `bun ${stubAgent} --log=${log} --goal-draft`,
    environment,
    log: logLine,
    pollMs: 30,
    send: (event) => events.push(event),
  });
  managers.push(manager);
  return { manager, events };
}

function isEventType(event: unknown, type: string): boolean {
  return typeof event === "object" && event !== null && "type" in event && event.type === type;
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

/** The prompt reads the stub logs after its own start line, so a start is not a prompt. */
function promptsFor(log: string, path: string): string[] {
  return logLines(log).filter((line) => line === `goal-draft ${path}`);
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
  test("starts the elaboration peer without skills", async () => {
    const { root, drafts, stateDir, log } = await fixture();
    writeFileSync(join(drafts, "noskills.md"), draftText("No skills", "STUB-HANG body"));
    const { manager } = managerFor(root, stateDir, log);

    expect((await manager.start(draftPath("noskills.md"))).ok).toBe(true);
    const argv = await waitFor(
      () => logLines(log).find((line) => line.startsWith("argv ")),
      "the peer's argv",
    );
    expect(argv).toContain("--no-skills");
  });

  test("starts two distinct drafts at once with one live owner and snapshot per path", async () => {
    const { root, drafts, stateDir, log } = await fixture();
    writeFileSync(join(drafts, "one.md"), draftText("One", "STUB-HANG body"));
    writeFileSync(join(drafts, "two.md"), draftText("Two", "STUB-HANG body"));
    const { manager, events } = managerFor(root, stateDir, log);

    const first = draftPath("one.md");
    const second = draftPath("two.md");
    expect((await manager.start(first)).ok).toBe(true);
    expect((await manager.start(second)).ok).toBe(true);
    const pids = await waitFor(() => (startPids(log).length === 2 ? startPids(log) : undefined), "both peers");
    expect(pids.every(alive)).toBe(true);
    expect(manager.snapshot(first).status).toBe("running");
    expect(manager.snapshot(second).status).toBe("running");
    expect(manager.snapshot(first).path).toBe(first);
    expect(manager.snapshot(second).path).toBe(second);
    expect(manager.isRunning(first)).toBe(true);
    expect(manager.isRunning(second)).toBe(true);
    expect(manager.snapshot().map((run) => run.path)).toEqual([first, second]);
    await waitFor(
      () =>
        manager.snapshot(first).activity.length > 0 && manager.snapshot(second).activity.length > 0
          ? true
          : undefined,
      "both activity streams",
    );
    expect(events.filter((event) => isEventType(event, "issuesDraftState")).length).toBeGreaterThan(1);
  });

  test("starts a third and fourth draft without refusing any of them", async () => {
    const { root, drafts, stateDir, log } = await fixture();
    const names = ["one.md", "two.md", "three.md", "four.md"];
    for (const name of names) writeFileSync(join(drafts, name), draftText(name, "STUB-HANG body"));
    const { manager } = managerFor(root, stateDir, log);

    for (const name of names) {
      expect((await manager.start(draftPath(name))).ok).toBe(true);
    }
    await waitFor(() => (startPids(log).length === 4 ? true : undefined), "four peers");
    expect(names.every((name) => manager.snapshot(draftPath(name)).status === "running")).toBe(true);
  });

  test("refuses a second peer for the same path with the exact reason", async () => {
    const { root, drafts, stateDir, log } = await fixture();
    writeFileSync(join(drafts, "once.md"), draftText("Once", "STUB-HANG body"));
    const { manager } = managerFor(root, stateDir, log);
    const path = draftPath("once.md");

    expect((await manager.start(path)).ok).toBe(true);
    await waitFor(() => startPids(log)[0], "the first peer");
    const refused = await manager.start(path);
    expect(refused).toEqual({ ok: false, message: "This draft is being elaborated." });
    expect(startPids(log)).toHaveLength(1);
  });

  test("answers one draft's question without reaching another", async () => {
    const { root, drafts, stateDir, log } = await fixture();
    writeFileSync(join(drafts, "a.md"), draftText("A", "STUB-QUESTION body"));
    writeFileSync(join(drafts, "b.md"), draftText("B", "STUB-QUESTION body"));
    const { manager } = managerFor(root, stateDir, log);
    const a = draftPath("a.md");
    const b = draftPath("b.md");

    expect((await manager.start(a)).ok).toBe(true);
    expect((await manager.start(b)).ok).toBe(true);
    const both = await waitFor(
      () =>
        manager.snapshot(a).question !== null && manager.snapshot(b).question !== null
          ? manager.snapshot()
          : undefined,
      "both questions",
    );
    expect(both).toHaveLength(2);
    expect(manager.answer(a, manager.snapshot(a).question!.id, "Alpha")).toBe(true);
    await waitFor(
      () => (logLines(log).filter((line) => line === "answer Alpha").length === 1 ? true : undefined),
      "the answer reaching only the first peer",
    );
    await waitFor(
      () => (manager.snapshot(a).question === null ? true : undefined),
      "the first question to clear",
    );
    expect(manager.snapshot(b).question).not.toBeNull();
    expect(manager.answer(a, "missing", "Alpha")).toBe(false);

    expect(manager.answer(b, manager.snapshot(b).question!.id, "Beta")).toBe(true);
    await waitFor(
      () => (logLines(log).filter((line) => line === "answer Beta").length === 1 ? true : undefined),
      "the answer reaching the second peer",
    );
    await waitFor(
      () =>
        manager.snapshot(a).status === "succeeded" && manager.snapshot(b).status === "succeeded"
          ? true
          : undefined,
      "both elaborations to finish",
    );
    expect(existsSync(join(drafts, "a.md"))).toBe(false);
    expect(existsSync(join(drafts, "b.md"))).toBe(false);
    expect(existsSync(join(root, ".devboard", "goals", "a.md"))).toBe(true);
    expect(existsSync(join(root, ".devboard", "goals", "b.md"))).toBe(true);
    expect(startPids(log)).toHaveLength(2);
  });

  test("refuses an answer when the addressed draft has no pending question", async () => {
    const { root, drafts, stateDir, log } = await fixture();
    writeFileSync(join(drafts, "quiet.md"), draftText("Quiet", "STUB-HANG body"));
    const { manager } = managerFor(root, stateDir, log);
    const path = draftPath("quiet.md");

    expect((await manager.start(path)).ok).toBe(true);
    await waitFor(() => startPids(log)[0], "the peer");
    expect(manager.answer(path, 1, "Alpha")).toBe(false);
    expect(manager.answer(draftPath("other.md"), 1, "Alpha")).toBe(false);
    expect(logLines(log).filter((line) => line.startsWith("answer "))).toEqual([]);
  });

  test("starts two drafts created from the drafts page at the same time", async () => {
    const { root, stateDir, log } = await fixture();
    const first = await writeGoalProposal(
      parseGoalProposalSubmission({ report: "Create the first goal from the drafts page. STUB-HANG" }),
      { repoDir: root },
    );
    const second = await writeGoalProposal(
      parseGoalProposalSubmission({ report: "Create the second goal from the drafts page. STUB-HANG" }),
      { repoDir: root },
    );
    const { manager } = managerFor(root, stateDir, log);

    expect((await manager.start(first.path)).ok).toBe(true);
    expect((await manager.start(second.path)).ok).toBe(true);
    await waitFor(() => (startPids(log).length === 2 ? true : undefined), "both created peers");
    // One prompt line per draft proves neither started twice.
    await waitFor(
      () =>
        promptsFor(log, first.path).length === 1 && promptsFor(log, second.path).length === 1
          ? true
          : undefined,
      "both draft prompts",
    );
    expect(promptsFor(log, first.path)).toHaveLength(1);
    expect(promptsFor(log, second.path)).toHaveLength(1);
    expect(listGoalDrafts(root).map((draft) => draft.path)).toEqual([first.path, second.path].sort());
  });

  test("stops only the addressed draft and keeps the other running", async () => {
    const { root, drafts, stateDir, log } = await fixture();
    writeFileSync(join(drafts, "keep.md"), draftText("Keep", "STUB-HANG body"));
    writeFileSync(join(drafts, "stop.md"), draftText("Stop", "STUB-HANG body"));
    const { manager } = managerFor(root, stateDir, log);
    const keep = draftPath("keep.md");
    const stop = draftPath("stop.md");

    expect((await manager.start(keep)).ok).toBe(true);
    expect((await manager.start(stop)).ok).toBe(true);
    await waitFor(() => (startPids(log).length === 2 ? true : undefined), "both peers");
    const stopPeer = await waitFor(
      () => readGoalDraftOwnerState(stateDir, root, stop)?.peer?.pid,
      "the stopped draft's peer",
    );
    const keepPeer = await waitFor(
      () => readGoalDraftOwnerState(stateDir, root, keep)?.peer?.pid,
      "the kept draft's peer",
    );
    expect(manager.stop(stop)).toBe(true);
    await waitFor(
      () => (manager.snapshot(stop).status === "stopped" ? true : undefined),
      "the stopped draft",
    );
    expect(manager.stop(draftPath("missing.md"))).toBe(false);
    expect(manager.snapshot(keep).status).toBe("running");
    expect(manager.isRunning(keep)).toBe(true);
    expect(existsSync(join(drafts, "stop.md"))).toBe(true);
    await waitFor(() => (alive(stopPeer) ? undefined : true), "the stopped peer to exit");
    expect(alive(keepPeer)).toBe(true);
    expect(readGoalDraftOwnerState(stateDir, root, stop)?.run.status).toBe("stopped");
  });

  test("records one success and one failure while a third draft keeps running", async () => {
    const { root, drafts, stateDir, log } = await fixture();
    writeFileSync(join(drafts, "win.md"), draftText("Win", "STUB-QUESTION body"));
    writeFileSync(join(drafts, "lose.md"), draftText("Lose", "STUB-FAIL body"));
    writeFileSync(join(drafts, "stay.md"), draftText("Stay", "STUB-HANG body"));
    const { manager } = managerFor(root, stateDir, log);
    const win = draftPath("win.md");
    const lose = draftPath("lose.md");
    const stay = draftPath("stay.md");

    expect((await manager.start(win)).ok).toBe(true);
    expect((await manager.start(lose)).ok).toBe(true);
    expect((await manager.start(stay)).ok).toBe(true);
    await waitFor(
      () => (manager.snapshot(win).question !== null ? true : undefined),
      "the winning question",
    );
    expect(manager.answer(win, manager.snapshot(win).question!.id, "Alpha")).toBe(true);

    const finished = await waitFor(
      () =>
        manager.snapshot(win).status === "succeeded" && manager.snapshot(lose).status === "failed"
          ? manager.snapshot()
          : undefined,
      "one success and one failure",
    );
    expect(finished.find((run) => run.path === lose)?.error).toContain(
      "goal label verification failed",
    );
    expect(manager.snapshot(stay).status).toBe("running");
    expect(existsSync(join(drafts, "win.md"))).toBe(false);
    expect(existsSync(join(drafts, "lose.md"))).toBe(true);
    expect(existsSync(join(drafts, "stay.md"))).toBe(true);
    expect(existsSync(join(root, ".devboard", "goals", "win.md"))).toBe(true);
    expect(existsSync(join(root, ".devboard", "goals", "lose.md"))).toBe(false);
    expect(startPids(log)).toHaveLength(3);
  });

  test("dispose ends every running owner with one interrupted failure", async () => {
    const { root, drafts, stateDir, log } = await fixture();
    writeFileSync(join(drafts, "first.md"), draftText("First", "STUB-HANG body"));
    writeFileSync(join(drafts, "second.md"), draftText("Second", "STUB-QUESTION body"));
    const { manager } = managerFor(root, stateDir, log);
    const paths = [draftPath("first.md"), draftPath("second.md")];

    for (const path of paths) expect((await manager.start(path)).ok).toBe(true);
    const pids = await waitFor(() => (startPids(log).length === 2 ? startPids(log) : undefined), "both peers");
    manager.dispose();
    await waitFor(() => (pids.every((pid) => !alive(pid)) ? true : undefined), "both peers to exit");
    for (const path of paths) {
      const state = await waitFor(
        () => {
          const stored = readGoalDraftOwnerState(stateDir, root, path);
          return stored?.run.status === "failed" ? stored : undefined;
        },
        `the terminal state for ${path}`,
      );
      expect(state.run.status).toBe("failed");
      expect(state.run.error).toContain("server exit interrupted the elaboration");
      expect(existsSync(join(root, path))).toBe(true);
    }
  });

  test("one dashboard's dispose leaves another dashboard's live elaboration running", async () => {
    const { root, drafts, stateDir, log } = await fixture();
    writeFileSync(join(drafts, "first.md"), draftText("First", "STUB-HANG body"));
    writeFileSync(join(drafts, "second.md"), draftText("Second", "STUB-HANG body"));
    const first = draftPath("first.md");
    const second = draftPath("second.md");
    const { manager: firstDashboard } = managerFor(root, stateDir, log);
    expect((await firstDashboard.start(first)).ok).toBe(true);
    const firstPeer = await waitFor(
      () => readGoalDraftOwnerState(stateDir, root, first)?.peer?.pid,
      "the first peer",
    );
    const lease = await waitFor(
      () => readGoalDraftLease(stateDir, root) ?? undefined,
      "the first lease",
    );
    expect(lease.pid).toBe(process.pid);
    expect(lease.instance).toBeDefined();

    // Attaches after the first dashboard holds the lease, then starts a draft
    // of its own without taking supervision away from it.
    const { manager: secondDashboard } = managerFor(root, stateDir, log);
    expect((await secondDashboard.start(second)).ok).toBe(true);
    const secondPeer = await waitFor(
      () => readGoalDraftOwnerState(stateDir, root, second)?.peer?.pid,
      "the second peer",
    );
    expect(readGoalDraftLease(stateDir, root)?.instance).toBe(lease.instance);

    firstDashboard.dispose();
    await waitFor(() => (alive(firstPeer) ? undefined : true), "the first peer to exit");
    await waitFor(
      () =>
        readGoalDraftOwnerState(stateDir, root, first)?.run.status === "failed" ? true : undefined,
      "the first run's interruption",
    );

    const secondState = readGoalDraftOwnerState(stateDir, root, second);
    expect(secondState?.run.status).toBe("running");
    expect(secondState?.owner).not.toBeNull();
    expect(alive(secondState!.owner!.pid)).toBe(true);
    expect(alive(secondPeer)).toBe(true);
  });

  test("an observing dashboard's dispose leaves the supervising dashboard's owner running", async () => {
    const { root, drafts, stateDir, log } = await fixture();
    writeFileSync(join(drafts, "supervised.md"), draftText("Supervised", "STUB-HANG body"));
    writeFileSync(join(drafts, "observed.md"), draftText("Observed", "STUB-HANG body"));
    const supervised = draftPath("supervised.md");
    const observedPath = draftPath("observed.md");
    const { manager: supervisor } = managerFor(root, stateDir, log);
    expect((await supervisor.start(supervised)).ok).toBe(true);
    const supervisedPeer = await waitFor(
      () => readGoalDraftOwnerState(stateDir, root, supervised)?.peer?.pid,
      "the supervised peer",
    );
    const { manager: observer } = managerFor(root, stateDir, log);
    expect((await observer.start(observedPath)).ok).toBe(true);
    const observedPeer = await waitFor(
      () => readGoalDraftOwnerState(stateDir, root, observedPath)?.peer?.pid,
      "the observed peer",
    );

    observer.dispose();
    await waitFor(() => (alive(observedPeer) ? undefined : true), "the observer's peer to exit");
    await waitFor(
      () =>
        readGoalDraftOwnerState(stateDir, root, observedPath)?.run.status === "failed"
          ? true
          : undefined,
      "the observer's interrupted run",
    );

    expect(readGoalDraftOwnerState(stateDir, root, supervised)?.run.status).toBe("running");
    expect(alive(supervisedPeer)).toBe(true);
  });

  test("refresh stops supervising when another live dashboard owns the lease", async () => {
    const { root, drafts, stateDir, log } = await fixture();
    writeFileSync(join(drafts, "leased.md"), draftText("Leased", "STUB-HANG body"));
    const path = draftPath("leased.md");
    const { manager } = managerFor(root, stateDir, log);
    expect((await manager.start(path)).ok).toBe(true);
    const peer = await waitFor(
      () => readGoalDraftOwnerState(stateDir, root, path)?.peer?.pid,
      "the leased peer",
    );

    // A live lease from another dashboard outranks this manager's supervision:
    // a refresh drops it, so no reload handoff claims the other dashboard's run.
    writeGoalDraftLease(stateDir, root, { pid: process.pid, updatedAt: 1, instance: "another" });
    manager.handoff();
    expect(readGoalDraftHandoff(stateDir, root)).toBeNull();
    const lease = readGoalDraftLease(stateDir, root);
    expect(lease?.instance).toBe("another");
    expect(lease?.updatedAt).toBe(1);

    manager.dispose();
    await waitFor(() => (alive(peer) ? undefined : true), "the leased peer to exit");
  });

  test("a stop while the provider environment resolves spawns no owner", async () => {
    const { root, drafts, stateDir, log } = await fixture();
    writeFileSync(join(drafts, "late.md"), draftText("Late", "STUB-HANG body"));
    const environment = Promise.withResolvers<Record<string, string | undefined>>();
    const { manager } = managerFor(root, stateDir, log, () => environment.promise);
    const path = draftPath("late.md");

    const starting = manager.start(path);
    expect(manager.snapshot(path).status).toBe("running");
    expect(manager.stop(path)).toBe(true);
    expect(manager.snapshot(path).status).toBe("stopped");
    environment.resolve({ ...process.env });

    const result = await starting;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stopped).toBe(true);
    expect(manager.snapshot(path).status).toBe("stopped");
    expect(manager.snapshot(path).error).toBeNull();
    expect(startPids(log)).toEqual([]);
    expect(readGoalDraftOwnerState(stateDir, root, path)?.run.status).toBe("stopped");
  });

  test("an environment failure records failed with no owner and no draft loss", async () => {
    const { root, drafts, stateDir, log } = await fixture();
    writeFileSync(join(drafts, "unavailable.md"), draftText("Unavailable", "STUB-HANG body"));
    const { manager } = managerFor(root, stateDir, log, async () => {
      throw new Error("no subscription can serve this peer");
    });
    const path = draftPath("unavailable.md");

    const result = await manager.start(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("no subscription");
    expect(manager.snapshot(path).status).toBe("failed");
    expect(manager.snapshot(path).error).toContain("no subscription");
    expect(existsSync(join(drafts, "unavailable.md"))).toBe(true);
    expect(startPids(log)).toEqual([]);
    expect(readGoalDraftOwnerState(stateDir, root, path)?.run.status).toBe("failed");
  });

  test("a failed peer keeps its draft and retry starts a new peer", async () => {
    const { root, drafts, stateDir, log } = await fixture();
    writeFileSync(join(drafts, "fail.md"), draftText("Fail", "STUB-FAIL body"));
    const { manager } = managerFor(root, stateDir, log);
    const path = draftPath("fail.md");

    expect((await manager.start(path)).ok).toBe(true);
    const failed = await waitFor(
      () => (manager.snapshot(path).status === "failed" ? manager.snapshot(path) : undefined),
      "the failure",
    );
    expect(failed.error).toContain("goal label verification failed");
    expect(existsSync(join(drafts, "fail.md"))).toBe(true);
    const firstPid = startPids(log)[0]!;
    await waitFor(() => (alive(firstPid) ? undefined : true), "the failed peer to exit");

    expect((await manager.start(path)).ok).toBe(true);
    await waitFor(() => (startPids(log).length === 2 ? true : undefined), "the retry peer");
    await waitFor(
      () => (promptsFor(log, path).length === 2 ? true : undefined),
      "both draft prompts",
    );
    expect(promptsFor(log, path)).toHaveLength(2);
  });
});

describe("draft poll write failures", () => {
  function runningState(root: string, path: string) {
    const now = new Date().toISOString();
    return {
      version: GOAL_DRAFT_OWNER_VERSION,
      run: {
        status: "running" as const,
        path,
        startedAt: now,
        finishedAt: null,
        error: null,
        activity: [],
        question: null,
      },
      owner: null,
      peer: null,
      launcherPid: process.pid,
      supervisorPid: process.pid,
      updatedAt: now,
    };
  }

  test("a failed owner-state write is logged once and the poller keeps polling", async () => {
    const { root, stateDir, log } = await fixture();
    const reported: string[] = [];
    const path = draftPath("interrupted.md");
    const { manager } = managerFor(root, stateDir, log, undefined, (line) =>
      reported.push(line),
    );
    writeGoalDraftOwnerState(stateDir, root, path, runningState(root, path));
    // A directory where writeJson's temporary file goes fails the write the
    // way a full or read-only state directory does, and the stored state stays
    // readable.
    const blocked = `${goalDraftOwnerStatePath(stateDir, root, path)}.${process.pid}.tmp`;
    mkdirSync(blocked);

    await waitFor(() => (reported.length > 0 ? true : undefined), "the poll failure log");
    // Several 30 ms polls must fail on the same error before the dedupe claim
    // means anything; the poller owns real intervals and a real process table,
    // so fake timers cannot drive it.
    await Bun.sleep(200);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("goal-draft poll failed");

    // The interval survived the failure: once the write can land again, the
    // same poller records the interrupted run without a restart.
    rmSync(blocked, { recursive: true, force: true });
    await waitFor(
      () => (manager.snapshot(path).status === "failed" ? true : undefined),
      "the interrupted run after recovery",
    );
    expect(readGoalDraftOwnerState(stateDir, root, path)?.run.status).toBe("failed");
    expect(reported).toHaveLength(1);
  });

  test("a failed lease write is logged and the supervised owner keeps running", async () => {
    const { root, drafts, stateDir, log } = await fixture();
    const reported: string[] = [];
    writeFileSync(join(drafts, "lease.md"), draftText("Lease", "STUB-HANG body"));
    const { manager } = managerFor(root, stateDir, log, undefined, (line) =>
      reported.push(line),
    );
    const path = draftPath("lease.md");
    expect((await manager.start(path)).ok).toBe(true);
    const peer = await waitFor(
      () => readGoalDraftOwnerState(stateDir, root, path)?.peer?.pid,
      "the peer",
    );
    const lease = await waitFor(() => readGoalDraftLease(stateDir, root) ?? undefined, "the lease");
    const blocked = `${goalDraftLeasePath(stateDir, root)}.${process.pid}.tmp`;
    mkdirSync(blocked);

    await waitFor(() => (reported.length > 0 ? true : undefined), "the lease failure log");
    expect(reported.every((line) => line.includes("goal-draft poll failed"))).toBe(true);
    expect(alive(peer)).toBe(true);
    expect(manager.snapshot(path).status).toBe("running");

    rmSync(blocked, { recursive: true, force: true });
    await waitFor(() => {
      const next = readGoalDraftLease(stateDir, root);
      return next !== null && next.updatedAt > lease.updatedAt ? true : undefined;
    }, "the lease to renew");
    expect(alive(peer)).toBe(true);
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
