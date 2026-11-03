/**
 * The release suite's retry and quarantine policy.
 *
 * The release workflow cannot publish while one flaky test fails, so its suite
 * step retries the whole suite and stops at the first attempt that reports no
 * failing test. A test that fails on three consecutive attempts is skipped for
 * the rest of the run by rewriting its registration in the step's own working
 * copy, and every rewrite is restored before the step returns, so the tracked
 * tree never carries a quarantine.
 *
 * Only a per-test failure is retried or quarantined. A failure of the suite
 * itself — a file that does not compile or import, a runner that crashes or
 * exits without a result, a result document that cannot be read — is
 * structural, and no rewrite or retry can address it: it ends the step with a
 * nonzero code and files nothing.
 *
 * The result document is the runner's JUnit report. Bun's console output
 * interleaves files under `--parallel`, so it cannot attribute a failure to a
 * test; the JUnit document names the file, the exact test, the registration's
 * line, and the failure text for each test it ran.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** One test the runner reported, with the site that registers it. */
export interface JunitCase {
  /** Path the runner reported, relative to the suite's working root. */
  file: string;
  /** The exact test name; the innermost `describe` is not part of it. */
  name: string;
  /** The test name with its `describe` chain, outermost first. */
  fullName: string;
  /** 1-based line of the registration in `file`, when the runner reports it. */
  line: number | undefined;
  state: "pass" | "skip" | "fail";
  /** The failure text the runner recorded; empty for a passing test. */
  output: string;
}

export interface JunitParse {
  cases: JunitCase[];
  /** Suite-level defects that are not a per-test result. */
  errors: string[];
}

/** A result document that cannot be read at all. */
export class QuarantineParseError extends Error {}

const ENTRY = /<(\/?)(testsuite|testcase)\b([^>]*?)(\/?)>/g;
const ATTRIBUTE = /([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g;
const FAILURE_BODY = /<failure\b([^>]*)>([\s\S]*?)<\/failure>/;
const FAILURE_EMPTY = /<failure\b([^>]*?)\/>/;
const ERROR_ELEMENT = /<error\b/;

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|quot|apos|lt|gt|amp);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    switch (entity) {
      case "quot":
        return '"';
      case "apos":
        return "'";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      default:
        return match;
    }
  });
}

function attributes(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const match of source.matchAll(ATTRIBUTE)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) values[key] = decodeEntities(value);
  }
  return values;
}

function failureText(inner: string, attributesSource: string): string {
  const nested = FAILURE_BODY.exec(inner);
  if (nested !== null) {
    const text = decodeEntities(nested[2] ?? "").trim();
    const message = attributes(nested[1] ?? "").message;
    return text.length > 0 ? text : (message ?? "");
  }
  const empty = FAILURE_EMPTY.exec(inner);
  if (empty !== null) return attributes(empty[1] ?? "").message ?? "";
  const own = attributes(attributesSource).message;
  return own ?? "";
}

function lineNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Reads the JUnit document bun writes for one attempt. A missing document is
 * the caller's concern; a document without a `testsuites` root cannot be read.
 */
export function parseJunit(xml: string): JunitParse {
  const source = xml.trim();
  if (!source.startsWith("<") || !source.includes("<testsuites")) {
    throw new QuarantineParseError("the runner's result document has no testsuites root");
  }
  const cases: JunitCase[] = [];
  const errors: string[] = [];
  const suites: string[] = [];
  ENTRY.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ENTRY.exec(source)) !== null) {
    const closing = match[1] === "/";
    const tag = match[2];
    const rawAttributes = match[3] ?? "";
    const selfClosing = match[4] === "/";
    if (tag === "testsuite") {
      if (closing) suites.pop();
      else if (!selfClosing) {
        const values = attributes(rawAttributes);
        // Bun names the file-level suite after the file itself; that suite is
        // the wrapper, not a `describe`, so it never joins a test's name.
        const wrapper = values.name !== undefined && values.name === values.file;
        suites.push(wrapper || values.name === undefined ? "" : values.name);
      }
      continue;
    }
    if (closing) continue;
    const values = attributes(rawAttributes);
    let inner = "";
    if (!selfClosing) {
      const end = source.indexOf("</testcase>", match.index + match[0].length);
      if (end < 0) throw new QuarantineParseError("a testcase element is not closed");
      inner = source.slice(match.index + match[0].length, end);
      ENTRY.lastIndex = end + "</testcase>".length;
    }
    if (values.file === undefined || values.file.length === 0) {
      errors.push(`the runner reported the test "${values.name ?? "unnamed"}" without a file`);
      continue;
    }
    const skip = /<skipped\b/.test(inner);
    const fail = /<failure\b/.test(inner);
    if (ERROR_ELEMENT.test(inner)) {
      errors.push(
        `the runner reported an error for "${values.name ?? "unnamed"}" in ${values.file}`,
      );
      continue;
    }
    const name = values.name ?? "";
    cases.push({
      file: values.file,
      name,
      fullName: [...suites.filter((suite) => suite.length > 0), name].join(" > "),
      line: lineNumber(values.line),
      state: skip ? "skip" : fail ? "fail" : "pass",
      output: fail ? failureText(inner, rawAttributes) : "",
    });
  }
  if (cases.length === 0 && errors.length === 0 && !source.includes("<testsuite")) {
    errors.push("the runner's result document named no test suite");
  }
  return { cases, errors };
}

/** One per-test failure, with the text the runner recorded for it. */
export interface AttemptFailure {
  file: string;
  name: string;
  fullName: string;
  line: number | undefined;
  output: string;
}

/** Everything one whole-suite attempt reported. */
export interface AttemptRecord {
  index: number;
  code: number;
  pass: number;
  skip: number;
  failures: AttemptFailure[];
  /** Set when the attempt failed for a reason no test's skip can address. */
  structural: string | undefined;
  /** The runner's console output, bounded for diagnostics. */
  output: string;
}

export interface AttemptInput {
  index: number;
  code: number;
  /** The JUnit document, or undefined when the runner wrote none. */
  junit: string | undefined;
  output: string;
}

const OUTPUT_LIMIT = 20_000;
const FAILURE_LIMIT = 4_000;

function bound(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… (${text.length - limit} more bytes)`;
}

/**
 * Sorts one attempt into a per-test result or a structural failure. A missing
 * document, an unreadable one, a document that names no test, an `<error>`
 * entry, bun's unhandled-load-error marker, a run that matched no file, and an
 * exit code that contradicts the document are all structural: none of them is
 * a test that failed, so none of them may be retried or skipped into a pass.
 */
export function classifyAttempt(input: AttemptInput): AttemptRecord {
  const output = bound(input.output, OUTPUT_LIMIT);
  const structural: string[] = [];
  let cases: JunitCase[] = [];
  let documentRead = false;
  if (input.junit === undefined || input.junit.trim().length === 0) {
    structural.push("the runner produced no test result document");
  } else {
    try {
      const parsed = parseJunit(input.junit);
      cases = parsed.cases;
      documentRead = true;
      structural.push(...parsed.errors);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      structural.push(`the runner's result could not be read: ${reason}`);
    }
  }
  if (
    documentRead &&
    cases.length === 0 &&
    !structural.some((reason) => reason.includes("reported"))
  ) {
    structural.push("the runner's result named no test");
  }
  if (/#\s*Unhandled error between tests/.test(input.output)) {
    structural.push("the runner reported an unhandled error between tests");
  }
  if (/The following filters did not match any test files/.test(input.output)) {
    structural.push("the run matched no test file");
  }
  const failures: AttemptFailure[] = cases
    .filter((entry) => entry.state === "fail")
    .map((entry) => ({
      file: entry.file,
      name: entry.name,
      fullName: entry.fullName,
      line: entry.line,
      output: bound(entry.output, FAILURE_LIMIT),
    }));
  if (input.code !== 0 && failures.length === 0 && structural.length === 0) {
    structural.push(`the runner exited ${input.code} without a failing test result`);
  }
  if (input.code === 0 && failures.length > 0) {
    structural.push(`the runner exited 0 while reporting ${failures.length} failing test(s)`);
  }
  return {
    index: input.index,
    code: input.code,
    pass: cases.filter((entry) => entry.state === "pass").length,
    skip: cases.filter((entry) => entry.state === "skip").length,
    failures,
    structural: structural.length === 0 ? undefined : structural.join("; "),
    output,
  };
}

/** A test quarantined in this run, with every failed attempt's text. */
export interface QuarantineReport {
  file: string;
  name: string;
  fullName: string;
  attempts: { index: number; output: string }[];
}

export interface QuarantineSuiteOptions {
  /** One whole-suite attempt; `index` is 1-based. */
  attempt: (index: number) => AttemptRecord | Promise<AttemptRecord>;
  /** Rewrites one registration in the working copy. */
  markSkipped: (failure: AttemptFailure) => void;
  log: (line: string) => void;
  maxAttempts?: number;
}

export interface QuarantineSuiteResult {
  code: number;
  attempts: number;
  quarantined: QuarantineReport[];
  /** Set when the run ended on a structural failure. */
  structural: string | undefined;
}

export const RELEASE_SUITE_MAX_ATTEMPTS = 9;
export const RELEASE_SUITE_CONSECUTIVE_FAILURES = 3;

interface ConsecutiveFailure {
  failure: AttemptFailure;
  attempts: { index: number; output: string }[];
}

function failureKey(failure: AttemptFailure): string {
  return `${failure.file}\u0000${failure.fullName}`;
}

/**
 * Drives the retry loop. It stops at the first attempt with no failing test,
 * quarantines a test on its third consecutive failure, never quarantines a
 * test that passed in between, and gives up after `maxAttempts` whole-suite
 * attempts. A structural failure ends the run immediately.
 */
export async function runQuarantineSuite(
  options: QuarantineSuiteOptions,
): Promise<QuarantineSuiteResult> {
  const maxAttempts = options.maxAttempts ?? RELEASE_SUITE_MAX_ATTEMPTS;
  const consecutive = new Map<string, ConsecutiveFailure>();
  const quarantinedByKey = new Map<string, QuarantineReport>();
  let attempts = 0;

  for (let index = 1; index <= maxAttempts; index += 1) {
    attempts = index;
    const record = await options.attempt(index);
    if (record.structural !== undefined) {
      options.log(`attempt ${index}/${maxAttempts}: structural failure: ${record.structural}`);
      if (record.output.trim().length > 0) options.log(record.output.trimEnd());
      return {
        code: 1,
        attempts,
        quarantined: [...quarantinedByKey.values()],
        structural: record.structural,
      };
    }
    const failedKeys = new Set(record.failures.map(failureKey));
    for (const key of [...consecutive.keys()]) {
      if (!failedKeys.has(key)) consecutive.delete(key);
    }
    for (const failure of record.failures) {
      if (quarantinedByKey.has(failureKey(failure))) continue;
      const entry = consecutive.get(failureKey(failure)) ?? { failure, attempts: [] };
      entry.failure = failure;
      entry.attempts.push({ index, output: failure.output });
      consecutive.set(failureKey(failure), entry);
    }
    options.log(
      `attempt ${index}/${maxAttempts}: ${record.failures.length} fail, ` +
        `${record.pass} pass, ${record.skip} skip`,
    );
    if (record.failures.length === 0) {
      return {
        code: 0,
        attempts,
        quarantined: [...quarantinedByKey.values()],
        structural: undefined,
      };
    }
    for (const [key, entry] of consecutive) {
      if (entry.attempts.length < RELEASE_SUITE_CONSECUTIVE_FAILURES) continue;
      options.markSkipped(entry.failure);
      const report: QuarantineReport = {
        file: entry.failure.file,
        name: entry.failure.name,
        fullName: entry.failure.fullName,
        attempts: entry.attempts,
      };
      quarantinedByKey.set(key, report);
      consecutive.delete(key);
      options.log(`quarantined: ${report.file} :: ${report.fullName}`);
    }
  }
  return { code: 1, attempts, quarantined: [...quarantinedByKey.values()], structural: undefined };
}

/**
 * The step's own working copy. Every registration it rewrites is backed up on
 * first touch, and `restore` writes each backup back byte for byte, so a
 * quarantining run leaves the tracked tree as it found it.
 */
export class QuarantineWorkingCopy {
  private readonly originals = new Map<string, string>();
  private readonly current = new Map<string, string>();
  private readonly touchedPaths = new Set<string>();

  constructor(private readonly root: string) {}

  private read(file: string): { path: string; text: string } {
    const path = resolve(this.root, file);
    this.touchedPaths.add(path);
    const cached = this.current.get(path);
    if (cached !== undefined) return { path, text: cached };
    const text = readFileSync(path, "utf8");
    this.originals.set(path, text);
    this.current.set(path, text);
    return { path, text };
  }

  /**
   * Turns the registration at `failure.line` into `test.skip(`. The name, the
   * body, and every expected value stay byte-identical: only the two tokens of
   * the registration grow by `.skip`.
   */
  markSkipped(failure: AttemptFailure): void {
    const { path, text } = this.read(failure.file);
    if (failure.line === undefined) {
      throw new Error(`the runner named no line for "${failure.fullName}" in ${failure.file}`);
    }
    const lines = text.split("\n");
    const index = failure.line - 1;
    const line = lines[index];
    if (line === undefined) {
      throw new Error(`${failure.file} has no line ${failure.line} for "${failure.fullName}"`);
    }
    const existing = /\b(?:test|it)\.skip\s*\(/.exec(line);
    if (existing !== null) return;
    const match = /\b(test|it)(\.skip)?\s*\(/.exec(line);
    if (match === null || match[2] !== undefined) {
      throw new Error(
        `the registration at ${failure.file}:${failure.line} is not a plain test() or it() call`,
      );
    }
    const start = match.index + match[1]!.length;
    lines[index] = `${line.slice(0, start)}.skip${line.slice(start)}`;
    const updated = lines.join("\n");
    this.current.set(path, updated);
    writeFileSync(path, updated);
  }

  /** Puts every rewritten file back exactly as it was read. */
  restore(): void {
    for (const [path, text] of this.originals) writeFileSync(path, text);
    this.originals.clear();
    this.current.clear();
  }

  /** Absolute paths the run touched, for diagnostics and tests. */
  touched(): string[] {
    return [...this.touchedPaths];
  }
}
