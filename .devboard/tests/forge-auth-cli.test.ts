/**
 * The canonical auth probe: `check --forge gitea --required write --json` with
 * no host, project, or URL flags. The target comes from the environment and the
 * origin remote, which is what the implement-issue prompt runs.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

const harnessRoot = join(import.meta.dir, "..");
let root: string;
let server: { readonly url: URL; stop(force?: boolean): void };

function git(...args: string[]): void {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", root, ...args],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
}

beforeAll(async () => {
  await mkdir(join(harnessRoot, ".tmp"), { recursive: true });
  root = await mkdtemp(join(harnessRoot, ".tmp", "forge-auth-cli-"));
  git("init", "-q");
  git("remote", "add", "origin", "https://example.test/owner/repo.git");

  server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/v1/repos/owner/repo") {
        return Response.json({
          full_name: "owner/repo",
          permissions: { admin: false, push: true, pull: true },
        });
      }
      if (path === "/api/v1/user") return Response.json({ login: "ds" });
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(async () => {
  server?.stop(true);
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe("canonical forge-auth check", () => {
  test("takes the Gitea target from the environment and origin remote", async () => {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        join(harnessRoot, "scripts", "forge-auth.ts"),
        "check",
        "--forge",
        "gitea",
        "--required",
        "write",
        "--json",
      ],
      cwd: root,
      env: { ...process.env, DEVBOARD_GITEA_URL: server.url.origin, GITEA_TOKEN: "token" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({
      forge: "gitea",
      host: new URL(server.url).host,
      project: "owner/repo",
      login: "ds",
      canWrite: true,
    });
  });
});
