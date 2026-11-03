import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { FeedbackRequestError } from "./feedback";
import { IdempotencyStore, MAX_IDEMPOTENCY_KEY, parseIdempotencyKey } from "./idempotency";

const temporaryDirectories: string[] = [];
const temporaryRoot = join(import.meta.dir, "..", ".tmp");

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, "idempotency-"));
  temporaryDirectories.push(directory);
  return directory;
}

const HOUR_MS = 60 * 60 * 1000;

/** Reads the entries the store persisted under `<stateDir>/idempotency/`. */
async function storedEntries(root: string): Promise<Array<{ key: string; createdAt: number }>> {
  const directory = join(root, "state", "idempotency");
  const names = await readdir(directory);
  const name = names[0];
  if (name === undefined) throw new Error("the store persisted no document");
  const document = JSON.parse(await readFile(join(directory, name), "utf8")) as {
    entries: Array<{ key: string; createdAt: number }>;
  };
  return document.entries;
}

describe("idempotency key parsing", () => {
  test("treats an absent header as no retry contract", () => {
    expect(parseIdempotencyKey(null)).toBeNull();
  });

  test("keeps an opaque key verbatim", () => {
    expect(parseIdempotencyKey(" Retry-1 ")).toBe("Retry-1");
  });

  test("refuses an empty, oversized, or control-bearing key", () => {
    for (const value of ["", "   ", "x".repeat(MAX_IDEMPOTENCY_KEY + 1), "line\nbreak"]) {
      expect(() => parseIdempotencyKey(value)).toThrow(FeedbackRequestError);
    }
  });
});

describe("idempotency store", () => {
  test("runs one keyed operation and replays its result", async () => {
    const root = await temporaryDirectory();
    const store = new IdempotencyStore({ stateDir: join(root, "state"), repoDir: root });
    let calls = 0;
    const operation = async () => {
      calls += 1;
      return { url: "https://gitea.example/issues/42" };
    };

    const first = await store.run("feedback", "retry-1", operation);
    const second = await store.run("feedback", "retry-1", operation);

    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });

  test("runs every operation without a key", async () => {
    const root = await temporaryDirectory();
    const store = new IdempotencyStore({ stateDir: join(root, "state"), repoDir: root });
    let calls = 0;
    const operation = async () => {
      calls += 1;
      return calls;
    };

    await store.run("feedback", null, operation);
    await store.run("feedback", null, operation);

    expect(calls).toBe(2);
  });

  test("shares one in-flight attempt between concurrent retries", async () => {
    const root = await temporaryDirectory();
    const store = new IdempotencyStore({ stateDir: join(root, "state"), repoDir: root });
    const gate = Promise.withResolvers<void>();
    let calls = 0;
    const operation = async () => {
      calls += 1;
      await gate.promise;
      return { links: { draft: { href: "file:///repo/.devboard/goal-proposals/one.md" } } };
    };

    const first = store.run("goal-proposal", "retry-1", operation);
    const second = store.run("goal-proposal", "retry-1", operation);
    gate.resolve();

    const draft = { links: { draft: { href: "file:///repo/.devboard/goal-proposals/one.md" } } };
    expect(await first).toEqual(draft);
    expect(await second).toEqual(draft);
    expect(calls).toBe(1);
  });

  test("replays a completed result after a dashboard replacement", async () => {
    const root = await temporaryDirectory();
    const options = { stateDir: join(root, "state"), repoDir: root };
    const before = new IdempotencyStore(options);
    const created = await before.run("feedback", "retry-1", async () => ({
      url: "https://gitea.example/issues/42",
    }));

    let calls = 0;
    const after = new IdempotencyStore(options);
    const replayed = await after.run("feedback", "retry-1", async () => {
      calls += 1;
      return { url: "https://gitea.example/issues/43" };
    });

    expect(calls).toBe(0);
    expect(replayed).toEqual(created);
  });

  test("runs a keyed operation again after a failure", async () => {
    const root = await temporaryDirectory();
    const store = new IdempotencyStore({ stateDir: join(root, "state"), repoDir: root });
    let calls = 0;
    const operation = async () => {
      calls += 1;
      if (calls === 1) throw new Error("Gitea refused the request.");
      return { url: "https://gitea.example/issues/42" };
    };

    await expect(store.run("feedback", "retry-1", operation)).rejects.toThrow(
      "Gitea refused the request.",
    );
    expect(await store.run("feedback", "retry-1", operation)).toEqual({
      url: "https://gitea.example/issues/42",
    });
    expect(calls).toBe(2);
  });

  test("replays inside the retention window and reruns after it", async () => {
    const root = await temporaryDirectory();
    let now = Date.parse("2026-01-01T00:00:00Z");
    const store = new IdempotencyStore({
      stateDir: join(root, "state"),
      repoDir: root,
      now: () => now,
    });
    let calls = 0;
    const operation = async () => {
      calls += 1;
      return { url: `https://gitea.example/issues/${40 + calls}` };
    };

    const first = await store.run("feedback", "retry-1", operation);
    now += 23 * HOUR_MS;
    expect(await store.run("feedback", "retry-1", operation)).toEqual(first);
    expect(calls).toBe(1);

    now += 2 * HOUR_MS;
    const second = await store.run("feedback", "retry-1", operation);
    expect(calls).toBe(2);
    expect(second).toEqual({ url: "https://gitea.example/issues/42" });
  });

  test("drops an expired entry from the persisted document", async () => {
    const root = await temporaryDirectory();
    let now = Date.parse("2026-01-01T00:00:00Z");
    const store = new IdempotencyStore({
      stateDir: join(root, "state"),
      repoDir: root,
      now: () => now,
    });

    await store.run("feedback", "old", async () => ({ url: "https://gitea.example/issues/42" }));
    now += 25 * HOUR_MS;
    await store.run("feedback", "fresh", async () => ({ url: "https://gitea.example/issues/43" }));

    expect(await storedEntries(root)).toMatchObject([{ key: "fresh", createdAt: now }]);
  });

  test("does not replay a stored entry older than the window after a replacement", async () => {
    const root = await temporaryDirectory();
    let now = Date.parse("2026-01-01T00:00:00Z");
    const options = { stateDir: join(root, "state"), repoDir: root, now: () => now };
    const before = new IdempotencyStore(options);
    await before.run("feedback", "retry-1", async () => ({
      url: "https://gitea.example/issues/42",
    }));

    now += 25 * HOUR_MS;
    let calls = 0;
    const after = new IdempotencyStore(options);
    const result = await after.run("feedback", "retry-1", async () => {
      calls += 1;
      return { url: "https://gitea.example/issues/43" };
    });

    expect(calls).toBe(1);
    expect(result).toEqual({ url: "https://gitea.example/issues/43" });
  });
});
