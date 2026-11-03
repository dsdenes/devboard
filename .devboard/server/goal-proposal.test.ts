import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createApp } from "./app";
import { GOAL_PROPOSALS_DIRECTORY, draftPathFromHref } from "../lib/goal-proposals";
import {
  goalProposalBody,
  goalProposalName,
  normalizeGoalSlug,
  parseGoalProposalSubmission,
  writeGoalProposal,
} from "./goal-proposal";
import { testProviderService } from "./fixtures/test-providers";
import type { Journal, JournalKind } from "./journal";
import { PROBLEM_CONTENT_TYPE, problemBody } from "./fixtures/problem-body";

const temporaryDirectories: string[] = [];
const temporaryRoot = join(import.meta.dir, "..", ".tmp");
const STUB_AGENT = join(import.meta.dir, "fixtures", "stub-agent.ts");

interface StartOptions {
  /**
   * `fallback` keeps unrelated tests deterministic; `agent` runs the real ACP
   * naming path against the stub agent; a function is the injected seam.
   */
  slug?: "fallback" | "agent" | ((report: string) => Promise<string>);
  /** What the stub agent answers the naming turn with. */
  slugAnswer?: string;
  /** Records the server journal instead of writing one to disk. */
  journal?: Journal;
}

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

async function startServer(options: StartOptions = {}) {
  const root = await temporaryDirectory();
  const adrDir = join(root, "adrs");
  const staticDir = join(root, "static");
  const recordPath = join(root, "gh-call.json");
  await mkdir(adrDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Proposals</title>");

  const slug = options.slug ?? "fallback";
  const goalSlug =
    slug === "agent"
      ? undefined
      : typeof slug === "function"
        ? slug
        : async (report: string) => goalProposalName(report);
  const agentCommand =
    slug === "agent"
      ? `bun ${STUB_AGENT} --goal-slug=${options.slugAnswer ?? ""}`
      : undefined;

  const server = createApp({
    adrDir,
    staticDir,
    hostname: "127.0.0.1",
    port: 0,
    repoDir: root,
    stateDir: join(root, "state"),
    providers: testProviderService(join(root, "state")),
    ...(agentCommand === undefined ? {} : { agentCommand }),
    ...(goalSlug === undefined ? {} : { goalSlug }),
    ...(options.journal === undefined ? {} : { journal: options.journal }),
  });
  return { server, root, url: `127.0.0.1:${server.port}`, recordPath };
}

/** Captures the journal records a server would write. */
function journalRecorder(): { journal: Journal; records: Array<[JournalKind, string]> } {
  const records: Array<[JournalKind, string]> = [];
  return {
    records,
    journal: { path: "test", write: (kind, text) => records.push([kind, text]) },
  };
}

function propose(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://${url}/goal-proposals`, {
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

/** The absolute URI the endpoint answers for a draft; throws on the old shape. */
async function responseHref(response: Response): Promise<string> {
  const body = (await response.json()) as {
    path?: unknown;
    links?: { draft?: { href?: unknown } };
  } | null;
  if (
    typeof body !== "object" ||
    body === null ||
    "path" in body ||
    typeof body.links?.draft?.href !== "string"
  ) {
    throw new Error("The endpoint returned no draft link.");
  }
  return body.links.draft.href;
}

async function responsePath(response: Response): Promise<string> {
  const path = draftPathFromHref(await responseHref(response));
  if (path === null) throw new Error("The endpoint returned an unusable draft link.");
  return path;
}

/** The absolute URI the server answers for one draft under `root`. */
function draftHref(root: string, name: string): string {
  return pathToFileURL(join(root, GOAL_PROPOSALS_DIRECTORY, name)).href;
}

describe("goal proposal drafts", () => {
  test("writes one draft with the operator text and captured context", async () => {
    const { server, root, url } = await startServer();

    try {
      const report = "  The Start button is clipped.\n\n  Second paragraph stays.\n";
      const response = await propose(url, proposal({ report }));

      expect(response.status).toBe(201);
      const href = await responseHref(response);
      expect(new URL(href).protocol).toBe("file:");
      expect(href).toBe(draftHref(root, "the-start-button-is-clipped.md"));
      const location = response.headers.get("location");
      expect(location).toBe(href);
      expect(new URL(location!).href).toBe(href);

      const files = await drafts(root);
      expect(files).toEqual(["the-start-button-is-clipped.md"]);
      const text = await readFile(
        join(root, GOAL_PROPOSALS_DIRECTORY, files[0]!),
        "utf8",
      );
      expect(text.startsWith("# Proposed goal: The Start button is clipped.\n\n")).toBe(true);
      expect(text).not.toContain("Unprocessed draft");
      expect(text).not.toContain("/goal-spec");
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

  test("writes a text-only draft with an unprocessed notice and no fabricated context", async () => {
    const { server, root, url } = await startServer();

    try {
      const instructions =
        "  The Draft goals page should create a goal in one step.\n\n  Keep this second paragraph.\n";
      const response = await propose(url, { report: instructions });

      expect(response.status).toBe(201);
      const path = await responsePath(response);
      expect(path).toBe(
        ".devboard/goal-proposals/the-draft-goals-page-should-create.md",
      );
      expect(await drafts(root)).toEqual([
        "the-draft-goals-page-should-create.md",
      ]);
      const text = await readFile(join(root, path), "utf8");
      expect(text.startsWith(
        "# Proposed goal: The Draft goals page should create a goal in one step.\n\n> Unprocessed draft. ",
      )).toBe(true);
      expect(text).toContain(instructions);
      expect(text).toContain("## Captured UI context\n\nNo page context was captured.\n");
      expect(text).not.toContain("- Route:");
      expect(text).not.toContain("- URL:");
      expect(text).not.toContain("- Selected element:");
      expect(text).not.toContain("- Viewport:");
      expect(text).not.toContain("- Captured at:");
      expect(text).not.toContain("### Visible text");
      expect(text).not.toContain("### DOM excerpt");
      expect(text).not.toContain("## Ask conversation");

      const blank = await propose(url, { report: " \n\t " });
      expect(blank.status).toBe(400);
      expect(await blank.json()).toEqual(
        problemBody("Bad Request", 400, "report must not be empty."),
      );
      expect(await drafts(root)).toEqual([
        "the-draft-goals-page-should-create.md",
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("a text-only draft earns a suffix without overwriting an existing name", async () => {
    const { server, root, url } = await startServer();

    try {
      const report = "Name two editors.";
      const first = await propose(url, { report });
      expect(first.status).toBe(201);
      const firstPath = await responsePath(first);
      const firstText = await readFile(join(root, firstPath), "utf8");

      const second = await propose(url, { report });
      expect(second.status).toBe(201);
      expect(await responseHref(second)).toBe(draftHref(root, "name-two-editors-2.md"));
      expect(await readFile(join(root, firstPath), "utf8")).toBe(firstText);
      expect(await drafts(root)).toEqual([
        "name-two-editors-2.md",
        "name-two-editors.md",
      ]);
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
          turns: [
            { role: "DEVELOPER", text: "Why is this button clipped?" },
            { role: "AGENT", text: "The flex row has no min-width." },
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
      expect(await responseHref(second)).toBe(
        draftHref(root, "the-start-button-is-clipped-on-2.md"),
      );

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
      const href = await responseHref(response);
      expect(href).not.toContain("..");
      expect(href).not.toContain("\\");
      const files = await drafts(root);
      expect(files).toHaveLength(1);
      expect(href).toBe(draftHref(root, files[0]!));
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
      expect(missing.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
      expect(await missing.json()).toEqual(
        problemBody("Bad Request", 400, "report is required."),
      );

      const blank = await propose(url, proposal({ report: " \n\t " }));
      expect(blank.status).toBe(400);
      expect(await blank.json()).toEqual(
        problemBody("Bad Request", 400, "report must not be empty."),
      );

      expect(await drafts(root)).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("refuses an unknown body field and accepts the same body without it", async () => {
    const { server, root, url } = await startServer();

    try {
      const accepted = proposal({ turns: [] });
      const refused = await propose(url, { ...accepted, unexpected: 1 });

      expect(refused.status).toBe(400);
      expect(refused.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
      expect(await refused.json()).toEqual(
        problemBody("Bad Request", 400, "unknown field: unexpected."),
      );
      expect(await drafts(root)).toEqual([]);

      const created = await propose(url, accepted);
      expect(created.status).toBe(201);
      expect((await drafts(root)).length).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("refuses the singular conversation key it no longer accepts", async () => {
    const { server, root, url } = await startServer();

    try {
      const response = await propose(url, proposal({ conversation: [] }));

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
      expect(await response.json()).toEqual(
        problemBody("Bad Request", 400, "unknown field: conversation."),
      );
      expect(await drafts(root)).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("refuses a captured_at that is not an RFC 3339 date-time", async () => {
    const { server, root, url } = await startServer();

    try {
      for (const capturedAt of [
        "2026-11-03 10:32:14",
        "yesterday",
        "2026-11-03t10:32:14z",
      ]) {
        const response = await propose(url, proposal({ captured_at: capturedAt }));

        expect(response.status).toBe(400);
        expect(response.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
        expect(await response.json()).toEqual(
          problemBody(
            "Bad Request",
            400,
            "captured_at must be an RFC 3339 date-time.",
          ),
        );
      }
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

  test("refuses a request whose Host is not one of the listener's names", async () => {
    const { server, root, url } = await startServer();

    try {
      const host = `evil.example:${server.port}`;
      const response = await propose(url, proposal(), { host, origin: `http://${host}` });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(
        problemBody("Forbidden", 403, "The request host is not served by this dashboard."),
      );
      expect(await drafts(root)).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("accepts a same-origin request for its listener host", async () => {
    const { server, root, url } = await startServer();

    try {
      const response = await propose(url, proposal(), { origin: `http://${url}` });

      expect(response.status).toBe(201);
      expect(await drafts(root)).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });

  test("refuses a non-POST request", async () => {
    const { server, url } = await startServer();

    try {
      const response = await fetch(`http://${url}/goal-proposals`);
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(response.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
      expect(await response.json()).toEqual(
        problemBody("Method Not Allowed", 405, "This endpoint accepts POST only."),
      );
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
    const { journal, records } = journalRecorder();
    const { server, root, url } = await startServer({ journal });
    // A file where the harness directory belongs makes the directory creation
    // fail, so the write cannot land.
    await rm(join(root, ".devboard"), { recursive: true, force: true });
    await writeFile(join(root, ".devboard"), "not a directory\n");

    try {
      const response = await propose(url, proposal());

      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
      expect(await response.json()).toEqual(
        problemBody("Internal Server Error", 500, "An internal error occurred."),
      );
      // The exception text reaches the journal and never the response.
      expect(records).toHaveLength(1);
      const [kind, text] = records[0]!;
      expect(kind).toBe("server-error");
      expect(text.startsWith("POST /goal-proposals: ")).toBe(true);
      expect(text.length).toBeGreaterThan("POST /goal-proposals: ".length);
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

  test("bounds the fallback name to a usable file name", () => {
    expect(goalProposalName("a".repeat(8000))).toBe("a".repeat(64));
    for (const report of [
      "word ".repeat(2000),
      `${"a".repeat(63)}b`,
      `${"a".repeat(40)} ${"b".repeat(40)}`,
      "a-".repeat(4000),
    ]) {
      const name = goalProposalName(report);
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(64);
      expect(name.endsWith("-")).toBe(false);
    }
  });

  test("writes a draft when a long report falls back to the derived name", async () => {
    const root = await temporaryDirectory();
    const submission = parseGoalProposalSubmission({ report: "a".repeat(8000) });
    const written = await writeGoalProposal(submission, {
      repoDir: root,
      slugger: async () => {
        throw new Error("The naming agent did not answer in time.");
      },
    });

    const filename = `${"a".repeat(64)}.md`;
    expect(written.links.draft.href).toBe(draftHref(root, filename));
    expect(await readdir(join(root, GOAL_PROPOSALS_DIRECTORY))).toEqual([filename]);
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

  test("normalizes an agent's slug and rejects unusable answers", () => {
    expect(normalizeGoalSlug("clipped-start-button")).toBe("clipped-start-button");
    expect(normalizeGoalSlug("`clipped-start-button`")).toBe("clipped-start-button");
    expect(normalizeGoalSlug("Slug: clipped-start-button\n")).toBe("clipped-start-button");
    expect(normalizeGoalSlug("```\nclipped-start-button\n```")).toBe("clipped-start-button");
    expect(normalizeGoalSlug("Here is the slug:\n\n`clipped-start-button`")).toBe(
      "clipped-start-button",
    );
    expect(normalizeGoalSlug("**clipped-start-button**.")).toBe("clipped-start-button");
    expect(normalizeGoalSlug("Clipped Start Button")).toBeNull();
    expect(normalizeGoalSlug("one-two-three-four-five-six-seven")).toBeNull();
    expect(normalizeGoalSlug("a".repeat(65))).toBeNull();
    expect(normalizeGoalSlug("clipped-start-button.")).toBe("clipped-start-button");
    expect(normalizeGoalSlug("")).toBeNull();
  });

  test("uses a chosen name and falls back when naming fails", async () => {
    const root = await temporaryDirectory();
    const submission = parseGoalProposalSubmission({
      report: "Make the start button visible.",
    });

    const chosen = await writeGoalProposal(submission, {
      repoDir: root,
      slugger: async () => "start-button-visibility",
    });
    expect(chosen.links.draft.href).toBe(draftHref(root, "start-button-visibility.md"));

    const failed = await writeGoalProposal(submission, {
      repoDir: root,
      slugger: async () => {
        throw new Error("The naming agent did not answer in time.");
      },
    });
    expect(failed.links.draft.href).toBe(
      draftHref(root, "make-the-start-button-visible.md"),
    );
  });

  test("names the draft with the ACP naming agent's slug", async () => {
    const { server, root, url } = await startServer({
      slug: "agent",
      slugAnswer: "clipped-start-button",
    });

    try {
      const response = await propose(url, proposal());

      expect(response.status).toBe(201);
      expect(await responseHref(response)).toBe(draftHref(root, "clipped-start-button.md"));
      expect(await drafts(root)).toEqual(["clipped-start-button.md"]);
    } finally {
      server.stop(true);
    }
  });

  test("echoes the request's flow id on the draft response", async () => {
    const { server, root, url } = await startServer();

    try {
      const response = await propose(url, proposal(), { "x-flow-id": "4d1c" });

      expect(response.status).toBe(201);
      expect(response.headers.get("x-flow-id")).toBe("4d1c");
      expect(await drafts(root)).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });

  test("writes one draft for a retried Idempotency-Key", async () => {
    const { server, root, url } = await startServer();

    try {
      const first = await propose(url, proposal(), { "idempotency-key": "draft-1" });
      const firstPath = await responsePath(first);
      const second = await propose(url, proposal(), { "idempotency-key": "draft-1" });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(await responsePath(second)).toBe(firstPath);
      expect(second.headers.get("location")).toBe(first.headers.get("location"));
      expect(second.headers.get("location")).toBe(
        draftHref(root, "the-start-button-is-clipped-on.md"),
      );
      expect(await drafts(root)).toEqual(["the-start-button-is-clipped-on.md"]);
    } finally {
      server.stop(true);
    }
  });

  test("writes one draft per distinct Idempotency-Key", async () => {
    const { server, root, url } = await startServer();

    try {
      const first = await propose(url, proposal(), { "idempotency-key": "draft-1" });
      const second = await propose(url, proposal(), { "idempotency-key": "draft-2" });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(await responsePath(second)).not.toBe(await responsePath(first));
      expect(await drafts(root)).toHaveLength(2);
    } finally {
      server.stop(true);
    }
  });

  test("refuses an empty Idempotency-Key before writing a draft", async () => {
    const { server, root, url } = await startServer();

    try {
      const response = await propose(url, proposal(), { "idempotency-key": "" });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(
        problemBody("Bad Request", 400, "Idempotency-Key must not be empty."),
      );
      expect(await drafts(root)).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("falls back to the deterministic name when the agent's answer is unusable", async () => {
    const { server, root, url } = await startServer({
      slug: "agent",
      slugAnswer: "INVALID_SLUG",
    });

    try {
      const response = await propose(url, proposal());

      expect(response.status).toBe(201);
      expect(await responseHref(response)).toBe(
        draftHref(root, "the-start-button-is-clipped-on.md"),
      );
      expect(await drafts(root)).toEqual(["the-start-button-is-clipped-on.md"]);
    } finally {
      server.stop(true);
    }
  });
});
