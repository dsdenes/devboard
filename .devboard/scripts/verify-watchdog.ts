#!/usr/bin/env bun
/**
 * Browser contract for the watchdog: the Issues-mode Watchdog page and the
 * footer indicator. Builds the client, seeds watchdog run directories, a
 * ledger, and a stub `gh`, starts a source dashboard, and drives headless
 * Chrome over the DevTools protocol. It proves the empty states, the removed
 * newest-cycle summary, the cycle history, the filed-issue table with GitHub
 * state and shipped version, the 60-second background refresh, a failed read
 * that keeps the rows, a later release that fills a blank version, freshness
 * without a reload, and the unchanged footer indicator and popover. Before the
 * browser starts it proves the record-based deduplication contract: a filed
 * record reaches the report and ledger without the coordinator filing, a
 * duplicate record files and comments on nothing, an unrecorded candidate
 * stays pending, and a recurrence still comments.
 */

import { spawn } from "node:child_process";
import { chmodSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceEvent } from "../watchdog/collect";
import { runCycle, type CycleOptions } from "../watchdog/coordinator";
import type { Dedup, DedupRequest, DedupRecord } from "../watchdog/dedup";
import type { WatchdogDelivery } from "../watchdog/delivery";
import type { Instance } from "../watchdog/discovery";
import { findingFingerprint } from "../watchdog/findings";
import { loadLedger, saveLedger, type Ledger } from "../watchdog/ledger";
import { saveLedger, type Ledger } from "../watchdog/ledger";
import {
  lockPath as watchdogLockPath,
  versionedWorkerDirectory,
  versionedWorkerStatePath,
} from "../watchdog/paths";
import { readWorkerState } from "../watchdog/worker-state";
import { WatchdogActivity } from "../server/watchdog";
import { agentRegistry } from "../server/agents/registry";
import { readHarnessVersion } from "../server/version";
import { liveLockOwners } from "../issues/lock";
import {
  assertTrue,
  VERIFY_DASHBOARD_AUTHORIZATION,
  dashboardPageUrl,
  freePort,
  harnessRoot,
  makeHost,
  makeRoot,
  run,
  waitFor,
} from "./verification";

const MAX_ISSUES = 10;
const ISSUE_COUNT = 12;
const FIRST_ISSUE = 901;

const chromeCandidates = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
];

function chromePath(): string {
  for (const candidate of chromeCandidates) {
    if (Bun.file(candidate).size > 0) return candidate;
  }
  throw new Error("verify:watchdog: /usr/bin/google-chrome is unavailable");
}

interface CdpReply {
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

class Devtools {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<number, (reply: CdpReply) => void>();

  /** Every uncaught exception and console error the page reported. */
  readonly errors: string[] = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
  }

  async connect(): Promise<void> {
    const opened = Promise.withResolvers<void>();
    this.socket.onopen = () => opened.resolve();
    this.socket.onerror = () => opened.reject(new Error("devtools websocket error"));
    await opened.promise;
    this.socket.onmessage = (event) => {
      let reply: CdpReply;
      try {
        reply = JSON.parse(String(event.data)) as CdpReply;
      } catch {
        return;
      }
      if (typeof reply.id === "number") {
        this.pending.get(reply.id)?.(reply);
        this.pending.delete(reply.id);
        return;
      }
      if (reply.method === "Runtime.exceptionThrown") {
        this.errors.push(JSON.stringify(reply.result ?? {}));
      }
      if (reply.method === "Runtime.consoleAPICalled") {
        const type = (reply.result as { type?: unknown } | undefined)?.type;
        if (type === "error") this.errors.push(JSON.stringify(reply.result ?? {}));
      }
    };
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<CdpReply> {
    const { promise, resolve: settle } = Promise.withResolvers<CdpReply>();
    const id = this.nextId;
    this.nextId += 1;
    this.pending.set(id, settle);
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  async evaluate(expression: string): Promise<unknown> {
    const reply = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (reply.error !== undefined) throw new Error(reply.error.message ?? "evaluation failed");
    const result = reply.result;
    if (result === undefined || !("result" in result)) return undefined;
    const value = result.result;
    return typeof value === "object" && value !== null && "value" in value ? value.value : undefined;
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

async function pageTarget(debugPort: number, dashboardPort: number): Promise<string> {
  return waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
          signal: AbortSignal.timeout(2000),
        });
        const targets = (await response.json()) as Array<{
          type?: string;
          url?: string;
          webSocketDebuggerUrl?: string;
        }>;
        const page = targets.find(
          (target) =>
            target.type === "page" &&
            typeof target.webSocketDebuggerUrl === "string" &&
            target.url?.includes(`:${dashboardPort}/`),
        );
        return page?.webSocketDebuggerUrl;
      } catch {
        return undefined;
      }
    },
    "the Chrome page target",
    30_000,
  );
}

async function click(devtools: Devtools, testid: string): Promise<void> {
  const clicked = await devtools.evaluate(`(() => {
    const element = document.querySelector('[data-testid="${testid}"]');
    if (element === null) return false;
    element.click();
    return true;
  })()`);
  assertTrue(clicked === true, `verify:watchdog: ${testid} is not clickable`);
}

async function text(devtools: Devtools, testid: string): Promise<string> {
  const value = await devtools.evaluate(`(() => {
    const element = document.querySelector('[data-testid="${testid}"]');
    return element === null ? "" : (element.textContent ?? "").replace(/\\s+/g, " ").trim();
  })()`);
  return typeof value === "string" ? value : "";
}

async function present(devtools: Devtools, testid: string): Promise<boolean> {
  return (
    (await devtools.evaluate(
      `document.querySelector('[data-testid="${testid}"]') !== null`,
    )) === true
  );
}

interface RenderedLink {
  href?: string;
  target?: string;
  rel?: string;
}

/** Narrow the browser's link snapshot without trusting its shape. */
function renderedLinks(value: unknown): RenderedLink[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("links" in value) || !Array.isArray(value.links)) return undefined;
  const links: RenderedLink[] = [];
  for (const link of value.links) {
    if (typeof link !== "object" || link === null) continue;
    links.push({
      ...("href" in link && typeof link.href === "string" ? { href: link.href } : {}),
      ...("target" in link && typeof link.target === "string" ? { target: link.target } : {}),
      ...("rel" in link && typeof link.rel === "string" ? { rel: link.rel } : {}),
    });
  }
  return links;
}

interface RenderedIssue {
  url: string;
  state: string;
  version: string;
  title: string;
  href: string;
  category: string;
  filed: string;
  filedText: string;
  stateText: string;
  versionText: string;
}

function renderedIssues(value: unknown): RenderedIssue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues: RenderedIssue[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    issues.push({
      url: String(record.url ?? ""),
      state: String(record.state ?? ""),
      version: String(record.version ?? ""),
      title: String(record.title ?? ""),
      href: String(record.href ?? ""),
      category: String(record.category ?? ""),
      filed: String(record.filed ?? ""),
      filedText: String(record.filedText ?? ""),
      stateText: String(record.stateText ?? ""),
      versionText: String(record.versionText ?? ""),
    });
  }
  return issues;
}

const readIssues = `(() => [...document.querySelectorAll('[data-testid="agent-issue"]')].map((row) => ({
  url: row.dataset.url ?? '',
  state: row.dataset.state ?? '',
  version: row.dataset.version ?? '',
  title: row.querySelector('[data-testid="agent-issue-title"]')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
  href: row.querySelector('[data-testid="agent-issue-title"]')?.getAttribute('href') ?? '',
  category: row.querySelector('[data-testid="agent-issue-category"]')?.textContent?.trim() ?? '',
  filed: row.querySelector('[data-testid="agent-issue-filed"]')?.getAttribute('datetime') ?? '',
  filedText: row.querySelector('[data-testid="agent-issue-filed"]')?.textContent?.trim() ?? '',
  stateText: row.querySelector('[data-testid="agent-issue-state"]')?.textContent?.trim() ?? '',
  versionText: row.querySelector('[data-testid="agent-issue-version"]')?.textContent?.trim() ?? '',
})))()`;

function issueUrl(index: number): string {
  return `https://github.com/dsdenes/devboard/issues/${FIRST_ISSUE + index}`;
}

interface EntryFixture {
  category: string;
  line: string;
  url: string;
  filedAt: string;
  disposition?: string;
}

function ledgerFixture(entries: EntryFixture[], pending: string[]): Ledger {
  return {
    version: 2,
    findings: Object.fromEntries(
      entries.map((entry, index) => [
        `fingerprint-${index}`,
        {
          category: entry.category,
          line: entry.line,
          firstSeen: entry.filedAt,
          lastSeen: entry.filedAt,
          count: 1,
          disposition: entry.disposition ?? `filed:${entry.url}`,
          ...(entry.disposition === "none" ? {} : { url: entry.url }),
          ...(entry.disposition === "none" ? {} : { filedAt: entry.filedAt }),
          instances: [],
        },
      ]),
    ),
    pendingFiling: pending,
  };
}

interface DeliveryCalls {
  creates: string[];
  comments: string[];
}

/**
 * A delivery the cycle can never call for a new issue: the dedup peer files
 * through its MCP tools now, so `create` is recorded only to prove the
 * coordinator stayed out of it. Comments still go through here because a
 * recurrence is the cycle's own action.
 */
function deliveryStub(calls: DeliveryCalls): WatchdogDelivery {
  return {
    repository: "acme/fixture",
    owns: () => true,
    async create(input) {
      calls.creates.push(input.line);
      return { ok: true, url: "https://github.com/acme/fixture/issues/1" };
    },
    async comment(url) {
      calls.comments.push(url);
      return { ok: true };
    },
    async state() {
      return "open";
    },
  };
}

/**
 * A deterministic dedup peer: it appends the records its MCP write tools would
 * append to the run directory the coordinator hands it. `fingerprint: "*"`
 * expands to every candidate in the request.
 */
function recordStub(
  records: DedupRecord[],
  reads = 0,
): { dedup: Dedup; calls: DedupRequest[] } {
  const calls: DedupRequest[] = [];
  const dedup: Dedup = async (request, runDir) => {
    calls.push(request);
    const expanded = records.flatMap((record) =>
      record.fingerprint === "*"
        ? request.candidates.map((candidate) => ({
            ...record,
            fingerprint: candidate.fingerprint,
          }))
        : [record],
    );
    await mkdir(runDir, { recursive: true });
    if (expanded.length > 0) {
      await writeFile(
        join(runDir, "dedup-records.jsonl"),
        `${expanded.map((record) => JSON.stringify(record)).join("\n")}\n`,
      );
    }
    await writeFile(join(runDir, "dedup-reads.jsonl"), `${JSON.stringify({ count: reads })}\n`);
    return "";
  };
  return { dedup, calls };
}

const DEDUP_NOW = new Date("2026-10-24T12:00:00.000Z");
const DEDUP_LINE = "Synthetic error: the dedup contract check";
const DEDUP_ISSUE = "https://github.com/acme/fixture/issues/501";

/**
 * The record-based dedup contract, without a model: the peer files and records
 * through its own tools, and the cycle reads only those records. Proves a
 * unique candidate is filed through its record and reaches the report and the
 * ledger without the coordinator calling delivery, a duplicate is recorded
 * silently, an unrecorded candidate stays pending, and a recurrence still
 * comments.
 */
async function verifyDedupContract(root: string): Promise<void> {
  const cycleRoot = join(root, "dedup-cycle");
  const harness = join(cycleRoot, ".devboard");
  await mkdir(join(harness, ".tmp", "journal"), { recursive: true });
  const instance: Instance = {
    pid: 4999,
    port: 9393,
    repoDir: cycleRoot,
    host: "127.0.0.1",
    harness,
    stateDir: join(harness, ".tmp"),
    journal: join(harness, ".tmp", "journal", "fixture.jsonl"),
    instrumented: true,
  };
  const fingerprint = findingFingerprint("server-error", DEDUP_LINE);
  const event = (now: Date): EvidenceEvent => ({
    source: instance.journal,
    kind: "server-error",
    ts: new Date(now.getTime() - 60_000).toISOString(),
    text: DEDUP_LINE,
    instance,
  });
  const cycleFor = (
    name: string,
    now: Date,
    dedup: Dedup,
    delivery: WatchdogDelivery,
  ): CycleOptions => ({
    root: cycleRoot,
    now,
    stateDir: join(harness, ".tmp", "watchdog", name),
    settings: { intervalMinutes: 10, maxPerHour: null, maxPending: null },
    deps: {
      discover: () => [instance],
      collect: () => ({ events: [event(now)], malformed: 0, unattributed: 0 }),
      gh: () => ({ code: 0, stdout: "", stderr: "" }),
      dedup,
      delivery,
    },
  });
  const record = (fields: Partial<DedupRecord>): DedupRecord => ({
    fingerprint,
    action: "filed",
    ...fields,
  });

  // 1. A filed record becomes the report's issue and the ledger's filing; the
  //    coordinator never creates an issue itself.
  const filedCalls: DeliveryCalls = { creates: [], comments: [] };
  const filed = recordStub(
    [record({ url: DEDUP_ISSUE, number: 501, title: "[watchdog] server-error" })],
    2,
  );
  const filedCycle = await runCycle(
    cycleFor("filed", DEDUP_NOW, filed.dedup, deliveryStub(filedCalls)),
  );
  assertTrue(
    filed.calls.length === 1 && filed.calls[0]?.candidates.length === 1,
    "verify:watchdog: dedup sent no single request over the candidate set",
  );
  assertTrue(
    filed.calls[0]?.candidates[0]?.fingerprint === fingerprint,
    "verify:watchdog: dedup request carries the wrong candidate",
  );
  assertTrue(
    filedCycle.report.issues.length === 1 &&
      filedCycle.report.issues[0]?.url === DEDUP_ISSUE &&
      filedCycle.report.issues[0]?.fingerprint === fingerprint,
    `verify:watchdog: a filed record did not reach report.issues: ${JSON.stringify(filedCycle.report.issues)}`,
  );
  assertTrue(
    filedCycle.report.action === "filed",
    `verify:watchdog: a filed record reports action ${filedCycle.report.action}`,
  );
  assertTrue(
    filedCycle.report.deduplication.openIssuesRead === 2,
    `verify:watchdog: the dedup read count is ${filedCycle.report.deduplication.openIssuesRead}`,
  );
  const filedLedger = loadLedger(join(harness, ".tmp", "watchdog", "filed"));
  assertTrue(
    filedLedger.findings[fingerprint]?.disposition === `filed:${DEDUP_ISSUE}` &&
      filedLedger.pendingFiling.length === 0,
    `verify:watchdog: a filed record left the ledger as ${JSON.stringify(filedLedger.findings[fingerprint])}`,
  );
  assertTrue(
    filedCalls.creates.length === 0 && filedCalls.comments.length === 0,
    `verify:watchdog: the coordinator filed through delivery: ${JSON.stringify(filedCalls)}`,
  );
  console.log("PASS dedup-record-filed");

  // 2. A duplicate record files and comments on nothing.
  const duplicateCalls: DeliveryCalls = { creates: [], comments: [] };
  const duplicate = recordStub([record({ action: "duplicate", issue: DEDUP_ISSUE })], 1);
  const duplicateCycle = await runCycle(
    cycleFor("duplicate", DEDUP_NOW, duplicate.dedup, deliveryStub(duplicateCalls)),
  );
  assertTrue(
    duplicateCycle.report.issues.length === 0 &&
      duplicateCalls.creates.length === 0 &&
      duplicateCalls.comments.length === 0,
    `verify:watchdog: a duplicate record filed or commented: ${JSON.stringify(duplicateCalls)}`,
  );
  const duplicateDecision = duplicateCycle.report.deduplication.decisions[0];
  assertTrue(
    duplicateDecision?.decision === "duplicate" && duplicateDecision.issue === DEDUP_ISSUE,
    `verify:watchdog: a duplicate record is not in the report: ${JSON.stringify(duplicateDecision)}`,
  );
  const duplicateLedger = loadLedger(join(harness, ".tmp", "watchdog", "duplicate"));
  assertTrue(
    duplicateLedger.findings[fingerprint]?.disposition === `duplicate:${DEDUP_ISSUE}` &&
      duplicateLedger.findings[fingerprint]?.url === undefined &&
      duplicateLedger.pendingFiling.length === 0,
    `verify:watchdog: a duplicate record left the ledger as ${JSON.stringify(duplicateLedger.findings[fingerprint])}`,
  );
  console.log("PASS dedup-record-duplicate");

  // 3. A candidate the peer recorded nothing about stays pending, files
  //    nothing, and is reported as undecided.
  const missingCalls: DeliveryCalls = { creates: [], comments: [] };
  const missing = recordStub([], 1);
  const missingCycle = await runCycle(
    cycleFor("missing", DEDUP_NOW, missing.dedup, deliveryStub(missingCalls)),
  );
  assertTrue(
    missingCycle.report.issues.length === 0 && missingCalls.creates.length === 0,
    `verify:watchdog: an unrecorded candidate filed an issue: ${JSON.stringify(missingCalls)}`,
  );
  const missingLedger = loadLedger(join(harness, ".tmp", "watchdog", "missing"));
  assertTrue(
    missingLedger.pendingFiling.includes(fingerprint) &&
      missingLedger.findings[fingerprint]?.disposition === "none",
    `verify:watchdog: an unrecorded candidate is not pending: ${JSON.stringify(missingLedger)}`,
  );
  assertTrue(
    missingCycle.report.deduplication.decisions[0]?.decision === "failed",
    `verify:watchdog: an unrecorded candidate is not reported undecided: ${JSON.stringify(missingCycle.report.deduplication.decisions)}`,
  );
  console.log("PASS dedup-record-missing");

  // 4. A recurrence keeps commenting on the filed issue without re-filing and
  //    without asking the dedup peer again.
  const recurrenceState = join(harness, ".tmp", "watchdog", "recurrence");
  const filedAt = new Date(DEDUP_NOW.getTime() - 25 * 60 * 60_000).toISOString();
  saveLedger(recurrenceState, {
    version: 2,
    findings: {
      [fingerprint]: {
        category: "server-error",
        line: DEDUP_LINE,
        firstSeen: filedAt,
        lastSeen: filedAt,
        count: 1,
        disposition: `filed:${DEDUP_ISSUE}`,
        url: DEDUP_ISSUE,
        filedAt,
        instances: [],
      },
    },
    pendingFiling: [],
  });
  const recurrenceCalls: DeliveryCalls = { creates: [], comments: [] };
  const recurrence = recordStub([], 0);
  const recurrenceCycle = await runCycle(
    cycleFor("recurrence", DEDUP_NOW, recurrence.dedup, deliveryStub(recurrenceCalls)),
  );
  assertTrue(
    recurrence.calls.length === 0,
    "verify:watchdog: a filed recurrence asked the dedup peer again",
  );
  assertTrue(
    recurrenceCycle.report.action === "commented" &&
      recurrenceCalls.comments.length === 1 &&
      recurrenceCalls.comments[0] === DEDUP_ISSUE &&
      recurrenceCalls.creates.length === 0,
    `verify:watchdog: a recurrence did not comment: ${JSON.stringify(recurrenceCycle.report.action)} ${JSON.stringify(recurrenceCalls)}`,
  );
  assertTrue(
    loadLedger(recurrenceState).findings[fingerprint]?.lastCommentAt === DEDUP_NOW.toISOString(),
    "verify:watchdog: a recurrence comment was not recorded in the ledger",
  );
  console.log("PASS dedup-recurrence-comment");
  console.log("PASS dedup-contract");
}

const GH_STUB = `#!/bin/sh
set -u
fixtures="$(cd "$(dirname "$0")/.." && pwd)/gh"
args="$*"
# The fail marker simulates an expired credential for the tracker reads the
# watchdog page makes. The dashboard's update check shares this stub, so keep
# answering its latest-release read or the fixture journals an update-error.
if [ -f "$fixtures/fail" ]; then
  case "$args" in
    *"repos/dsdenes/devboard/releases/latest"*) ;;
    *) echo "HTTP 401: Bad credentials" >&2; exit 1 ;;
  esac
fi
case "$args" in
  *"repos/acme/fixture --jq .permissions.push"*) echo true ;;
  *"repos/dsdenes/devboard/issues/901 --jq [.state, .created_at, .closed_at] | @tsv"*)
    printf 'open\\t2026-10-24T12:00:00Z\\t\\n' ;;
  *"repos/dsdenes/devboard/issues/902 --jq [.state, .created_at, .closed_at] | @tsv"*)
    printf 'closed\\t2026-10-24T11:00:00Z\\t2026-10-25T11:00:00Z\\n' ;;
  *"repos/dsdenes/devboard/issues/903 --jq [.state, .created_at, .closed_at] | @tsv"*)
    printf 'closed\\t2026-10-24T10:00:00Z\\t2026-10-26T10:00:00Z\\n' ;;
  *"repos/dsdenes/devboard/issues/904 --jq [.state, .created_at, .closed_at] | @tsv"*)
    printf 'open\\t2026-10-24T09:00:00Z\\t\\n' ;;
  *"/issues/"*"--jq [.state, .created_at, .closed_at] | @tsv"*)
    printf 'open\\t2026-10-24T10:00:00Z\\t\\n' ;;
  *"repos/dsdenes/devboard/issues/901 --jq .state"*) echo open ;;
  *"repos/dsdenes/devboard/issues/902 --jq .state"*) echo closed ;;
  *"repos/dsdenes/devboard/issues/903 --jq .state"*) echo closed ;;
  *"repos/dsdenes/devboard/issues/904 --jq .state"*) echo open ;;
  *"/issues/"*"--jq .state"*) echo open ;;
  *"repos/dsdenes/devboard/issues/901/timeline"*) : ;;
  *"repos/dsdenes/devboard/issues/902/timeline"*) echo 1111111 ;;
  *"repos/dsdenes/devboard/issues/903/timeline"*) : ;;
  *"repos/dsdenes/devboard/issues/901/comments"*) : ;;
  *"repos/dsdenes/devboard/issues/902/comments"*) : ;;
  *"repos/dsdenes/devboard/issues/903/comments"*) printf '%s\\n' '{"body":"fixed by 2222222"}' ;;
  *"repos/dsdenes/devboard/commits/1111111 --jq .sha"*) echo 1111111111111111111111111111111111111111 ;;
  *"repos/dsdenes/devboard/commits/2222222 --jq .sha"*) echo 2222222222222222222222222222222222222222 ;;
  *"repos/dsdenes/devboard/releases/latest"*) cat "$fixtures/release.json" ;;
  *"repos/dsdenes/devboard/releases"*) cat "$fixtures/releases.jsonl" ;;
  *"compare/1111111111111111111111111111111111111111...v1.0.0"*) echo ahead ;;
  *"compare/2222222222222222222222222222222222222222...v1.2.0"*) echo ahead ;;
  *"compare/"*) echo behind ;;
  *) echo "unexpected gh arguments: $args" >&2; exit 1 ;;
esac
`;

const root = await makeRoot("verify-watchdog");
let dashboardPid = 0;
let chromePid = 0;

try {
  const build = run(process.execPath, ["run", "build"], { cwd: harnessRoot });
  assertTrue(build.code === 0, `verify:watchdog: bun run build failed: ${build.stderr}`);
  assertTrue(
    Bun.file(join(harnessRoot, "dist", "index.html")).size > 0,
    "verify:watchdog: the build produced dist/index.html",
  );

  const host = await makeHost(root, "host");
  run("git", ["-C", host.directory, "remote", "add", "origin", "https://github.com/acme/fixture.git"]);
  await verifyDedupContract(root);
  const stateDir = join(root, "state");
  const watchdogDir = join(host.directory, ".devboard", ".tmp", "watchdog");
  await mkdir(watchdogDir, { recursive: true });
  const binDir = join(root, "bin");
  const ghFixtures = join(root, "gh");
  await mkdir(binDir, { recursive: true });
  await mkdir(ghFixtures, { recursive: true });
  const ghPath = join(binDir, "gh");
  await writeFile(ghPath, GH_STUB);
  chmodSync(ghPath, 0o755);
  const systemctlPath = join(binDir, "systemctl");
  await writeFile(
    systemctlPath,
    `#!/bin/sh
case "$2" in
  is-active) echo inactive ;;
  is-enabled) echo disabled ;;
esac
exit 0
`,
  );
  chmodSync(systemctlPath, 0o755);
  await writeFile(
    join(ghFixtures, "releases.jsonl"),
    '{"tag":"v1.0.0","publishedAt":"2026-10-20T00:00:00Z","draft":false}\n' +
      '{"tag":"v1.1.0","publishedAt":"2026-10-21T00:00:00Z","draft":false}\n',
  );
  // The update check reads the newest release as one object, not the listing.
  await writeFile(
    join(ghFixtures, "release.json"),
    '{"tag_name":"v1.1.0","assets":[]}\n',
  );

  const port = await freePort();
  const dashboard = spawn(process.execPath, [join(harnessRoot, "server", "index.ts")], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOST: "127.0.0.1",
      PORT: String(port),
      REPO_DIR: host.directory,
      ADRS_DIR: join(host.directory, "adrs"),
      GOAL_FILE: join(host.directory, "GOAL.md"),
      STATIC_DIR: join(harnessRoot, "dist"),
      STATE_DIR: stateDir,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  dashboardPid = dashboard.pid ?? 0;

  await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/ready`, {
          ...VERIFY_DASHBOARD_AUTHORIZATION,
          signal: AbortSignal.timeout(2000),
        });
        return response.ok ? true : undefined;
      } catch {
        return undefined;
      }
    },
    "the seeded dashboard",
    30_000,
  );

  const debugPort = await freePort();
  const profile = join(root, "chrome-profile");
  await mkdir(profile, { recursive: true });
  const chrome = spawn(
    chromePath(),
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1440,900",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      dashboardPageUrl(port),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  chromePid = chrome.pid ?? 0;

  const devtools = new Devtools(await pageTarget(debugPort, port));
  await devtools.connect();
  try {
    await devtools.send("Runtime.enable");
    await devtools.send("Page.enable");
    await devtools.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    /* ---------------------------------------------------------------- */
    /* 1. The sidebar entry and an empty page                            */
    /* ---------------------------------------------------------------- */
    await waitFor(
      async () => ((await present(devtools, "mode-devboard")) ? true : undefined),
      "the Devboard mode control",
      30_000,
    );
    await click(devtools, "mode-devboard");
    await waitFor(
      async () => ((await present(devtools, "open-devboard-watchdog")) ? true : undefined),
      "the Watchdog sidebar entry",
      15_000,
    );
    const entry = await devtools.evaluate(`(() => {
      const button = document.querySelector('[data-testid="open-devboard-watchdog"]');
      if (button === null) return null;
      const previous = button.previousElementSibling;
      return {
        command: button.dataset.command ?? '',
        label: button.querySelector('.sidebar-item__label')?.textContent?.trim() ?? '',
        previous: previous?.getAttribute('data-testid') ?? '',
      };
    })()`);
    const entryRecord = entry as Record<string, unknown> | null;
    assertTrue(
      entryRecord?.command === "open.devboard.watchdog",
      `the Watchdog entry has no command: ${JSON.stringify(entryRecord)}`,
    );
    assertTrue(
      entryRecord?.label === "Watchdog",
      `the Watchdog entry label is ${String(entryRecord?.label)}`,
    );
    assertTrue(
      entryRecord?.previous === "open-devboard-scout",
      `the Watchdog entry does not follow Auto Scout: ${String(entryRecord?.previous)}`,
    );
    console.log("PASS open-devboard-watchdog");

    await click(devtools, "open-devboard-watchdog");
    await waitFor(
      async () => ((await present(devtools, "agent-page")) ? true : undefined),
      "the Watchdog page",
      10_000,
    );
    assertTrue(
      (await devtools.evaluate(
        `document.querySelector('[data-testid="agent-header"] h1')?.textContent?.trim() ?? ''`,
      )) === "Watchdog",
      "the page title is Watchdog",
    );
    assertTrue(
      !(await devtools.evaluate(
        `document.querySelector('[data-testid="agent-header"] .page-header__eyebrow') !== null`,
      )),
      "the Watchdog header still carries its Issues eyebrow",
    );
    assertTrue(await present(devtools, "agent-issues-empty"), "no issue renders no empty state");
    const current = await devtools.evaluate(
      `document.querySelector('[data-testid="open-devboard-watchdog"]')?.getAttribute('aria-current') ?? ''`,
    );
    assertTrue(current === "true", "the Watchdog entry is not the active tab");
    console.log("PASS agent-page-empty");

    /* ---------------------------------------------------------------- */
    /* 2. Seed the local facts while the page is open                    */
    /* ---------------------------------------------------------------- */
    // The dashboard-started worker wrote its own first cycle; the seeded
    // history is the one this page must render.
    await rm(join(watchdogDir, "runs"), { recursive: true, force: true });
    const cycleTimes = ["2026-10-24T10:00:00.000Z", "2026-10-24T11:00:00.000Z", "2026-10-24T12:00:00.000Z"];
    const reports = [
      { cycle: cycleTimes[0], action: "failed", findings: 2, reason: "gh unavailable" },
      { cycle: cycleTimes[1], action: "duplicate", findings: 0 },
      { cycle: cycleTimes[2], action: "filed", findings: 1, reason: "filed 1 issue(s)" },
    ];
    for (const report of reports) {
      const name = report.cycle.replace(/[:.]/g, "-");
      await mkdir(join(watchdogDir, "runs", name), { recursive: true });
      await writeFile(
        join(watchdogDir, "runs", name, "report.json"),
        JSON.stringify({
          ...report,
          window: { start: report.cycle, end: report.cycle, minutes: 10 },
          instances: [],
          findings: Array.from({ length: report.findings }, (_unused, index) => ({
            fingerprint: `fingerprint-${index}`,
          })),
          issues: [],
          pending: 0,
          malformed: 0,
          unattributed: 0,
        }),
      );
    }
    const broken = "2026-10-24T13-00-00-000Z";
    await mkdir(join(watchdogDir, "runs", broken), { recursive: true });
    await writeFile(join(watchdogDir, "runs", broken, "report.json"), "{not json");

    const latest = {
      cycle: "2026-10-24T12:00:00.000Z",
      window: { start: "2026-10-24T11:50:00.000Z", end: "2026-10-24T12:00:00.000Z", minutes: 10 },
      instances: [],
      findings: [{ fingerprint: "1" }, { fingerprint: "2" }],
      action: "filed",
      issues: [],
      pending: 0,
      reason: "filed 2 issue(s)",
      malformed: 0,
      unattributed: 0,
    };
    await writeFile(join(watchdogDir, "latest.json"), JSON.stringify(latest));

    const entries: EntryFixture[] = [
      { category: "server-error", line: "Synthetic error A", url: issueUrl(0), filedAt: "2026-10-24T12:00:00.000Z" },
      { category: "stall", line: "lane-1 implementing", url: issueUrl(1), filedAt: "2026-10-24T11:00:00.000Z" },
      { category: "update-error", line: "release check failed", url: issueUrl(2), filedAt: "2026-10-24T10:00:00.000Z" },
      { category: "omp-warn", line: "slow response", url: issueUrl(3), filedAt: "2026-10-24T09:00:00.000Z", disposition: "none" },
    ];
    saveLedger(watchdogDir, ledgerFixture(entries, ["fingerprint-3"]));

    const localIssues = await waitFor(
      async () => {
        const value = renderedIssues(await devtools.evaluate(readIssues).catch(() => undefined));
        return value !== undefined && value.length === 3 ? value : undefined;
      },
      "the filed issues from the ledger",
      20_000,
    );
    assertTrue(
      JSON.stringify(localIssues.map((issue) => issue.url)) ===
        JSON.stringify([issueUrl(0), issueUrl(1), issueUrl(2)]),
      `the table is not newest first: ${JSON.stringify(localIssues.map((issue) => issue.url))}`,
    );
    console.log("PASS watchdog-fresh-ledger");

    /* ---------------------------------------------------------------- */
    /* 3. GitHub states and shipped versions arrive on a later request   */
    /* ---------------------------------------------------------------- */
    const projected = await waitFor(
      async () => {
        const value = renderedIssues(await devtools.evaluate(readIssues).catch(() => undefined));
        if (value === undefined || value.length !== 3) return undefined;
        const states = value.map((issue) => `${issue.url}:${issue.state}:${issue.version}`);
        return states[0] === `${issueUrl(0)}:pending:` &&
          states[1] === `${issueUrl(1)}:implemented:v1.0.0` &&
          states[2] === `${issueUrl(2)}:implemented:`
          ? value
          : undefined;
      },
      "the GitHub projection",
      90_000,
    );
    assertTrue(
      projected[0]?.title === "[watchdog] server-error: Synthetic error A",
      `an issue title is wrong: ${String(projected[0]?.title)}`,
    );
    assertTrue(
      projected[0]?.href === issueUrl(0) &&
        projected.every((issue) => issue.category.length > 0),
      "an issue row is missing its URL or category",
    );
    assertTrue(
      projected[1]?.filed === "2026-10-24T11:00:00.000Z" &&
        (projected[1]?.filedText ?? "").length > 0,
      "an issue row is missing its filed time",
    );
    assertTrue(
      projected[0]?.stateText === "pending" && projected[1]?.stateText === "implemented",
      "an issue row renders the wrong state",
    );
    assertTrue(
      projected[1]?.versionText === "v1.0.0" && projected[2]?.versionText === "—",
      "an issue row renders the wrong shipped version",
    );
    assertTrue(
      (await text(devtools, "agent-sync-at")) !== "never",
      "a successful read leaves the last-success time at never",
    );
    console.log("PASS agent-issues");

    /* ---------------------------------------------------------------- */
    /* 4. A failed read keeps the rows and reports its reason            */
    /* ---------------------------------------------------------------- */
    await writeFile(join(ghFixtures, "fail"), "");
    // The marker fakes an expired credential for tracker reads. The update
    // check shares the same gh, so prove its release read still succeeds:
    // otherwise the fixture itself journals an update-error the watchdog files.
    const failEnv = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };
    const releaseWhileFailing = run(
      join(binDir, "gh"),
      ["api", "repos/dsdenes/devboard/releases/latest"],
      { env: failEnv },
    );
    assertTrue(
      releaseWhileFailing.code === 0 && releaseWhileFailing.stdout.includes('"tag_name"'),
      `the fail fixture broke the update release check: ${releaseWhileFailing.stderr}`,
    );
    const trackerWhileFailing = run(
      join(binDir, "gh"),
      ["api", "repos/dsdenes/devboard/issues/901"],
      { env: failEnv },
    );
    assertTrue(
      trackerWhileFailing.code !== 0 && trackerWhileFailing.stderr.includes("Bad credentials"),
      "the fail fixture no longer fails tracker reads",
    );
    await waitFor(
      async () => {
        const value = await text(devtools, "agent-sync-error").catch(() => "");
        return value.includes("Bad credentials") ? value : undefined;
      },
      "the sync error reason",
      90_000,
    );
    const afterFailure = renderedIssues(await devtools.evaluate(readIssues));
    assertTrue(
      afterFailure !== undefined && afterFailure.length === 3,
      "a failed read hid the filed issues",
    );
    assertTrue(
      afterFailure[1]?.version === "v1.0.0" && afterFailure[1]?.state === "implemented",
      "a failed read dropped a last known state or version",
    );
    console.log("PASS agent-sync-error");

    /* ---------------------------------------------------------------- */
    /* 5. Recovery and a release published later fill a blank version    */
    /* ---------------------------------------------------------------- */
    await rm(join(ghFixtures, "fail"), { force: true });
    await writeFile(
      join(ghFixtures, "releases.jsonl"),
      '{"tag":"v1.0.0","publishedAt":"2026-10-20T00:00:00Z","draft":false}\n' +
        '{"tag":"v1.1.0","publishedAt":"2026-10-21T00:00:00Z","draft":false}\n' +
        '{"tag":"v1.2.0","publishedAt":"2026-10-28T00:00:00Z","draft":false}\n',
    );
    const recovered = await waitFor(
      async () => {
        const value = renderedIssues(await devtools.evaluate(readIssues).catch(() => undefined));
        if (value?.[2]?.version !== "v1.2.0") return undefined;
        const failing = await devtools
          .evaluate(`document.querySelector('[data-testid="agent-sync-error"]') !== null`)
          .catch(() => true);
        return failing === false ? value : undefined;
      },
      "the recovered GitHub projection",
      90_000,
    );
    assertTrue(
      recovered[1]?.version === "v1.0.0",
      "the earliest release changed after a later one was published",
    );
    console.log("PASS agent-sync-recovered");

    /* ---------------------------------------------------------------- */
    /* 6. A new run directory and a new ledger entry appear without a reload */
    /* ---------------------------------------------------------------- */
    const newestCycle = "2026-10-24T14:00:00.000Z";
    const newestName = newestCycle.replace(/[:.]/g, "-");
    await mkdir(join(watchdogDir, "runs", newestName), { recursive: true });
    await writeFile(
      join(watchdogDir, "runs", newestName, "report.json"),
      JSON.stringify({
        cycle: newestCycle,
        window: { start: newestCycle, end: newestCycle, minutes: 10 },
        instances: [],
        findings: [{ fingerprint: "9" }],
        action: "filed",
        issues: [],
        pending: 0,
        reason: "filed 1 issue(s)",
        malformed: 0,
        unattributed: 0,
      }),
    );
    await writeFile(
      join(watchdogDir, "latest.json"),
      JSON.stringify({
        ...latest,
        cycle: newestCycle,
        window: { start: newestCycle, end: newestCycle, minutes: 10 },
        findings: [{ fingerprint: "9" }, { fingerprint: "10" }, { fingerprint: "11" }],
        reason: "filed 3 issue(s)",
      }),
    );
    entries.push({
      category: "server-error",
      line: "Synthetic error B",
      url: issueUrl(3),
      filedAt: "2026-10-24T13:00:00.000Z",
    });
    saveLedger(watchdogDir, ledgerFixture(entries, []));

    const fresh = await waitFor(
      async () => {
        const issues = renderedIssues(await devtools.evaluate(readIssues).catch(() => undefined));
        return issues?.length === 4 ? issues : undefined;
      },
      "the new run directory and ledger entry",
      20_000,
    );
    assertTrue(
      fresh[0]?.url === issueUrl(3),
      "a newly filed ledger entry did not become the newest row",
    );
    assertTrue(
      (await text(devtools, "agent-issues-count")).startsWith("4 filed"),
      "the filed-issue count did not refresh without a reload",
    );
    console.log("PASS watchdog-freshness");

    /* ---------------------------------------------------------------- */
    /* 7. The footer indicator and popover are unchanged                 */
    /* ---------------------------------------------------------------- */
    saveLedger(
      watchdogDir,
      ledgerFixture(
        Array.from({ length: ISSUE_COUNT }, (_unused, index) => ({
          category: index % 2 === 0 ? "server-error" : "update-error",
          line: `fixture finding ${index}`,
          url: issueUrl(index),
          filedAt: new Date(Date.parse("2026-10-24T12:00:00.000Z") - index * 60_000).toISOString(),
        })),
        [],
      ),
    );
    await click(devtools, "status-watchdog");
    const links = await waitFor(
      async () => {
        const value = await devtools
          .evaluate(`(() => {
            const element = document.querySelector('[data-testid="watchdog-popover"]');
            if (element === null) return null;
            return {
              links: [...element.querySelectorAll('a')].map((anchor) => ({
                href: anchor.getAttribute('href'),
                target: anchor.getAttribute('target'),
                rel: anchor.getAttribute('rel'),
              })),
            };
          })()`)
          .catch(() => undefined);
        const links = renderedLinks(value);
        return links !== undefined && links.length === MAX_ISSUES ? links : undefined;
      },
      "the watchdog popover to refresh with the seeded issues",
      15_000,
    );
    console.log("PASS watchdog-popover");

    const indicatorText = await text(devtools, "status-watchdog");
    assertTrue(indicatorText.includes("filed"), `the indicator names the last action: ${indicatorText}`);
    assertTrue(
      /(just now|\d+m ago|\d+h ago|\d+d ago)/.test(indicatorText),
      `the indicator shows the age: ${indicatorText}`,
    );
    assertTrue(
      links.length === MAX_ISSUES,
      `the popover lists at most ten issues: found ${links.length}`,
    );
    for (const link of links) {
      assertTrue(link.target === "_blank", `an issue link opens a new tab: ${JSON.stringify(link)}`);
      assertTrue(
        link.rel?.includes("noopener") === true && link.rel?.includes("noreferrer") === true,
        `an issue link is rel="noopener noreferrer": ${JSON.stringify(link)}`,
      );
      assertTrue(
        link.href?.startsWith("https://github.com/dsdenes/devboard/issues/") === true,
        `an issue link is a filed URL: ${String(link.href)}`,
      );
    }
    assertTrue(
      links[0]?.href === issueUrl(0),
      `the newest issue comes first: ${String(links[0]?.href)}`,
    );
    console.log("PASS issue-links");

    await devtools.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
    await devtools.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
    await waitFor(
      async () =>
        (await devtools
          .evaluate(
            `document.querySelector('[data-testid="watchdog-popover"]') === null ? true : undefined`,
          )
          .catch(() => undefined)) === true
          ? true
          : undefined,
      "the popover to close on Escape",
      10_000,
    );
    console.log("PASS escape-closes");

    assertTrue(
      devtools.errors.length === 0,
      `the page logged no uncaught console error: ${devtools.errors.join("\n")}`,
    );
    console.log("PASS no-console-error");
  } finally {
    devtools.close();
  }

  /* ---------------------------------------------------------------- */
  /* The live worker family: takeover, merged view, whole-family Stop   */
  /* ---------------------------------------------------------------- */
  const oldVersion = "0.1.900";
  const newestVersion = readHarnessVersion(harnessRoot) ?? "unknown";
  const workerEnvironment: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    REPO_DIR: host.directory,
    STATE_DIR: stateDir,
  };
  const oldWorker = spawn(
    process.execPath,
    [
      join(harnessRoot, "watchdog", "worker.ts"),
      "--root",
      host.directory,
      "--state-dir",
      watchdogDir,
      "--owner-state-dir",
      stateDir,
    ],
    {
      cwd: host.directory,
      env: { ...workerEnvironment, DEVBOARD_HARNESS_VERSION: oldVersion },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  const bridge = new WatchdogActivity({
    descriptor: agentRegistry.require("watchdog"),
    repoDir: host.directory,
    stateDir,
    watchdogDir,
    harnessDir: harnessRoot,
    runningVersion: newestVersion,
    send: () => undefined,
    log: (line) => console.error(line),
    environment: workerEnvironment,
    preflight: async () => ({ ok: true }),
    intervalMs: 100,
  });
  try {
    await waitFor(
      () =>
        liveLockOwners(watchdogLockPath(watchdogDir)).some(
          (owner) => owner.harnessVersion === oldVersion,
        )
          ? true
          : undefined,
      "the old Watchdog worker's lock",
      20_000,
      50,
    );
    console.log(`verify:watchdog: takeover: the live ${oldVersion} worker holds the family`);
    bridge.begin();
    const merged = await waitFor(
      () => {
        const snapshot = bridge.snapshot();
        const workers = snapshot.workers ?? [];
        return workers.length >= 2 ? workers : undefined;
      },
      "the merged Watchdog worker view",
      30_000,
      50,
    );
    const versions = merged.map((worker) => worker.version).sort();
    assertTrue(
      versions.includes(oldVersion),
      `verify:watchdog: the merged view lost the old worker: ${JSON.stringify(versions)}`,
    );
    assertTrue(
      versions.includes(newestVersion),
      `verify:watchdog: the newer worker did not become live: ${JSON.stringify(versions)}`,
    );
    assertTrue(
      !JSON.stringify({ workers: merged, notice: bridge.snapshot().notice }).includes(
        "this dashboard loaded",
      ),
      "verify:watchdog: the merged view carries a version divergence notice",
    );
    console.log(
      `verify:watchdog: takeover: old ${oldVersion} and new ${newestVersion} are both live with no divergence notice`,
    );
    bridge.stop();
    await waitFor(
      () =>
        liveLockOwners(watchdogLockPath(watchdogDir)).length === 0 ? true : undefined,
      "every Watchdog worker to exit after the family Stop",
      30_000,
      100,
    );
    const retired = readWorkerState(versionedWorkerDirectory(watchdogDir, oldVersion));
    assertTrue(
      readWorkerState(versionedWorkerDirectory(watchdogDir, oldVersion)) !== undefined,
      `verify:watchdog: the retired worker's state was removed: ${versionedWorkerStatePath(
        watchdogDir,
        oldVersion,
      )}`,
    );
    assertTrue(
      retired?.lifecycle === "stopped" || retired?.lifecycle === "failed",
      `verify:watchdog: the retired worker did not publish its stop: ${JSON.stringify(retired)}`,
    );
    console.log(
      "verify:watchdog: takeover: the whole-family Stop ended both workers and the retired state remains readable",
    );
  } finally {
    bridge.dispose();
    if (oldWorker.pid !== undefined) {
      try {
        process.kill(oldWorker.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }

  console.log("verify:watchdog: page, history, issues, sync, refresh, indicator, and popover passed");
} finally {
  if (chromePid > 0) {
    try {
      process.kill(chromePid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  if (dashboardPid > 0) {
    try {
      process.kill(dashboardPid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  await rm(root, { recursive: true, force: true });
}
