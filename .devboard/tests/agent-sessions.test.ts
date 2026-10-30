import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  SESSION_RESPONSE_MAX_BYTES,
  defaultSessionReader,
  firstNormalizedLine,
  listSessions,
  normalizeSessionLine,
  readSessionMessages,
  searchSessions,
  selectSessions,
  toolFailureFingerprint,
  type SessionReader,
} from "../lib/agent-sessions";

const harnessRoot = resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; stateDir: string; repoDir: string }> {
  await mkdir(join(harnessRoot, ".tmp"), { recursive: true });
  const root = await mkdtemp(join(harnessRoot, ".tmp", "agent-sessions-"));
  temporaryDirectories.push(root);
  const repoDir = join(root, "checkout");
  const stateDir = join(root, "state");
  await mkdir(join(repoDir, ".worktree", "task"), { recursive: true });
  await mkdir(join(stateDir, "providers", "agents", "fixture", "sessions", "bucket"), {
    recursive: true,
  });
  return { root, stateDir, repoDir };
}

interface Seed {
  id: string;
  cwd: string;
  startedAt: string;
  messages?: number;
  toolErrors?: number;
  command?: string;
  errorText?: string;
  malformed?: boolean;
}

async function seed(stateDir: string, seed: Seed): Promise<string> {
  const path = join(
    stateDir,
    "providers",
    "agents",
    "fixture",
    "sessions",
    "bucket",
    `${seed.id}.jsonl`,
  );
  const records: string[] = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: seed.id,
      timestamp: seed.startedAt,
      cwd: seed.cwd,
    }),
    JSON.stringify({ type: "title", v: 1, title: `title ${seed.id}`, updatedAt: seed.startedAt }),
  ];
  const messages = seed.messages ?? 0;
  for (let index = 0; index < messages; index += 1) {
    records.push(
      JSON.stringify({
        type: "message",
        id: `a${index}`,
        timestamp: seed.startedAt,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: `call-${index}`,
              name: "bash",
              arguments: { command: seed.command ?? "echo fixture" },
            },
          ],
          usage: {
            input: 10,
            output: 5,
            cacheRead: 2,
            cacheWrite: 1,
            totalTokens: 18,
            cost: { total: 0.5 },
          },
        },
      }),
    );
    records.push(
      JSON.stringify({
        type: "message",
        id: `r${index}`,
        timestamp: seed.startedAt,
        message: {
          role: "toolResult",
          toolCallId: `call-${index}`,
          toolName: "bash",
          content: [{ type: "text", text: seed.errorText ?? "ok" }],
          isError: index < (seed.toolErrors ?? 0),
        },
      }),
    );
  }
  if (seed.malformed === true) records.push("{not json");
  await writeFile(path, `${records.join("\n")}\n`);
  return path;
}

describe("ACP session reader", () => {
  test("selects only this repository's cwd and its worktrees", async () => {
    const { repoDir, stateDir } = await fixture();
    await seed(stateDir, { id: "root", cwd: repoDir, startedAt: "2026-01-01T10:00:00.000Z" });
    await seed(stateDir, {
      id: "worktree",
      cwd: join(repoDir, ".worktree", "task"),
      startedAt: "2026-01-01T11:00:00.000Z",
    });
    await seed(stateDir, { id: "elsewhere", cwd: "/tmp/other", startedAt: "2026-01-01T12:00:00.000Z" });
    await writeFile(
      join(stateDir, "providers", "agents", "fixture", "sessions", "bucket", "broken.jsonl"),
      JSON.stringify({ type: "session", id: "no-cwd", timestamp: "2026-01-01T12:00:00.000Z" }) + "\n",
    );
    const selected = selectSessions({ stateDir, repoDir });
    expect(selected.sessions.map((session) => session.id)).toEqual(["root", "worktree"]);
    expect(selected.skipped).toBe(1);
    expect(selected.truncated).toBe(false);
    expect(selected.sessions.map((session) => session.relativeCwd)).toEqual([
      ".",
      ".worktree/task",
    ]);
  });

  test("sums tokens, cost, and tool errors, and counts malformed lines", async () => {
    const { repoDir, stateDir } = await fixture();
    await seed(stateDir, {
      id: "s1",
      cwd: repoDir,
      startedAt: "2026-01-01T10:00:00.000Z",
      messages: 3,
      toolErrors: 2,
      errorText: "ERROR: boom",
      malformed: true,
    });
    const selected = selectSessions({ stateDir, repoDir });
    const session = selected.sessions[0]!;
    expect(session.usage).toEqual({
      input: 30,
      output: 15,
      cacheRead: 6,
      cacheWrite: 3,
      totalTokens: 54,
      cost: 1.5,
    });
    expect(session.cost).toBeCloseTo(1.5);
    expect(session.toolErrorCount).toBe(2);
    expect(session.malformed).toBe(1);
    expect(selected.malformed).toBe(1);
    const errors = session.messages.filter((message) => message.isError);
    expect(errors.map((message) => message.errorFingerprint)).toEqual([
      toolFailureFingerprint("bash", "ERROR: boom"),
      toolFailureFingerprint("bash", "ERROR: boom"),
    ]);
  });

  test("lists newest first with filters, and pages with a bounded limit", async () => {
    const { repoDir, stateDir } = await fixture();
    for (let index = 0; index < 3; index += 1) {
      await seed(stateDir, {
        id: `s${index}`,
        cwd: repoDir,
        startedAt: `2026-01-0${index + 1}T10:00:00.000Z`,
        messages: 1,
      });
    }
    const page = listSessions({ stateDir, repoDir, limit: 2 });
    expect(page.sessions.map((session) => session.id)).toEqual(["s2", "s1"]);
    expect(page.truncated).toBe(true);
    expect(page.nextOffset).toBe(2);
    const filtered = listSessions({
      stateDir,
      repoDir,
      since: "2026-01-02T00:00:00.000Z",
      until: "2026-01-02T23:59:59.000Z",
    });
    expect(filtered.sessions.map((session) => session.id)).toEqual(["s1"]);
    const capped = listSessions({ stateDir, repoDir, limit: 999 });
    expect(capped.sessions).toHaveLength(3);
  });

  test("reads messages in order with row and byte bounds", async () => {
    const { repoDir, stateDir } = await fixture();
    await seed(stateDir, {
      id: "long",
      cwd: repoDir,
      startedAt: "2026-01-01T10:00:00.000Z",
      messages: 65,
    });
    const first = readSessionMessages({ stateDir, repoDir, id: "long" });
    expect(first?.messages).toHaveLength(50);
    expect(first?.truncated).toBe(true);
    expect(first?.nextOffset).toBe(50);
    const second = readSessionMessages({ stateDir, repoDir, id: "long", offset: 50, limit: 200 });
    expect(second?.messages).toHaveLength(80);
    expect(second?.truncated).toBe(false);
    const missing = readSessionMessages({ stateDir, repoDir, id: "absent" });
    expect(missing).toBeUndefined();

    const huge = await fixture();
    await writeFile(
      join(huge.stateDir, "providers", "agents", "fixture", "sessions", "bucket", "huge.jsonl"),
      [
        JSON.stringify({
          type: "session",
          id: "huge",
          timestamp: "2026-01-01T10:00:00.000Z",
          cwd: huge.repoDir,
        }),
        ...Array.from({ length: 20 }, (_, index) =>
          JSON.stringify({
            type: "message",
            timestamp: "2026-01-01T10:00:00.000Z",
            message: {
              role: "toolResult",
              toolName: "bash",
              content: [{ type: "text", text: `x`.repeat(10_000) }],
              isError: false,
            },
          }),
        ),
      ].join("\n"),
    );
    const bounded = readSessionMessages({
      stateDir: huge.stateDir,
      repoDir: huge.repoDir,
      id: "huge",
      limit: 200,
    });
    expect(bounded?.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(bounded?.messages), "utf8")).toBeLessThanOrEqual(
      SESSION_RESPONSE_MAX_BYTES,
    );
  });

  test("searches case-insensitively with a bounded snippet", async () => {
    const { repoDir, stateDir } = await fixture();
    await writeFile(
      join(stateDir, "providers", "agents", "fixture", "sessions", "bucket", "search.jsonl"),
      [
        JSON.stringify({
          type: "session",
          id: "search",
          timestamp: "2026-01-01T10:00:00.000Z",
          cwd: repoDir,
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-01-01T10:00:00.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "please use the NEEDLE in this haystack" }],
          },
        }),
      ].join("\n"),
    );
    const found = searchSessions({ stateDir, repoDir, query: "needle" });
    expect(found.matches.length).toBeGreaterThan(0);
    expect(found.matches[0]?.sessionId).toBe("search");
    expect(found.matches[0]?.snippet.length).toBeLessThanOrEqual(200);
    expect(found.matches[0]?.snippet.toLowerCase()).toContain("needle");
  });

  test("normalization and a tool-error fingerprint are stable", () => {
    const repo = "/home/user/checkout";
    const text = "ERROR in /home/user/checkout/.worktree/task at 2026-01-01T10:00:00.000Z id 1234567890abcdef";
    const normalized = normalizeSessionLine(text, { repoDir: repo });
    expect(normalized).toBe("ERROR in <repo>/.worktree/task at <timestamp> id <hex>");
    expect(firstNormalizedLine(`\n\n${text}\nmore`, { repoDir: repo })).toBe(normalized);
    expect(toolFailureFingerprint("bash", text)).toBe(
      toolFailureFingerprint(
        "bash",
        "ERROR in /home/user/checkout/.worktree/task at 2025-12-31T00:00:00.000Z id deadbeefdeadbeef",
      ),
    );
    expect(toolFailureFingerprint("bash", text)).toMatch(/^[0-9a-f]{16}$/);
  });

  test("parses at most maxFiles transcripts, not the whole corpus", async () => {
    const { repoDir, stateDir } = await fixture();
    const total = 1_000;
    for (let index = 0; index < total; index += 1) {
      await seed(stateDir, {
        id: `s${String(index).padStart(4, "0")}`,
        cwd: repoDir,
        startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      });
    }
    const parsed: string[] = [];
    let headers = 0;
    const reader: SessionReader = {
      list: (directory) => defaultSessionReader.list(directory),
      readHeader: (meta) => {
        headers += 1;
        return defaultSessionReader.readHeader(meta);
      },
      readText: (meta) => {
        parsed.push(meta.path);
        return defaultSessionReader.readText(meta);
      },
    };
    const selected = selectSessions({ stateDir, repoDir, maxFiles: 10, reader });
    expect(parsed).toHaveLength(10);
    expect(headers).toBe(total);
    expect(selected.sessions).toHaveLength(10);
    expect(selected.sessions.at(-1)?.id).toBe("s0999");
    expect(selected.selected).toBe(total);
    expect(selected.omitted).toBe(total - 10);
    expect(selected.truncated).toBe(true);
  });

  test("reads one session by header without parsing the rest of the corpus", async () => {
    const { repoDir, stateDir } = await fixture();
    for (let index = 0; index < 40; index += 1) {
      await seed(stateDir, {
        id: `noise-${index}`,
        cwd: repoDir,
        startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        messages: 2,
      });
    }
    const target = await seed(stateDir, {
      id: "target",
      cwd: repoDir,
      startedAt: "2026-01-02T00:00:00.000Z",
      messages: 3,
    });
    const parsed: string[] = [];
    let headers = 0;
    const reader: SessionReader = {
      list: (directory) => defaultSessionReader.list(directory),
      readHeader: (meta) => {
        headers += 1;
        return defaultSessionReader.readHeader(meta);
      },
      readText: (meta) => {
        parsed.push(meta.path);
        return defaultSessionReader.readText(meta);
      },
    };
    const page = readSessionMessages({ stateDir, repoDir, id: "target", reader });
    expect(page?.id).toBe("target");
    expect(page?.messages).toHaveLength(6);
    expect(parsed).toEqual([target]);
    expect(headers).toBe(41);
    expect(readSessionMessages({ stateDir, repoDir, id: "absent", reader })).toBeUndefined();
  });

  test("skips transcripts last written before the mtime bound", async () => {
    const { repoDir, stateDir } = await fixture();
    const stale = await seed(stateDir, {
      id: "stale",
      cwd: repoDir,
      startedAt: "2026-01-01T10:00:00.000Z",
    });
    await seed(stateDir, { id: "fresh", cwd: repoDir, startedAt: "2026-01-02T10:00:00.000Z" });
    const longAgo = new Date("2000-01-01T00:00:00.000Z");
    await utimes(stale, longAgo, longAgo);
    const selected = selectSessions({
      stateDir,
      repoDir,
      mtimeSince: Date.now() - 60_000,
    });
    expect(selected.sessions.map((session) => session.id)).toEqual(["fresh"]);
    expect(selected.selected).toBe(1);
  });

  test("one session read does not scale with total corpus bytes", async () => {
    const corpus = await fixture();
    const single = await fixture();
    const decoder = (repoDir: string) =>
      [
        JSON.stringify({
          type: "session",
          id: "match",
          timestamp: "2026-01-01T10:00:00.000Z",
          cwd: repoDir,
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-01-01T10:00:00.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "x".repeat(1_000_000) }],
          },
        }),
      ].join("\n");
    const corpusBucket = join(
      corpus.stateDir,
      "providers",
      "agents",
      "fixture",
      "sessions",
      "bucket",
    );
    const singleBucket = join(
      single.stateDir,
      "providers",
      "agents",
      "fixture",
      "sessions",
      "bucket",
    );
    const decoyBody = `${JSON.stringify({ type: "note", text: "y".repeat(1_000_000) })}\n`;
    let corpusBytes = 0;
    const matching = decoder(corpus.repoDir);
    await writeFile(join(corpusBucket, "match.jsonl"), matching);
    corpusBytes += Buffer.byteLength(matching);
    for (let index = 0; index < 120; index += 1) {
      const header = `${JSON.stringify({
        type: "session",
        id: `decoy-${index}`,
        timestamp: "2026-01-01T10:00:00.000Z",
        cwd: corpus.repoDir,
      })}\n`;
      await writeFile(join(corpusBucket, `decoy-${index}.jsonl`), header + decoyBody);
      corpusBytes += Buffer.byteLength(header) + Buffer.byteLength(decoyBody);
    }
    expect(corpusBytes).toBeGreaterThanOrEqual(100 * 1024 * 1024);
    await writeFile(join(singleBucket, "match.jsonl"), decoder(single.repoDir));

    const corpusStart = performance.now();
    const corpusPage = readSessionMessages({
      stateDir: corpus.stateDir,
      repoDir: corpus.repoDir,
      id: "match",
    });
    const corpusElapsed = performance.now() - corpusStart;
    const singleStart = performance.now();
    const singlePage = readSessionMessages({
      stateDir: single.stateDir,
      repoDir: single.repoDir,
      id: "match",
    });
    const singleElapsed = performance.now() - singleStart;
    expect(corpusPage?.messages).toHaveLength(1);
    expect(singlePage?.messages).toHaveLength(1);
    expect(corpusElapsed).toBeLessThan(singleElapsed * 2 + 250);
  });
});
