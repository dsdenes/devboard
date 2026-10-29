import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  SESSION_RESPONSE_MAX_BYTES,
  firstNormalizedLine,
  listSessions,
  normalizeSessionLine,
  readSessionMessages,
  searchSessions,
  selectSessions,
  toolFailureFingerprint,
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
});
