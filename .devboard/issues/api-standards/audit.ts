import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  apiStandardsConfig,
  type ApiStandardsConfig,
} from "./paths";
import { ApiStandardsInputError, readRestSkill, type RestSkill } from "./rules";

/**
 * The audit turn's input. The worker reads every API source file the dashboard
 * server exposes, inventories the HTTP routes it answers, and carries the REST
 * skill's two normative files. The peer audits and files its own findings
 * through the MCP issue tool; the worker records each decision from the answer
 * the peer writes.
 */

export interface AuditFile {
  /** Repository-relative path, `/` separators. */
  path: string;
  lines: number;
  text: string;
}

/** One route the server answers, derived from its own source. */
export interface RouteEntry {
  /** The concrete pathname, or `*` for the static-file fallback. */
  path: string;
  /** Every HTTP method the branch names; empty when it names none. */
  methods: string[];
  /** `endpoint`, `upgrade`, or `static-fallback`. */
  kind: "endpoint" | "upgrade" | "static-fallback";
  /** The repository-relative file the route was read from. */
  source: string;
  /** The line the route starts on, one-based, or 1 for a derived fallback. */
  line: number;
}

export interface AuditInput {
  sources: AuditFile[];
  routes: RouteEntry[];
  skill: RestSkill;
  /** The configured source directory, repository-relative. */
  sourceDir: string;
}

const ROUTE_PATH = /\.pathname\s*===\s*["'`]([^"'`]+)["'`]/;
const REQUEST_METHOD = /request\.method\s*===\s*"([A-Z]+)"/g;
const METHOD_SET = /METHODS?\s*=\s*\[([^\]]*)\]/;

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.replace(/\n$/, "").split("\n").length;
}

/** A file that routes requests or shapes request parsing and responses. */
function isApiSource(name: string): boolean {
  if (!name.endsWith(".ts")) return false;
  if (name.endsWith(".test.ts") || name.endsWith(".spec.ts")) return false;
  return true;
}

function walk(directory: string, found: string[]): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "fixtures" || entry.name === "node_modules") continue;
      walk(absolute, found);
      continue;
    }
    if (!entry.isFile() || !isApiSource(entry.name)) continue;
    found.push(absolute);
  }
}

function methodsIn(branch: string): string[] {
  const methods = new Set<string>();
  for (const match of branch.matchAll(REQUEST_METHOD)) {
    const method = match[1];
    if (method !== undefined) methods.add(method);
  }
  const declared = METHOD_SET.exec(branch);
  if (declared !== null) {
    for (const part of (declared[1] ?? "").split(",")) {
      const method = part.trim().replace(/["'`]/g, "");
      if (/^[A-Z]+$/.test(method)) methods.add(method);
    }
  }
  return [...methods];
}

/**
 * Every `pathname === "<path>"` branch is a route; the branch body up to the
 * next route names its methods. A `/ws` branch is the upgrade, and a server
 * that serves files keeps a derived static fallback in the inventory. A route
 * added to the source directory appears here on the next cycle with no engine
 * change.
 */
export function routeInventory(sources: readonly AuditFile[]): RouteEntry[] {
  const routes: RouteEntry[] = [];
  let servesFiles = false;
  for (const source of sources) {
    if (/\bBun\.file\(|createReadStream\(|serveStatic\(/.test(source.text)) servesFiles = true;
    const lines = source.text.split(/\r?\n/);
    const starts: number[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = (lines[index] ?? "").trim();
      if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
      if (ROUTE_PATH.test(line)) starts.push(index);
    }
    for (let position = 0; position < starts.length; position += 1) {
      const start = starts[position] ?? 0;
      const end = starts[position + 1] ?? Math.min(lines.length, start + 60);
      const match = ROUTE_PATH.exec(lines[start] ?? "");
      const path = match?.[1];
      if (path === undefined) continue;
      const branch = lines.slice(start, Math.min(end, start + 60)).join("\n");
      routes.push({
        path,
        methods: methodsIn(branch),
        kind: path === "/ws" ? "upgrade" : "endpoint",
        source: source.path,
        line: start + 1,
      });
    }
  }
  if (servesFiles) {
    routes.push({
      path: "*",
      methods: ["GET", "HEAD"],
      kind: "static-fallback",
      source: sources[0]?.path ?? "",
      line: 1,
    });
  }
  routes.sort((left, right) => {
    if (left.path !== right.path) return left.path.localeCompare(right.path);
    return left.source.localeCompare(right.source);
  });
  return routes;
}

function readDocument(root: string, relativePath: string): AuditFile {
  let text: string;
  try {
    text = readFileSync(join(root, relativePath), "utf8");
  } catch {
    throw new ApiStandardsInputError(`${relativePath} is not readable`);
  }
  return {
    path: relativePath.replace(/\\/g, "/"),
    lines: lineCount(text),
    text,
  };
}

/**
 * Reads every TypeScript file below the API source directory that defines
 * routing, request parsing, or responses, plus both skill files. A missing
 * source directory refuses the whole input; an installed npm prefix has no
 * such directory and is refused by name.
 */
export function readAuditInput(
  repoDir: string,
  config: ApiStandardsConfig = apiStandardsConfig(),
): AuditInput {
  const root = resolve(repoDir);
  const sourceRoot = resolve(root, config.sourceDir);
  let sourceStat;
  try {
    sourceStat = lstatSync(sourceRoot);
  } catch {
    throw new ApiStandardsInputError(
      `the canonical harness source checkout has no ${config.sourceDir} directory ` +
        "(an installed npm prefix is refused)",
    );
  }
  if (!sourceStat.isDirectory()) {
    throw new ApiStandardsInputError(`${config.sourceDir} is not a directory`);
  }
  const files: string[] = [];
  walk(sourceRoot, files);
  if (files.length === 0) {
    throw new ApiStandardsInputError(
      `${config.sourceDir} carries no API source file; a cycle cannot audit an empty surface`,
    );
  }
  const sources: AuditFile[] = [];
  for (const absolute of files) {
    const path = relative(root, absolute).split(sep).join("/");
    let text: string;
    try {
      text = readFileSync(absolute, "utf8");
    } catch {
      throw new ApiStandardsInputError(`${path} is not readable`);
    }
    sources.push({ path, lines: lineCount(text), text });
  }
  const skill = readRestSkill(root, config);
  return {
    sources,
    routes: routeInventory(sources),
    skill,
    sourceDir: config.sourceDir,
  };
}
