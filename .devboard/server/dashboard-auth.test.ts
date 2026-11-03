import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "./app";
import { GOAL_PROPOSALS_DIRECTORY } from "../lib/goal-proposals";
import { goalProposalName } from "./goal-proposal";
import { testProviderService } from "./fixtures/test-providers";

const TOKEN = "dashboard-test-token";
const BOOTSTRAP = "dashboard-test-bootstrap";
const temporaryDirectories: string[] = [];
const temporaryRoot = join(import.meta.dir, "..", ".tmp");

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, "dashboard-auth-"));
  temporaryDirectories.push(directory);
  return directory;
}

interface RecordedCall {
  url: string;
  method: string;
}

async function startServer() {
  const root = await temporaryDirectory();
  const adrDir = join(root, "adrs");
  const staticDir = join(root, "static");
  await mkdir(adrDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Dashboard</title>");

  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input, method: init?.method ?? "GET" });
    return Response.json({
      number: 12,
      title: "filed",
      html_url: "https://gitea.example/dsdenes/devboard/issues/12",
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
    token: TOKEN,
    bootstrap: BOOTSTRAP,
    goalSlug: async (report: string) => goalProposalName(report),
    feedback: {
      baseUrl: "https://gitea.example",
      repo: "dsdenes/devboard",
      token: "secret-token",
      timeoutMs: 5_000,
      fetchImpl,
    },
  });
  return { server, root, url: `127.0.0.1:${server.port}`, calls };
}

function submit(
  url: string,
  path: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

function report(): Record<string, unknown> {
  return {
    report: "The Start button is clipped on narrow windows.",
    route: "/",
    url: "http://127.0.0.1:8123/",
    selector: "main > section.run > button.start-button",
    dom_excerpt: '<button class="start-button">Start</button>',
    visible_text: "Start",
    viewport: "1280x720 @1x",
    captured_at: "2026-10-22T10:00:00.000Z",
  };
}

function proposal(): Record<string, unknown> {
  return { ...report(), report: "Add a Stop control to the run panel." };
}

async function draftNames(root: string): Promise<string[]> {
  const directory = join(root, GOAL_PROPOSALS_DIRECTORY);
  if (!existsSync(directory)) return [];
  return (await readdir(directory)).filter((name) => name.endsWith(".md")).sort();
}

/** A handshake that would upgrade if the endpoint admitted it. */
function upgrade(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://${url}/ws`, {
    headers: {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
      ...headers,
    },
  });
}

function openSocket(url: string, headers: Record<string, string>): Promise<void> {
  // Bun's WebSocket takes handshake headers; the DOM type declares only protocols.
  const socket = new WebSocket(`ws://${url}/ws`, { headers } as unknown as string[]);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  socket.onopen = () => {
    socket.close();
    resolve();
  };
  socket.onerror = () => reject(new Error("the socket upgrade was refused"));
  return promise;
}

describe("dashboard credential", () => {
  test("refuses an unauthenticated report and files nothing", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(url, "/feedback", report());

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(await response.json()).toMatchObject({ status: 401, title: "Unauthorized" });
      expect(calls).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("files a report that carries the configured bearer token", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(url, "/feedback", report(), {
        authorization: `Bearer ${TOKEN}`,
      });

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        title: "[ui] The Start button is clipped on narrow windows.",
        links: {
          issue: { href: "https://gitea.example/dsdenes/devboard/issues/12" },
        },
      });
      expect(calls).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });

  test("refuses a report that carries another token", async () => {
    const { server, url, calls } = await startServer();

    try {
      const response = await submit(url, "/feedback", report(), {
        authorization: "Bearer another-token",
      });

      expect(response.status).toBe(401);
      expect(calls).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("refuses an unauthenticated goal proposal and writes no draft", async () => {
    const { server, root, url } = await startServer();

    try {
      const response = await submit(url, "/goal-proposals", proposal());

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(await draftNames(root)).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("writes a goal proposal that carries the configured bearer token", async () => {
    const { server, root, url } = await startServer();

    try {
      const response = await submit(url, "/goal-proposals", proposal(), {
        authorization: `Bearer ${TOKEN}`,
      });

      expect(response.status).toBe(201);
      expect(await draftNames(root)).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });

  test("refuses the socket upgrade before it runs", async () => {
    const { server, url } = await startServer();

    try {
      const response = await upgrade(url);

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
    } finally {
      server.stop(true);
    }
  });

  test("refuses readiness without the dashboard token and never reports the pid", async () => {
    const { server, url } = await startServer();

    try {
      const response = await fetch(`http://${url}/ready`);

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(response.headers.get("content-type")).toBe("application/problem+json");
      expect(await response.text()).not.toContain("pid");

      const head = await fetch(`http://${url}/ready`, { method: "HEAD" });
      expect(head.status).toBe(401);
      expect(head.headers.get("www-authenticate")).toBe("Bearer");
      expect(await head.text()).toBe("");

      const foreign = await fetch(`http://${url}/ready`, {
        headers: { authorization: "Bearer another-token" },
      });
      expect(foreign.status).toBe(401);
      expect(await foreign.text()).not.toContain("pid");
    } finally {
      server.stop(true);
    }
  });

  test("answers readiness with the dashboard token", async () => {
    const { server, url } = await startServer();

    try {
      const response = await fetch(`http://${url}/ready`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ pid: process.pid });
    } finally {
      server.stop(true);
    }
  });

  test("refuses an anonymous document without handing it the cookie", async () => {
    const { server, url } = await startServer();

    try {
      const response = await fetch(`http://${url}/`);

      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toBe("application/problem+json");
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.json()).toEqual({
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        detail: "This page requires the dashboard credential.",
      });
    } finally {
      server.stop(true);
    }
  });

  test("hands the page a cookie to the bootstrap handshake", async () => {
    const { server, url } = await startServer();

    try {
      const name = `devboard_dashboard_${server.port}`;
      const page = await fetch(`http://${url}/?bootstrap=${BOOTSTRAP}`);
      const cookie = page.headers.get("set-cookie") ?? "";

      expect(page.status).toBe(200);
      expect(cookie).toContain(`${name}=${TOKEN}`);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
    } finally {
      server.stop(true);
    }
  });

  test("hands the page a cookie to a request that already presents it", async () => {
    const { server, url } = await startServer();

    try {
      const name = `devboard_dashboard_${server.port}`;
      const presented = `${name}=${TOKEN}`;
      const page = await fetch(`http://${url}/`, { headers: { cookie: presented } });
      const cookie = page.headers.get("set-cookie") ?? "";

      expect(page.status).toBe(200);
      expect(cookie).toContain(`${name}=${TOKEN}`);

      await openSocket(url, { cookie: presented });

      const response = await submit(url, "/goal-proposals", proposal(), { cookie: presented });
      expect(response.status).toBe(201);
    } finally {
      server.stop(true);
    }
  });

  test("does not admit the endpoints with the bootstrap value", async () => {
    const { server, url, calls } = await startServer();

    try {
      expect((await fetch(`http://${url}/?bootstrap=${BOOTSTRAP}`)).status).toBe(200);

      const filed = await submit(url, "/feedback", report(), {
        authorization: `Bearer ${BOOTSTRAP}`,
      });
      expect(filed.status).toBe(401);
      expect(calls).toHaveLength(0);

      const upgradeResponse = await upgrade(url, { cookie: `devboard_dashboard=${BOOTSTRAP}` });
      expect(upgradeResponse.status).toBe(401);
    } finally {
      server.stop(true);
    }
  });
});
