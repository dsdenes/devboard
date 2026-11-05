import { expect, test } from "bun:test";
import {
  INVALID_FRAME_MESSAGE,
  isInvalidFrameError,
  reloadOnceForStaleBundle,
  STALE_BUNDLE_RELOAD_KEY,
} from "./stale-bundle";

/** A tab session store that records what it keeps. */
function session(entries: Array<[string, string]> = []): {
  storage: Pick<Storage, "getItem" | "setItem">;
  values: Map<string, string>;
} {
  const values = new Map(entries);
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    },
  };
}

test("only the server's refusal of an unknown command counts", () => {
  expect(isInvalidFrameError({ type: "error", message: INVALID_FRAME_MESSAGE })).toBe(true);
  expect(isInvalidFrameError({ type: "error", message: "Unknown background agent: x." })).toBe(false);
  expect(isInvalidFrameError({ type: "flowError", message: INVALID_FRAME_MESSAGE })).toBe(false);
  expect(isInvalidFrameError({ type: "error" })).toBe(false);
});

test("the first refusal in a tab reloads and records the attempt", () => {
  const { storage, values } = session();
  let reloads = 0;

  expect(reloadOnceForStaleBundle(storage, () => reloads += 1)).toBe(true);
  expect(reloads).toBe(1);
  expect(values.get(STALE_BUNDLE_RELOAD_KEY)).toBe("1");
});

test("a refusal after that reload keeps the error instead of reloading again", () => {
  const { storage } = session([[STALE_BUNDLE_RELOAD_KEY, "1"]]);
  let reloads = 0;

  expect(reloadOnceForStaleBundle(storage, () => reloads += 1)).toBe(false);
  expect(reloads).toBe(0);
});

test("a browser without a usable tab session never reloads", () => {
  let reloads = 0;
  expect(reloadOnceForStaleBundle(null, () => reloads += 1)).toBe(false);

  const throwing = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  expect(reloadOnceForStaleBundle(throwing, () => reloads += 1)).toBe(false);
  expect(reloads).toBe(0);
});
