import { expect, test } from "bun:test";
import { elapsedText, releaseGateFrom, releaseRunFrom } from "./release-run";

function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "run-1",
    state: "running",
    range: "v1.0.0..abc",
    target: "abc",
    version: "1.1.0",
    peerPid: 4242,
    startedAt: "2026-11-13T10:00:00.000Z",
    elapsedMs: 125000,
    phase: "suite",
    phaseElapsedMs: 45000,
    records: [
      {
        at: "2026-11-13T10:00:01.000Z",
        phase: "suite",
        detail: "attempt 1/9: 2 fail, 98 pass, 0 skip",
        attempt: 1,
        passed: 98,
        failed: 2,
      },
    ],
    ...overrides,
  };
}

test("a run frame projects its phase, elapsed times, peer, and records", () => {
  const run = releaseRunFrom(frame());
  expect(run).not.toBeNull();
  expect(run?.id).toBe("run-1");
  expect(run?.range).toBe("v1.0.0..abc");
  expect(run?.target).toBe("abc");
  expect(run?.version).toBe("1.1.0");
  expect(run?.peerPid).toBe(4242);
  expect(run?.elapsedMs).toBe(125000);
  expect(run?.phase).toBe("suite");
  expect(run?.phaseElapsedMs).toBe(45000);
  expect(run?.records.length).toBe(1);
  expect(run?.records[0]?.attempt).toBe(1);
  expect(run?.records[0]?.ciRun).toBeNull();
});

test("a frame without a run is null rather than a half-rendered panel", () => {
  expect(releaseRunFrom(null)).toBeNull();
  expect(releaseRunFrom(undefined)).toBeNull();
  expect(releaseRunFrom(frame({ id: 42 }))).toBeNull();
  expect(releaseRunFrom(frame({ records: [{ at: "x" }] }))).toBeNull();
});

test("a gate frame names its verdict and the range it decided for", () => {
  const gate = releaseGateFrom({
    state: "unreleased",
    at: "2026-11-13T10:00:00.000Z",
    detail: null,
    target: "abc",
    range: "v1.0.0..abc",
    version: "1.1.0",
  });
  expect(gate?.state).toBe("unreleased");
  expect(gate?.range).toBe("v1.0.0..abc");
  expect(gate?.version).toBe("1.1.0");
  expect(releaseGateFrom(null)).toBeNull();
});

test("an elapsed count reads as seconds, minutes, and hours", () => {
  expect(elapsedText(0)).toBe("0s");
  expect(elapsedText(45000)).toBe("45s");
  expect(elapsedText(125000)).toBe("2m 5s");
  expect(elapsedText(3_930_000)).toBe("1h 5m");
  expect(elapsedText(null)).toBe("—");
});
