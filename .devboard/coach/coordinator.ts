import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectEvidence, type CoachCollection } from "./collect";
import {
  createCoachDelivery,
  type CoachDelivery,
  type DeliveryResult,
} from "./delivery";
import {
  buildFamilies,
  EVIDENCE_WINDOW_MS,
  type CoachFamily,
  type FamilyKind,
} from "./families";
import {
  familyTag,
  issueTitle,
  type CoachOpenIssue,
} from "./issue";
import {
  dropStalePending,
  enqueuePending,
  loadLedger,
  markFamily,
  recordFamilies,
  removePending,
  saveLedger,
  type CoachLedger,
} from "./ledger";
import { coachDirectory, latestPath, runsDirectory } from "./paths";
import { readCoachSettings, type CoachSettings } from "./settings";
import {
  parseSynthesisAnswer,
  readSynthesisStub,
  synthesisPrompt,
  synthesizeFamily,
  SYNTHESIS_CONCURRENCY,
  SYNTHESIS_STUB_ENV,
  type Proposal,
  type SynthesisResult,
  type Synthesize,
} from "./synthesize";
import { validateProposal } from "./validate";

/**
 * One Coach cycle, in order: collect, families, triage, synthesize, validate,
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

export interface CoachFamilySummary {
  key: string;
  kind: FamilyKind;
  score: number;
  calls: number;
  sessions: number;
  days: number;
}

export interface CoachSynthesisSummary {
  family: string;
  model: string;
  durationMs: number;
  ok: boolean;
  reason?: string;
}

export type CoachValidationOutcome =
  | "filed"
  | "pending"
  | "none"
  | "duplicate"
  | "invalid"
  | "dropped"
  | "failed";

export interface CoachValidationSummary {
  family: string;
  outcome: CoachValidationOutcome;
  rule?: string;
  reason?: string;
}

export interface CoachReport {
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
  findings: CoachFamilySummary[];
  selected: CoachFamilySummary[];
  omitted: number;
  ledgerReset: boolean;
  synthesis: CoachSynthesisSummary[];
  validations: CoachValidationSummary[];
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
  /** The dashboard's STATE_DIR; Coach files live under its `coach/`. */
  stateDir: string;
  now?: Date;
  dryRun?: boolean;
  settings?: CoachSettings;
  environment?: Record<string, string | undefined>;
  /** Test seams. */
  collect?: () => CoachCollection;
  delivery?: CoachDelivery;
  openIssues?: CoachOpenIssue[];
  synthesize?: Synthesize;
}

export interface CycleResult {
  report: CoachReport;
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

function summaryOf(family: CoachFamily): CoachFamilySummary {
  return {
    key: family.key,
    kind: family.kind,
    score: family.score,
    calls: family.calls,
    sessions: family.sessions.length,
    days: family.days,
  };
}

function renderMarkdown(report: CoachReport): string {
  return [
    `# Coach cycle ${report.cycle}`,
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
  openIssues: CoachOpenIssue[],
  title: string,
  family: string,
): CoachOpenIssue | undefined {
  const tag = `family:${familyTag(family)}`;
  return openIssues.find((issue) => issue.title === title || issue.body.includes(tag));
}

function filingsThisHour(ledger: CoachLedger, now: Date): number {
  const start = now.getTime() - 60 * 60_000;
  let count = 0;
  for (const entry of Object.values(ledger.families)) {
    const filedAt = Date.parse(entry.lastFiledAt ?? "");
    if (Number.isFinite(filedAt) && filedAt > start) count += 1;
  }
  return count;
}

function hourlyRoom(settings: CoachSettings, ledger: CoachLedger, now: Date): number {
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

/** Runs one Coach cycle. The caller owns the singleton lock. */
export async function runCycle(options: CycleOptions): Promise<CycleResult> {
  const root = resolve(options.root);
  const stateDir = resolve(options.stateDir);
  const coachDir = coachDirectory(stateDir);
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const environment = options.environment ?? process.env;
  const window = {
    start: new Date(now.getTime() - EVIDENCE_WINDOW_MS),
    end: now,
  };
  const settings = options.settings ?? readCoachSettings(coachDir);
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
  const loaded = loadLedger(coachDir);
  const ledger = loaded.ledger;
  if (!dryRun) recordFamilies(ledger, selection.families, now);

  const runDir = join(runsDirectory(coachDir), stamp(now));
  const reportPath = join(runDir, "report.json");
  const selected = selection.selected.map(summaryOf);
  const report: CoachReport = {
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
    pending: ledger.pendingFiling.length,
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
    report.pending = ledger.pendingFiling.length;
    if (failure !== undefined) {
      report.action = "failed";
      report.reason = failure;
    } else if (report.issues.length > 0) {
      report.action = "filed";
      report.reason = `filed ${report.issues.length} issue(s)`;
    } else if (report.validations.some((entry) => entry.outcome === "pending")) {
      report.action = "capped";
      report.reason =
        `filing cap reached; ${ledger.pendingFiling.length} proposal(s) stay pending`;
    } else if (selection.families.length === 0) {
      report.action = "none";
      report.reason = "no family in the window";
    } else {
      report.action = "none";
      report.reason = "no proposal passed validation";
    }
    saveLedger(coachDir, ledger);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(latestPath(coachDir), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(runDir, "report.md"), renderMarkdown(report));
    return { report, exitCode: report.action === "failed" ? 1 : 0, runDir };
  };

  const keys = new Set(selection.families.map((family) => family.key));
  for (const stale of dropStalePending(ledger, keys, now)) {
    report.dropped += 1;
    report.validations.push({
      family: stale.family,
      outcome: "dropped",
      rule: "pending-expired",
      reason: "older than seven days or absent from the window",
    });
  }

  let delivery = options.delivery;
  let deliveryFailure: string | undefined;
  const deliveryFor = (): CoachDelivery | undefined => {
    if (delivery !== undefined) return delivery;
    if (deliveryFailure !== undefined) return undefined;
    try {
      delivery = createCoachDelivery({
        repoDir: root,
        stateDir,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      });
    } catch (error) {
      deliveryFailure = firstLine(error);
    }
    return delivery;
  };

  let openIssues: CoachOpenIssue[] = [];
  let failure: string | undefined;
  const needsForge =
    ledger.pendingFiling.length > 0 || selection.selected.length > 0;
  if (needsForge) {
    const active = deliveryFor();
    if (active === undefined) {
      failure = deliveryFailure ?? "the Coach delivery is unavailable";
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

  const recordFiling = (entry: {
    family: string;
    title: string;
    kind: FamilyKind;
    url: string;
  }): void => {
    cycleFiled += 1;
    if (room !== Number.POSITIVE_INFINITY) room -= 1;
    report.issues.push(entry);
    report.validations.push({ family: entry.family, outcome: "filed" });
    markFamily(ledger, entry.family, "filed", {
      at: now,
      issueUrl: entry.url,
      title: entry.title,
    });
    openIssues.push({
      number: openIssues.length + 1,
      title: entry.title,
      body: "",
      url: entry.url,
    });
  };

  /* Pending proposals file before new synthesis, with their original bytes. */
  const queue = ledger.pendingFiling
    .slice()
    .sort(
      (left, right) =>
        right.score - left.score || left.createdAt.localeCompare(right.createdAt),
    );
  for (const pending of queue) {
    if (failure !== undefined) break;
    const duplicate = duplicateOf(openIssues, pending.title, pending.family);
    if (duplicate !== undefined) {
      report.duplicates.push({ family: pending.family, url: duplicate.url });
      report.validations.push({
        family: pending.family,
        outcome: "duplicate",
        rule: "open-issue",
        reason: duplicate.url,
      });
      removePending(ledger, pending.family);
      markFamily(ledger, pending.family, "duplicate", { at: now });
      handled.add(pending.family);
      continue;
    }
    if (cycleFiled >= settings.maxIssuesPerCycle || room <= 0) {
      report.validations.push({
        family: pending.family,
        outcome: "pending",
        rule: "cap",
        reason: "the per-cycle or per-hour cap has no room",
      });
      markFamily(ledger, pending.family, "capped", { at: now });
      continue;
    }
    const active = deliveryFor();
    if (active === undefined) {
      failure = deliveryFailure ?? "the Coach delivery is unavailable";
      break;
    }
    let filed: DeliveryResult;
    try {
      filed = await active.create(pending.title, pending.body);
    } catch (error) {
      filed = { ok: false, reason: firstLine(error) };
    }
    if (!filed.ok) {
      failure = filed.reason;
      report.validations.push({
        family: pending.family,
        outcome: "failed",
        rule: "delivery",
        reason: filed.reason,
      });
      markFamily(ledger, pending.family, "failed", { at: now });
      break;
    }
    removePending(ledger, pending.family);
    handled.add(pending.family);
    recordFiling({
      family: pending.family,
      title: pending.title,
      kind: pending.kind,
      url: filed.url,
    });
  }

  const queued = new Set(ledger.pendingFiling.map((entry) => entry.family));
  const toSynthesize = selection.selected.filter(
    (family) => !queued.has(family.key) && !handled.has(family.key),
  );

  if (failure === undefined && toSynthesize.length > 0) {
    const stubPath = environment[SYNTHESIS_STUB_ENV];
    const run: Synthesize =
      options.synthesize ??
      ((family, prompt) => {
        const stub =
          typeof stubPath === "string" && stubPath.length > 0
            ? readSynthesisStub(stubPath, family.key)
            : undefined;
        return synthesizeFamily({
          repoDir: root,
          stateDir,
          family,
          prompt,
          environment,
          ...(stub === undefined ? {} : { run: stub }),
        });
      });
    const coachIssues = openIssues.filter(
      (issue) => issue.title.startsWith("[coach]") || issue.body.includes("family:"),
    );
    const prompts = toSynthesize.map((family) =>
      synthesisPrompt({ family, settings, openIssues: coachIssues }),
    );
    const calls = await mapLimit(
      toSynthesize,
      SYNTHESIS_CONCURRENCY,
      async (family, index): Promise<{ family: CoachFamily; result: SynthesisResult }> => {
        let result: SynthesisResult;
        try {
          result = await run(family, prompts[index] ?? "");
        } catch (error) {
          result = { ok: false, reason: firstLine(error), model: "", durationMs: 0 };
        }
        return { family, result };
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
      // proposals the peer calls that did succeed returned. Only a cycle in
      // which every synthesis call failed is a cycle failure.
      if (failedCalls.length === calls.length) {
        return finish(
          `synthesis failed for ${failedCalls.map((call) => call.family.key).join(", ")}: ` +
            `${failedCalls[0]?.result.reason ?? "no diagnostic"}`,
        );
      }
    }

    interface Candidate {
      family: CoachFamily;
      proposal: Proposal;
      title: string;
      body: string;
    }
    const candidates: Candidate[] = [];
    for (const call of calls) {
      if (call.result.text === undefined) continue;
      let proposal: Proposal;
      try {
        proposal = parseSynthesisAnswer(call.result.text, call.family.key);
      } catch (error) {
        report.validations.push({
          family: call.family.key,
          outcome: "invalid",
          rule: "contract",
          reason: firstLine(error),
        });
        markFamily(ledger, call.family.key, "invalid", { at: now });
        continue;
      }
      if (proposal.action === "none") {
        report.validations.push({
          family: call.family.key,
          outcome: "none",
          reason: proposal.rationale,
        });
        markFamily(ledger, call.family.key, "none", { at: now });
        continue;
      }
      const validation = validateProposal({
        family: call.family,
        proposal,
        settings,
        openIssues,
      });
      if (!validation.ok) {
        report.validations.push({
          family: call.family.key,
          outcome: "invalid",
          rule: validation.rule,
          reason: validation.detail,
        });
        markFamily(ledger, call.family.key, "invalid", { at: now });
        continue;
      }
      const title = issueTitle(call.family, proposal.action);
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
      candidates.push({
        family: call.family,
        proposal,
        title,
        body: validation.body,
      });
    }

    for (const candidate of candidates) {
      if (failure !== undefined) break;
      if (cycleFiled >= settings.maxIssuesPerCycle || room <= 0) {
        const dropped = enqueuePending(
          ledger,
          {
            family: candidate.family.key,
            kind: candidate.family.kind,
            title: candidate.title,
            body: candidate.body,
            score: candidate.family.score,
            createdAt: now.toISOString(),
          },
          settings.maxPending,
        );
        report.dropped += dropped.length;
        report.validations.push({
          family: candidate.family.key,
          outcome: "pending",
          rule: "cap",
          reason: "the per-cycle or per-hour cap has no room",
        });
        markFamily(ledger, candidate.family.key, "capped", { at: now });
        continue;
      }
      const active = deliveryFor();
      if (active === undefined) {
        failure = deliveryFailure ?? "the Coach delivery is unavailable";
        markFamily(ledger, candidate.family.key, "failed", { at: now });
        break;
      }
      let filed: DeliveryResult;
      try {
        filed = await active.create(candidate.title, candidate.body);
      } catch (error) {
        filed = { ok: false, reason: firstLine(error) };
      }
      if (!filed.ok) {
        failure = filed.reason;
        report.validations.push({
          family: candidate.family.key,
          outcome: "failed",
          rule: "delivery",
          reason: filed.reason,
        });
        enqueuePending(
          ledger,
          {
            family: candidate.family.key,
            kind: candidate.family.kind,
            title: candidate.title,
            body: candidate.body,
            score: candidate.family.score,
            createdAt: now.toISOString(),
          },
          settings.maxPending,
        );
        markFamily(ledger, candidate.family.key, "failed", { at: now });
        break;
      }
      recordFiling({
        family: candidate.family.key,
        title: candidate.title,
        kind: candidate.family.kind,
        url: filed.url,
      });
    }
  }

  return finish(failure);
}

/** Renders the CLI's human line from a finished cycle. */
export function describeCycle(result: CycleResult): string {
  const report = result.report;
  return (
    `coach: ${report.action} — ${report.reason ?? "no reason"} ` +
    `(${report.families} family/families, ${report.selected.length} selected, ` +
    `${report.issues.length} filed, ${report.pending} pending)`
  );
}
