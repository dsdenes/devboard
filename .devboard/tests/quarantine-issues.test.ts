import { describe, expect, test } from "bun:test";
import {
  fileQuarantineReports,
  quarantineCommentBody,
  quarantineIssueBody,
  quarantineIssueTitle,
  type IssueForge,
  type OpenIssue,
} from "../lib/quarantine-issues";
import type { QuarantineReport } from "../lib/test-quarantine";

const CONTEXT = {
  commit: "0123456789abcdef0123456789abcdef01234567",
  runUrl: "http://forge.test/dsdenes/devboard/actions/runs/77",
};

function report(name = "always fails: fixture", file = "tests/a.test.ts"): QuarantineReport {
  return {
    file,
    name,
    fullName: name,
    attempts: [
      { index: 1, output: "AssertionError: first attempt" },
      { index: 2, output: "AssertionError: second attempt" },
      { index: 3, output: "AssertionError: third attempt" },
    ],
  };
}

interface Recorder extends IssueForge {
  created: { title: string; body: string }[];
  comments: { number: number; body: string }[];
}

function forge(options: {
  open?: OpenIssue[];
  listError?: Error;
  createError?: Error;
  commentError?: Error;
} = {}): Recorder {
  const created: { title: string; body: string }[] = [];
  const comments: { number: number; body: string }[] = [];
  let next = 100;
  return {
    created,
    comments,
    async listOpenIssues() {
      if (options.listError !== undefined) throw options.listError;
      return options.open ?? [];
    },
    async createIssue(input) {
      if (options.createError !== undefined) throw options.createError;
      created.push(input);
      return { number: next++ };
    },
    async commentIssue(number, body) {
      if (options.commentError !== undefined) throw options.commentError;
      comments.push({ number, body });
    },
  };
}

describe("quarantine issue text", () => {
  test("the title is one line, within 200 characters, and carries the exact name", () => {
    const title = quarantineIssueTitle(report("a very specific failure: fixture"));
    expect(title).toBe("quarantine(test): a very specific failure: fixture");
    expect(title?.length).toBeLessThanOrEqual(200);
    expect(title ?? "").not.toContain("\n");
  });

  test("the suite chain is dropped before the name when the title would overflow", () => {
    const nested: QuarantineReport = {
      ...report("name that matters: fixture"),
      fullName: `${"suite ".repeat(40)}name that matters: fixture`,
    };
    const title = quarantineIssueTitle(nested);
    expect(title).toBe("quarantine(test): name that matters: fixture");
    expect(title?.length).toBeLessThanOrEqual(200);
  });

  test("no title is offered when the exact name cannot fit", () => {
    expect(quarantineIssueTitle(report("x".repeat(250)))).toBeUndefined();
  });

  test("the body names the file, the test, every attempt, the commit, and the run", () => {
    const body = quarantineIssueBody(report(), CONTEXT);
    expect(body).toContain("tests/a.test.ts");
    expect(body).toContain("always fails: fixture");
    expect(body).toContain("AssertionError: first attempt");
    expect(body).toContain("AssertionError: second attempt");
    expect(body).toContain("AssertionError: third attempt");
    expect(body).toContain(CONTEXT.commit);
    expect(body).toContain(CONTEXT.runUrl);
  });

  test("the comment names the new run and its attempt output", () => {
    const body = quarantineCommentBody(report(), CONTEXT);
    expect(body).toContain(CONTEXT.runUrl);
    expect(body).toContain("AssertionError: third attempt");
    expect(body).toContain(CONTEXT.commit);
  });
});

describe("fileQuarantineReports", () => {
  test("creates one issue when no open issue names the test", async () => {
    const lines: string[] = [];
    const fake = forge();
    await fileQuarantineReports([report()], fake, CONTEXT, (line) => lines.push(line));
    expect(fake.created.length).toBe(1);
    expect(fake.created[0]?.title).toBe("quarantine(test): always fails: fixture");
    expect(fake.created[0]?.body).toContain("tests/a.test.ts");
    expect(fake.comments).toEqual([]);
    expect(lines.join("\n")).toContain("filed issue #100");
  });

  test("comments exactly once on an open issue whose title names the test", async () => {
    const lines: string[] = [];
    const fake = forge({
      open: [{ number: 41, title: "quarantine(test): always fails: fixture" }],
    });
    await fileQuarantineReports([report()], fake, CONTEXT, (line) => lines.push(line));
    expect(fake.created).toEqual([]);
    expect(fake.comments.length).toBe(1);
    expect(fake.comments[0]?.number).toBe(41);
    expect(fake.comments[0]?.body).toContain(CONTEXT.runUrl);
    expect(fake.comments[0]?.body).toContain("third attempt");
    expect(lines.join("\n")).toContain("commented on issue #41");
  });

  test("a create failure is reported on one line and never thrown", async () => {
    const lines: string[] = [];
    const fake = forge({ createError: new Error("HTTP 401: token refused\nsecond line") });
    await fileQuarantineReports([report()], fake, CONTEXT, (line) => lines.push(line));
    const text = lines.join("\n");
    expect(text).toContain("filing failed: create issue");
    expect(text).toContain("HTTP 401: token refused");
    expect(text).not.toContain("second line");
  });

  test("an unreadable open list still attempts the create and reports both failures", async () => {
    const lines: string[] = [];
    const fake = forge({
      listError: new Error("Unable to connect"),
      createError: new Error("Unable to connect"),
    });
    await fileQuarantineReports([report()], fake, CONTEXT, (line) => lines.push(line));
    const text = lines.join("\n");
    expect(text).toContain("filing failed: open issue list: Unable to connect");
    expect(text).toContain("filing failed: create issue");
  });

  test("a comment failure is reported and does not create a duplicate", async () => {
    const lines: string[] = [];
    const fake = forge({
      open: [{ number: 41, title: "always fails: fixture" }],
      commentError: new Error("HTTP 403: forbidden"),
    });
    await fileQuarantineReports([report()], fake, CONTEXT, (line) => lines.push(line));
    expect(fake.created).toEqual([]);
    expect(lines.join("\n")).toContain("filing failed: comment on issue #41: HTTP 403: forbidden");
  });

  test("every quarantined test gets its own issue", async () => {
    const fake = forge();
    await fileQuarantineReports([report("first: fixture"), report("second: fixture")], fake, CONTEXT, () => {});
    expect(fake.created.map((entry) => entry.title)).toEqual([
      "quarantine(test): first: fixture",
      "quarantine(test): second: fixture",
    ]);
  });
});
