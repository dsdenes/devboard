#!/usr/bin/env bun
/**
 * The deterministic `gh` for Single Responsibility verification. It answers
 * the forge reads and the issue write the worker and the MCP issue tools make,
 * backed by one JSON store under the verification root.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const LABEL = "consistent-naming";

interface StubIssue {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  createdAt: string;
  body: string;
  labels: string[];
}

interface StubStore {
  nextNumber: number;
  issues: StubIssue[];
  openTitles: string[];
}

const args = process.argv.slice(2);
const logPath = process.env.CONSISTENT_NAMING_STUB_GH_LOG;
const storePath = process.env.CONSISTENT_NAMING_STUB_STATE;

if (logPath !== undefined) appendFileSync(logPath, `${JSON.stringify(args)}\n`);

function valueAfter(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function loadStore(): StubStore {
  if (storePath === undefined) throw new Error("no store");
  try {
    return JSON.parse(readFileSync(storePath, "utf8")) as StubStore;
  } catch {
    return { nextNumber: 1, issues: [], openTitles: [] };
  }
}

function saveStore(store: StubStore): void {
  if (storePath === undefined) throw new Error("no store");
  writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
}

const repository = "acme/fixture-consistent-naming";
const jq = valueAfter("--jq");
const endpoint = args.find((argument) => argument.startsWith("repos/")) ?? "";
const store = loadStore();

if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(
    `${JSON.stringify({
      hosts: {
        "github.com": [{ state: "success", login: "fixture", active: true, tokenSource: "gh" }],
      },
    })}\n`,
  );
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "token") {
  process.stdout.write("stub-token\n");
  process.exit(0);
}
if (args[0] === "api") {
  if (jq !== undefined && jq.endsWith(".permissions.push")) {
    process.stdout.write("true\n");
    process.exit(0);
  }
  if (endpoint.endsWith(`/labels/${LABEL}`) && jq === ".name") {
    process.stderr.write("HTTP 404: Not Found\n");
    process.exit(1);
  }
  if (jq !== undefined && jq.endsWith(".permissions")) {
    process.stdout.write(
      `${JSON.stringify({ admin: false, maintain: false, push: true, triage: true, pull: true })}\n`,
    );
    process.exit(0);
  }
  process.stdout.write("{}\n");
  process.exit(0);
}
if (args[0] === "label" && args[1] === "create") {
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "list") {
  const state = (valueAfter("--state") ?? "open").toLowerCase();
  const rows = store.issues.filter(
    (issue) =>
      state === "all" ||
      (state === "open" && issue.state === "open") ||
      (state === "closed" && issue.state === "closed"),
  );
  if (valueAfter("--json") === "title") {
    process.stdout.write(
      `${JSON.stringify([
        ...rows.map((issue) => ({ title: issue.title })),
        ...store.openTitles.map((title) => ({ title })),
      ])}\n`,
    );
    process.exit(0);
  }
  if (valueAfter("--label") === LABEL) {
    process.stdout.write(
      `${JSON.stringify(
        rows
          .filter((issue) => issue.labels.includes(LABEL))
          .map((issue) => ({
            number: issue.number,
            title: issue.title,
            url: issue.url,
            state: issue.state,
            createdAt: issue.createdAt,
            body: issue.body,
            labels: issue.labels,
          })),
      )}\n`,
    );
    process.exit(0);
  }
  process.stdout.write(
    `${JSON.stringify(
      rows.map((issue) => ({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        labels: issue.labels,
        url: issue.url,
        createdAt: issue.createdAt,
      })),
    )}\n`,
  );
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "create") {
  const body = await Bun.stdin.text();
  const number = store.nextNumber;
  store.nextNumber += 1;
  const labels: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--label" && args[index + 1] !== undefined) labels.push(args[index + 1]!);
  }
  const issue: StubIssue = {
    number,
    title: valueAfter("--title") ?? "",
    url: `https://github.com/${repository}/issues/${number}`,
    state: "open",
    createdAt: new Date().toISOString(),
    body,
    labels,
  };
  store.issues.push(issue);
  saveStore(store);
  process.stdout.write(`${issue.url}\n`);
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "view") {
  const number = Number(args[2]);
  const issue = store.issues.find((entry) => entry.number === number);
  if (issue === undefined) {
    process.stderr.write("no issue\n");
    process.exit(1);
  }
  process.stdout.write(
    `${JSON.stringify({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels,
      url: issue.url,
      createdAt: issue.createdAt,
    })}\n`,
  );
  process.exit(0);
}
process.stderr.write(`unsupported gh invocation: ${args.join(" ")}\n`);
process.exit(1);
