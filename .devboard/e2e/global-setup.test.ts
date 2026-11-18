/**
 * The suite's version probe settles on a binary that never starts.
 *
 * A spawn that fails emits `error` and `close` and never `exit`, so a probe
 * settled only on `exit` awaits forever and the global setup never reaches a
 * spec. Every case below settles inside the test's own timeout.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { harnessVersionOf } from "./global-setup.ts";
import { tmpDir } from "./support.ts";

const scratch = path.join(tmpDir, "version-probe");

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function stub(name: string, body: string): string {
  mkdirSync(scratch, { recursive: true });
  const file = path.join(scratch, name);
  writeFileSync(file, body, { mode: 0o755 });
  return file;
}

describe("harnessVersionOf", () => {
  test("names the binary it could not start", async () => {
    const missing = path.join(scratch, "absent", "devboard");
    await expect(harnessVersionOf(missing)).rejects.toThrow(
      `the suite's devboard binary could not be run: ${missing}`,
    );
  });

  test("reads the last token a working binary prints", async () => {
    const working = stub("devboard-working", "#!/bin/sh\nprintf 'devboard 9.9.9\\n'\n");
    expect(await harnessVersionOf(working)).toBe("9.9.9");
  });

  test("refuses a nonzero probe", async () => {
    const failing = stub("devboard-failing", "#!/bin/sh\nexit 3\n");
    await expect(harnessVersionOf(failing)).rejects.toThrow(
      `devboard version failed: ${failing}: exited 3`,
    );
  });
});
