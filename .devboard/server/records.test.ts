import { fixtureRecord } from "./fixtures/adr-source";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readRecords } from "./records";

const temporaryDirectories: string[] = [];
const TEMP_ROOT = join(import.meta.dir, "..", ".tmp");

async function temporaryDirectory() {
  await mkdir(TEMP_ROOT, { recursive: true });
  const directory = await mkdtemp(join(TEMP_ROOT, "records-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("readRecords", () => {
  test("reads the title and status from the frontmatter", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "0001-example.md"), fixtureRecord("0001-example.md", "Example record"));

    const [record] = (await readRecords(directory)).records;

    expect(record).toEqual({
      file: "0001-example.md",
      title: "Example record",
      status: "Accepted",
      pending: false,
      summary: "",
    });
  });

  test("summarizes the first paragraph of the Decision section", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, "0007-decision.md"),
      fixtureRecord(
        "0007-decision.md",
        "A decision",
        "accepted",
        [
          "## Context",
          "",
          "This must not be the summary.",
          "",
          "## Decision",
          "",
          "Use the `boring` runtime for **every** service.",
          "The second sentence stays in the summary.",
          "",
          "## Consequences",
          "",
          "Ignored.",
        ].join("\n"),
      ),
    );

    const [record] = (await readRecords(directory)).records;

    expect(record?.summary).toBe(
      "Use the boring runtime for every service. The second sentence stays in the summary.",
    );
  });

  test("shortens a long decision paragraph at a word boundary", async () => {
    const directory = await temporaryDirectory();
    const paragraph = `${"word ".repeat(80)}end.`;
    await writeFile(
      join(directory, "0008-long.md"),
      fixtureRecord("0008-long.md", "Long", "proposed", `## Decision\n\n${paragraph}\n`),
    );

    const [record] = (await readRecords(directory)).records;

    expect(record?.summary.length).toBeLessThanOrEqual(281);
    expect(record?.summary.endsWith("…")).toBe(true);
    expect(record?.summary.startsWith("word word")).toBe(true);
  });

  test("marks draft and proposed records as pending", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "0001-draft.md"), fixtureRecord("0001-draft.md", "Draft", "draft"));
    await writeFile(
      join(directory, "0002-proposed.md"),
      fixtureRecord("0002-proposed.md", "Proposed", "proposed"),
    );
    await writeFile(join(directory, "0003-accepted.md"), fixtureRecord("0003-accepted.md", "Accepted"));
    await writeFile(
      join(directory, "0004-rejected.md"),
      fixtureRecord("0004-rejected.md", "Rejected", "rejected"),
    );
    await writeFile(
      join(directory, "0005-deprecated.md"),
      fixtureRecord("0005-deprecated.md", "Deprecated", "deprecated"),
    );

    const list = await readRecords(directory);

    expect(list.records.map((record) => [record.file, record.status, record.pending])).toEqual([
      ["0001-draft.md", "Draft", true],
      ["0002-proposed.md", "Proposed", true],
      ["0003-accepted.md", "Accepted", false],
      ["0004-rejected.md", "Rejected", false],
      ["0005-deprecated.md", "Deprecated", false],
    ]);
    expect(list.next).toBe("0001-draft.md");
  });

  test("leaves a file without valid frontmatter out of the list, pending set and next", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "0001-invalid.md"), "# Invalid\n\nNo frontmatter here.\n");
    await writeFile(join(directory, "0002-valid.md"), fixtureRecord("0002-valid.md", "Valid", "proposed"));

    const list = await readRecords(directory);

    expect(list.records.map((record) => record.file)).toEqual(["0002-valid.md"]);
    expect(list.next).toBe("0002-valid.md");
  });

  test("orders records by file name and marks the lowest pending record as next", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, "0002-second.md"),
      fixtureRecord("0002-second.md", "Second", "proposed"),
    );
    await writeFile(join(directory, "0001-first.md"), fixtureRecord("0001-first.md", "First"));
    await writeFile(
      join(directory, "0003-third.md"),
      fixtureRecord("0003-third.md", "Third", "proposed"),
    );
    await writeFile(join(directory, "notes.txt"), "not a record");

    const list = await readRecords(directory);

    expect(list.records.map((record) => record.file)).toEqual([
      "0001-first.md",
      "0002-second.md",
      "0003-third.md",
    ]);
    expect(list.next).toBe("0002-second.md");
  });

  test("returns null next when every record is resolved", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "0001-first.md"), fixtureRecord("0001-first.md", "First"));

    const list = await readRecords(directory);

    expect(list.records).toHaveLength(1);
    expect(list.next).toBeNull();
  });

  test("reflects records added and removed between reads", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "0001-first.md"), fixtureRecord("0001-first.md", "First"));

    expect((await readRecords(directory)).next).toBeNull();

    await writeFile(
      join(directory, "0002-added.md"),
      fixtureRecord("0002-added.md", "Added", "proposed"),
    );
    expect((await readRecords(directory)).next).toBe("0002-added.md");

    await rm(join(directory, "0002-added.md"));
    expect((await readRecords(directory)).next).toBeNull();
  });

  test("treats an absent record directory as an empty list", async () => {
    const directory = join(await temporaryDirectory(), "removed");

    expect(await readRecords(directory)).toEqual({ records: [], next: null });
  });
});
