import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeSessionLine } from "../lib/agent-sessions";
import { MCP_COVERS } from "../mcp/catalog";
import { readProjection } from "../watchdog/projection";
import { collectEvidence, type CoachCollection, type EvidenceWindow } from "./collect";
import {
  createCoachDelivery,
  type CoachDelivery,
  type CommentResult,
  type DeliveryResult,
} from "./delivery";
import {
  DECISIONS_STUB_ENV,
  readDecisionStub,
  runGate,
  stubRequest,
  type GateOutcome,
  type GateRun,
} from "./gate";
import { createJevClient, DECISIONS_URL_ENV, type JevRequest } from "./jev";
import {
  finalizeFindings,
  readFinalizerStub,
  FINALIZER_STUB_ENV,
  type Finalize,
  type FinalizeResult,
} from "./finalize";
import {
  analyzeEvidence,
  EVIDENCE_WINDOW_MS,
  isCoachCategory,
  type CoachFinding,
} from "./findings";
import { coachBody, coachComment, coachTitle, type CoachEvidence } from "./issue";
import {
  isFiled,
  loadLedger,
  markCommented,
  markFiled,
  markPending,
  markRejected,
  needsDecision,
  recordFindings,
  saveLedger,
  type CoachDecisionRecord,
  type CoachLedger,
} from "./ledger";
import { coachDirectory, latestPath, runsDirectory } from "./paths";
import { openRouterKey } from "./providers";
import { readCoachSettings, type CoachSettings } from "./settings";

/**
 * One Coach cycle. The deterministic detectors run first; every new finding
 * then passes the decision gate (one typed Decisions request each), and only
 * the survivors reach the single finalizer peer call that writes the proposal.
 *
 * Fail-closed: a gate failure files nothing this cycle, a finalizer failure
 * files nothing, and every outcome is recorded in the ledger and the report.
 * The cycle writes only `<STATE_DIR>/coach/` and the generated provider agent
 * directory the finalizer peer needs.
 */

/** How long an existing issue waits before a recurrence comments again. */
export const COMMENT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface CoachDecisionSummary {
  fingerprint: string;
  category: string;
  line: string;
  outcome: GateOutcome;
  probabilities: Record<string, number>;
  reason?: string;
}

export interface CoachGateSummary {
  model: string;
  calls: number;
  accepted: number;
  rejected: number;
  review: number;
  failed: number;
  costUsd: number;
  finalized: number;
  filed: number;
  dropped: number;
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
  findings: CoachFinding[];
  decisions: CoachDecisionSummary[];
  gate: CoachGateSummary | null;
  action: "none" | "duplicate" | "filed" | "commented" | "capped" | "rejected" | "failed";
  issues: Array<{ url: string; category: string; fingerprint: string; line: string }>;
  pending: number;
  reportPath: string;
  reason?: string;
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
  collect?: (window: EvidenceWindow) => CoachCollection;
  delivery?: CoachDelivery;
  gate?: (findings: CoachFinding[]) => Promise<GateRun>;
  finalize?: Finalize;
  projection?: { state: "ok" | "error" | "stale"; issues: Array<{ url: string; state: "pending" | "implemented" }> };
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

function scopeEvidence(
  collection: CoachCollection,
  root: string,
  finding: CoachFinding,
): Map<string, string> {
  const kind = finding.category === "repeat-question" ? "question" : "acp-stderr";
  const scopes = new Map<string, string>();
  for (const record of collection.journal) {
    const scope = record.scope;
    if (scope === null || record.kind !== kind) continue;
    const excerpt = normalizeSessionLine(record.text, { repoDir: root }).slice(0, 2_000);
    if (excerpt.length === 0) continue;
    const current = scopes.get(scope);
    if (current === undefined) {
      scopes.set(scope, excerpt);
      continue;
    }
    // Prefer the record whose normalized text the fingerprint was built from.
    if (excerpt.includes(finding.subject) || finding.subject.includes(excerpt)) {
      scopes.set(scope, excerpt);
    }
  }
  return scopes;
}

function evidenceFor(
  collection: CoachCollection,
  root: string,
  finding: CoachFinding,
): CoachEvidence {
  const sessions = new Map<
    string,
    CoachCollection["sessions"][number]
  >();
  for (const id of finding.sessions) {
    const session = collection.sessions.find((candidate) => candidate.id === id);
    if (session !== undefined) sessions.set(id, session);
  }
  return {
    window: collection.window,
    sessions,
    scopes: scopeEvidence(collection, root, finding),
    repoDir: resolve(root),
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
    `- Findings: ${report.findings.length}`,
    `- Pending filings: ${report.pending}`,
    ...(report.gate === null
      ? []
      : [
          `- Gate: ${report.gate.model}, ${report.gate.calls} call(s), ` +
            `${report.gate.accepted} accepted, ${report.gate.rejected} rejected, ` +
            `${report.gate.review} review, ${report.gate.failed} failed, ` +
            `cost ${report.gate.costUsd.toFixed(6)} USD`,
          `- Finalizer: ${report.gate.finalized} survivor(s), ${report.gate.filed} filed, ` +
            `${report.gate.dropped} dropped`,
        ]),
    "",
    "## Findings",
    "",
    ...(report.findings.length === 0
      ? ["None."]
      : report.findings.map(
          (finding) =>
            `- ${finding.category} \`${finding.fingerprint}\` (${finding.count}): ${finding.line}`,
        )),
    "",
    "## Decisions",
    "",
    ...(report.decisions.length === 0
      ? ["None."]
      : report.decisions.map((decision) => {
          const probabilities = Object.entries(decision.probabilities)
            .map(([name, probability]) => `${name}=${probability.toFixed(2)}`)
            .join(", ");
          return (
            `- ${decision.outcome} \`${decision.fingerprint}\` (${decision.category}): ` +
            `${probabilities.length === 0 ? "no answer" : probabilities}` +
            `${decision.reason === undefined ? "" : ` — ${decision.reason}`}`
          );
        })),
    "",
    "## Issues",
    "",
    ...(report.issues.length === 0
      ? ["None."]
      : report.issues.map((issue) => `- ${issue.url} (${issue.category})`)),
    "",
  ].join("\n");
}

/** The production gate: stub when configured, otherwise the live Decisions API. */
function decisionGate(options: {
  stateDir: string;
  settings: CoachSettings;
  environment: Record<string, string | undefined>;
  findings: CoachFinding[];
}): Promise<GateRun> {
  const stubPath = options.environment[DECISIONS_STUB_ENV];
  let request: JevRequest;
  try {
    if (typeof stubPath === "string" && stubPath.length > 0) {
      request = stubRequest(readDecisionStub(stubPath));
    } else {
      const key = openRouterKey(options.stateDir, options.environment);
      if (!key.ok) {
        return Promise.resolve({ ok: false, reason: key.reason, decisions: [], costUsd: 0 });
      }
      request = createJevClient({
        apiKey: key.value.key,
        ...(options.environment[DECISIONS_URL_ENV] === undefined
          ? {}
          : { url: options.environment[DECISIONS_URL_ENV] }),
      });
    }
  } catch (error) {
    return Promise.resolve({ ok: false, reason: firstLine(error), decisions: [], costUsd: 0 });
  }
  return runGate({
    findings: options.findings,
    model: options.settings.decisionModel,
    approveAt: options.settings.approveAt,
    rejectAt: options.settings.rejectAt,
    request,
  });
}

/** Runs one Coach cycle. The caller owns the singleton lock. */
export async function runCycle(options: CycleOptions): Promise<CycleResult> {
  const root = resolve(options.root);
  const stateDir = resolve(options.stateDir);
  const coachDir = coachDirectory(stateDir);
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const environment = options.environment ?? process.env;
  const window: EvidenceWindow = {
    start: new Date(now.getTime() - EVIDENCE_WINDOW_MS),
    end: now,
  };
  const settings = options.settings ?? readCoachSettings(coachDir);
  const collection =
    options.collect?.(window) ??
    collectEvidence({
      stateDir,
      repoDir: root,
      window,
    });
  const findings = analyzeEvidence({
    sessions: collection.sessions,
    journal: collection.journal,
    window: collection.window,
    repoDir: root,
    covers: MCP_COVERS,
  });
  const ledger = loadLedger(coachDir);
  if (!dryRun) recordFindings(ledger, findings, now);

  const candidates = findings.filter((finding) =>
    needsDecision(ledger.findings[finding.fingerprint], finding, now),
  );

  const runDir = join(runsDirectory(coachDir), stamp(now));
  const reportPath = join(runDir, "report.json");
  const report: CoachReport = {
    cycle: now.toISOString(),
    window: { ...collection.window, minutes: EVIDENCE_WINDOW_MS / 60_000 },
    sessions: collection.sessions.length,
    sessionFiles: collection.sessionFiles,
    truncated: collection.truncated,
    skipped: collection.skipped,
    malformed: collection.malformed,
    journalRecords: collection.journalRecords,
    findings,
    decisions: [],
    gate: null,
    action: "none",
    issues: [],
    pending: ledger.pendingFiling.length,
    reportPath,
  };

  if (dryRun) {
    const settled = findings.every((finding) => isFiled(ledger.findings[finding.fingerprint]));
    if (findings.length === 0) report.reason = "no finding in the window";
    else if (settled) {
      report.action = "duplicate";
      report.reason = "every finding already has an issue";
    } else {
      report.reason =
        `dry run: ${findings.length} finding(s), ${candidates.length} awaiting the gate`;
    }
    return { report, exitCode: 0 };
  }

  let delivery = options.delivery;
  let deliveryFailure: string | undefined;
  const deliveryFor = (): CoachDelivery | undefined => {
    if (delivery !== undefined) return delivery;
    if (deliveryFailure !== undefined) return undefined;
    try {
      delivery = createCoachDelivery({
        repoDir: root,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      });
    } catch (error) {
      deliveryFailure = firstLine(error);
    }
    return delivery;
  };

  const capsActive = settings.maxPerHour !== null || settings.maxPending !== null;
  const projection = options.projection ?? readProjection(coachDir);
  let room = Number.POSITIVE_INFINITY;
  if (capsActive) {
    if (projection === undefined || projection.state !== "ok") {
      room = 0;
      report.reason = "a filing cap is set and the forge projection is not ok; nothing new was filed";
    } else {
      const hourStart = now.getTime() - 60 * 60_000;
      let filedThisHour = 0;
      for (const entry of Object.values(ledger.findings)) {
        if (!entry.disposition.startsWith("filed:")) continue;
        const filedAt = Date.parse(entry.filedAt ?? "");
        if (Number.isFinite(filedAt) && filedAt > hourStart) filedThisHour += 1;
      }
      const open = projection.issues.filter((issue) => issue.state === "pending").length;
      const hourlyRoom =
        settings.maxPerHour === null
          ? Number.POSITIVE_INFINITY
          : Math.max(0, settings.maxPerHour - filedThisHour);
      const openRoom =
        settings.maxPending === null
          ? Number.POSITIVE_INFINITY
          : Math.max(0, settings.maxPending - open);
      room = Math.min(hourlyRoom, openRoom);
    }
  }

  let failure: string | undefined;
  let rejectedThisCycle = 0;
  const rejectedUntil = new Date(
    now.getTime() + settings.rejectCooldownHours * 60 * 60_000,
  ).toISOString();
  let survivors: CoachFinding[] = [];

  if (candidates.length > 0 && room <= 0) {
    for (const finding of candidates) {
      markPending(ledger, finding.fingerprint, "the filing cap has no room this hour");
    }
  } else if (candidates.length > 0) {
    const gate = options.gate ?? ((awaiting: CoachFinding[]) =>
      decisionGate({ stateDir, settings, environment, findings: awaiting }));
    let outcome: GateRun;
    try {
      outcome = await gate(candidates);
    } catch (error) {
      outcome = { ok: false, reason: firstLine(error), decisions: [], costUsd: 0 };
    }
    report.gate = {
      model: settings.decisionModel,
      calls: outcome.decisions.length,
      accepted: 0,
      rejected: 0,
      review: 0,
      failed: 0,
      costUsd: outcome.costUsd,
      finalized: 0,
      filed: 0,
      dropped: 0,
    };
    for (const decision of outcome.decisions) {
      const finding = decision.finding;
      report.decisions.push({
        fingerprint: finding.fingerprint,
        category: finding.category,
        line: finding.line,
        outcome: decision.outcome,
        probabilities: decision.probabilities,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      });
      if (decision.outcome === "accept") {
        report.gate.accepted += 1;
        survivors.push(finding);
        continue;
      }
      if (decision.outcome === "error") {
        report.gate.failed += 1;
        markPending(ledger, finding.fingerprint, decision.reason ?? "the gate call failed");
        continue;
      }
      if (decision.outcome === "review") report.gate.review += 1;
      else report.gate.rejected += 1;
      rejectedThisCycle += 1;
      markRejected(ledger, finding.fingerprint, {
        at: now.toISOString(),
        model: decision.model,
        outcome: decision.outcome,
        probabilities: decision.probabilities,
        count: finding.count,
        rejectedUntil,
        ...(decision.requestId === undefined ? {} : { requestId: decision.requestId }),
        ...(decision.costUsd === undefined ? {} : { costUsd: decision.costUsd }),
        reason:
          decision.outcome === "review"
            ? `ambiguous probabilities; cool-down until ${rejectedUntil}`
            : (decision.reason ?? "the gate rejected the finding"),
      });
    }
    if (!outcome.ok) {
      failure = outcome.reason ?? "the decision gate failed";
      for (const finding of survivors) {
        markPending(ledger, finding.fingerprint, failure);
      }
      survivors = [];
    }
    saveLedger(coachDir, ledger);
  }

  if (failure === undefined && survivors.length > 0) {
    const finalize =
      options.finalize ??
      ((finalizing: CoachFinding[]) => {
        const stubPath = environment[FINALIZER_STUB_ENV];
        return finalizeFindings({
          repoDir: root,
          stateDir,
          survivors: finalizing,
          environment,
          ...(typeof stubPath === "string" && stubPath.length > 0
            ? { run: readFinalizerStub(stubPath) }
            : {}),
        });
      });
    let recommendations: FinalizeResult | undefined;
    try {
      recommendations = await finalize(survivors);
    } catch (error) {
      failure = `the finalizer failed: ${firstLine(error)}`;
    }
    if (recommendations === undefined) {
      for (const finding of survivors) {
        markPending(ledger, finding.fingerprint, failure);
      }
    } else {
      report.gate = report.gate ?? {
        model: "",
        calls: 0,
        accepted: 0,
        rejected: 0,
        review: 0,
        failed: 0,
        costUsd: 0,
        finalized: 0,
        filed: 0,
        dropped: 0,
      };
      report.gate.finalized = survivors.length;
      for (const finding of survivors) {
        const recommendation = recommendations.recommendations.get(finding.fingerprint);
        if (recommendation === undefined) {
          failure ??= `the finalizer omitted ${finding.fingerprint}`;
          markPending(ledger, finding.fingerprint, "the finalizer omitted the finding");
          continue;
        }
        if (recommendation.action === "drop") {
          report.gate.dropped += 1;
          rejectedThisCycle += 1;
          markRejected(ledger, finding.fingerprint, {
            at: now.toISOString(),
            model: recommendations.model,
            outcome: "reject",
            probabilities: {},
            count: finding.count,
            rejectedUntil,
            reason:
              recommendation.duplicateOf === undefined
                ? "the finalizer dropped the finding"
                : `duplicate of ${recommendation.duplicateOf}`,
          });
          continue;
        }
        if (room <= 0) {
          markPending(ledger, finding.fingerprint, "the filing cap has no room this hour");
          continue;
        }
        const active = deliveryFor();
        if (active === undefined) {
          failure ??= deliveryFailure ?? "the Coach delivery is unavailable";
          markPending(ledger, finding.fingerprint, failure);
          continue;
        }
        const evidence = evidenceFor(collection, root, finding);
        let filed: DeliveryResult;
        try {
          filed = await active.create(
            coachTitle(finding),
            coachBody({
              finding,
              evidence,
              recommendation: {
                proposal: recommendation.proposal,
                acceptance: recommendation.acceptance,
              },
            }),
          );
        } catch (error) {
          filed = { ok: false, reason: firstLine(error) };
        }
        if (filed.ok) {
          room -= 1;
          report.gate.filed += 1;
          markFiled(ledger, finding.fingerprint, filed.url, now);
          report.issues.push({
            url: filed.url,
            category: finding.category,
            fingerprint: finding.fingerprint,
            line: finding.line,
          });
          saveLedger(coachDir, ledger);
          continue;
        }
        failure ??= filed.reason;
        markPending(ledger, finding.fingerprint, filed.reason);
      }
    }
    saveLedger(coachDir, ledger);
  }

  const filedThisCycle = new Set(report.issues.map((issue) => issue.fingerprint));
  let commented = 0;
  for (const finding of findings) {
    if (filedThisCycle.has(finding.fingerprint)) continue;
    const entry = ledger.findings[finding.fingerprint];
    if (entry === undefined || entry.url === undefined || !isFiled(entry)) continue;
    const baseline = Date.parse(entry.lastCommentAt ?? entry.filedAt ?? "");
    if (!Number.isFinite(baseline) || now.getTime() - baseline < COMMENT_INTERVAL_MS) continue;
    const active = deliveryFor();
    if (active === undefined) {
      const reason = deliveryFailure ?? "the Coach delivery is unavailable";
      failure ??= reason;
      markPending(ledger, finding.fingerprint, reason);
      continue;
    }
    let comment: CommentResult;
    try {
      comment = await active.comment(
        entry.url,
        coachComment({ finding, evidence: evidenceFor(collection, root, finding) }),
      );
    } catch (error) {
      comment = { ok: false, reason: firstLine(error) };
    }
    if (comment.ok) {
      markCommented(ledger, finding.fingerprint, now);
      saveLedger(coachDir, ledger);
      commented += 1;
      continue;
    }
    failure ??= comment.reason;
    markPending(ledger, finding.fingerprint, comment.reason);
  }

  if (failure !== undefined) {
    report.action = "failed";
    report.reason = failure;
  } else if (report.issues.length > 0) {
    report.action = "filed";
    report.reason = `filed ${report.issues.length} issue(s)`;
  } else if (commented > 0) {
    report.action = "commented";
    report.reason = `commented on ${commented} issue(s)`;
  } else if (rejectedThisCycle > 0) {
    report.action = "rejected";
    report.reason = `rejected ${rejectedThisCycle} finding(s) until ${rejectedUntil}`;
  } else if (capsActive && ledger.pendingFiling.length > 0) {
    report.action = "capped";
    report.reason =
      report.reason ?? `filing cap reached; ${ledger.pendingFiling.length} finding(s) stay pending`;
  } else if (findings.length > 0 || ledger.pendingFiling.length > 0) {
    report.action = "duplicate";
    report.reason = "every finding already has an issue";
  } else {
    report.reason = "no finding in the window";
  }
  report.pending = ledger.pendingFiling.length;

  saveLedger(coachDir, ledger);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(latestPath(coachDir), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(runDir, "report.md"), renderMarkdown(report));
  return { report, exitCode: report.action === "failed" ? 1 : 0, runDir };
}

/** Re-reads the report to render the CLI's human line. */
export function describeCycle(result: CycleResult): string {
  const report = result.report;
  return (
    `coach: ${report.action} — ${report.reason ?? "no reason"} ` +
    `(${report.findings.length} finding(s), ${report.sessions} session(s), ` +
    `${report.pending} pending)`
  );
}

export type { CoachLedger, CoachDecisionRecord };
