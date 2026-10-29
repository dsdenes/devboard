#!/usr/bin/env bun
/**
 * The stub Gitea API for Design System verification. It serves the repository,
 * labels, issues, releases, and workflow-run endpoints the agent reads, and an
 * `/admin` surface the verifier uses to seed and inspect issues. State lives in
 * a JSON file under the fixture root; no real forge is contacted.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

interface StubIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  createdAt: string;
  url: string;
}

interface StubState {
  next: number;
  issues: StubIssue[];
}

const port = Number(process.env.PORT ?? "0");
const statePath = process.env.DESIGN_STUB_FORGE_STATE;
if (statePath === undefined) throw new Error("DESIGN_STUB_FORGE_STATE is required");

function load(): StubState {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as StubState;
  } catch {
    return { next: 1, issues: [] };
  }
}

function save(state: StubState): void {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function document(issue: StubIssue, body = false): Record<string, unknown> {
  return {
    number: issue.number,
    title: issue.title,
    ...(body ? { body: issue.body } : {}),
    state: issue.state,
    created_at: issue.createdAt,
    html_url: issue.url,
    labels: [{ id: 1, name: "design" }],
  };
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const requestLog = process.env.DESIGN_STUB_FORGE_LOG;
    if (requestLog !== undefined) appendFileSync(requestLog, `${request.method} ${path}${url.search}\n`);
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (path === "/admin/health") return json({ ok: true });
    if (path === "/admin/state") return json(load());
    if (path === "/admin/seed" && request.method === "POST") {
      const state = load();
      const input = (await request.json()) as {
        title?: string;
        body?: string;
        state?: "open" | "closed";
      };
      const number = state.next;
      state.next += 1;
      state.issues.push({
        number,
        title: input.title ?? `Seeded issue ${number}`,
        body: input.body ?? "",
        state: input.state ?? "open",
        createdAt: new Date().toISOString(),
        url: `http://forge.test/acme/fixture/issues/${number}`,
      });
      save(state);
      return json(document(state.issues[state.issues.length - 1]!, true));
    }

    const prefix = "/api/v1/repos/acme/fixture";
    if (!path.startsWith(prefix)) return json({ message: "not found" }, 404);
    const suffix = path.slice(prefix.length);
    if (suffix === "") return json({ permissions: { push: true } });
    if (suffix === "/labels") {
      const page = Number(url.searchParams.get("page") ?? "1");
      return json(page === 1 ? [{ id: 1, name: "design", color: "1f6feb" }] : []);
    }
    if (suffix === "/releases") return json([]);
    if (suffix === "/actions/runs") {
      const sha = url.searchParams.get("head_sha") ?? "";
      return json({
        workflow_runs: [{ id: 1, head_sha: sha, status: "completed", conclusion: "success" }],
      });
    }
    if (suffix === "/issues" && request.method === "POST") {
      const state = load();
      const body = (await request.json()) as { title?: unknown; body?: unknown };
      const number = state.next;
      state.next += 1;
      const issue: StubIssue = {
        number,
        title: typeof body.title === "string" ? body.title : "untitled",
        body: typeof body.body === "string" ? body.body : "",
        state: "open",
        createdAt: new Date().toISOString(),
        url: `http://forge.test/acme/fixture/issues/${number}`,
      };
      state.issues.push(issue);
      save(state);
      return json(document(issue, true));
    }
    if (suffix === "/issues" && request.method === "GET") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const status = url.searchParams.get("state") ?? "all";
      const issues = load().issues.filter(
        (issue) =>
          status === "all" ||
          (status === "open" ? issue.state === "open" : issue.state === "closed"),
      );
      return json(page === 1 ? issues.map((issue) => document(issue, true)) : []);
    }
    if (/^\/issues\/\d+\/(timeline|comments)$/.test(suffix)) return json([]);
    const one = /^\/issues\/(\d+)$/.exec(suffix);
    if (one !== null) {
      const issue = load().issues.find((entry) => entry.number === Number(one[1]));
      return issue === undefined ? json({ message: "not found" }, 404) : json(document(issue, true));
    }
    return json({ message: "unhandled" }, 404);
  },
});

if (statePath !== undefined) {
  setInterval(() => {
    try {
      writeFileSync(`${statePath}.beat`, String(Date.now()));
    } catch {
      // The fixture root was removed.
    }
  }, 200).unref();
}
console.log(`design-stub-forge ${server.port}`);
