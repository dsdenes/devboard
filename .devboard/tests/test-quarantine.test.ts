import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  classifyAttempt,
  parseJunit,
  QuarantineWorkingCopy,
  RELEASE_SUITE_MAX_ATTEMPTS,
  runQuarantineSuite,
  type AttemptFailure,
  type AttemptRecord,
} from "../lib/test-quarantine";

const harnessRoot = resolve(import.meta.dir, "..");
const testRoot = join(harnessRoot, ".tmp");
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch(name: string): string {
  const directory = join(testRoot, `quarantine-unit-${name}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(directory, { recursive: true });
  roots.push(directory);
  return directory;
}

const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" assertions="1" failures="1" skipped="1">
  <testsuite name="tests/a.test.ts" file="tests/a.test.ts" tests="4" failures="1" skipped="1">
    <testcase name="top passes" classname="" time="0.001" file="tests/a.test.ts" line="2" />
    <testsuite name="outer" file="tests/a.test.ts" line="3" tests="2" failures="1" skipped="0">
      <testsuite name="inner" file="tests/a.test.ts" line="4" tests="1" failures="1" skipped="0">
        <testcase name="nested fails" classname="inner &gt; outer" file="tests/a.test.ts" line="5" assertions="1">
          <failure type="AssertionError" message="expect(received).toBe(expected)&#10;Expected: &quot;b&quot;">AssertionError: expect(received).toBe(expected)&#10;&#10;Expected: &quot;b&quot;&#10;</failure>
        </testcase>
      </testsuite>
      <testcase name="top skip" classname="outer" file="tests/a.test.ts" line="8">
        <skipped />
      </testcase>
    </testsuite>
  </testsuite>
</testsuites>`;

const PASSING = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1" failures="0">
  <testsuite name="tests/a.test.ts" file="tests/a.test.ts" tests="1" failures="0">
    <testcase name="top passes" file="tests/a.test.ts" line="2" />
  </testsuite>
</testsuites>`;

describe("parseJunit", () => {
  test("reads every case with its file, line, state, and suite chain", () => {
    const parsed = parseJunit(JUNIT);
    expect(parsed.errors).toEqual([]);
    expect(parsed.cases.map((entry) => entry.name)).toEqual([
      "top passes",
      "nested fails",
      "top skip",
    ]);
    expect(parsed.cases.map((entry) => entry.state)).toEqual(["pass", "fail", "skip"]);
    expect(parsed.cases[1]).toMatchObject({
      file: "tests/a.test.ts",
      fullName: "outer > inner > nested fails",
      line: 5,
    });
    expect(parsed.cases[0]?.fullName).toBe("top passes");
    expect(parsed.cases[1]?.output).toContain('Expected: "b"');
    expect(parsed.cases[1]?.output).toContain("\n");
  });

  test("refuses a document without a testsuites root", () => {
    expect(() => parseJunit("no document")).toThrow(/testsuites root/);
  });

  test("names a testcase without a file as a defect rather than a result", () => {
    const parsed = parseJunit(
      `<testsuites><testsuite name="x"><testcase name="lost" /></testsuite></testsuites>`,
    );
    expect(parsed.cases).toEqual([]);
    expect(parsed.errors.join(" ")).toContain("without a file");
  });
});

describe("classifyAttempt", () => {
  const passing = (): AttemptRecord =>
    classifyAttempt({ index: 1, code: 0, junit: PASSING, output: "" });

  test("accepts a per-test failure as retryable", () => {
    const record = classifyAttempt({ index: 1, code: 1, junit: JUNIT, output: "(fail) nested fails" });
    expect(record.structural).toBeUndefined();
    expect(record.failures.map((entry) => entry.fullName)).toEqual(["outer > inner > nested fails"]);
    expect(record.pass).toBe(1);
    expect(record.skip).toBe(1);
  });

  test("reads a passing attempt as success", () => {
    const record = passing();
    expect(record.structural).toBeUndefined();
    expect(record.failures).toEqual([]);
  });

  test("treats a missing document as structural", () => {
    const record = classifyAttempt({ index: 1, code: 1, junit: undefined, output: "Cannot find module" });
    expect(record.structural).toContain("no test result document");
  });

  test("treats an unreadable document as structural", () => {
    const record = classifyAttempt({ index: 1, code: 1, junit: "<html>oops</html>", output: "" });
    expect(record.structural).toContain("could not be read");
  });

  test("treats an error entry as structural", () => {
    const document = `<testsuites><testsuite name="tests/a.test.ts" file="tests/a.test.ts">
      <testcase name="breaks" file="tests/a.test.ts" line="2"><error message="boom" /></testcase>
    </testsuite></testsuites>`;
    const record = classifyAttempt({ index: 1, code: 1, junit: document, output: "" });
    expect(record.structural).toContain("reported an error");
    expect(record.failures).toEqual([]);
  });

  test("treats an unhandled load error and an unmatched filter as structural", () => {
    const load = classifyAttempt({
      index: 1,
      code: 1,
      junit: undefined,
      output: "# Unhandled error between tests",
    });
    expect(load.structural).toContain("unhandled error between tests");
    const filtered = classifyAttempt({
      index: 1,
      code: 1,
      junit: undefined,
      output: "The following filters did not match any test files",
    });
    expect(filtered.structural).toContain("matched no test file");
  });

  test("refuses an exit code that contradicts the document", () => {
    const noFailures = classifyAttempt({
      index: 1,
      code: 1,
      junit: JUNIT.replace('failures="1"', 'failures="0"').replace(/<failure[\s\S]*?<\/failure>/, ""),
      output: "",
    });
    expect(noFailures.structural).toContain("without a failing test result");
    const failuresButZero = classifyAttempt({ index: 1, code: 0, junit: JUNIT, output: "" });
    expect(failuresButZero.structural).toContain("exited 0");
  });
});

function failure(name: string, file = "tests/a.test.ts"): AttemptFailure {
  return { file, name, fullName: name, line: 2, output: `${name} failed` };
}

function failing(index: number, ...names: string[]): AttemptRecord {
  return {
    index,
    code: 1,
    pass: 0,
    skip: 0,
    failures: names.map((name) => failure(name)),
    structural: undefined,
    output: "",
  };
}

function clean(index: number): AttemptRecord {
  return { index, code: 0, pass: 1, skip: 0, failures: [], structural: undefined, output: "" };
}

describe("runQuarantineSuite", () => {
  test("skips a test only after three consecutive failures and stops on a clean attempt", async () => {
    const quarantined: string[] = [];
    const lines: string[] = [];
    const result = await runQuarantineSuite({
      attempt: (index) => (index < 4 ? failing(index, "flaky") : clean(index)),
      markSkipped: (entry) => quarantined.push(entry.fullName),
      log: (line) => lines.push(line),
    });
    expect(result.code).toBe(0);
    expect(result.attempts).toBe(4);
    expect(quarantined).toEqual(["flaky"]);
    expect(result.quarantined[0]?.attempts.map((attempt) => attempt.index)).toEqual([1, 2, 3]);
    expect(lines.some((line) => line.startsWith("quarantined: tests/a.test.ts :: flaky"))).toBe(true);
    expect(lines.at(-1)).toBe("attempt 4/9: 0 fail, 1 pass, 0 skip");
  });

  test("a test that failed twice then passed is never skipped", async () => {
    const quarantined: string[] = [];
    const result = await runQuarantineSuite({
      maxAttempts: 5,
      attempt: (index) => (index < 3 ? failing(index, "intermittent") : clean(index)),
      markSkipped: (entry) => quarantined.push(entry.fullName),
      log: () => {},
    });
    expect(quarantined).toEqual([]);
    expect(result.quarantined).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.attempts).toBe(3);
  });

  test("resets a test's streak when it passes while another test still fails", async () => {
    const quarantined: string[] = [];
    const records = [
      failing(1, "streak", "persistent"),
      failing(2, "streak", "persistent"),
      failing(3, "persistent"),
      clean(4),
    ];
    const result = await runQuarantineSuite({
      attempt: (index) => records[index - 1]!,
      markSkipped: (entry) => quarantined.push(entry.fullName),
      log: () => {},
    });
    expect(quarantined).toEqual(["persistent"]);
    expect(result.quarantined.map((entry) => entry.fullName)).toEqual(["persistent"]);
    expect(result.quarantined[0]?.attempts.map((attempt) => attempt.index)).toEqual([1, 2, 3]);
    expect(result.code).toBe(0);
  });

  test("skips every test that reached the third consecutive failure", async () => {
    const quarantined: string[] = [];
    const result = await runQuarantineSuite({
      attempt: (index) => (index < 4 ? failing(index, "one", "two") : clean(index)),
      markSkipped: (entry) => quarantined.push(entry.fullName),
      log: () => {},
    });
    expect(quarantined).toEqual(["one", "two"]);
    expect(result.attempts).toBe(4);
    expect(result.code).toBe(0);
  });

  test("ends a structural failure immediately, before any skip", async () => {
    const quarantined: string[] = [];
    const lines: string[] = [];
    const result = await runQuarantineSuite({
      attempt: () => ({
        index: 1,
        code: 1,
        pass: 0,
        skip: 0,
        failures: [],
        structural: "the runner produced no test result document",
        output: "error: Cannot find module './gone.ts'",
      }),
      markSkipped: (entry) => quarantined.push(entry.fullName),
      log: (line) => lines.push(line),
    });
    expect(result.code).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.structural).toContain("no test result document");
    expect(result.quarantined).toEqual([]);
    expect(quarantined).toEqual([]);
    expect(lines.join("\n")).toContain("error: Cannot find module './gone.ts'");
  });

  test("stops after nine whole-suite attempts that still fail", async () => {
    const result = await runQuarantineSuite({
      attempt: (index) => failing(index, `distinct-${index}`),
      markSkipped: () => {},
      log: () => {},
    });
    expect(RELEASE_SUITE_MAX_ATTEMPTS).toBe(9);
    expect(result.attempts).toBe(9);
    expect(result.code).toBe(1);
  });
});

describe("QuarantineWorkingCopy", () => {
  const SOURCE = [
    'import { expect, test } from "bun:test";',
    "",
    'test("first fails: copy", () => {',
    "  expect(1).toBe(2);",
    "});",
    "",
    'test("second fails: copy", () => {',
    "  expect(2).toBe(3);",
    "});",
    "",
  ].join("\n");

  test("rewrites only the registration and restores the exact bytes", () => {
    const root = scratch("copy");
    const file = join(root, "tests", "a.test.ts");
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(file, SOURCE);
    const copy = new QuarantineWorkingCopy(root);
    copy.markSkipped({ ...failure("first fails: copy"), line: 3 });
    const rewritten = readFileSync(file, "utf8");
    expect(rewritten).toContain('test.skip("first fails: copy"');
    expect(rewritten).toContain('test("second fails: copy"');
    expect(rewritten.replace(".skip(", "(")).toBe(SOURCE);
    copy.markSkipped({ ...failure("second fails: copy"), line: 7 });
    const both = readFileSync(file, "utf8");
    expect(both.match(/test\.skip\(/g)?.length).toBe(2);
    expect(both.replace(/\.skip\(/g, "(")).toBe(SOURCE);
    copy.restore();
    expect(readFileSync(file, "utf8")).toBe(SOURCE);
    expect(copy.touched()).toEqual([file]);
  });

  test("is idempotent for a registration already skipped", () => {
    const root = scratch("idempotent");
    mkdirSync(join(root, "tests"), { recursive: true });
    const file = join(root, "tests", "a.test.ts");
    writeFileSync(file, SOURCE);
    const copy = new QuarantineWorkingCopy(root);
    copy.markSkipped({ ...failure("first fails: copy"), line: 3 });
    copy.markSkipped({ ...failure("first fails: copy"), line: 3 });
    expect(readFileSync(file, "utf8").match(/test\.skip\(/g)?.length).toBe(1);
    copy.restore();
  });

  test("refuses a registration it cannot rewrite as test.skip(", () => {
    const root = scratch("refuse");
    mkdirSync(join(root, "tests"), { recursive: true });
    const file = join(root, "tests", "a.test.ts");
    writeFileSync(file, 'import { test } from "bun:test";\ntest.each([1])("%s", () => {});\n');
    const copy = new QuarantineWorkingCopy(root);
    expect(() => copy.markSkipped({ ...failure("each"), line: 2 })).toThrow(/plain test\(\)/);
    copy.restore();
    expect(readFileSync(file, "utf8")).toContain("test.each(");
  });
});
