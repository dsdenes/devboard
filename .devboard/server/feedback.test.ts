import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "./app";

const temporaryDirectories: string[] = [];
const temporaryRoot = join(import.meta.dir, "..", ".tmp");
const STUB_GH = join(import.meta.dir, "fixtures", "stub-gh.ts");

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, "feedback-"));
  temporaryDirectories.push(directory);
  return directory;
}

interface RecordedGh {
  args: string[];
  cwd: string;
  body: string;
}

async function startServer(mode: "ok" | "fail" | "hang" = "ok", timeoutMs = 5_000) {
  const root = await temporaryDirectory();
  const adrDir = join(root, "adrs");
  const staticDir = join(root, "static");
  const recordPath = join(root, "gh-call.json");
  await mkdir(adrDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Feedback</title>");

  const server = createApp({
    adrDir,
    staticDir,
    hostname: "127.0.0.1",
    port: 0,
    repoDir: root,
    feedback: {
      ghCommand: ["bun", STUB_GH],
      timeoutMs,
      env: { STUB_GH_RECORD: recordPath, STUB_GH_MODE: mode },
    },
  });
  return { server, root, url: `127.0.0.1:${server.port}`, recordPath };
}

function submit(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://${url}/api/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    report: "The Start button is clipped on narrow windows.",
    route: "/",
    url: "http://127.0.0.1:8123/",
    selector: "main > section.run > button.start-button",
    dom_excerpt: '<button class="start-button">Start</button>',
    visible_text: "Start",
    viewport: "1280x720 @1x",
    captured_at: "2026-10-22T10:00:00.000Z",
    ...overrides,
  };
}

async function recorded(path: string): Promise<RecordedGh> {
  return JSON.parse(await readFile(path, "utf8")) as RecordedGh;
}

describe("feedback endpoint", () => {
  test("files the report and captured context as a GitHub issue", async () => {
    const { server, url, root, recordPath } = await startServer();

    try {
      const response = await submit(url, report());

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        url: "https://github.com/example/host/issues/42",
        title: "[ui] The Start button is clipped on narrow windows.",
      });

      const call = await recorded(recordPath);
      expect(call.cwd).toBe(root);
      expect(call.args).toContain("issue");
      expect(call.args).toContain("create");
      expect(call.args).toContain("--body-file");
      expect(call.args).toContain("-");
      expect(call.args).toContain("--title");
      expect(call.args).toContain("[ui] The Start button is clipped on narrow windows.");
      // The captured context travels through stdin, never argv.
      expect(call.args.join(" ")).not.toContain("start-button");

      expect(call.body).toContain("## Operator report");
      expect(call.body).toContain("The Start button is clipped on narrow windows.");
      expect(call.body).toContain("- Route: `/`");
      expect(call.body).toContain("- Selected element: `main > section.run > button.start-button`");
      expect(call.body).toContain("### Visible text");
      expect(call.body).toContain("### DOM excerpt");
      expect(call.body).toContain('<button class="start-button">Start</button>');
    } finally {
      server.stop(true);
    }
  });

  test("always files the issue in the harness repository", async () => {
    const { server, url, recordPath } = await startServer();

    try {
      const response = await submit(url, report());

      expect(response.status).toBe(201);
      const call = await recorded(recordPath);
      const repoIndex = call.args.indexOf("--repo");
      expect(repoIndex).toBeGreaterThan(-1);
      expect(call.args[repoIndex + 1]).toBe("dsdenes/devboard");
    } finally {
      server.stop(true);
    }
  });

  test("refuses an empty report before running gh", async () => {
    const { server, url, recordPath } = await startServer();

    try {
      const response = await submit(url, report({ report: "   " }));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "report must not be empty." });
      expect(existsSync(recordPath)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("refuses oversized fields before running gh", async () => {
    const { server, url, recordPath } = await startServer();

    try {
      const response = await submit(url, report({ report: "x".repeat(8001) }));

      expect(response.status).toBe(400);
      expect(existsSync(recordPath)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("refuses a cross-origin browser request", async () => {
    const { server, url, recordPath } = await startServer();

    try {
      const response = await submit(url, report(), { origin: "http://evil.example" });

      expect(response.status).toBe(403);
      expect(existsSync(recordPath)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("reports a gh failure with its diagnostic", async () => {
    const { server, url } = await startServer("fail");

    try {
      const response = await submit(url, report());

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: "Issue creation failed: boom: not a git repository",
      });
    } finally {
      server.stop(true);
    }
  });

  test("reports a gh timeout", async () => {
    const { server, url } = await startServer("hang", 100);

    try {
      const response = await submit(url, report());

      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({
        error: "Issue creation timed out after 100 ms.",
      });
    } finally {
      server.stop(true);
    }
  });

  test("clamps a long report line to the title limit", async () => {
    const { server, url } = await startServer();

    try {
      const response = await submit(url, report({ report: `\n\n${"long ".repeat(100)}` }));
      const body = (await response.json()) as { title: string };

      expect(response.status).toBe(201);
      expect(body.title.startsWith("[ui] long")).toBe(true);
      expect(body.title.length).toBeLessThanOrEqual(200);
    } finally {
      server.stop(true);
    }
  });
});
