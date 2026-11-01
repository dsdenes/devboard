/**
 * The Gitea lane's close command must name a wrapper `forge-auth` accepts.
 *
 * `forge-auth exec` refuses Gitea and exits 2, so the old prompt turned every
 * finished Gitea lane into a phantom blocked run with the issue still open.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { buildGoalIssuePrompt } from "../extensions/implement-goal-issue.ts";
import { forgeAuthCommand } from "../extensions/implement-next-epic.ts";

const repo = resolve(import.meta.dir, "..", "..");
const body = "## Objective\n\nShip the export command.\n";

interface Recorded {
  method: string;
  path: string;
  authorization: string | null;
  body: string;
}

const requests: Recorded[] = [];
let server: { readonly url: URL; stop(force?: boolean): void };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        body: await request.text(),
      });
      if (url.pathname === "/api/v1/repos/owner/repo") {
        return Response.json({
          full_name: "owner/repo",
          permissions: { admin: false, push: true, pull: true },
        });
      }
      if (url.pathname === "/api/v1/user") return Response.json({ login: "ds" });
      if (url.pathname === "/api/v1/repos/owner/repo/issues/42") {
        return Response.json({ number: 42, state: "closed" });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  server?.stop(true);
});

describe("the emitted Gitea close command", () => {
  test("checks the identity, then closes the issue through the API", async () => {
    const info = {
      host: new URL(server.url).host,
      project: "owner/repo",
      forge: "gitea" as const,
    };
    const prompt = buildGoalIssuePrompt(
      {
        number: 42,
        title: "A goal",
        url: `${server.url.origin}/owner/repo/issues/42`,
        body,
        labels: ["goal"],
      },
      repo,
      join(repo, ".worktree", "goal-42"),
      "devboard/goal-42",
      "gitea",
      "owner/repo",
      forgeAuthCommand(repo, info),
    );
    const command = prompt.match(/^ {2}`(.+)`$/m)?.[1] ?? "";
    expect(command).not.toBe("");

    const child = Bun.spawn({
      cmd: ["sh", "-c", command],
      cwd: repo,
      env: { ...process.env, DEVBOARD_GITEA_URL: server.url.origin, GITEA_TOKEN: "token" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, status] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    expect(requests.find((request) => request.method === "PATCH")).toMatchObject({
      path: "/api/v1/repos/owner/repo/issues/42",
      authorization: "token token",
      body: '{"state":"closed"}',
    });
  });
});
