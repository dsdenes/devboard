import { describe, expect, test } from "bun:test";
import type { IssuesIssue } from "../issues/state";
import { GITLAB_TRACKER_UNSUPPORTED } from "../issues/tracker";
import { TrackerSync, TRACKER_SYNC_INTERVAL_MS } from "./issue-sync";

function issue(number: number): IssuesIssue {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://gitea.test/acme/fixture/issues/${number}`,
    createdAt: "2026-10-29T00:00:00Z",
    labels: [],
  };
}

function sync(
  read: ConstructorParameters<typeof TrackerSync>[0]["read"],
  overrides: { repository?: string | null; intervalMs?: number; timeoutMs?: number } = {},
): TrackerSync {
  return new TrackerSync({
    repoDir: "/fixture/repo",
    repository: () => (overrides.repository === undefined ? "acme/fixture" : overrides.repository),
    environment: {},
    ...(read === undefined ? {} : { read }),
    ...(overrides.intervalMs === undefined ? {} : { intervalMs: overrides.intervalMs }),
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
  });
}

describe("dashboard tracker sync", () => {
  test("publishes the complete open list and its interval", async () => {
    const subject = sync(async () => ({ kind: "issues", issues: [issue(2), issue(1)], etag: "etag-1" }));
    const result = await subject.sync();
    expect(result).toMatchObject({ fresh: true, error: null });
    expect(result.issues?.map((entry) => entry.number)).toEqual([2, 1]);
    expect(subject.openIssues?.map((entry) => entry.number)).toEqual([2, 1]);
    expect(subject.view.intervalMs).toBe(TRACKER_SYNC_INTERVAL_MS);
    expect(subject.view.lastSyncAt).not.toBeNull();
    expect(subject.view.error).toBeNull();
  });

  test("reuses the etag and keeps the list on a 304", async () => {
    const etags: Array<string | null> = [];
    const subject = sync(async ({ etag }) => {
      etags.push(etag);
      return etag === null
        ? { kind: "issues", issues: [issue(1)], etag: '"etag-1"' }
        : { kind: "not-modified", etag };
    });
    await subject.sync();
    const second = await subject.sync();
    expect(etags).toEqual([null, '"etag-1"']);
    expect(second.fresh).toBe(false);
    expect(subject.openIssues?.map((entry) => entry.number)).toEqual([1]);
    expect(subject.view.error).toBeNull();
  });

  test("keeps the last complete list when a read fails, and names the failure", async () => {
    let calls = 0;
    const subject = sync(async () => {
      calls += 1;
      return calls === 1
        ? { kind: "issues", issues: [issue(1)], etag: null }
        : { kind: "error", detail: "HTTP 502" };
    });
    await subject.sync();
    const failed = await subject.sync();
    expect(failed).toMatchObject({ fresh: false, issues: [issue(1)], error: "HTTP 502" });
    expect(failed.startedAt).not.toBeNull();
    expect(subject.view.error).toBe("HTTP 502");
    expect(subject.view.lastSyncAt).not.toBeNull();
  });

  test("does nothing without a repository and never invents a list", async () => {
    let calls = 0;
    const subject = sync(
      async () => {
        calls += 1;
        return { kind: "issues", issues: [issue(1)], etag: null };
      },
      { repository: null },
    );
    const result = await subject.sync();
    expect(calls).toBe(0);
    expect(result).toEqual({ fresh: false, issues: null, error: null, startedAt: null });
    expect(subject.openIssues).toBeNull();
    expect(subject.view.error).toBeNull();
    expect(subject.view.lastSyncAt).toBeNull();
  });

  test("bounds a read that never settles and lets the next call retry", async () => {
    let calls = 0;
    const subject = sync(
      () => {
        calls += 1;
        return calls === 1
          ? new Promise<never>(() => undefined)
          : Promise.resolve({ kind: "issues" as const, issues: [issue(3)], etag: null });
      },
      { timeoutMs: 20 },
    );
    const first = await subject.sync();
    expect(first.fresh).toBe(false);
    expect(subject.view.error).toContain("did not answer within 20 ms");
    const second = await subject.sync();
    expect(second.fresh).toBe(true);
    expect(second.issues?.map((entry) => entry.number)).toEqual([3]);
    expect(subject.view.error).toBeNull();
  });

  test("joins a read already in flight instead of issuing a second", async () => {
    let calls = 0;
    const gate = Promise.withResolvers<{ kind: "issues"; issues: IssuesIssue[]; etag: string | null }>();
    const subject = sync(() => {
      calls += 1;
      return gate.promise;
    });
    const first = subject.sync();
    const second = subject.sync();
    expect(first).toBe(second);
    gate.resolve({ kind: "issues", issues: [issue(4)], etag: null });
    expect(await first).toEqual(await second);
    expect(calls).toBe(1);
  });

  test("publishes a named unsupported state and never retries that forge", async () => {
    let calls = 0;
    const subject = sync(async () => {
      calls += 1;
      return { kind: "unsupported", detail: GITLAB_TRACKER_UNSUPPORTED };
    });
    const first = await subject.sync();
    expect(first.fresh).toBe(false);
    expect(first.error).toBe(GITLAB_TRACKER_UNSUPPORTED);
    expect(first.startedAt).not.toBeNull();
    expect(subject.view.error).toBe(GITLAB_TRACKER_UNSUPPORTED);
    expect(subject.unsupportedDetail).toBe(GITLAB_TRACKER_UNSUPPORTED);
    const second = await subject.sync();
    expect(second).toEqual({
      fresh: false,
      issues: null,
      error: GITLAB_TRACKER_UNSUPPORTED,
      startedAt: null,
    });
    expect(calls).toBe(1);
  });
});
