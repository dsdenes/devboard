/**
 * The suite's `.env` walk stays inside the checkout that bounds it.
 *
 * The operator suite files and closes issues on a live Gitea board, so a
 * `.env` above the repository root must never decide the URL or the token.
 * These cases build their own trees under `.devboard/.tmp`, so no real
 * checkout's `.env` takes part.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  dotEnvCandidates,
  dotEnvRootFor,
  giteaUrl,
  type GiteaIssue,
  loadDotEnv,
  openIssues,
  pidAlive,
  repoRoot,
  sleep,
  stopChild,
  tmpDir,
} from "./support.ts";

const scratch = path.join(tmpDir, "dotenv");

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function tree(...parts: string[]): string {
  const directory = path.join(scratch, ...parts);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function dotEnv(directory: string, body: string): void {
  writeFileSync(path.join(directory, ".env"), body);
}

describe("the suite's .env search", () => {
  test("yields only candidates at or below the root, nearest first", () => {
    const root = tree("bounded", "repo");
    const harness = tree("bounded", "repo", ".devboard");
    const candidates = dotEnvCandidates(harness, root);
    expect(candidates).toEqual([path.join(harness, ".env"), path.join(root, ".env")]);
    for (const candidate of candidates) {
      const relative = path.relative(root, candidate);
      expect(relative.startsWith("..")).toBe(false);
      expect(path.isAbsolute(relative)).toBe(false);
    }
  });

  test("stops above the root even when several .env ancestors exist", () => {
    const base = tree("outside");
    dotEnv(base, "DEVBOARD_GITEA_URL=http://outside.test\n");
    dotEnv(tree("outside", "middle"), "DEVBOARD_GITEA_URL=http://middle.test\n");
    const root = tree("outside", "middle", "repo");
    const harness = tree("outside", "middle", "repo", ".devboard");
    expect(dotEnvCandidates(harness, root)).toEqual([
      path.join(harness, ".env"),
      path.join(root, ".env"),
    ]);
  });

  test("leaves the environment unchanged for a .env above the root", () => {
    const base = tree("adopted");
    dotEnv(base, "DEVBOARD_GITEA_URL=http://outside.test\n");
    const root = tree("adopted", "middle", "repo");
    const harness = tree("adopted", "middle", "repo", ".devboard");
    const saved = process.env.DEVBOARD_GITEA_URL;
    delete process.env.DEVBOARD_GITEA_URL;
    try {
      loadDotEnv({ start: harness, root });
      expect(process.env.DEVBOARD_GITEA_URL).toBeUndefined();
      expect(() => giteaUrl()).toThrow("the suite needs DEVBOARD_GITEA_URL");
    } finally {
      if (saved === undefined) delete process.env.DEVBOARD_GITEA_URL;
      else process.env.DEVBOARD_GITEA_URL = saved;
    }
  });

  test("reads a .env at the root", () => {
    const root = tree("supplied", "repo");
    dotEnv(root, "DEVBOARD_GITEA_URL='http://supplied.test/'\n");
    const harness = tree("supplied", "repo", ".devboard");
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv({ start: harness, root, env });
    expect(env.DEVBOARD_GITEA_URL).toBe("http://supplied.test/");
  });

  test("prefers the nearest .env and never overrides a set value", () => {
    const root = tree("nearest", "repo");
    dotEnv(root, "DEVBOARD_GITEA_URL=http://root.test\nGITEA_TOKEN=root-token\n");
    const worktree = tree("nearest", "repo", ".worktree", "issue-1");
    dotEnv(worktree, "DEVBOARD_GITEA_URL=http://worktree.test\n");
    const harness = tree("nearest", "repo", ".worktree", "issue-1", ".devboard");
    const env: NodeJS.ProcessEnv = { GITEA_TOKEN: "caller-token" };
    loadDotEnv({ start: harness, root: dotEnvRootFor(worktree), env });
    expect(env.DEVBOARD_GITEA_URL).toBe("http://worktree.test");
    expect(env.GITEA_TOKEN).toBe("caller-token");
  });

  test("a worktree resolves the checkout that spawned it", () => {
    const checkout = tree("worktree", "checkout");
    dotEnv(checkout, "DEVBOARD_GITEA_URL=http://checkout.test\n");
    const worktree = tree("worktree", "checkout", ".worktree", "issue-1");
    const harness = tree("worktree", "checkout", ".worktree", "issue-1", ".devboard");
    expect(dotEnvRootFor(worktree)).toBe(checkout);
    const candidates = dotEnvCandidates(harness, dotEnvRootFor(worktree));
    expect(candidates).toContain(path.join(checkout, ".env"));
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv({ start: harness, root: dotEnvRootFor(worktree), env });
    expect(env.DEVBOARD_GITEA_URL).toBe("http://checkout.test");
  });

  test("this checkout bounds its own search", () => {
    const root = dotEnvRootFor(repoRoot);
    expect(path.relative(root, repoRoot).startsWith("..")).toBe(false);
    const candidates = dotEnvCandidates(path.join(repoRoot, ".devboard"), root);
    expect(candidates.at(-1)).toBe(path.join(root, ".env"));
    for (const candidate of candidates) {
      const relative = path.relative(root, candidate);
      expect(relative.startsWith("..")).toBe(false);
    }
  });
});

/**
 * The board read walks every page the tracker serves.
 *
 * The soak's proof is only as wide as the read behind it: a board holding more
 * open issues than one page must return all of them, a forge that clamps the
 * requested page size must not be read as a final page, and a page that
 * repeats itself must end the walk instead of looping.
 */
describe("the suite's board read", () => {
  const saved = {
    url: process.env.DEVBOARD_GITEA_URL,
    token: process.env.GITEA_TOKEN,
  };

  afterAll(() => {
    if (saved.url === undefined) delete process.env.DEVBOARD_GITEA_URL;
    else process.env.DEVBOARD_GITEA_URL = saved.url;
    if (saved.token === undefined) delete process.env.GITEA_TOKEN;
    else process.env.GITEA_TOKEN = saved.token;
  });

  function boardIssue(number: number): GiteaIssue {
    return {
      number,
      title: `issue ${number}`,
      body: "",
      state: "open",
      html_url: `https://board.test/issues/${number}`,
    };
  }

  /** A tracker stub serving `rows(page)` and recording every page it is asked for. */
  function stubBoard(
    rows: (page: number) => GiteaIssue[],
    total: number,
  ): { requests: URLSearchParams[]; stop: () => void } {
    const requests: URLSearchParams[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url);
        requests.push(url.searchParams);
        const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
        return Response.json(rows(page), {
          headers: { "X-Total-Count": String(total) },
        });
      },
    });
    process.env.DEVBOARD_GITEA_URL = server.url.origin;
    process.env.GITEA_TOKEN = "suite-token";
    return { requests, stop: () => server.stop(true) };
  }

  test("returns every open issue across every page", async () => {
    const numbers = Array.from({ length: 120 }, (_, index) => index + 1);
    const board = stubBoard(
      (page) => numbers.slice((page - 1) * 50, page * 50).map(boardIssue),
      numbers.length,
    );
    try {
      const issues = await openIssues();
      expect(issues.map((issue) => issue.number)).toEqual(numbers);
      expect(board.requests.map((params) => params.get("page"))).toEqual(["1", "2", "3", "4"]);
      expect(board.requests.every((params) => params.get("limit") === "50")).toBe(true);
      expect(board.requests.every((params) => params.get("state") === "open")).toBe(true);
    } finally {
      board.stop();
    }
  });

  test("confirms a short final page with one empty request", async () => {
    const board = stubBoard((page) => (page === 1 ? [boardIssue(1), boardIssue(2)] : []), 2);
    try {
      expect((await openIssues()).map((issue) => issue.number)).toEqual([1, 2]);
      expect(board.requests).toHaveLength(2);
    } finally {
      board.stop();
    }
  });

  test("walks past a forge that clamps the requested page size", async () => {
    const numbers = Array.from({ length: 60 }, (_, index) => index + 1);
    // The forge serves its own cap of 20 rows whatever `limit` the read asks for.
    const board = stubBoard(
      (page) => numbers.slice((page - 1) * 20, page * 20).map(boardIssue),
      numbers.length,
    );
    try {
      const issues = await openIssues();
      expect(issues.map((issue) => issue.number)).toEqual(numbers);
      // Three clamped pages carry the board; the fourth confirms the end.
      expect(board.requests.map((params) => params.get("page"))).toEqual(["1", "2", "3", "4"]);
      expect(board.requests.every((params) => params.get("limit") === "50")).toBe(true);
      expect(board.requests.every((params) => params.get("type") === "issues")).toBe(true);
    } finally {
      board.stop();
    }
  });

  test("stops when a page repeats itself instead of looping", async () => {
    const rows = Array.from({ length: 50 }, (_, index) => boardIssue(index + 1));
    const board = stubBoard(() => rows, rows.length);
    try {
      expect((await openIssues()).map((issue) => issue.number)).toEqual(
        rows.map((issue) => issue.number),
      );
      expect(board.requests).toHaveLength(2);
    } finally {
      board.stop();
    }
  });
});
describe("the suite's dashboard stop", () => {
  test("returns at once for a dashboard that already exited", async () => {
    const child = spawn("sleep", ["60"], { stdio: "ignore" });
    const { promise: exited, resolve } = Promise.withResolvers<void>();
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
    await exited;
    const started = Date.now();
    await stopChild(child);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(child.signalCode).toBe("SIGKILL");
  });

  test("signals a live dashboard and returns when it exits", async () => {
    const child = spawn("sleep", ["60"], { stdio: "ignore" });
    const started = Date.now();
    await stopChild(child);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(child.signalCode).toBe("SIGTERM");
  });

  test(
    "escalates to SIGKILL when the dashboard ignores SIGTERM",
    async () => {
      const child = spawn("bash", ["-c", 'trap "" TERM; exec sleep 60'], { stdio: "ignore" });
      const started = Date.now();
      await stopChild(child, 500);
      expect(Date.now() - started).toBeLessThan(10_000);
      const pid = child.pid ?? 0;
      const deadline = Date.now() + 5_000;
      while (pidAlive(pid) && Date.now() < deadline) {
        await sleep(20);
      }
      expect(pidAlive(pid)).toBe(false);
    },
    15_000,
  );
});
