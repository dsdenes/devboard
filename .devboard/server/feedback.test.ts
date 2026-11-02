import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "./app";
import { REDESIGN_INSTRUCTION } from "./feedback";
import { testProviderService } from "./fixtures/test-providers";

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
  title: string;
  body: string;
}

type Mode = "ok" | "fail" | "hang";

async function startServer(options: { enabled?: boolean; mode?: Mode; timeoutMs?: number } = {}) {
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

  const server = createApp({
    adrDir,
    staticDir,
    hostname: "127.0.0.1",
    port: 0,
    repoDir: root,
    stateDir: join(root, "state"),
    providers: testProviderService(join(root, "state")),
    feedback:
      options.enabled === false
        ? undefined
        : {
            baseUrl: "https://gitea.example",
            repo: "dsdenes/devboard",
            token: "secret-token",
            timeoutMs: options.timeoutMs ?? 5_000,
            fetchImpl,
          },
  });
  return { server, root, url: `127.0.0.1:${server.port}`, calls };
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

describe("feedback endpoint", () => {
  test("files the report and captured context through the Gitea API", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(url, report());

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        url: ISSUE_URL,
        title: "[ui] The Start button is clipped on narrow windows.",
      });

      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.method).toBe("POST");
      expect(call.url).toBe("https://gitea.example/api/v1/repos/dsdenes/devboard/issues");
      expect(call.authorization).toBe("token secret-token");
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

  test("carries the Ask conversation as context in the filed issue", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(
        url,
        report({
          conversation: [
            { role: "developer", text: "Why is this button clipped?" },
            { role: "agent", text: "The flex row has no min-width." },
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

  test("refuses a malformed conversation before reaching Gitea", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(
        url,
        report({ conversation: [{ role: "system", text: "ignored" }] }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "conversation[0].role must be developer or agent.",
      });
      expect(calls).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("refuses an oversized conversation before reaching Gitea", async () => {
    const { server, url, calls } = await startServer();
    const turn = "x".repeat(4000);

    try {
      const response = await submit(
        url,
        report({
          conversation: [
            { role: "developer", text: turn },
            { role: "agent", text: turn },
            { role: "developer", text: turn },
            { role: "agent", text: turn },
          ],
        }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "conversation is longer than 12000 characters.",
      });
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
      expect(await response.json()).toEqual({ error: "report must not be empty." });
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
      expect(await response.json()).toEqual({
        error: "The request host is not served by this dashboard.",
      });
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

  test("reports a delivery failure with its diagnostic", async () => {
    const { server, url } = await startServer({ mode: "fail" });

    try {
      const response = await submit(url, report());

      expect(response.status).toBe(502);
      const body = (await response.json()) as { error: string };
      expect(body.error.startsWith("Issue creation failed:")).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("reports a delivery timeout", async () => {
    const { server, url } = await startServer({ mode: "hang", timeoutMs: 100 });

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

  test("disables reporting when no Gitea address is configured", async () => {
    const { server, url } = await startServer({ enabled: false });

    try {
      const response = await submit(url, report());

      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("DEVBOARD_GITEA_URL");
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

  test("files a removal request without report text", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(
        url,
        report({ action: "remove", report: undefined, selector: "main > section.run" }),
      );

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        url: ISSUE_URL,
        title: "[ui] Remove element: main > section.run",
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
        report({ action: "redesign", report: "ignored operator text" }),
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
        report({ action: "remove", report: undefined, selector: "a ".repeat(300) }),
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
        report({ action: "remove", report: undefined, selector: "" }),
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
});
