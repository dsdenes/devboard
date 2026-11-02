#!/usr/bin/env bun
/**
 * The deterministic `gh` for Issues verification. It reads a JSON issue store,
 * serves conditional `--include` responses with an ETag, and never contacts
 * GitHub. Every invocation is appended to the log the verification reads.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
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

// The issues worker writes its `processing` label around a run.
if (args[0] === "label" && args[1] === "create") {
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "edit") {
  const storePath = process.env.ISSUES_STUB_STORE;
  if (storePath === undefined) {
    process.stderr.write("stub gh: no store\n");
    process.exit(1);
  }
  const number = Number(args[2]);
  const add = args.includes("--add-label");
  const remove = args.includes("--remove-label");
  const label = valueAfter(add ? "--add-label" : "--remove-label");
  let issues: Array<Record<string, unknown>> = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(storePath, "utf8"));
    if (Array.isArray(parsed)) issues = parsed as Array<Record<string, unknown>>;
  } catch {
    issues = [];
  }
  for (const entry of issues) {
    if (entry.number !== number) continue;
    const labels = Array.isArray(entry.labels)
      ? (entry.labels as string[]).filter((name) => typeof name === "string")
      : [];
    if (add && label !== undefined && !labels.includes(label)) labels.push(label);
    if (remove) {
      const index = label === undefined ? -1 : labels.indexOf(label);
      if (index >= 0) labels.splice(index, 1);
    }
    entry.labels = labels;
  }
  writeFileSync(storePath, `${JSON.stringify(issues, null, 2)}\n`);
  process.exit(0);
}

if (args[0] !== "api") {
  process.stderr.write("stub gh: only api is supported\n");
  process.exit(2);
}

if (jq === ".permissions.push") {
  process.stdout.write(`${process.env.ISSUES_STUB_PERMISSION ?? "true"}\n`);
  process.exit(0);
}

// The dashboard's startup update check asks for the latest release.
if (endpoint.endsWith("/releases/latest")) {
  process.stdout.write(`${JSON.stringify({ tag_name: "v0.0.0", assets: [] })}\n`);
  process.exit(0);
}

if (!endpoint.includes("/issues")) {
  process.stderr.write("stub gh: unexpected endpoint\n");
  process.exit(1);
}

// The worker proves one issue's state after a run; the stub peer has done
// its work, so the tracker reports the issue closed.
if (jq === ".state" && /\/issues\/[0-9]+$/.test(endpoint)) {
  process.stdout.write("closed\n");
  process.exit(0);
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
