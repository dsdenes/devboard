import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectEvidence, type McpOptimizerCollection } from "./collect";
import {
  createMcpOptimizerDelivery,
  type McpOptimizerDelivery,
} from "./delivery";
import {
  buildFamilies,
  EVIDENCE_WINDOW_MS,
  type McpOptimizerFamily,
  type FamilyKind,
} from "./families";
import { familyTag, type McpOptimizerOpenIssue } from "./issue";
import {
  loadLedger,
  markFamily,
  recordFamilies,
  saveLedger,
  type McpOptimizerLedger,
} from "./ledger";
import { mcpOptimizerDirectory, latestPath, runsDirectory } from "./paths";
import { readMcpOptimizerSettings, type McpOptimizerSettings } from "./settings";
import {
  mcpOptimizerIssues,
  readSynthesisStub,
  synthesisPrompt,
  synthesizeFamily,
  SYNTHESIS_CONCURRENCY,
  SYNTHESIS_STUB_ENV,
  type SynthesisPaths,
  type SynthesisResult,
  type Synthesize,
} from "./synthesize";
import { readToolLog, toolValueNumber, toolValueString } from "../lib/tool-log";

/**
 * One MCP optimizer cycle, in order: collect, families, triage, synthesize, validate,
 * file. Every family is a normalized command or journal line; the top 20 by
 * recurrence each get exactly one ACP synthesis call, a deterministic validator
 * decides what the answer is worth, and filing stops at the configured caps.
 *
 * Fail-closed: a cycle whose synthesis calls all fail files nothing that cycle,
 * a failed open issue read files nothing, and every outcome is recorded in the
 * ledger and the report. A single failed synthesis call is recorded for its
 * family while the proposals that did parse still file. The cycle writes only
 * `<STATE_DIR>/coach/` and the generated provider agent directory the
 * synthesizer peer needs.
 */

export interface McpOptimizerFamilySummary {
  key: string;
  kind: FamilyKind;
  score: number;
  calls: number;
  sessions: number;
  days: number;
}

export interface McpOptimizerSynthesisSummary {
  family: string;
  model: string;
  durationMs: number;
  ok: boolean;
  reason?: string;
}

export type McpOptimizerValidationOutcome =
  | "filed"
  | "pending"
  | "none"
  | "skipped"
  | "duplicate"
  | "invalid"
  | "dropped"
  | "failed";

export interface McpOptimizerValidationSummary {
  family: string;
  outcome: McpOptimizerValidationOutcome;
  rule?: string;
  reason?: string;
}

export interface McpOptimizerReport {
  cycle: string;
  window: { start: string; end: string; minutes: number };
  sessions: number;
  sessionFiles: number;
  truncated: boolean;
  skipped: number;
  malformed: number;
  journalRecords: number;
  /** Total families in the window. */
  families: number;
  /** One entry per selected family, highest score first; cycle history reads this. */
  findings: McpOptimizerFamilySummary[];
  selected: McpOptimizerFamilySummary[];
  omitted: number;
  ledgerReset: boolean;
  synthesis: McpOptimizerSynthesisSummary[];
  validations: McpOptimizerValidationSummary[];
  action: "filed" | "none" | "capped" | "failed";
  reason?: string;
  issues: Array<{ url: string; family: string; kind: FamilyKind; title: string }>;
  duplicates: Array<{ family: string; url: string }>;
  dropped: number;
  pending: number;
  reportPath: string;
}

export interface CycleOptions {
  /** The repository root the cycle reads. */
  root: string;
  /** The dashboard's STATE_DIR; MCP optimizer files live under its `coach/`. */
  stateDir: string;
  now?: Date;
  dryRun?: boolean;
  settings?: McpOptimizerSettings;
  environment?: Record<string, string | undefined>;
  /** Test seams. */
  collect?: () => McpOptimizerCollection;
  delivery?: McpOptimizerDelivery;
  openIssues?: McpOptimizerOpenIssue[];
  synthesize?: Synthesize;
}

export interface CycleResult {
  report: McpOptimizerReport;
  exitCode: number;
  runDir?: string;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

function summaryOf(family: McpOptimizerFamily): McpOptimizerFamilySummary {
  return {
    key: family.key,
    kind: family.kind,
    score: family.score,
    calls: family.calls,
    sessions: family.sessions.length,
    days: family.days,
  };
}

function renderMarkdown(report: McpOptimizerReport): string {
  return [
    `# MCP optimizer cycle ${report.cycle}`,
    "",
    `- Window: ${report.window.start} .. ${report.window.end}`,
    `- Action: ${report.action}`,
    `- Reason: ${report.reason ?? "none"}`,
    `- Sessions: ${report.sessions} of ${report.sessionFiles} selected` +
      `${report.truncated ? " (truncated)" : ""}`,
    `- Skips: ${report.skipped}, malformed lines: ${report.malformed}`,
    `- Journal records: ${report.journalRecords}`,
    `- Families: ${report.families}, selected: ${report.selected.length}, ` +
      `omitted: ${report.omitted}`,
    `- Ledger reset: ${report.ledgerReset ? "yes" : "no"}`,
    `- Pending: ${report.pending}, dropped: ${report.dropped}`,
    "",
    "## Selected families",
    "",
    ...(report.selected.length === 0
      ? ["None."]
      : report.selected.map(
          (family) =>
            `- \`${family.key}\` (${family.kind}) score ${family.score} — ` +
            `${family.calls} call(s), ${family.sessions} session(s), ${family.days} day(s)`,
        )),
    "",
    "## Synthesis",
    "",
    ...(report.synthesis.length === 0
      ? ["None."]
      : report.synthesis.map(
          (call) =>
            `- \`${call.family}\`: ${call.model}, ${call.durationMs}ms, ` +
            `${call.ok ? "ok" : `failed — ${call.reason ?? "no reason"}`}`,
        )),
    "",
    "## Validation",
    "",
    ...(report.validations.length === 0
      ? ["None."]
      : report.validations.map(
          (entry) =>
            `- \`${entry.family}\`: ${entry.outcome}` +
            `${entry.rule === undefined ? "" : ` (${entry.rule})`}` +
            `${entry.reason === undefined ? "" : ` — ${entry.reason}`}`,
        )),
    "",
    "## Issues",
    "",
    ...(report.issues.length === 0
      ? ["None."]
      : report.issues.map((issue) => `- ${issue.url} — ${issue.title}`)),
    "",
    "## Duplicates",
    "",
    ...(report.duplicates.length === 0
      ? ["None."]
      : report.duplicates.map((entry) => `- \`${entry.family}\`: ${entry.url}`)),
    "",
  ].join("\n");
}

function duplicateOf(
  openIssues: McpOptimizerOpenIssue[],
  title: string,
  family: string,
): McpOptimizerOpenIssue | undefined {
  const tag = `family:${familyTag(family)}`;
  return openIssues.find((issue) => issue.title === title || issue.body.includes(tag));
}

function filingsThisHour(ledger: McpOptimizerLedger, now: Date): number {
  const start = now.getTime() - 60 * 60_000;
  let count = 0;
  for (const entry of Object.values(ledger.families)) {
    const filedAt = Date.parse(entry.lastFiledAt ?? "");
    if (Number.isFinite(filedAt) && filedAt > start) count += 1;
  }
  return count;
}

function hourlyRoom(settings: McpOptimizerSettings, ledger: McpOptimizerLedger, now: Date): number {
  if (settings.maxPerHour === null) return Number.POSITIVE_INFINITY;
  return Math.max(0, settings.maxPerHour - filingsThisHour(ledger, now));
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        const item = items[index];
        if (item === undefined) return;
        results[index] = await work(item, index);
      }
    }),
  );
  return results;
}

/** Runs one MCP optimizer cycle. The caller owns the singleton lock. */
export async function runCycle(options: CycleOptions): Promise<CycleResult> {
  const root = resolve(options.root);
  const stateDir = resolve(options.stateDir);
  const mcpOptimizerDir = mcpOptimizerDirectory(stateDir);
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const environment = options.environment ?? process.env;
  const window = {
    start: new Date(now.getTime() - EVIDENCE_WINDOW_MS),
    end: now,
  };
  const settings = options.settings ?? readMcpOptimizerSettings(mcpOptimizerDir);
  const collection =
    options.collect?.() ??
    collectEvidence({
      stateDir,
      repoDir: root,
      window,
    });
  const selection = buildFamilies({
    sessions: collection.sessions,
    journal: collection.journal,
    window: collection.window,
    repoDir: root,
  });
  const loaded = loadLedger(mcpOptimizerDir);
  const ledger = loaded.ledger;
  if (!dryRun) recordFamilies(ledger, selection.families, now);

  const runDir = join(runsDirectory(mcpOptimizerDir), stamp(now));
  const reportPath = join(runDir, "report.json");
  const selected = selection.selected.map(summaryOf);
  const report: McpOptimizerReport = {
    cycle: now.toISOString(),
    window: { ...collection.window, minutes: EVIDENCE_WINDOW_MS / 60_000 },
    sessions: collection.sessions.length,
    sessionFiles: collection.sessionFiles,
    truncated: collection.truncated,
    skipped: collection.skipped,
    malformed: collection.malformed,
    journalRecords: collection.journalRecords,
    families: selection.families.length,
    findings: selected,
    selected,
    omitted: selection.omitted,
    ledgerReset: loaded.reset,
    synthesis: [],
    validations: [],
    action: "none",
    issues: [],
    duplicates: [],
    dropped: 0,
    pending: 0,
    reportPath,
  };

  if (dryRun) {
    report.reason =
      selection.families.length === 0
        ? "no family in the window"
        : `dry run: ${selection.families.length} family/families, ` +
          `${selection.selected.length} selected for synthesis`;
    return { report, exitCode: 0 };
  }

  const finish = (failure: string | undefined): CycleResult => {
    report.pending = 0;
    if (failure !== undefined) {
      report.action = "failed";
      report.reason = failure;
    } else if (report.issues.length > 0) {
      report.action = "filed";
      report.reason = `filed ${report.issues.length} issue(s)`;
    } else if (selection.families.length === 0) {
      report.action = "none";
      report.reason = "no family in the window";
    } else if (cappedReason !== undefined) {
      report.action = "capped";
      report.reason = cappedReason;
    } else {
      report.action = "none";
      report.reason = "no family filed a proposal";
    }
    saveLedger(mcpOptimizerDir, ledger);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(latestPath(mcpOptimizerDir), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(runDir, "report.md"), renderMarkdown(report));
    return { report, exitCode: report.action === "failed" ? 1 : 0, runDir };
  };

  let delivery = options.delivery;
  let deliveryFailure: string | undefined;
  const deliveryFor = (): McpOptimizerDelivery | undefined => {
    if (delivery !== undefined) return delivery;
    if (deliveryFailure !== undefined) return undefined;
    try {
      delivery = createMcpOptimizerDelivery({
        repoDir: root,
        stateDir,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      });
    } catch (error) {
      deliveryFailure = firstLine(error);
    }
    return delivery;
  };

  let openIssues: McpOptimizerOpenIssue[] = [];
  let failure: string | undefined;
  // A queue written by an older revision is discarded, not filed: the
  // synthesis turn files its own proposal or records why it filed none.
  if (ledger.pendingFiling.length > 0) {
    report.dropped += ledger.pendingFiling.length;
    for (const pending of ledger.pendingFiling) {
      report.validations.push({
        family: pending.family,
        outcome: "dropped",
        rule: "pending-queue-removed",
        reason: "the proposal queue is gone; the synthesis turn files directly",
      });
    }
    ledger.pendingFiling = [];
  }
  if (selection.selected.length > 0) {
    const active = deliveryFor();
    if (active === undefined) {
      failure = deliveryFailure ?? "the MCP optimizer delivery is unavailable";
    } else if (options.openIssues !== undefined) {
      openIssues = options.openIssues;
    } else {
      try {
        openIssues = await active.list();
      } catch (error) {
        failure = `the open issues could not be read: ${firstLine(error)}`;
      }
    }
  }
  if (failure !== undefined) return finish(failure);

  let cycleFiled = 0;
  let room = hourlyRoom(settings, ledger, now);
  const handled = new Set<string>();
  // The cap that left no family any filing room this cycle, if one did; it
  // makes a suppressed cycle read as `capped` instead of a quiet repository.
  let cappedReason: string | undefined;
  const cappedFamilies = new Set<string>();

  const recordFiling = (entry: {
    family: string;
    title: string;
    kind: FamilyKind;
    url: string;
    body: string;
  }): void => {
    cycleFiled += 1;
    if (room !== Number.POSITIVE_INFINITY) room -= 1;
    report.issues.push({
      family: entry.family,
      title: entry.title,
      kind: entry.kind,
      url: entry.url,
    });
    report.validations.push({ family: entry.family, outcome: "filed" });
    markFamily(ledger, entry.family, "filed", {
      at: now,
      issueUrl: entry.url,
      title: entry.title,
    });
    openIssues.push({
      number: openIssues.length + 1,
      title: entry.title,
      body: entry.body,
      url: entry.url,
    });
  };

  const toSynthesize = selection.selected.filter((family) => !handled.has(family.key));

  if (failure === undefined && toSynthesize.length > 0) {
    const stubPath = environment[SYNTHESIS_STUB_ENV];
    const run: Synthesize =
      options.synthesize ??
      ((family, prompt, paths) => {
        const stub =
          typeof stubPath === "string" && stubPath.length > 0
            ? readSynthesisStub(stubPath, family.key, paths)
            : undefined;
        return synthesizeFamily({
          repoDir: root,
          stateDir,
          family,
          prompt,
          environment,
          toolLogPath: paths.toolLogPath,
          skipLogPath: paths.skipLogPath,
          ...(stub === undefined ? {} : { run: stub }),
        });
      });
    const openMcpOptimizerIssues = mcpOptimizerIssues(openIssues);
    const available = Math.max(
      0,
      Math.min(
        settings.maxIssuesPerCycle - cycleFiled,
        room === Number.POSITIVE_INFINITY ? toSynthesize.length : room,
      ),
    );
    if (available === 0) {
      cappedReason =
        room === 0
          ? `maxPerHour ${settings.maxPerHour} reached; ` +
            `${toSynthesize.length} family/families suppressed`
          : `maxIssuesPerCycle ${settings.maxIssuesPerCycle} reached; ` +
            `${toSynthesize.length} family/families suppressed`;
    }
    const work = toSynthesize.map((family, index) => {
      const directory = join(runDir, "families", family.key.replace(/[^a-zA-Z0-9._-]+/g, "-"));
      mkdirSync(directory, { recursive: true });
      const paths: SynthesisPaths = {
        toolLogPath: join(directory, "tool-log.jsonl"),
        skipLogPath: join(directory, "skips.jsonl"),
      };
      const filingRoom = index < available ? 1 : 0;
      if (filingRoom === 0) cappedFamilies.add(family.key);
      return {
        family,
        paths,
        prompt: synthesisPrompt({
          family,
          settings,
          openIssues: openMcpOptimizerIssues,
          filingRoom,
        }),
      };
    });
    const calls = await mapLimit(
      work,
      SYNTHESIS_CONCURRENCY,
      async (
        item,
      ): Promise<{ family: McpOptimizerFamily; paths: SynthesisPaths; result: SynthesisResult }> => {
        let result: SynthesisResult;
        try {
          result = await run(item.family, item.prompt, item.paths);
        } catch (error) {
          result = { ok: false, reason: firstLine(error), model: "", durationMs: 0 };
        }
        return { family: item.family, paths: item.paths, result };
      },
    );
    for (const call of calls) {
      report.synthesis.push({
        family: call.family.key,
        model: call.result.model,
        durationMs: call.result.durationMs,
        ok: call.result.ok,
        ...(call.result.reason === undefined ? {} : { reason: call.result.reason }),
      });
    }
    const failedCalls = calls.filter((call) => !call.result.ok);
    if (failedCalls.length > 0) {
      for (const call of failedCalls) {
        markFamily(ledger, call.family.key, "failed", { at: now });
      }
      // A partial failure is recorded per family and must not discard the
      // proposals the peer calls that did succeed filed. Only a cycle in which
      // every synthesis call failed is a cycle failure.
      if (failedCalls.length === calls.length) {
        return finish(
          `synthesis failed for ${failedCalls.map((call) => call.family.key).join(", ")}: ` +
            `${failedCalls[0]?.result.reason ?? "no diagnostic"}`,
        );
      }
    }

    for (const call of calls) {
      if (!call.result.ok) continue;
      const filings = readToolLog(call.paths.toolLogPath).filter(
        (entry) => entry.tool === "issue_create" && entry.ok === true,
      );
      const filed = filings[filings.length - 1];
      const number = filed === undefined ? undefined : toolValueNumber(filed.value, "number");
      const title = filed === undefined ? undefined : toolValueString(filed.value, "title");
      const url = filed === undefined ? undefined : toolValueString(filed.value, "url");
      if (number !== undefined && title !== undefined && url !== undefined) {
        const duplicate = duplicateOf(openIssues, title, call.family.key);
        if (duplicate !== undefined) {
          report.duplicates.push({ family: call.family.key, url: duplicate.url });
          report.validations.push({
            family: call.family.key,
            outcome: "duplicate",
            rule: "open-issue",
            reason: duplicate.url,
          });
          markFamily(ledger, call.family.key, "duplicate", { at: now });
          continue;
        }
        recordFiling({
          family: call.family.key,
          title,
          kind: call.family.kind,
          url,
          body: "",
        });
        continue;
      }
      const skips = readToolLog(call.paths.skipLogPath).filter(
        (entry) => entry.tool === "mcp_optimizer_proposal_skip" && entry.ok === true,
      );
      const skip = skips[skips.length - 1];
      const reason = skip === undefined ? undefined : toolValueString(skip.value, "reason");
      report.validations.push({
        family: call.family.key,
        outcome: "skipped",
        rule: reason === undefined ? "no-filing" : "tool",
        reason: reason ?? "the synthesis turn filed nothing",
      });
      markFamily(
        ledger,
        call.family.key,
        cappedFamilies.has(call.family.key) ? "capped" : "none",
        { at: now },
      );
    }
  }

  return finish(failure);
}

/** Renders the CLI's human line from a finished cycle. */
export function describeCycle(result: CycleResult): string {
  const report = result.report;
  return (
    `mcp-optimizer: ${report.action} — ${report.reason ?? "no reason"} ` +
    `(${report.families} family/families, ${report.selected.length} selected, ` +
    `${report.issues.length} filed, ${report.pending} pending)`
  );
}
