import { expect, jest, test } from "bun:test";
import { busyWord, createCommandBusy } from "./command-busy.svelte";

const WORDS: Array<[string, string]> = [
  ["Start", "Starting…"],
  ["Stop", "Stopping…"],
  ["Pause", "Pausing…"],
  ["Resume", "Resuming…"],
  ["Save", "Saving…"],
  ["Check", "Checking…"],
  ["Close", "Closing…"],
  ["Send", "Sending…"],
  ["Create", "Creating…"],
  ["Revise", "Revising…"],
  ["Prepare", "Preparing…"],
  ["Reset", "Resetting…"],
  ["Refresh", "Refreshing…"],
  ["Merge", "Merging…"],
  ["Retry", "Retrying…"],
  ["Accept", "Accepting…"],
  ["Refuse", "Refusing…"],
  ["Delete", "Deleting…"],
  ["Discover project", "Discovering…"],
  ["Submit answer", "Submitting…"],
];

test("every command label becomes its present-participle busy word", () => {
  for (const [label, word] of WORDS) expect([label, busyWord(label)]).toEqual([label, word]);
});

test("busy holds until the confirming evidence, then releases the label", () => {
  const box = { value: 1 };
  const command = createCommandBusy({ label: "Start", evidence: () => box.value });
  expect(command.busy).toBe(false);
  command.start();
  expect(command.busy).toBe(true);
  expect(command.word).toBe("Starting…");
  expect(command.notice).toBeNull();
  box.value = 2;
  expect(command.busy).toBe(false);
  expect(command.notice).toBeNull();
});

test("the ceiling releases the label and states the action received no answer", () => {
  jest.useFakeTimers();
  try {
    const box = { value: 1 };
    const command = createCommandBusy({
      label: "Stop",
      evidence: () => box.value,
      ceilingMs: 5,
    });
    command.start();
    expect(command.busy).toBe(true);
    expect(command.notice).toBeNull();
    jest.advanceTimersByTime(5);
    expect(command.busy).toBe(false);
    expect(command.notice).toBe("Stop received no answer.");
    command.dismiss();
    expect(command.notice).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

test("a refused dispatch never waits for an answer or shows the ceiling notice", () => {
  jest.useFakeTimers();
  try {
    const box = { value: 1 };
    const command = createCommandBusy({
      label: "Save limits",
      evidence: () => box.value,
      ceilingMs: 5,
    });
    command.start();
    command.refuse();
    expect(command.busy).toBe(false);
    expect(command.notice).toBeNull();
    jest.advanceTimersByTime(5);
    expect(command.busy).toBe(false);
    expect(command.notice).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

test("a new dispatch clears the previous ceiling notice", () => {
  jest.useFakeTimers();
  try {
    const box = { value: 1 };
    const command = createCommandBusy({
      label: "Save",
      evidence: () => box.value,
      ceilingMs: 5,
    });
    command.start();
    jest.advanceTimersByTime(5);
    expect(command.notice).toBe("Save received no answer.");
    command.start();
    expect(command.busy).toBe(true);
    expect(command.notice).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

test("a confirming frame that arrives after the ceiling drops the notice", () => {
  jest.useFakeTimers();
  try {
    const box = { value: 1 };
    const command = createCommandBusy({
      label: "Start",
      evidence: () => box.value,
      ceilingMs: 5,
    });
    command.start();
    jest.advanceTimersByTime(5);
    expect(command.notice).toBe("Start received no answer.");
    box.value = 2;
    expect(command.notice).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

test("a control reused for another subject drops the previous subject's latch", () => {
  const family = { id: "scout" };
  const lifecycle = { value: "running" };
  const command = createCommandBusy({
    label: "Stop",
    evidence: () => lifecycle.value,
    scope: () => family.id,
  });
  command.start();
  expect(command.busy).toBe(true);
  // The operator opens another running family on the same page component.
  family.id = "dead-code";
  expect(command.busy).toBe(false);
  expect(command.notice).toBeNull();
  // Returning to the family that was stopped re-arms nothing on its own.
  family.id = "scout";
  expect(command.busy).toBe(true);
  lifecycle.value = "stopped";
  expect(command.busy).toBe(false);
});

test("a reused control never shows the ceiling notice on another subject", () => {
  jest.useFakeTimers();
  try {
    const family = { id: "scout" };
    const lifecycle = { value: "running" };
    const command = createCommandBusy({
      label: "Stop",
      evidence: () => lifecycle.value,
      scope: () => family.id,
      ceilingMs: 5,
    });
    command.start();
    family.id = "dead-code";
    jest.advanceTimersByTime(5);
    expect(command.notice).toBeNull();
    family.id = "scout";
    expect(command.notice).toBe("Stop received no answer.");
  } finally {
    jest.useRealTimers();
  }
});

test("a confirmation stays permanent when the evidence returns to its dispatch baseline", () => {
  jest.useFakeTimers();
  try {
    const box = { value: 1 };
    const command = createCommandBusy({
      label: "Start",
      evidence: () => box.value,
      ceilingMs: 5,
    });
    command.start();
    expect(command.busy).toBe(true);
    // The Issues lifecycle answers the command.
    box.value = 2;
    expect(command.busy).toBe(false);
    // Stop returns the lifecycle to its pre-dispatch value.
    box.value = 1;
    expect(command.busy).toBe(false);
    expect(command.notice).toBeNull();
    // The answered dispatch never reaches its ceiling.
    jest.advanceTimersByTime(5);
    expect(command.busy).toBe(false);
    expect(command.notice).toBeNull();
    // Only a new dispatch arms the control.
    command.start();
    expect(command.busy).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});

test("an answered dispatch never repeats its ceiling notice after the evidence returns", () => {
  jest.useFakeTimers();
  try {
    const box = { value: 1 };
    const command = createCommandBusy({
      label: "Start",
      evidence: () => box.value,
      ceilingMs: 5,
    });
    command.start();
    jest.advanceTimersByTime(5);
    expect(command.notice).toBe("Start received no answer.");
    box.value = 2;
    expect(command.notice).toBeNull();
    box.value = 1;
    expect(command.notice).toBeNull();
    expect(command.busy).toBe(false);
    jest.advanceTimersByTime(5);
    expect(command.notice).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});
