import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { suggestGoalSlug } from "./goal-slug";

const STUB_AGENT = join(import.meta.dir, "fixtures", "stub-agent.ts");

describe("suggestGoalSlug", () => {
  test("returns the normalized assistant text", async () => {
    const slug = await suggestGoalSlug("The Start button is clipped.", {
      command: "stub",
      cwd: ".",
      connect: (options) => ({
        run: async () => {
          options.onText?.("`clipped-start-button`");
        },
        close: () => {},
      }),
    });

    expect(slug).toBe("clipped-start-button");
  });

  test("rejects an unusable answer and closes the peer", async () => {
    let closed = false;
    await expect(
      suggestGoalSlug("The Start button is clipped.", {
        command: "stub",
        cwd: ".",
        connect: (options) => ({
          run: async () => {
            options.onText?.("I would call it the clipped start button.");
          },
          close: () => {
            closed = true;
          },
        }),
      }),
    ).rejects.toThrow("no usable slug");
    expect(closed).toBe(true);
  });

  test("cancels the naming peer's permission request and performs no write", async () => {
    const root = join(import.meta.dir, "..", ".tmp");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "goal-slug-"));
    const logPath = join(directory, "agent.log");
    const probePath = join(directory, "permission-probe.txt");
    try {
      const slug = await suggestGoalSlug("The Start button is clipped.", {
        command: [
          `bun ${STUB_AGENT}`,
          "--goal-slug=clipped-start-button",
          `--log=${logPath}`,
          `--permission-probe=${probePath}`,
        ].join(" "),
        cwd: directory,
        timeoutMs: 10_000,
      });

      expect(slug).toBe("clipped-start-button");
      const lines = readFileSync(logPath, "utf8").split("\n").filter((line) => line.length > 0);
      expect(lines).toContain("permission cancelled");
      expect(lines.some((line) => line.startsWith("permission selected"))).toBe(false);
      expect(lines.some((line) => line.startsWith("argv ") && line.includes("--no-skills"))).toBe(
        true,
      );
      expect(existsSync(probePath)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("times out a silent peer and closes it", async () => {
    let closed = false;
    await expect(
      suggestGoalSlug("The Start button is clipped.", {
        command: "stub",
        cwd: ".",
        timeoutMs: 10,
        connect: () => ({
          run: () => Promise.withResolvers<never>().promise,
          close: () => {
            closed = true;
          },
        }),
      }),
    ).rejects.toThrow("did not answer in time");
    expect(closed).toBe(true);
  });
});
