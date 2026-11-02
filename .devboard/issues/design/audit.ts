import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { DEFAULT_SOURCE_DIRECTORY, type DesignConfig } from "./paths";

/**
 * The audit turn's input. The worker reads the interface source and the two
 * normative documents, writes them into the cycle directory, and lets the peer
 * audit and file its own findings through the MCP issue tool. The answer
 * parser that used to reject a whole audit document is gone.
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
