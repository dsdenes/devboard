#!/usr/bin/env bun
/**
 * The deterministic `gh` for Auto Scout verification. It answers the auth
 * probes the forge resolver makes, reports write permission, serves the issue
 * and release reads from one mutable store, and records issue creation. The
 * verification edits the store to close an issue or publish a release. It
 * never contacts GitHub.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

interface StubIssue {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  createdAt: string;
  body: string;
  labels: string[];
}

interface StubRelease {
  tag: string;
  publishedAt: string;
  draft?: boolean;
}

interface StubStore {
  nextNumber: number;
  issues: StubIssue[];
  openTitles: string[];
  releases: StubRelease[];
  closing: Record<string, string>;
  comments: Record<string, string[]>;
  failReads?: boolean;
  /** The diagnostic `failReads` prints; a permanent one is not retried. */
  failMessage?: string;
}

const args = process.argv.slice(2);
const logPath = process.env.SCOUT_STUB_GH_LOG;
const storePath = process.env.SCOUT_STUB_STATE;

if (logPath !== undefined) appendFileSync(logPath, `${JSON.stringify(args)}\n`);

function valueAfter(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function emptyStore(): StubStore {
  return {
    nextNumber: 1,
    issues: [],
    openTitles: [],
    releases: [],
    closing: {},
    comments: {},
  };
}

function loadStore(): StubStore {
  if (storePath === undefined || !existsSync(storePath)) return emptyStore();
  try {
    return { ...emptyStore(), ...(JSON.parse(readFileSync(storePath, "utf8")) as StubStore) };
  } catch {
    return emptyStore();
  }
}

function saveStore(store: StubStore): void {
  if (storePath === undefined) return;
  writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
}

function fail(message: string): never {
  process.stderr.write(`stub gh: ${message}\n`);
  process.exit(1);
}

const jq = valueAfter("--jq");
const endpoint = args.find((argument) => argument.startsWith("repos/")) ?? "";
const store = loadStore();

if (store.failReads === true && args[0] === "issue" && args[1] === "list") {
  fail(store.failMessage ?? "the GitHub read is unavailable");
}
if (store.failReads === true && args[0] === "api" && endpoint.endsWith("/releases")) {
  fail(store.failMessage ?? "the GitHub release read is unavailable");
}

if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(
    `${JSON.stringify({ hosts: { "github.com": [{ login: "acme-bot", active: true, state: "success" }] } })}\n`,
  );
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "token") {
  process.stdout.write("stub-token\n");
  process.exit(0);
}

if (args[0] === "api") {
  if (jq === ".permissions.push") {
    process.stdout.write(`${process.env.SCOUT_STUB_PERMISSION ?? "true"}\n`);
    process.exit(0);
  }
  if (jq === ".permissions") {
    process.stdout.write(`${JSON.stringify({ admin: false, maintain: false, push: true })}\n`);
    process.exit(0);
  }
  if (jq === ".login") {
    process.stdout.write("acme-bot\n");
    process.exit(0);
  }
  // The dashboard's startup update check asks for the latest release.
  if (endpoint.endsWith("/releases/latest")) {
    process.stdout.write(`${JSON.stringify({ tag_name: "v0.0.0", assets: [] })}\n`);
    process.exit(0);
  }
  if (args.includes("--include") && endpoint.includes("/issues")) {
    const etag = `"${process.env.SCOUT_STUB_ETAG ?? "stub-etag"}"`;
    process.stdout.write(`HTTP/2.0 200 OK\netag: ${etag}\n\n`);
    process.exit(0);
  }
  if (endpoint.endsWith("/labels/scout")) {
    process.stderr.write("HTTP 404: Not Found\n");
    process.exit(1);
  }
  if (endpoint.endsWith("/releases")) {
    const published = store.releases.filter((release) => release.draft !== true);
    for (const release of published) {
      process.stdout.write(
        `${JSON.stringify({ tag: release.tag, publishedAt: release.publishedAt, draft: false })}\n`,
      );
    }
    process.exit(0);
  }
  const timeline = /\/issues\/(\d+)\/timeline$/.exec(endpoint);
  if (timeline !== null) {
    const sha = store.closing[timeline[1]!];
    if (sha !== undefined) process.stdout.write(`${sha}\n`);
    process.exit(0);
  }
  const comments = /\/issues\/(\d+)\/comments$/.exec(endpoint);
  if (comments !== null) {
    for (const body of store.comments[comments[1]!] ?? []) {
      process.stdout.write(`${JSON.stringify({ body })}\n`);
    }
    process.exit(0);
  }
  const commit = /\/commits\/([0-9a-fA-F]{7,40})$/.exec(endpoint);
  if (commit !== null) {
    process.stdout.write(`${JSON.stringify({ sha: commit[1]!.padEnd(40, "0") })}\n`);
    process.exit(0);
  }
  if (endpoint.includes("/compare/")) {
    process.stdout.write("behind\n");
    process.exit(0);
  }
  fail(`unexpected api endpoint ${endpoint}`);
}

if (args[0] === "label" && args[1] === "create") {
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "list") {
  const state = valueAfter("--state") ?? "open";
  const scout = store.issues.filter((issue) => issue.labels.includes("scout"));
  if (args.includes("--json") && valueAfter("--json") === "title") {
    const titles = [
      ...scout.filter((issue) => issue.state === "open").map((issue) => issue.title),
      ...store.openTitles,
    ];
    process.stdout.write(`${JSON.stringify(titles.map((title) => ({ title })))}\n`);
    process.exit(0);
  }
  const selected = scout.filter((issue) => state === "all" || issue.state === state);
  process.stdout.write(
    `${JSON.stringify(
      selected.map((issue) => ({
        number: issue.number,
        title: issue.title,
        url: issue.url,
        state: issue.state === "closed" ? "CLOSED" : "OPEN",
        createdAt: issue.createdAt,
        body: issue.body,
        labels: issue.labels,
      })),
    )}\n`,
  );
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "view") {
  const number = Number(args[2]);
  const issue = store.issues.find((entry) => entry.number === number);
  if (issue === undefined) fail(`no issue ${number}`);
  process.stdout.write(
    `${JSON.stringify({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      state: issue.state === "closed" ? "CLOSED" : "OPEN",
      createdAt: issue.createdAt,
      body: issue.body,
      labels: issue.labels,
    })}\n`,
  );
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "create") {
  const bodyPath = valueAfter("--body-file");
  const number = store.nextNumber;
  store.nextNumber += 1;
  const title = valueAfter("--title") ?? "";
  const url = `https://github.com/acme/fixture-scout/issues/${number}`;
  const labels: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--label" && args[index + 1] !== undefined) labels.push(args[index + 1]!);
  }
  const body =
    bodyPath === "-"
      ? await Bun.stdin.text()
      : bodyPath === undefined
        ? ""
        : readFileSync(bodyPath, "utf8");
  store.issues.push({
    number,
    title,
    url,
    state: "open",
    createdAt: new Date().toISOString(),
    body,
    labels: labels.length === 0 ? ["scout"] : labels,
  });
  saveStore(store);
  process.stdout.write(`${url}\n`);
  process.exit(0);
}

fail(`unsupported invocation ${args.join(" ")}`);
