#!/usr/bin/env bun
/**
 * The deterministic `gh` for Issues verification. It reads a JSON issue store,
 * serves conditional `--include` responses with an ETag, and never contacts
 * GitHub. Every invocation is appended to the log the verification reads.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const logPath = process.env.ISSUES_STUB_GH_LOG;
if (logPath !== undefined) appendFileSync(logPath, `${JSON.stringify(args)}\n`);

function valueAfter(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const endpoint = args.find((argument) => argument.startsWith("repos/")) ?? "";
const jq = valueAfter("--jq");

if (args[0] !== "api") {
  process.stderr.write("stub gh: only api is supported\n");
  process.exit(2);
}

if (jq === ".permissions.push") {
  process.stdout.write(`${process.env.ISSUES_STUB_PERMISSION ?? "true"}\n`);
  process.exit(0);
}

if (!endpoint.includes("/issues")) {
  process.stderr.write("stub gh: unexpected endpoint\n");
  process.exit(1);
}

const storePath = process.env.ISSUES_STUB_STORE;
if (storePath === undefined) {
  process.stderr.write("stub gh: no store\n");
  process.exit(1);
}

let issues: unknown[] = [];
try {
  const parsed: unknown = JSON.parse(readFileSync(storePath, "utf8"));
  if (Array.isArray(parsed)) issues = parsed;
} catch {
  issues = [];
}

const body = issues
  .filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry) && entry.pull_request === undefined,
  )
  .map((entry) =>
    JSON.stringify({
      number: entry.number,
      title: entry.title,
      url: entry.html_url,
      createdAt: entry.created_at,
      labels: Array.isArray(entry.labels) ? entry.labels : [],
    }),
  );

const etag = `"${createHash("sha256").update(body.join("\n")).digest("hex").slice(0, 16)}"`;
const condition = valueAfter("-H") ?? "";
const ifNoneMatch = /^If-None-Match:\s*(.+)$/i.exec(condition)?.[1]?.trim();
if (ifNoneMatch === etag) {
  process.stdout.write(`HTTP/2.0 304 Not Modified\netag: ${etag}\n\n`);
  process.exit(0);
}

process.stdout.write(`HTTP/2.0 200 OK\netag: ${etag}\n\n`);
for (const line of body) process.stdout.write(`${line}\n`);
