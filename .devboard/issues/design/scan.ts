import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CYCLE_VERSION,
  DESIGN_CATEGORIES,
  auditPath,
  cycleDirectory,
  draftDocumentPath,
  requestPath,
  type DesignConfig,
} from "./paths";
import type { AuditInput } from "./audit";

/**
 * One cycle's on-disk request and answer. The peer reads the audit input and
 * drives only its own draft copies of the two documents; the worker decides
 * whether that draft is admitted, committed, and released.
 */

export interface CycleRequest {
  version: 1;
  cycleId: string;
  repository: string;
  repoDir: string;
  sourceDir: string;
  documents: string[];
  sources: Array<{ path: string; lines: number }>;
  categories: readonly string[];
  knownTitles: string[];
  issueRoom: number;
  createdAt: string;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, "").replace("T", "-").replace("Z", "");
}

let sequence = 0;

export function createCycleDirectory(
  repoDir: string,
  now: Date,
): { cycleId: string; directory: string } {
  const base = `${stamp(now)}-${String(process.pid).padStart(6, "0")}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    sequence += 1;
    const cycleId = `${base}-${String(sequence).padStart(4, "0")}`;
    const directory = cycleDirectory(repoDir, cycleId);
    if (existsSync(directory)) continue;
    mkdirSync(directory, { recursive: true });
    return { cycleId, directory };
  }
  throw new Error("could not allocate a unique design cycle directory");
}

/** Writes the input snapshot, the peer's draft documents, and the request. */
export function writeCycle(
  directory: string,
  options: {
    cycleId: string;
    repository: string;
    repoDir: string;
    input: AuditInput;
    config: DesignConfig;
    knownTitles: string[];
    issueRoom: number;
    now: Date;
  },
): CycleRequest {
  const sourceRoot = resolve(options.repoDir);
  const request: CycleRequest = {
    version: CYCLE_VERSION,
    cycleId: options.cycleId,
    repository: options.repository,
    repoDir: sourceRoot,
    sourceDir: options.config.sourceDir,
    documents: [options.config.designDocument, options.config.tokenDocument],
    sources: options.input.sources.map((file) => ({ path: file.path, lines: file.lines })),
    categories: DESIGN_CATEGORIES,
    knownTitles: [...options.knownTitles].sort(),
    issueRoom: options.issueRoom,
    createdAt: options.now.toISOString(),
  };
  writeFileSync(
    join(directory, "input.json"),
    `${JSON.stringify(
      {
        sources: options.input.sources,
        documents: options.input.documents,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(requestPath(directory), `${JSON.stringify(request, null, 2)}\n`);
  for (const document of options.input.documents) {
    const path = draftDocumentPath(directory, document.path);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, document.text);
  }
  return request;
}

export function promptFor(directory: string): string {
  return `/design-system-audit ${directory}`;
}

export function readAuditText(directory: string): string {
  return readFileSync(auditPath(directory), "utf8");
}

export function readDraftDocument(directory: string, document: string): string {
  return readFileSync(draftDocumentPath(directory, document), "utf8");
}

export function draftChanged(
  directory: string,
  documents: Array<{ path: string; text: string }>,
): boolean {
  return documents.some((document) => {
    try {
      return readDraftDocument(directory, document.path) !== document.text;
    } catch {
      return false;
    }
  });
}

const PRINCIPLE_HEADINGS = ["## Design principles", "## UX principles"] as const;

/** Both principle surfaces exist in the revised prose. */
export function missingPrincipleSections(text: string): string[] {
  return PRINCIPLE_HEADINGS.filter((heading) => !text.includes(heading));
}

/**
 * The token correction is present in both surfaces: every changed leaf name
 * appears in the prose, and the prose's changed names appear in the token
 * document. The documents are compared as text at their own boundary.
 */
export function tokenNames(text: string): Set<string> {
  const names = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, entry] of Object.entries(value)) {
      if (key.startsWith("$")) continue;
      names.add(key);
      if (typeof entry === "object" && entry !== null && "$value" in entry) {
        names.add(key);
        continue;
      }
      walk(entry);
    }
  };
  try {
    walk(JSON.parse(text));
  } catch {
    return names;
  }
  return names;
}

/** Every leaf token name and its serialized value, for correction detection. */
export function tokenValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, entry] of Object.entries(value)) {
      if (key.startsWith("$")) continue;
      if (typeof entry === "object" && entry !== null && "$value" in entry) {
        values.set(key, JSON.stringify(entry.$value));
        continue;
      }
      walk(entry);
    }
  };
  try {
    walk(JSON.parse(text));
  } catch {
    return values;
  }
  return values;
}

export function validTokenDocument(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/** Every token name the cycle adds or corrects is named in the prose tables. */
export function tokensNamedInProse(
  changedTokens: Set<string>,
  prose: string,
): string[] {
  return [...changedTokens].filter((name) => !prose.includes(name));
}
