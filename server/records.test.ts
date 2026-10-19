import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRecord, readRecords } from "./records";

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "devboard-adr-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("parseRecord", () => {
  test("reads the title and status from a record", () => {
    const record = parseRecord(
      "0001-example.md",
      "# Example record\n\n- Status: Accepted\n\n## Context\n",
    );

    expect(record).toEqual({
      file: "0001-example.md",
      title: "Example record",
      status: "Accepted",
      pending: false,
    });
  });

  test("marks only Proposed records as pending", () => {
    expect(parseRecord("0002.pending.md", "# Waiting\n\n- Status: Proposed\n").pending).toBe(true);
    expect(parseRecord("0003.accepted.md", "# Done\n\n- Status: Accepted\n").pending).toBe(false);
    expect(parseRecord("0004.rejected.md", "# Done\n\n- Status: Rejected\n").pending).toBe(false);
  });

  test("accepts a status line without a list marker", () => {
    expect(parseRecord("0005.md", "# Title\n\nStatus: Proposed\n").pending).toBe(true);
  });

  test("falls back to the file name when there is no title", () => {
    expect(parseRecord("0006-untitled.md", "- Status: Accepted\n").title).toBe("0006-untitled");
  });
});

describe("readRecords", () => {
  test("orders records by file name and marks the lowest pending record as next", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "0002-second.md"), "# Second\n\n- Status: Proposed\n");
    await writeFile(join(directory, "0001-first.md"), "# First\n\n- Status: Accepted\n");
    await writeFile(join(directory, "0003-third.md"), "# Third\n\n- Status: Proposed\n");
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
    await writeFile(join(directory, "0001-first.md"), "# First\n\n- Status: Accepted\n");

    const list = await readRecords(directory);

    expect(list.records).toHaveLength(1);
    expect(list.next).toBeNull();
  });

  test("reflects records added and removed between reads", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "0001-first.md"), "# First\n\n- Status: Accepted\n");

    expect((await readRecords(directory)).next).toBeNull();

    await writeFile(join(directory, "0002-added.md"), "# Added\n\n- Status: Proposed\n");
    expect((await readRecords(directory)).next).toBe("0002-added.md");

    await rm(join(directory, "0002-added.md"));
    expect((await readRecords(directory)).next).toBeNull();
  });
});
