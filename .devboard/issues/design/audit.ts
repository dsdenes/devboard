import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isRecord } from "../guards";
import { normalizeTitle } from "../scout/recommendation";
import { DEFAULT_SOURCE_DIRECTORY, TITLE_MAX, type DesignCategory, type DesignConfig } from "./paths";

/**
 * The cycle's audit contract. The worker reads the interface source and the
 * two normative documents, writes them into the cycle directory, and validates
 * the peer's answer atomically before anything is filed or committed.
 */

export interface AuditFile {
  /** Repository-relative path, `/` separators. */
  path: string;
  lines: number;
  text: string;
}

export interface AuditInput {
  sources: AuditFile[];
  documents: AuditFile[];
  /** The configured source directory, repository-relative. */
  sourceDir: string;
}

export interface DesignEvidence {
  path: string;
  lines: string;
  quote: string;
}

export interface DesignFinding {
  category: DesignCategory;
  title: string;
  /** The violated principle, its quoted document passage, and its name. */
  principle: { name: string; passage: string };
  /** The violated token, when the finding is about a value. */
  token?: { name: string; value?: string };
  evidence: DesignEvidence[];
  files: string[];
  proposedChange: string;
  acceptanceCriteria: string[];
}

export type DocumentationDecision =
  | { decision: "none" }
  | {
      decision: "edit";
      summary: string;
      rationale: string;
      /** Distinct interface surfaces that evidence the standard. */
      surfaces: string[];
      /** True when the documents contradict each other. */
      contradiction: boolean;
      /** A quoted contradiction passage, when `contradiction` is true. */
      evidence: string[];
      /** Token names this edit adds or corrects, for the drift guard. */
      addsTokens: string[];
    };

export interface DroppedFinding {
  title: string;
  reason: string;
}

export interface ParsedAudit {
  findings: DesignFinding[];
  dropped: DroppedFinding[];
  documentation: DocumentationDecision;
  /** Why the documentation decision was refused, or null. */
  documentationError: string | null;
}

export class DesignInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignInputError";
  }
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.replace(/\n$/, "").split("\n").length;
}

function isSourceFile(name: string): boolean {
  return (
    name === "index.html" ||
    name.endsWith(".svelte") ||
    name.endsWith(".css") ||
    name.endsWith(".ts")
  );
}

function walk(directory: string, root: string, found: string[]): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(absolute, root, found);
      continue;
    }
    if (!entry.isFile() || !isSourceFile(entry.name)) continue;
    found.push(absolute);
  }
}

function readDocument(repoDir: string, relativePath: string): AuditFile {
  const absolute = resolve(repoDir, relativePath);
  let text: string;
  try {
    text = readFileSync(absolute, "utf8");
  } catch {
    throw new DesignInputError(`${relativePath} is not readable`);
  }
  return { path: relativePath.replace(/\\/g, "/"), lines: lineCount(text), text };
}

/**
 * Reads every `.svelte`, `.css`, `.ts`, and `index.html` file below the
 * configured source directory plus the two documents. A missing source
 * directory, index.html, or document refuses the whole input; an installed
 * npm prefix has no such `client` directory and is refused by name.
 */
export function readAuditInput(repoDir: string, config: DesignConfig): AuditInput {
  const root = resolve(repoDir);
  const sourceRoot = resolve(root, config.sourceDir);
  if (config.sourceDir !== DEFAULT_SOURCE_DIRECTORY && !config.sourceDir.endsWith("/client")) {
    throw new DesignInputError(
      `the audit source ${config.sourceDir} is not an interface source directory`,
    );
  }
  let sourceStat;
  try {
    sourceStat = lstatSync(sourceRoot);
  } catch {
    throw new DesignInputError(
      `the canonical harness source checkout has no ${config.sourceDir} directory ` +
        "(an installed npm prefix is refused)",
    );
  }
  if (!sourceStat.isDirectory()) {
    throw new DesignInputError(`${config.sourceDir} is not a directory`);
  }
  // Vite's entry sits beside the client directory in the source checkout.
  const indexCandidates = [
    resolve(sourceRoot, "index.html"),
    resolve(sourceRoot, "..", "index.html"),
  ];
  const index = indexCandidates.find((candidate) => {
    try {
      return lstatSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (index === undefined) {
    throw new DesignInputError(`${config.sourceDir} has no index.html entry`);
  }

  const files: string[] = [];
  walk(sourceRoot, root, files);
  const sources: AuditFile[] = [];
  for (const absolute of files) {
    const path = relative(root, absolute).split(sep).join("/");
    let text: string;
    try {
      text = readFileSync(absolute, "utf8");
    } catch {
      throw new DesignInputError(`${path} is not readable`);
    }
    sources.push({ path, lines: lineCount(text), text });
  }
  const documents = [
    readDocument(root, config.designDocument),
    readDocument(root, config.tokenDocument),
  ];
  return { sources, documents, sourceDir: config.sourceDir };
}

const LINE_SPAN = /^(\d+)(?:-(\d+))?$/;

function normal(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function containsPassage(text: string, passage: string): boolean {
  const needle = normal(passage);
  return needle.length > 0 && normal(text).includes(needle);
}

function evidenceLines(
  file: AuditFile,
  lines: string,
): { ok: true; first: number; last: number } | { ok: false; detail: string } {
  const span = LINE_SPAN.exec(lines.trim());
  if (span === null) return { ok: false, detail: `${file.path}:${lines} is not a line span` };
  const first = Number(span[1]);
  const last = span[2] === undefined ? first : Number(span[2]);
  if (file.lines === 0) return { ok: false, detail: `${file.path} is empty` };
  if (first < 1 || last < first || last > file.lines) {
    return {
      ok: false,
      detail: `${file.path}:${lines} is outside the file's ${file.lines} line(s)`,
    };
  }
  return { ok: true, first, last };
}

function quotedSource(file: AuditFile, first: number, last: number, quote: string): boolean {
  const span = file.text.replace(/\n$/, "").split("\n").slice(first - 1, last).join("\n");
  return normal(span).includes(normal(quote));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const entries = value.map(stringValue);
  return entries.every((entry): entry is string => entry !== null) ? entries : null;
}

function categories(): readonly string[] {
  return ["color", "typography", "spacing", "wording", "state", "placement"];
}

export interface ParseAuditContext {
  input: AuditInput;
  /** Every existing issue title that must not be restated. */
  knownTitles: readonly string[];
}

/**
 * Validates one answer. A malformed finding is dropped with its reason rather
 * than rejecting the whole cycle, so the remaining well-evidenced divergences
 * still become issues. A malformed documentation decision is refused, leaving
 * the documents untouched.
 */
export function parseAudit(value: unknown, context: ParseAuditContext): ParsedAudit {
  if (!isRecord(value)) {
    throw new DesignInputError("audit.json is not an object");
  }
  if (!Array.isArray(value.findings)) {
    throw new DesignInputError("audit.json has no findings array");
  }
  const sourceByPath = new Map(context.input.sources.map((file) => [file.path, file]));
  const documents = context.input.documents.map((file) => file.text).join("\n");
  const known = new Set(context.knownTitles.map(normalizeTitle));
  const findings: DesignFinding[] = [];
  const dropped: DroppedFinding[] = [];

  for (const [index, entry] of value.findings.entries()) {
    const label = `finding ${index + 1}`;
    if (!isRecord(entry)) {
      dropped.push({ title: label, reason: "the finding is not an object" });
      continue;
    }
    const rawTitle = stringValue(entry.title);
    if (rawTitle === null) {
      dropped.push({ title: label, reason: "the title is empty" });
      continue;
    }
    const title = rawTitle.replace(/\s+/g, " ");
    if (title.length > TITLE_MAX) {
      dropped.push({ title: title.slice(0, 60), reason: `the title exceeds ${TITLE_MAX} characters` });
      continue;
    }
    const category = entry.category;
    if (typeof category !== "string" || !categories().includes(category)) {
      dropped.push({
        title,
        reason:
          "the category is outside color, typography, spacing, wording, state, placement " +
          "(not a design-system finding)",
      });
      continue;
    }
    if (known.has(normalizeTitle(title))) {
      dropped.push({ title, reason: "the title restates an existing issue" });
      continue;
    }
    const principle = entry.principle;
    if (
      !isRecord(principle) ||
      stringValue(principle.name) === null ||
      stringValue(principle.passage) === null
    ) {
      dropped.push({ title, reason: "the violated principle and its document passage are missing" });
      continue;
    }
    const passage = stringValue(principle.passage)!;
    if (!containsPassage(documents, passage)) {
      dropped.push({ title, reason: "the principle passage does not appear in the design documents" });
      continue;
    }
    let token: DesignFinding["token"];
    if (entry.token !== undefined) {
      if (
        !isRecord(entry.token) ||
        stringValue(entry.token.name) === null ||
        (entry.token.value !== undefined && stringValue(entry.token.value) === null)
      ) {
        dropped.push({ title, reason: "the token is not a name and optional value" });
        continue;
      }
      token = {
        name: stringValue(entry.token.name)!,
        ...(entry.token.value === undefined ? {} : { value: stringValue(entry.token.value)! }),
      };
      if (
        !containsPassage(documents, token.name) ||
        (token.value !== undefined && !containsPassage(documents, token.value))
      ) {
        dropped.push({ title, reason: `the token ${token.name} is not documented` });
        continue;
      }
    }
    if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
      dropped.push({ title, reason: "no evidence was supplied" });
      continue;
    }
    const evidence: DesignEvidence[] = [];
    let evidenceError: string | null = null;
    for (const raw of entry.evidence) {
      if (!isRecord(raw)) {
        evidenceError = "an evidence entry is not an object";
        break;
      }
      const path = stringValue(raw.path);
      const lines = stringValue(raw.lines);
      const quote = stringValue(raw.quote);
      if (path === null || lines === null || quote === null) {
        evidenceError = "an evidence entry lacks its path, line range, or quote";
        break;
      }
      const file = sourceByPath.get(path.replace(/^\.\//, ""));
      if (file === undefined) {
        evidenceError = `${path} is not part of the interface source`;
        break;
      }
      const span = evidenceLines(file, lines);
      if (!span.ok) {
        evidenceError = span.detail;
        break;
      }
      if (!quotedSource(file, span.first, span.last, quote)) {
        evidenceError = `${path}:${lines} does not contain the quoted source`;
        break;
      }
      evidence.push({ path: file.path, lines, quote });
    }
    if (evidenceError !== null) {
      dropped.push({ title, reason: evidenceError });
      continue;
    }
    const files = stringList(entry.files);
    if (files === null || files.some((file) => !sourceByPath.has(file.replace(/^\.\//, "")))) {
      dropped.push({ title, reason: "the affected files are missing or outside the interface source" });
      continue;
    }
    const proposedChange = stringValue(entry.proposedChange);
    if (proposedChange === null) {
      dropped.push({ title, reason: "the proposed change is empty" });
      continue;
    }
    const criteria = stringList(entry.acceptanceCriteria);
    if (criteria === null) {
      dropped.push({ title, reason: "the acceptance criteria are empty" });
      continue;
    }
    known.add(normalizeTitle(title));
    findings.push({
      category: category as DesignCategory,
      title,
      principle: { name: stringValue(principle.name)!, passage },
      ...(token === undefined ? {} : { token }),
      evidence,
      files: files.map((file) => file.replace(/^\.\//, "")),
      proposedChange,
      acceptanceCriteria: criteria,
    });
  }

  const rawDecision = value.documentation ?? { decision: "none" };
  if (!isRecord(rawDecision) || (rawDecision.decision !== "none" && rawDecision.decision !== "edit")) {
    return {
      findings,
      dropped,
      documentation: { decision: "none" },
      documentationError: "the documentation decision is not none or edit",
    };
  }
  if (rawDecision.decision === "none") {
    return { findings, dropped, documentation: { decision: "none" }, documentationError: null };
  }
  const summary = stringValue(rawDecision.summary);
  const rationale = stringValue(rawDecision.rationale);
  const surfaces = Array.isArray(rawDecision.surfaces)
    ? rawDecision.surfaces
        .map(stringValue)
        .filter((entry): entry is string => entry !== null)
        .map((entry) => entry.replace(/^\.\//, ""))
    : [];
  const contradiction = rawDecision.contradiction === true;
  const evidence = Array.isArray(rawDecision.evidence)
    ? rawDecision.evidence.filter((entry): entry is string => typeof entry === "string")
    : [];
  const addsTokens = Array.isArray(rawDecision.addsTokens)
    ? rawDecision.addsTokens.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (summary === null || rationale === null) {
    return {
      findings,
      dropped,
      documentation: { decision: "none" },
      documentationError: "the documentation edit has no summary or rationale",
    };
  }
  const distinct = [...new Set(surfaces)];
  if (distinct.some((surface) => !sourceByPath.has(surface))) {
    return {
      findings,
      dropped,
      documentation: { decision: "none" },
      documentationError: "a documentation surface is outside the interface source",
    };
  }
  const evidenced = distinct.length >= 2;
  const contradicted =
    contradiction &&
    evidence.some((passage) =>
      context.input.documents.some((document) => containsPassage(document.text, passage)),
    );
  if (!evidenced && !contradicted) {
    return {
      findings,
      dropped,
      documentation: { decision: "none" },
      documentationError:
        "the documentation edit is not evidenced by two distinct interface surfaces or an " +
        "internal contradiction",
    };
  }
  // Never legalize a value the cycle simultaneously reports as drift.
  const driftTokens = new Set(
    findings
      .map((finding) => finding.token?.name)
      .filter((name): name is string => name !== undefined)
      .map((name) => name.toLowerCase()),
  );
  const legalizes = addsTokens.some((name) => driftTokens.has(name.toLowerCase()));
  if (legalizes) {
    return {
      findings,
      dropped,
      documentation: { decision: "none" },
      documentationError: "the documentation edit would legalize a reported drift",
    };
  }
  return {
    findings,
    dropped,
    documentation: {
      decision: "edit",
      summary,
      rationale,
      surfaces: distinct,
      contradiction,
      evidence,
      addsTokens,
    },
    documentationError: null,
  };
}
