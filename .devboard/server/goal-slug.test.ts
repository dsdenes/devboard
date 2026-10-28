import { describe, expect, test } from "bun:test";
import { suggestGoalSlug } from "./goal-slug";

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
