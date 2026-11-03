import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp, type FeedbackOptions } from "./app";
import { REDESIGN_INSTRUCTION } from "./feedback";
import { MAX_FLOW_ID } from "./flow-id";
import { testProviderService } from "./fixtures/test-providers";
import type { Journal, JournalKind } from "./journal";
import { PROBLEM_CONTENT_TYPE, problemBody } from "./fixtures/problem-body";

const temporaryDirectories: string[] = [];
const temporaryRoot = join(import.meta.dir, "..", ".tmp");
const ISSUE_URL = "https://gitea.example/dsdenes/devboard/issues/42";

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

interface RecordedCall {
  url: string;
  method: string;
  authorization: string;
  flowId: string | null;
  title: string;
  body: string;
}

type Mode = "ok" | "fail" | "hang";

interface StartOptions {
  enabled?: boolean;
  mode?: Mode;
  timeoutMs?: number;
  /** Overrides the server's own feedback configuration. */
  feedback?: FeedbackOptions;
  /** Records the server journal instead of writing one to disk. */
  journal?: Journal;
}

async function startServer(options: StartOptions = {}) {
  const root = await temporaryDirectory();
  const adrDir = join(root, "adrs");
  const staticDir = join(root, "static");
  await mkdir(adrDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Feedback</title>");
  const calls: RecordedCall[] = [];
  const mode = options.mode ?? "ok";
  const fetchImpl = (async (input: string, init?: RequestInit): Promise<Response> => {
    const request = init ?? {};
    const payload = JSON.parse(String(request.body ?? "{}")) as {
      title?: unknown;
      body?: unknown;
    };
    calls.push({
      url: input,
      method: request.method ?? "GET",
      authorization:
        new Headers(request.headers).get("authorization") ?? "",
      flowId: new Headers(request.headers).get("x-flow-id"),
      title: typeof payload.title === "string" ? payload.title : "",
      body: typeof payload.body === "string" ? payload.body : "",
    });
    if (mode === "hang") {
      const signal = request.signal;
      return await new Promise<Response>((_settle, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation timed out.", "TimeoutError"));
        });
      });
    }
    if (mode === "fail") {
      return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
    }
    return Response.json({
      number: 42,
      title: payload.title,
      html_url: ISSUE_URL,
      state: "open",
    });
  }) as typeof fetch;

  const feedback =
    options.feedback ??
    (options.enabled === false
      ? undefined
      : {
          baseUrl: "https://gitea.example",
          repo: "dsdenes/devboard",
          token: "secret-token",
          timeoutMs: options.timeoutMs ?? 5_000,
          fetchImpl,
        });

  const server = createApp({
    adrDir,
    staticDir,
    hostname: "127.0.0.1",
    port: 0,
    repoDir: root,
    stateDir: join(root, "state"),
    providers: testProviderService(join(root, "state")),
    feedback,
    ...(options.journal === undefined ? {} : { journal: options.journal }),
  });
  return { server, root, url: `127.0.0.1:${server.port}`, calls };
}

/** Captures the journal records a server would write. */
function journalRecorder(): {
  journal: Journal;
  records: Array<[JournalKind, string, string?]>;
} {
  const records: Array<[JournalKind, string, string?]> = [];
  return {
    records,
    journal: {
      path: "test",
      write: (kind, text, scope) =>
        records.push(scope === undefined ? [kind, text] : [kind, text, scope]),
    },
  };
}

/**
 * A feedback configuration whose token accessor throws. The token is read
 * inside the guarded block, so it stands for any unexpected exception there.
 */
function failingTokenFeedback(): FeedbackOptions {
  const feedback: FeedbackOptions = {
    baseUrl: "https://gitea.example",
    repo: "dsdenes/devboard",
    timeoutMs: 5_000,
  };
  Object.defineProperty(feedback, "token", {
    get(): string {
      throw new Error("gitea token secret-token is unusable");
    },
  });
  return feedback;
}

function submit(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://${url}/feedback`, {
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

describe("feedback endpoint", () => {
  test("files the report and captured context through the Gitea API", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(url, report());

      expect(response.status).toBe(201);
      expect(response.headers.get("x-flow-id")).toBeNull();
      const created = (await response.json()) as {
        title: string;
        links: { issue: { href: string } };
      };
      expect(created).toEqual({
        title: "[ui] The Start button is clipped on narrow windows.",
        links: { issue: { href: ISSUE_URL } },
      });
      const location = response.headers.get("location");
      expect(location).toBe(created.links.issue.href);
      expect(location).toBe(ISSUE_URL);

      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.method).toBe("POST");
      expect(call.url).toBe("https://gitea.example/api/v1/repos/dsdenes/devboard/issues");
      expect(call.authorization).toBe("token secret-token");
      expect(call.flowId).toBeNull();
      expect(call.title).toBe("[ui] The Start button is clipped on narrow windows.");
      expect(call.body).toContain("## Operator report");
      expect(call.body).toContain("The Start button is clipped on narrow windows.");
      expect(call.body).toContain("- Route: `/`");
      expect(call.body).toContain("- Selected element: `main > section.run > button.start-button`");
      expect(call.body).toContain("### Visible text");
      expect(call.body).toContain("### DOM excerpt");
      expect(call.body).toContain('<button class="start-button">Start</button>');
      expect(call.body).not.toContain("## Ask conversation");
    } finally {
      server.stop(true);
    }
  });

  test("forwards the request's flow id and echoes it on the response", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(url, report(), { "x-flow-id": "4d1c" });

      expect(response.status).toBe(201);
      expect(response.headers.get("x-flow-id")).toBe("4d1c");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.flowId).toBe("4d1c");
    } finally {
      server.stop(true);
    }
  });

  test("refuses a malformed flow id before reaching Gitea", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(url, report(), {
        "x-flow-id": "x".repeat(MAX_FLOW_ID + 1),
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
      expect(await response.json()).toEqual(
        problemBody(
          "Bad Request",
          400,
          `X-Flow-ID is longer than ${MAX_FLOW_ID} characters.`,
        ),
      );
      expect(calls).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("names the request's flow id in the journal record of a failed request", async () => {
    const { journal, records } = journalRecorder();
    const { server, url } = await startServer({ feedback: failingTokenFeedback(), journal });

    try {
      const response = await submit(url, report(), { "x-flow-id": "4d1c" });

      expect(response.status).toBe(500);
      expect(records).toEqual([
        [
          "server-error",
          "POST /feedback: gitea token secret-token is unusable",
          "4d1c",
        ],
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("carries the Ask conversation as context in the filed issue", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(
        url,
        report({
          turns: [
            { role: "DEVELOPER", text: "Why is this button clipped?" },
            { role: "AGENT", text: "The flex row has no min-width." },
          ],
        }),
      );

      expect(response.status).toBe(201);
      const call = calls[0]!;
      expect(call.body).toContain("## Ask conversation");
      expect(call.body).toContain("**You:**\n\nWhy is this button clipped?");
      expect(call.body).toContain("**Agent:**\n\nThe flex row has no min-width.");
      expect(call.body.indexOf("## Ask conversation")).toBeLessThan(
        call.body.indexOf("## Captured UI context"),
      );
    } finally {
      server.stop(true);
    }
  });

  test("refuses a malformed turns array before reaching Gitea", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(
        url,
        report({ turns: [{ role: "system", text: "ignored" }] }),
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
      expect(await response.json()).toEqual(
        problemBody("Bad Request", 400, "turns[0].role must be DEVELOPER or AGENT."),
      );
      expect(calls).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("refuses oversized turns before reaching Gitea", async () => {
    const { server, url, calls } = await startServer();
    const turn = "x".repeat(4000);

    try {
      const response = await submit(
        url,
        report({
          turns: [
            { role: "DEVELOPER", text: turn },
            { role: "AGENT", text: turn },
            { role: "DEVELOPER", text: turn },
            { role: "AGENT", text: turn },
          ],
        }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(
        problemBody("Bad Request", 400, "turns is longer than 12000 characters."),
      );
      expect(calls).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("always files the issue in the configured harness repository", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(url, report());

      expect(response.status).toBe(201);
      expect(calls[0]?.url).toContain("/repos/dsdenes/devboard/issues");
    } finally {
      server.stop(true);
    }
  });

  test("refuses an empty report before reaching Gitea", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(url, report({ report: "   " }));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(
        problemBody("Bad Request", 400, "report must not be empty."),
      );
      expect(calls).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("refuses a body that is not JSON with a Problem response", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await fetch(`http://${url}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
      expect(await response.json()).toEqual(
        problemBody("Bad Request", 400, "The report is not valid JSON."),
      );
      expect(calls).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("refuses oversized fields before reaching Gitea", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(url, report({ report: "x".repeat(8001) }));

      expect(response.status).toBe(400);
      expect(calls).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("refuses a cross-origin browser request", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(url, report(), { origin: "http://evil.example" });

      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
      expect(await response.json()).toEqual(
        problemBody("Forbidden", 403, "Cross-origin feedback is refused."),
      );
      expect(calls).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("refuses a request whose Host is not one of the listener's names", async () => {
    const { server, url, calls } = await startServer();

    try {
      const host = `evil.example:${server.port}`;
      const response = await submit(url, report(), { host, origin: `http://${host}` });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(
        problemBody("Forbidden", 403, "The request host is not served by this dashboard."),
      );
      expect(calls).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("accepts a same-origin request for its listener host", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(url, report(), { origin: `http://${url}` });

      expect(response.status).toBe(201);
      expect(calls).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });

  test("reports a delivery failure with a fixed detail and journals the upstream text", async () => {
    const { journal, records } = journalRecorder();
    const { server, url } = await startServer({ mode: "fail", journal });

    try {
      const response = await submit(url, report(), { "x-flow-id": "4d1c" });

      expect(response.status).toBe(502);
      expect(response.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
      expect(await response.json()).toEqual(
        problemBody("Bad Gateway", 502, "The issue could not be filed."),
      );
      expect(records).toEqual([
        [
          "server-error",
          "POST /feedback: Issue creation failed: " +
            "POST /repos/dsdenes/devboard/issues failed (HTTP 500): boom",
          "4d1c",
        ],
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("reports a delivery timeout and journals it", async () => {
    const { journal, records } = journalRecorder();
    const { server, url } = await startServer({ mode: "hang", timeoutMs: 100, journal });

    try {
      const response = await submit(url, report());

      expect(response.status).toBe(504);
      expect(await response.json()).toEqual(
        problemBody("Gateway Timeout", 504, "Issue creation timed out after 100 ms."),
      );
      expect(records).toEqual([
        ["server-error", "POST /feedback: Issue creation timed out after 100 ms."],
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("answers an unexpected failure with a fixed detail and journals the exception", async () => {
    const { journal, records } = journalRecorder();
    // The response must carry no exception text, and the journal must hold the
    // detail.
    const { server, url } = await startServer({
      feedback: failingTokenFeedback(),
      journal,
    });

    try {
      const response = await submit(url, report());

      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
      expect(await response.json()).toEqual(
        problemBody("Internal Server Error", 500, "An internal error occurred."),
      );
      expect(records).toEqual([
        ["server-error", "POST /feedback: gitea token secret-token is unusable"],
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("disables reporting when no Gitea address is configured", async () => {
    const { server, url } = await startServer({ enabled: false });

    try {
      const response = await submit(url, report());

      expect(response.status).toBe(503);
      expect(response.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
      const body = (await response.json()) as { title: string; detail: string };
      expect(body.title).toBe("Service Unavailable");
      expect(body.detail).toContain("DEVBOARD_GITEA_URL");
    } finally {
      server.stop(true);
    }
  });

  test("answers a non-POST method with 405 when reporting is disabled", async () => {
    const { server, url, calls } = await startServer({ enabled: false });

    try {
      const get = await fetch(`http://${url}/feedback`);
      expect(get.status).toBe(405);
      expect(get.headers.get("allow")).toBe("POST");
      expect(get.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
      expect(await get.json()).toEqual(
        problemBody("Method Not Allowed", 405, "This endpoint accepts POST only."),
      );

      const head = await fetch(`http://${url}/feedback`, { method: "HEAD" });
      expect(head.status).toBe(405);
      expect(head.headers.get("allow")).toBe("POST");
      expect(await head.text()).toBe("");

      expect(calls).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("answers a non-POST method with 405 when reporting is enabled", async () => {
    const { server, url } = await startServer();

    try {
      const response = await fetch(`http://${url}/feedback`);

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
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

  test("defaults a missing action to the free-text report", async () => {
    const { server, url, calls } = await startServer();

    try {
      const payload = report();
      delete payload.action;
      const response = await submit(url, payload);

      expect(response.status).toBe(201);
      const call = calls[0]!;
      expect(call.body).toContain("## Operator report");
      expect(call.body).toContain("The Start button is clipped on narrow windows.");
    } finally {
      server.stop(true);
    }
  });

  test("accepts the upper-case report action and developer role", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(
        url,
        report({
          action: "REPORT",
          turns: [{ role: "DEVELOPER", text: "Why is this button clipped?" }],
        }),
      );

      expect(response.status).toBe(201);
      const call = calls[0]!;
      expect(call.body).toContain("## Operator report");
      expect(call.body).toContain("**You:**\n\nWhy is this button clipped?");
    } finally {
      server.stop(true);
    }
  });

  test("refuses the lower-case action value it no longer declares", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(url, report({ action: "report" }));

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
      expect(await response.json()).toEqual(
        problemBody("Bad Request", 400, "action must be one of REPORT, REMOVE, REDESIGN."),
      );
      expect(calls).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("files a removal request without report text", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(
        url,
        report({ action: "REMOVE", report: undefined, selector: "main > section.run" }),
      );

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        title: "[ui] Remove element: main > section.run",
        links: { issue: { href: ISSUE_URL } },
      });

      const call = calls[0]!;
      expect(call.body.startsWith("## Removal request\n\n")).toBe(true);
      expect(call.body).toContain(
        "\nRemove the selected UI element from the interface.\n",
      );
      expect(call.body).toContain("## Captured UI context");
      expect(call.body).toContain("- Selected element: `main > section.run`");
      expect(call.body).not.toContain("## Operator report");
    } finally {
      server.stop(true);
    }
  });

  test("files a redesign request with the normative design instruction", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(
        url,
        report({ action: "REDESIGN", report: "ignored operator text" }),
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as { title: string };
      expect(body.title).toBe(
        "[ui] Redesign element: main > section.run > button.start-button",
      );
      const call = calls[0]!;
      expect(call.body.startsWith("## Redesign request\n\n")).toBe(true);
      expect(call.body).toContain(REDESIGN_INSTRUCTION);
      expect(call.body).toContain("project UI/UX skill (devboard-ui-ux)");
      expect(call.body).not.toContain("global OMP UI/UX");
      expect(call.body).toContain("DESIGN.md");
      expect(call.body).toContain("design/tokens.json");
      expect(call.body).not.toContain("ignored operator text");
    } finally {
      server.stop(true);
    }
  });

  test("clamps a long selector to the title limit", async () => {
    const { server, url } = await startServer();

    try {
      const response = await submit(
        url,
        report({ action: "REMOVE", report: undefined, selector: "a ".repeat(300) }),
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as { title: string };
      expect(body.title.startsWith("[ui] Remove element: a a a")).toBe(true);
      expect(body.title.length).toBeLessThanOrEqual(200);
      expect(body.title).not.toContain("  ");
    } finally {
      server.stop(true);
    }
  });

  test("names a removal without a selector", async () => {
    const { server, url } = await startServer();

    try {
      const response = await submit(
        url,
        report({ action: "REMOVE", report: undefined, selector: "" }),
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as { title: string };
      expect(body.title).toBe("[ui] Remove element");
    } finally {
      server.stop(true);
    }
  });

  test("refuses an unknown action before reaching Gitea", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(url, report({ action: "delete" }));

      expect(response.status).toBe(400);
      expect(calls).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("refuses an unknown body field and accepts the same body without it", async () => {
    const { server, url, calls } = await startServer();

    try {
      const accepted = report({ action: "REPORT", turns: [] });
      const refused = await submit(url, { ...accepted, unexpected: 1 });

      expect(refused.status).toBe(400);
      expect(refused.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
      expect(await refused.json()).toEqual(
        problemBody("Bad Request", 400, "unknown field: unexpected."),
      );
      expect(calls).toHaveLength(0);

      const created = await submit(url, accepted);
      expect(created.status).toBe(201);
      expect(calls).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });

  test("refuses the singular conversation key it no longer accepts", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(url, report({ conversation: [] }));

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
      expect(await response.json()).toEqual(
        problemBody("Bad Request", 400, "unknown field: conversation."),
      );
      expect(calls).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("files one issue for a retried Idempotency-Key", async () => {
    const { server, url, calls } = await startServer();

    try {
      const first = await submit(url, report(), { "idempotency-key": "report-1" });
      const second = await submit(url, report(), { "idempotency-key": "report-1" });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const expected = {
        title: "[ui] The Start button is clipped on narrow windows.",
        links: { issue: { href: ISSUE_URL } },
      };
      expect(await first.json()).toEqual(expected);
      expect(await second.json()).toEqual(expected);
      expect(first.headers.get("location")).toBe(ISSUE_URL);
      expect(second.headers.get("location")).toBe(ISSUE_URL);
      expect(calls).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });

  test("files one issue per distinct Idempotency-Key", async () => {
    const { server, url, calls } = await startServer();

    try {
      const first = await submit(url, report(), { "idempotency-key": "report-1" });
      const second = await submit(url, report(), { "idempotency-key": "report-2" });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(calls).toHaveLength(2);
    } finally {
      server.stop(true);
    }
  });

  test("refuses an empty Idempotency-Key before reaching Gitea", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(url, report(), { "idempotency-key": "" });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(
        problemBody("Bad Request", 400, "Idempotency-Key must not be empty."),
      );
      expect(calls).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });
});
