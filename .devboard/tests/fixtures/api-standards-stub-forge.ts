#!/usr/bin/env bun
/**
 * The stub Gitea API for API Standards verification. It serves the repository,
 * label, and issue endpoints the agent's `issue_create` call and the worker's
 * periodic read use, plus an `/admin` surface the verifier seeds and inspects.
 * State lives in a JSON file under the fixture root; no real forge is
 * contacted.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

interface StubIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  createdAt: string;
  labels: string[];
}

interface StubLabel {
  id: number;
  name: string;
  color: string;
  description: string;
}

interface StubState {
  next: number;
  nextLabel: number;
  labels: StubLabel[];
  issues: StubIssue[];
}

const port = Number(process.env.PORT ?? "0");
const statePath = process.env.API_STANDARDS_STUB_FORGE_STATE;
if (statePath === undefined) throw new Error("API_STANDARDS_STUB_FORGE_STATE is required");

const DEFAULT_STATE: StubState = {
  next: 1,
  nextLabel: 2,
  labels: [{ id: 1, name: "api-standards", color: "0e8a16", description: "" }],
  issues: [],
};

function load(): StubState {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<StubState>;
    return {
      next: parsed.next ?? 1,
      nextLabel: parsed.nextLabel ?? 2,
      labels: parsed.labels ?? DEFAULT_STATE.labels,
      issues: parsed.issues ?? [],
    };
  } catch {
    return { ...DEFAULT_STATE, labels: [...DEFAULT_STATE.labels], issues: [] };
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
    html_url: `http://forge.test/acme/fixture/issues/${issue.number}`,
    labels: issue.labels.map((name, index) => ({ id: index + 1, name })),
  };
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const requestLog = process.env.API_STANDARDS_STUB_FORGE_LOG;
    if (requestLog !== undefined) {
      appendFileSync(requestLog, `${request.method} ${path}${url.search}\n`);
    }
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
        labels?: string[];
      };
      const number = state.next;
      state.next += 1;
      const issue: StubIssue = {
        number,
        title: input.title ?? `Seeded issue ${number}`,
        body: input.body ?? "",
        state: input.state ?? "open",
        createdAt: new Date().toISOString(),
        labels: input.labels ?? ["api-standards"],
      };
      state.issues.push(issue);
      save(state);
      return json(document(issue, true));
    }
    if (path === "/api/v1/user") return json({ id: 1, login: "fixture", is_admin: false });
    if (path === "/api/v1/version") return json({ version: "1.22.0" });

    const prefix = "/api/v1/repos/acme/fixture";
    if (!path.startsWith(prefix)) return json({ message: "not found" }, 404);
    const suffix = path.slice(prefix.length);
    const state = load();
    if (suffix === "") return json({ permissions: { push: true } });
    if (suffix === "/labels") {
      if (request.method === "POST") {
        const input = (await request.json()) as {
          name?: string;
          color?: string;
          description?: string;
        };
        const label: StubLabel = {
          id: state.nextLabel,
          name: input.name ?? "label",
          color: input.color ?? "ededed",
          description: input.description ?? "",
        };
        state.nextLabel += 1;
        state.labels.push(label);
        save(state);
        return json(label, 201);
      }
      const page = Number(url.searchParams.get("page") ?? "1");
      return json(page === 1 ? state.labels : []);
    }
    if (suffix === "/issues" && request.method === "POST") {
      const input = (await request.json()) as {
        title?: unknown;
        body?: unknown;
        labels?: unknown;
      };
      const names = Array.isArray(input.labels)
        ? input.labels
            .map((id) => state.labels.find((label) => label.id === id)?.name)
            .filter((name): name is string => name !== undefined)
        : [];
      const number = state.next;
      state.next += 1;
      const issue: StubIssue = {
        number,
        title: typeof input.title === "string" ? input.title : "untitled",
        body: typeof input.body === "string" ? input.body : "",
        state: "open",
        createdAt: new Date().toISOString(),
        labels: names,
      };
      state.issues.push(issue);
      save(state);
      return json(document(issue, true));
    }
    if (suffix === "/issues" && request.method === "GET") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const status = url.searchParams.get("state") ?? "all";
      const issues = state.issues.filter(
        (issue) =>
          status === "all" ||
          (status === "open" ? issue.state === "open" : issue.state === "closed"),
      );
      return json(page === 1 ? issues.map((issue) => document(issue, true)) : []);
    }
    const one = /^\/issues\/(\d+)$/.exec(suffix);
    if (one !== null) {
      const issue = state.issues.find((entry) => entry.number === Number(one[1]));
      return issue === undefined ? json({ message: "not found" }, 404) : json(document(issue, true));
    }
    if (/^\/issues\/\d+\/(timeline|comments)$/.test(suffix)) return json([]);
    return json({ message: "unhandled" }, 404);
  },
});

console.log(`api-standards stub forge on ${server.port}`);
