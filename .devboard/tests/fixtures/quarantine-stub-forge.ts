#!/usr/bin/env bun
/**
 * The stub Gitea API for the release suite's quarantine verification.
 *
 * It serves the issue endpoints the suite step reads and writes — the open
 * issue list, issue creation, and issue comments — under any `/api/v1/repos/
 * <owner>/<repo>` path, plus an `/admin` surface the verifier uses to inspect
 * what was filed. State lives in a JSON file named by
 * `QUARANTINE_STUB_FORGE_STATE`; no real forge is contacted.
 */

import { readFileSync, writeFileSync } from "node:fs";

interface StubComment {
  body: string;
  createdAt: string;
}

interface StubIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  createdAt: string;
  url: string;
  comments: StubComment[];
}

interface StubState {
  next: number;
  issues: StubIssue[];
}

const port = Number(process.env.PORT ?? "0");
const statePath = process.env.QUARANTINE_STUB_FORGE_STATE;
if (statePath === undefined) throw new Error("QUARANTINE_STUB_FORGE_STATE is required");

function load(): StubState {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as StubState;
    return { next: parsed.next ?? 1, issues: parsed.issues ?? [] };
  } catch {
    return { next: 1, issues: [] };
  }
}

function save(state: StubState): void {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function document(issue: StubIssue, body: boolean): Record<string, unknown> {
  return {
    number: issue.number,
    title: issue.title,
    ...(body ? { body: issue.body } : {}),
    state: issue.state,
    created_at: issue.createdAt,
    html_url: issue.url,
    labels: [],
  };
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (path === "/admin/health") return json({ ok: true });
    if (path === "/admin/state") return json(load());
    if (path === "/api/v1/user") return json({ id: 1, login: "fixture", is_admin: false });
    if (path === "/api/v1/version") return json({ version: "1.22.0" });

    const prefix = "/api/v1/repos/";
    if (!path.startsWith(prefix)) return json({ message: "not found" }, 404);
    const segments = path.slice(prefix.length).split("/").filter((part) => part.length > 0);
    // `<owner>/<repo>` is the project; every later segment addresses it.
    const suffix = segments.slice(2).join("/");
    if (segments.length < 2) return json({ message: "not found" }, 404);
    if (suffix === "") return json({ permissions: { push: true } });

    if (suffix === "issues" && request.method === "POST") {
      const input = (await request.json()) as { title?: unknown; body?: unknown };
      const state = load();
      const number = state.next;
      state.next += 1;
      const issue: StubIssue = {
        number,
        title: typeof input.title === "string" ? input.title : "untitled",
        body: typeof input.body === "string" ? input.body : "",
        state: "open",
        createdAt: new Date().toISOString(),
        url: `http://forge.test/${segments.slice(0, 2).join("/")}/issues/${number}`,
        comments: [],
      };
      state.issues.push(issue);
      save(state);
      return json(document(issue, true), 201);
    }
    if (suffix === "issues" && request.method === "GET") {
      const state = load();
      const status = url.searchParams.get("state") ?? "all";
      const page = Number(url.searchParams.get("page") ?? "1");
      const issues = state.issues.filter(
        (issue) =>
          status === "all" ||
          (status === "open" ? issue.state === "open" : issue.state === "closed"),
      );
      return json(page === 1 ? issues.map((issue) => document(issue, true)) : []);
    }
    const comment = /^issues\/(\d+)\/comments$/.exec(suffix);
    if (comment !== null && request.method === "POST") {
      const state = load();
      const issue = state.issues.find((entry) => entry.number === Number(comment[1]));
      if (issue === undefined) return json({ message: "not found" }, 404);
      const input = (await request.json()) as { body?: unknown };
      issue.comments.push({
        body: typeof input.body === "string" ? input.body : "",
        createdAt: new Date().toISOString(),
      });
      save(state);
      return json({ id: issue.comments.length, body: issue.comments.at(-1)?.body ?? "" }, 201);
    }
    const one = /^issues\/(\d+)$/.exec(suffix);
    if (one !== null) {
      const issue = load().issues.find((entry) => entry.number === Number(one[1]));
      return issue === undefined ? json({ message: "not found" }, 404) : json(document(issue, true));
    }
    return json({ message: "unhandled" }, 404);
  },
});

console.log(`quarantine-stub-forge ${server.port}`);
