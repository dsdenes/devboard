#!/usr/bin/env bun
/**
 * The deterministic `gh` for Auto Scout verification. It answers the auth
 * probes the forge resolver makes, reports write permission, serves an empty
 * open-issue page with an ETag, reports the `scout` label as missing, records
 * label creation and issue creation, and never contacts GitHub.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const logPath = process.env.SCOUT_STUB_GH_LOG;
if (logPath !== undefined) appendFileSync(logPath, `${JSON.stringify(args)}\n`);

function valueAfter(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function fail(message: string): never {
  process.stderr.write(`stub gh: ${message}\n`);
  process.exit(1);
}

const jq = valueAfter("--jq");
const endpoint = args.find((argument) => argument.startsWith("repos/")) ?? "";

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
  if (args.includes("--include") && endpoint.includes("/issues")) {
    const etag = `"${process.env.SCOUT_STUB_ETAG ?? "stub-etag"}"`;
    process.stdout.write(`HTTP/2.0 200 OK\netag: ${etag}\n\n`);
    process.exit(0);
  }
  if (endpoint.endsWith("/labels/scout")) {
    process.stderr.write("HTTP 404: Not Found\n");
    process.exit(1);
  }
  fail(`unexpected api endpoint ${endpoint}`);
}

if (args[0] === "label" && args[1] === "create") {
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "create") {
  const bodyPath = valueAfter("--body-file");
  const record = {
    repo: valueAfter("--repo") ?? "",
    title: valueAfter("--title") ?? "",
    label: valueAfter("--label") ?? "",
    body: bodyPath === undefined ? "" : readFileSync(bodyPath, "utf8"),
  };
  const store = process.env.SCOUT_STUB_ISSUES;
  const count =
    store === undefined || !existsSync(store)
      ? 1
      : readFileSync(store, "utf8").split("\n").filter((line) => line.trim().length > 0).length + 1;
  if (store !== undefined) {
    appendFileSync(store, `${JSON.stringify(record)}\n`);
  }
  process.stdout.write(`https://github.com/acme/fixture-scout/issues/${count}\n`);
  process.exit(0);
}

fail(`unsupported invocation ${args.join(" ")}`);
