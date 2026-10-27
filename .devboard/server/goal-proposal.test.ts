import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "./app";
import {
  GOAL_PROPOSALS_DIRECTORY,
  goalProposalBody,
  goalProposalName,
  parseGoalProposalSubmission,
} from "./goal-proposal";

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
  const directory = await mkdtemp(join(temporaryRoot, "goal-proposal-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function startServer() {
  const root = await temporaryDirectory();
  const adrDir = join(root, "adrs");
  const staticDir = join(root, "static");
  const recordPath = join(root, "gh-call.json");
  await mkdir(adrDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Proposals</title>");

  const server = createApp({
    adrDir,
    staticDir,
    hostname: "127.0.0.1",
    port: 0,
    repoDir: root,
    stateDir: join(root, "state"),
    feedback: {
      ghCommand: ["bun", STUB_GH],
      timeoutMs: 5_000,
      env: { STUB_GH_RECORD: recordPath, STUB_GH_MODE: "ok" },
    },
  });
  return { server, root, url: `127.0.0.1:${server.port}`, recordPath };
}

function propose(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://${url}/api/goal-proposals`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

async function drafts(root: string): Promise<string[]> {
  const directory = join(root, GOAL_PROPOSALS_DIRECTORY);
  if (!existsSync(directory)) return [];
  return (await readdir(directory)).filter((name) => name.endsWith(".md")).sort();
}

async function responsePath(response: Response): Promise<string> {
  const body = (await response.json()) as unknown;
  if (
    typeof body !== "object" ||
    body === null ||
    !("path" in body) ||
    typeof body.path !== "string"
  ) {
    throw new Error("The endpoint returned no draft path.");
  }
  return body.path;
}

describe("goal proposal drafts", () => {
  test("writes one draft with the operator text and captured context", async () => {
    const { server, root, url } = await startServer();

    try {
      const report = "  The Start button is clipped.\n\n  Second paragraph stays.\n";
      const response = await propose(url, proposal({ report }));

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        path: ".devboard/goal-proposals/the-start-button-is-clipped.md",
      });

      const files = await drafts(root);
      expect(files).toEqual(["the-start-button-is-clipped.md"]);
      const text = await readFile(
        join(root, GOAL_PROPOSALS_DIRECTORY, files[0]!),
        "utf8",
      );
      expect(text.startsWith("# Proposed goal: The Start button is clipped.\n")).toBe(true);
      expect(text).toContain("Unprocessed draft");
      expect(text).toContain("/goal-spec");
      expect(text).toContain(report);
      expect(text).toContain("## Captured UI context");
      expect(text).toContain("- Route: `/`");
      expect(text).toContain("- URL: `http://127.0.0.1:8123/`");
      expect(text).toContain(
        "- Selected element: `main > section.run > button.start-button`",
      );
      expect(text).toContain("- Viewport: `1280x720 @1x`");
      expect(text).toContain("- Captured at: `2026-10-22T10:00:00.000Z`");
      expect(text).toContain("### Visible text\n\nStart");
      expect(text).toContain("### DOM excerpt\n\n```html\n");
      expect(text).toContain('<button class="start-button">Start</button>\n```');
      for (const heading of [
        "## Success criteria",
        "## Verification",
        "## Boundaries",
        "## Stop conditions",
      ]) {
        expect(text).not.toContain(heading);
      }
    } finally {
      server.stop(true);
    }
  });

  test("carries the Ask conversation into the draft as context", async () => {
    const { server, root, url } = await startServer();

    try {
      const response = await propose(
        url,
        proposal({
          conversation: [
            { role: "developer", text: "Why is this button clipped?" },
            { role: "agent", text: "The flex row has no min-width." },
          ],
        }),
      );

      expect(response.status).toBe(201);
      const path = await responsePath(response);
      const text = await readFile(join(root, path), "utf8");
      expect(text).toContain("## Ask conversation");
      expect(text).toContain("**You:**\n\nWhy is this button clipped?");
      expect(text).toContain("**Agent:**\n\nThe flex row has no min-width.");
      expect(text.indexOf("## Ask conversation")).toBeLessThan(
        text.indexOf("## Captured UI context"),
      );
    } finally {
      server.stop(true);
    }
  });

  test("never overwrites a draft and leaves no other side effect", async () => {
    const { server, root, url, recordPath } = await startServer();
    const goalsDir = join(root, ".devboard", "goals");
    await mkdir(goalsDir, { recursive: true });
    await writeFile(join(goalsDir, "kept.md"), "# Kept goal\n");
    await writeFile(join(root, "GOAL.md"), "# Goal\n\nKeep it.\n");

    try {
      const first = await propose(url, proposal());
      const firstPath = await responsePath(first);
      const firstText = await readFile(join(root, firstPath), "utf8");

      const second = await propose(url, proposal());
      expect(second.status).toBe(201);
      expect(await second.json()).toEqual({
        path: ".devboard/goal-proposals/the-start-button-is-clipped-on-2.md",
      });

      expect(await drafts(root)).toEqual([
        "the-start-button-is-clipped-on-2.md",
        "the-start-button-is-clipped-on.md",
      ]);
      expect(await readFile(join(root, firstPath), "utf8")).toBe(firstText);
      expect(await readFile(join(goalsDir, "kept.md"), "utf8")).toBe("# Kept goal\n");
      expect(await readFile(join(root, "GOAL.md"), "utf8")).toBe("# Goal\n\nKeep it.\n");
      // No `gh` call and no GitHub issue: the stub never started.
      expect(existsSync(recordPath)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("keeps traversal-shaped text inside the proposal directory", async () => {
    const { server, root, url } = await startServer();

    try {
      const response = await propose(
        url,
        proposal({ report: "../escape / \\ \u0000 name\n../../outside.md" }),
      );

      expect(response.status).toBe(201);
      const body = await responsePath(response);
      expect(body.startsWith(`${GOAL_PROPOSALS_DIRECTORY}/`)).toBe(true);
      expect(body).not.toContain("..");
      expect(body).not.toContain("\\");
      const files = await drafts(root);
      expect(files).toHaveLength(1);
      expect(body).toBe(`${GOAL_PROPOSALS_DIRECTORY}/${files[0]!}`);
      expect(existsSync(join(root, "outside.md"))).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("refuses a missing or whitespace-only report", async () => {
    const { server, root, url } = await startServer();

    try {
      const missing = await propose(url, proposal({ report: undefined }));
      expect(missing.status).toBe(400);
      expect(await missing.json()).toEqual({ error: "report is required." });

      const blank = await propose(url, proposal({ report: " \n\t " }));
      expect(blank.status).toBe(400);
      expect(await blank.json()).toEqual({ error: "report must not be empty." });

      expect(await drafts(root)).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("applies the feedback field limits", async () => {
    const { server, root, url } = await startServer();

    try {
      expect((await propose(url, proposal({ report: "x".repeat(8001) }))).status).toBe(400);
      expect(
        (await propose(url, proposal({ dom_excerpt: "x".repeat(8001) }))).status,
      ).toBe(400);
      expect((await propose(url, proposal({ selector: "x".repeat(2001) }))).status).toBe(400);
      expect(await drafts(root)).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("refuses a cross-origin browser request", async () => {
    const { server, root, url } = await startServer();

    try {
      const response = await propose(url, proposal(), { origin: "http://evil.example" });

      expect(response.status).toBe(403);
      expect(await drafts(root)).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("refuses a non-POST request", async () => {
    const { server, url } = await startServer();

    try {
      const response = await fetch(`http://${url}/api/goal-proposals`);
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    } finally {
      server.stop(true);
    }
  });

  test("refuses an oversized body", async () => {
    const { server, root, url } = await startServer();

    try {
      const response = await propose(url, proposal({ report: "x".repeat(70_000) }));

      expect(response.status).toBe(413);
      expect(await drafts(root)).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("reports a write failure without a partial draft", async () => {
    const { server, root, url } = await startServer();
    // A file where the harness directory belongs makes the directory creation
    // fail, so the write cannot land.
    await rm(join(root, ".devboard"), { recursive: true, force: true });
    await writeFile(join(root, ".devboard"), "not a directory\n");

    try {
      const response = await propose(url, proposal());

      expect(response.status).toBe(500);
      const body: unknown = await response.json();
      const error =
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string"
          ? body.error
          : "";
      expect(error.length).toBeGreaterThan(0);
      expect(await readFile(join(root, ".devboard"), "utf8")).toBe("not a directory\n");
      expect(await drafts(root)).toEqual([]);
    } finally {
      server.stop(true);
    }
  });
});

describe("goal proposal naming and body", () => {
  test("derives a bounded lowercase name", () => {
    expect(goalProposalName("The Start Button is clipped on narrow windows.")).toBe(
      "the-start-button-is-clipped-on",
    );
    expect(goalProposalName("\n\n  Make  it   Pretty!  \nsecond line")).toBe(
      "make-it-pretty",
    );
    expect(goalProposalName("../..")).toBe("ui-goal");
    expect(goalProposalName("\u0000\u0000")).toBe("ui-goal");
  });

  test("bounds the heading and omits empty optional context", () => {
    const submission = parseGoalProposalSubmission({
      report: `${"word ".repeat(100)}`,
    });
    const body = goalProposalBody(submission);
    const heading = body.split("\n")[0]!;
    expect(heading.startsWith("# Proposed goal: ")).toBe(true);
    expect(heading.length).toBeLessThanOrEqual("# Proposed goal: ".length + 200);
    expect(body).toContain("No page context was captured.");
    expect(body).not.toContain("### Visible text");
    expect(body).not.toContain("### DOM excerpt");
  });
});
