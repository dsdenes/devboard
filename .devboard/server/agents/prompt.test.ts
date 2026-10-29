import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildRequest, createScanDirectory } from "../../issues/scout/scan";
import { settingsPath, statePath } from "../../issues/scout/paths";
import { emptyState, writeSettings, writeState } from "../../issues/scout/state";
import { agentRegistry } from "./registry";
import {
  AgentPromptController,
  buildChatPrompt,
  parsePromptProposal,
} from "./prompt";

const roots: string[] = [];
const PROMPT = "---\ndescription: fixture\n---\n\n# Fixture prompt\n\nKeep this byte for byte.\n";
const CHAT_STUB = join(import.meta.dir, "..", "..", "tests", "fixtures", "prompt-stub-acp.ts");
const HARNESS_ROOT = join(import.meta.dir, "..", "..");

async function temporaryRoot(name: string): Promise<string> {
  const base = join(HARNESS_ROOT, ".tmp", "prompt-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, `${name}-`));
  roots.push(root);
  return root;
}

/** A fixture that `isHarnessSourceCheckout` accepts, with one prompt file. */
async function sourceRoot(name = "source"): Promise<string> {
  const root = await temporaryRoot(name);
  mkdirSync(join(root, ".devboard", "prompts"), { recursive: true });
  writeFileSync(
    join(root, ".devboard", "package.json"),
    `${JSON.stringify({ name: "@dsdenes/devboard", version: "0.1.0" }, null, 2)}\n`,
  );
  writeFileSync(join(root, ".devboard", "prompts", "scout-recommendations.md"), PROMPT);
  mkdirSync(join(root, ".devboard", "goal-proposals"), { recursive: true });
  writeFileSync(
    join(root, ".devboard", "goal-proposals", "draft.md"),
    "# A Draft Heading\n\nbody\n",
  );
  return root;
}

function controller(
  root: string,
  options: { stateDir?: string; agentCommand?: string } = {},
): AgentPromptController {
  return new AgentPromptController({
    registry: agentRegistry,
    repoDir: root,
    stateDir: options.stateDir ?? join(root, ".devboard", ".tmp", "state"),
    agentCommand: options.agentCommand ?? `bun ${CHAT_STUB}`,
    agentEnvironment: async () => ({ ...process.env }),
    harnessDir: HARNESS_ROOT,
    send: () => undefined,
    now: () => new Date("2026-10-29T12:00:00Z"),
  });
}

function seededState(root: string): void {
  const stateDir = join(root, ".devboard", ".tmp", "state");
  const state = emptyState({ repo: "acme/fixture", root });
  state.issues = [
    {
      number: 101,
      title: "Open  Scout Issue",
      url: "https://example.test/101",
      createdAt: "2026-10-29T11:30:00Z",
      state: "pending",
      category: "clarity",
      version: null,
    },
    {
      number: 102,
      title: "Shipped Scout Issue",
      url: "https://example.test/102",
      createdAt: "2026-10-29T11:00:00Z",
      state: "implemented",
      category: "tests",
      version: "v1.0.0",
    },
  ];
  state.openTitles = ["Existing open issue"];
  writeState(statePath(stateDir, root), state);
  writeSettings(settingsPath(stateDir, root), {
    maxPerHour: 10,
    maxPending: 5,
    intervalMinutes: 1,
  });
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("prompt snapshot", () => {
  test("Auto Scout publishes the exact file, its invocation, and the next request", async () => {
    const root = await sourceRoot();
    seededState(root);
    const prompt = controller(root).snapshot("scout");
    expect(prompt?.absent).toBe(false);
    expect(prompt?.editable).toBe(true);
    expect(prompt?.text).toBe(PROMPT);
    expect(prompt?.command).toBe(
      `/scout-recommendations ${join(root, ".devboard", ".tmp", "scout", "scans", "<scan-id>")}`,
    );
    expect(prompt?.error).toBeNull();
    const request = prompt?.request;
    expect(request).not.toBeNull();
    expect(request?.scanId).toBeNull();
    expect(request?.createdAt).toBeNull();
    expect(request?.repository).toBe("acme/fixture");
    expect(request?.repositoryPath).toBe(root);
    expect(request?.requested).toBe(4);
    expect(request?.significanceThreshold).toBe(4);
    expect(request?.categories).toEqual([
      "clarity",
      "structure",
      "naming",
      "tests",
      "robustness",
      "correctness",
    ]);
    expect(request?.excludedRoots).toEqual([
      ".git",
      "node_modules",
      "dist",
      ".worktree",
      ".tmp",
      ".devboard/.tmp",
    ]);
    expect(request?.knownTitles).toEqual([
      "a draft heading",
      "existing open issue",
      "open scout issue",
      "shipped scout issue",
    ]);
    expect(request?.draftGoalHeadings).toEqual(["A Draft Heading"]);
  });

  test("the preview equals the worker's buildRequest except the assigned fields", async () => {
    const root = await sourceRoot();
    seededState(root);
    const prompt = controller(root).snapshot("scout");
    const scan = createScanDirectory(root, new Date("2026-10-29T12:00:00Z"));
    const written = buildRequest({
      scan,
      repository: "acme/fixture",
      repoDir: root,
      requested: 4,
      knownTitles: prompt?.request?.knownTitles ?? [],
      draftGoalHeadings: prompt?.request?.draftGoalHeadings ?? [],
    });
    expect(
      { ...written, scanId: null, createdAt: null } as unknown as Record<string, unknown>,
    ).toEqual(prompt?.request as unknown as Record<string, unknown>);
  });

  test("Watchdog has no prompt at all", async () => {
    const root = await sourceRoot();
    const prompt = controller(root).snapshot("watchdog");
    expect(prompt).toEqual({
      id: "watchdog",
      absent: true,
      editable: false,
      command: null,
      text: null,
      request: null,
      error: null,
    });
  });
});

describe("prompt save", () => {
  test("writes the editor's exact bytes and nothing else", async () => {
    const root = await sourceRoot();
    const promptFile = join(root, ".devboard", "prompts", "scout-recommendations.md");
    const before = await readdir(join(root, ".devboard", "prompts"));
    const frames: unknown[] = [];
    const save = controller(root);
    save.save({ send: (data) => frames.push(JSON.parse(data)) }, "scout", "one line\n");
    expect(readFileSync(promptFile, "utf8")).toBe("one line\n");
    expect(await readdir(join(root, ".devboard", "prompts"))).toEqual(before);
    expect(frames).toContainEqual({
      type: "agentPromptSaved",
      id: "scout",
      text: "one line\n",
      notice: "Prompt saved. The next scan reads this file.",
    });
    expect(save.snapshot("scout")?.text).toBe("one line\n");
  });

  test("an installed prefix refuses and leaves the file byte-identical", async () => {
    const root = await temporaryRoot("installed");
    mkdirSync(join(root, ".devboard", "prompts"), { recursive: true });
    const promptFile = join(root, ".devboard", "prompts", "scout-recommendations.md");
    writeFileSync(promptFile, PROMPT);
    const frames: Array<Record<string, unknown>> = [];
    const installed = controller(root);
    installed.save({ send: (data) => frames.push(JSON.parse(data) as Record<string, unknown>) }, "scout", "x");
    expect(readFileSync(promptFile, "utf8")).toBe(PROMPT);
    expect(frames[0]?.type).toBe("agentPromptError");
    expect(String(frames[0]?.message)).toContain("harness source checkout");
    expect(installed.snapshot("scout")?.editable).toBe(false);
  });

  test("a failed write reports an error, keeps the file, and shows no success", async () => {
    const root = await sourceRoot();
    const promptFile = join(root, ".devboard", "prompts", "scout-recommendations.md");
    renameSync(promptFile, `${promptFile}.aside`);
    mkdirSync(promptFile);
    const frames: Array<Record<string, unknown>> = [];
    controller(root).save(
      { send: (data) => frames.push(JSON.parse(data) as Record<string, unknown>) },
      "scout",
      "replacement\n",
    );
    expect(frames.some((frame) => frame.type === "agentPromptSaved")).toBe(false);
    const failure = frames.find((frame) => frame.type === "agentPromptError");
    expect(failure).toBeDefined();
    expect(String(failure?.message)).toContain("Could not write the Auto Scout prompt");
    expect(existsSync(`${promptFile}.aside`)).toBe(true);
    expect(readFileSync(`${promptFile}.aside`, "utf8")).toBe(PROMPT);
  });

  test("Watchdog refuses every prompt command", async () => {
    const root = await sourceRoot();
    const frames: Array<Record<string, unknown>> = [];
    const prompts = controller(root);
    prompts.save({ send: (data) => frames.push(JSON.parse(data) as Record<string, unknown>) }, "watchdog", "x");
    expect(frames[0]?.type).toBe("agentPromptError");
    expect(String(frames[0]?.message)).toContain("runs no agent and has no prompt");
    expect(existsSync(join(root, ".devboard", "prompts", "scout-recommendations.md"))).toBe(true);
    expect(readFileSync(join(root, ".devboard", "prompts", "scout-recommendations.md"), "utf8")).toBe(
      PROMPT,
    );
  });
});

describe("prompt chat", () => {
  test("streams one reply, proposes text, and never writes the file", async () => {
    const root = await sourceRoot();
    seededState(root);
    const promptFile = join(root, ".devboard", "prompts", "scout-recommendations.md");
    const frames: Array<Record<string, unknown>> = [];
    const prompts = controller(root, {
      agentCommand: `bun ${CHAT_STUB}`,
    });
    const target = {
      send: (data: string) => frames.push(JSON.parse(data) as Record<string, unknown>),
    };
    const stateBefore = readFileSync(
      statePath(join(root, ".devboard", ".tmp", "state"), root),
      "utf8",
    );
    await prompts.chat(target, "scout", "Tighten the evidence rule.", PROMPT);
    prompts.dispose();
    expect(
      readFileSync(statePath(join(root, ".devboard", ".tmp", "state"), root), "utf8"),
    ).toBe(stateBefore);
    const chunks = frames.filter((frame) => frame.type === "agentPromptChat");
    expect(chunks.length).toBeGreaterThan(0);
    expect(
      chunks.map((frame) => String(frame.text)).join(""),
    ).toContain("Here is the revision.");
    const done = frames.find((frame) => frame.type === "agentPromptChatDone");
    expect(done?.proposal).toBe("# Revised prompt\n\nFollow it.\n");
    expect(readFileSync(promptFile, "utf8")).toBe(PROMPT);
    expect(frames.some((frame) => frame.type === "agentPromptError")).toBe(false);
  });

  test("a failed turn reports a chat error and leaves the editor base alone", async () => {
    const root = await sourceRoot();
    const promptFile = join(root, ".devboard", "prompts", "scout-recommendations.md");
    const frames: Array<Record<string, unknown>> = [];
    const prompts = controller(root, {
      agentCommand: `env PROMPT_STUB_FAIL=1 bun ${CHAT_STUB}`,
    });
    await prompts.chat(
      { send: (data) => frames.push(JSON.parse(data) as Record<string, unknown>) },
      "scout",
      "Change it.",
      PROMPT,
    );
    prompts.dispose();
    const failure = frames.find((frame) => frame.type === "agentPromptChatError");
    expect(failure).toBeDefined();
    expect(readFileSync(promptFile, "utf8")).toBe(PROMPT);
  });

  test("an installed prefix refuses chat without spawning", async () => {
    const root = await temporaryRoot("installed-chat");
    mkdirSync(join(root, ".devboard", "prompts"), { recursive: true });
    writeFileSync(join(root, ".devboard", "prompts", "scout-recommendations.md"), PROMPT);
    const frames: Array<Record<string, unknown>> = [];
    const prompts = controller(root, { agentCommand: "definitely-not-an-agent" });
    await prompts.chat(
      { send: (data) => frames.push(JSON.parse(data) as Record<string, unknown>) },
      "scout",
      "Change it.",
      PROMPT,
    );
    expect(frames[0]?.type).toBe("agentPromptChatError");
    expect(String(frames[0]?.message)).toContain("harness source checkout");
  });
});

describe("prompt proposal parsing", () => {
  test("takes the last complete fenced block", () => {
    const reply = [
      "First:",
      "<prompt-file>",
      "old",
      "</prompt-file>",
      "Second:",
      "<prompt-file>",
      "# Title",
      "```json",
      "{ \"a\": 1 }",
      "```",
      "</prompt-file>",
      "done",
    ].join("\n");
    expect(parsePromptProposal(reply)).toBe("# Title\n```json\n{ \"a\": 1 }\n```\n");
  });

  test("returns null without a complete block", () => {
    expect(parsePromptProposal("no proposal here")).toBeNull();
    expect(parsePromptProposal("<prompt-file>\nunfinished")).toBeNull();
  });

  test("the chat prompt carries the base and the operator request", () => {
    const prompt = buildChatPrompt("Rules", "BASE\n", "Make it shorter.");
    expect(prompt).toContain("Rules");
    expect(prompt).toContain("BASE\n");
    expect(prompt).toContain("Make it shorter.");
  });
});
