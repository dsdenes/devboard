import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { settingsPath, statePath } from "../../issues/scout/paths";
import { emptyState, writeSettings, writeState } from "../../issues/scout/state";
import { coachDirectory } from "../../coach/paths";
import { readCoachSettings } from "../../coach/settings";
import {
  COACH_PROMPT_ISSUES_UNAVAILABLE,
  coachPromptTemplate,
} from "../../coach/synthesize";
import { agentRegistry } from "./registry";
import {
  AgentPromptController,
  DiscoverPromptController,
  buildChatPrompt,
  parsePromptProposal,
} from "./prompt";
import { DISCOVER_AGENTS } from "./registry";

const roots: string[] = [];
const PROMPT = "---\ndescription: fixture\n---\n\n# Fixture prompt\n\nKeep this byte for byte.\n";
const DESIGN_PROMPT = "---\ndescription: design fixture\n---\n\n# Design prompt\n";
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
  writeFileSync(join(root, ".devboard", "prompts", "design-system.md"), DESIGN_PROMPT);
  return root;
}

function controller(root: string, options: { agentCommand?: string } = {}): AgentPromptController {
  return new AgentPromptController({
    registry: agentRegistry,
    repoDir: root,
    agentCommand: options.agentCommand ?? `bun ${CHAT_STUB}`,
    agentEnvironment: async () => ({ ...process.env }),
    harnessDir: HARNESS_ROOT,
    send: () => undefined,
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
      versionAttemptAt: null,
      versionError: null,
    },
    {
      number: 102,
      title: "Shipped Scout Issue",
      url: "https://example.test/102",
      createdAt: "2026-10-29T11:00:00Z",
      state: "implemented",
      category: "tests",
      version: "v1.0.0",
      versionAttemptAt: null,
      versionError: null,
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
  test("Auto Scout publishes the exact file and its invocation", async () => {
    const root = await sourceRoot();
    seededState(root);
    const prompt = controller(root).snapshot("scout");
    expect(prompt?.absent).toBe(false);
    expect(prompt?.editable).toBe(true);
    expect(prompt?.text).toBe(PROMPT);
    expect(prompt?.error).toBeNull();
  });

  test("Design System publishes its own prompt file", async () => {
    const root = await sourceRoot();
    const prompt = controller(root).snapshot("design");
    expect(prompt?.absent).toBe(false);
    expect(prompt?.editable).toBe(true);
    expect(prompt?.text).toBe(DESIGN_PROMPT);
    expect(prompt?.error).toBeNull();
  });

  test("Watchdog has no prompt at all", async () => {
    const root = await sourceRoot();
    const prompt = controller(root).snapshot("watchdog");
    expect(prompt).toEqual({
      id: "watchdog",
      absent: true,
      editable: false,
      text: null,
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

  test("Design System saves its own file and names the next cycle", async () => {
    const root = await sourceRoot();
    const designFile = join(root, ".devboard", "prompts", "design-system.md");
    const scoutFile = join(root, ".devboard", "prompts", "scout-recommendations.md");
    const frames: unknown[] = [];
    controller(root).save(
      { send: (data) => frames.push(JSON.parse(data)) },
      "design",
      "design bytes\n",
    );
    expect(readFileSync(designFile, "utf8")).toBe("design bytes\n");
    expect(readFileSync(scoutFile, "utf8")).toBe(PROMPT);
    expect(frames).toContainEqual({
      type: "agentPromptSaved",
      id: "design",
      text: "design bytes\n",
      notice: "Prompt saved. The next cycle reads this file.",
    });
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

  test("a failure after the staged write keeps both prompts' previous bytes", async () => {
    const root = await sourceRoot("staged-failure");
    writeFileSync(
      join(root, ".devboard", "prompts", "discover-naming-conventions.md"),
      "---\ndescription: discover fixture\n---\n\n# Naming prompt\n",
    );
    const fixture = join(HARNESS_ROOT, "tests", "fixtures", "prompt-save-rename-failure.ts");
    const child = Bun.spawn({
      cmd: [process.execPath, fixture, root],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("Watchdog refuses every prompt command", async () => {
    const root = await sourceRoot();
    const frames: Array<Record<string, unknown>> = [];
    const prompts = controller(root);
    prompts.save({ send: (data) => frames.push(JSON.parse(data) as Record<string, unknown>) }, "watchdog", "x");
    expect(frames[0]?.type).toBe("agentPromptError");
    expect(String(frames[0]?.message)).toBe(
      "Watchdog runs no agent, so it has no prompt to show or edit.",
    );
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

  test("Design System chat reads its own instructions and target, never Scout's", async () => {
    const root = await sourceRoot();
    seededState(root);
    const capture = join(root, "design-chat-prompt.txt");
    const frames: Array<Record<string, unknown>> = [];
    const prompts = controller(root, {
      agentCommand: `env PROMPT_STUB_CAPTURE=${capture} bun ${CHAT_STUB}`,
    });
    await prompts.chat(
      { send: (data) => frames.push(JSON.parse(data) as Record<string, unknown>) },
      "design",
      "Clarify the evidence rule.",
      DESIGN_PROMPT,
    );
    prompts.dispose();
    const received = readFileSync(capture, "utf8");
    expect(received).toContain(".devboard/prompts/design-system.md");
    expect(received).toContain("audit.json");
    expect(received).toContain("DESIGN.md");
    expect(received).not.toContain("scout-recommendations.md");
    expect(received).not.toContain("Auto Scout");
    expect(received).toContain(DESIGN_PROMPT);
    expect(frames.find((frame) => frame.type === "agentPromptChatDone")?.proposal).toBe(
      "# Revised prompt\n\nFollow it.\n",
    );
    expect(frames.some((frame) => frame.type === "agentPromptChatError")).toBe(false);
  });

  test("Auto Scout chat still reads the Scout instructions and target", async () => {
    const root = await sourceRoot();
    seededState(root);
    const capture = join(root, "scout-chat-prompt.txt");
    const frames: Array<Record<string, unknown>> = [];
    const prompts = controller(root, {
      agentCommand: `env PROMPT_STUB_CAPTURE=${capture} bun ${CHAT_STUB}`,
    });
    await prompts.chat(
      { send: (data) => frames.push(JSON.parse(data) as Record<string, unknown>) },
      "scout",
      "Tighten the evidence rule.",
      PROMPT,
    );
    prompts.dispose();
    const received = readFileSync(capture, "utf8");
    expect(received).toContain(".devboard/prompts/scout-recommendations.md");
    expect(received).not.toContain(".devboard/prompts/design-system.md");
    expect(received).not.toContain("design-prompt-chat.md");
    expect(received).toContain(PROMPT);
    expect(frames.some((frame) => frame.type === "agentPromptChatError")).toBe(false);
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

const DISCOVER_PROMPT_FILES = [
  "discover-sheet.md",
  "discover-contribution.md",
  "discover-testing-strategy.md",
  "discover-naming-conventions.md",
  "discover-coding-conventions.md",
  "discover-architecture-boundaries.md",
  "discover-glossary.md",
];

/** A fixture that `isHarnessSourceCheckout` accepts, with the seven prompts. */
async function discoverSourceRoot(name = "discover-source"): Promise<string> {
  const root = await temporaryRoot(name);
  mkdirSync(join(root, ".devboard", "prompts"), { recursive: true });
  writeFileSync(
    join(root, ".devboard", "package.json"),
    `${JSON.stringify({ name: "@dsdenes/devboard", version: "0.1.0" }, null, 2)}\n`,
  );
  for (const file of DISCOVER_PROMPT_FILES) {
    writeFileSync(
      join(root, ".devboard", "prompts", file),
      readFileSync(join(HARNESS_ROOT, "prompts", file), "utf8"),
    );
  }
  return root;
}

function discoverController(
  root: string,
  options: { agentCommand?: string } = {},
): DiscoverPromptController {
  return new DiscoverPromptController({
    repoDir: root,
    agentCommand: options.agentCommand ?? `bun ${CHAT_STUB}`,
    agentEnvironment: async () => ({ ...process.env }),
    harnessDir: HARNESS_ROOT,
    send: () => undefined,
  });
}

describe("discover prompt snapshots", () => {
  test("each of the seven agents publishes exactly its own prompt file bytes", async () => {
    const root = await discoverSourceRoot();
    const prompts = discoverController(root);
    const seen = new Set<string>();
    for (const descriptor of DISCOVER_AGENTS) {
      const prompt = prompts.snapshot(descriptor.id);
      expect(prompt?.agent).toBe(descriptor.id);
      expect(prompt?.editable).toBe(true);
      expect(prompt?.error).toBeNull();
      const bytes = readFileSync(join(HARNESS_ROOT, "prompts", descriptor.promptFile), "utf8");
      expect(prompt?.text).toBe(bytes);
      expect(seen.has(bytes)).toBe(false);
      seen.add(bytes);
    }
    expect(seen.size).toBe(7);
    prompts.dispose();
  });

  test("an installed prefix shows every prompt read-only", async () => {
    const root = await temporaryRoot("discover-installed");
    mkdirSync(join(root, ".devboard", "prompts"), { recursive: true });
    for (const file of DISCOVER_PROMPT_FILES) {
      writeFileSync(join(root, ".devboard", "prompts", file), `# ${file}\n`);
    }
    const prompts = discoverController(root, { agentCommand: "definitely-not-an-agent" });
    for (const descriptor of DISCOVER_AGENTS) {
      const prompt = prompts.snapshot(descriptor.id);
      expect(prompt?.editable).toBe(false);
      expect(prompt?.text).toBe(`# ${descriptor.promptFile}\n`);
    }
    prompts.dispose();
  });
});

describe("discover prompt save", () => {
  test("writes exactly one agent's prompt file and nothing else", async () => {
    const root = await discoverSourceRoot();
    const prompts = discoverController(root);
    const before = new Map(
      DISCOVER_PROMPT_FILES.map((file) => [
        file,
        readFileSync(join(root, ".devboard", "prompts", file), "utf8"),
      ]),
    );
    const frames: Array<Record<string, unknown>> = [];
    prompts.save(
      { send: (data) => frames.push(JSON.parse(data) as Record<string, unknown>) },
      "discover-naming-conventions",
      "exact bytes\n",
    );
    expect(readFileSync(join(root, ".devboard", "prompts", "discover-naming-conventions.md"), "utf8")).toBe(
      "exact bytes\n",
    );
    for (const [file, text] of before) {
      if (file === "discover-naming-conventions.md") continue;
      expect(readFileSync(join(root, ".devboard", "prompts", file), "utf8")).toBe(text);
    }
    expect(frames[0]).toEqual({
      type: "discoverPromptSaved",
      agent: "discover-naming-conventions",
      text: "exact bytes\n",
      notice: "Prompt saved. The next /discover-naming-conventions run reads this file.",
    });
    expect(prompts.snapshot("discover-naming-conventions")?.text).toBe("exact bytes\n");
    expect(prompts.snapshot("sheet")?.text).not.toBe("exact bytes\n");

    // The contribution prompt is the seventh file and follows the same rule.
    const contributionFrames: Array<Record<string, unknown>> = [];
    prompts.save(
      { send: (data) => contributionFrames.push(JSON.parse(data) as Record<string, unknown>) },
      "discover-contribution",
      "contribution bytes\n",
    );
    expect(
      readFileSync(join(root, ".devboard", "prompts", "discover-contribution.md"), "utf8"),
    ).toBe("contribution bytes\n");
    expect(
      readFileSync(join(root, ".devboard", "prompts", "discover-naming-conventions.md"), "utf8"),
    ).toBe("exact bytes\n");
    expect(contributionFrames[0]).toEqual({
      type: "discoverPromptSaved",
      agent: "discover-contribution",
      text: "contribution bytes\n",
      notice: "Prompt saved. The next /discover-contribution run reads this file.",
    });
    prompts.dispose();
  });

  test("an installed prefix refuses and leaves every prompt byte-identical", async () => {
    const root = await temporaryRoot("discover-installed-save");
    mkdirSync(join(root, ".devboard", "prompts"), { recursive: true });
    const file = join(root, ".devboard", "prompts", "discover-glossary.md");
    writeFileSync(file, "# glossary\n");
    const frames: Array<Record<string, unknown>> = [];
    const prompts = discoverController(root);
    prompts.save(
      { send: (data) => frames.push(JSON.parse(data) as Record<string, unknown>) },
      "discover-glossary",
      "replacement\n",
    );
    expect(readFileSync(file, "utf8")).toBe("# glossary\n");
    expect(frames[0]?.type).toBe("discoverPromptError");
    expect(String(frames[0]?.message)).toContain("harness source checkout");
    const contributionFrames: Array<Record<string, unknown>> = [];
    prompts.save(
      { send: (data) => contributionFrames.push(JSON.parse(data) as Record<string, unknown>) },
      "discover-contribution",
      "installed bytes\n",
    );
    expect(contributionFrames[0]?.type).toBe("discoverPromptError");
    expect(String(contributionFrames[0]?.message)).toContain("harness source checkout");
    prompts.dispose();
  });
});

describe("discover prompt chat", () => {
  test("streams one reply per turn, proposes a replacement, and writes no file", async () => {
    const root = await discoverSourceRoot();
    const file = join(root, ".devboard", "prompts", "discover-sheet.md");
    const before = readFileSync(file, "utf8");
    const frames: Array<Record<string, unknown>> = [];
    const prompts = discoverController(root);
    await prompts.chat(
      { send: (data) => frames.push(JSON.parse(data) as Record<string, unknown>) },
      "sheet",
      "Tighten the evidence rule.",
      before,
    );
    prompts.dispose();
    const chunks = frames.filter((frame) => frame.type === "discoverPromptChat");
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) expect(chunk.agent).toBe("sheet");
    const done = frames.find((frame) => frame.type === "discoverPromptChatDone");
    expect(done?.agent).toBe("sheet");
    expect(done?.proposal).toBe("# Revised prompt\n\nFollow it.\n");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(frames.some((frame) => frame.type === "discoverPromptSaved")).toBe(false);
  });

  test("a failed turn reports a chat error and leaves the editor base alone", async () => {
    const root = await discoverSourceRoot();
    const file = join(root, ".devboard", "prompts", "discover-testing-strategy.md");
    const before = readFileSync(file, "utf8");
    const frames: Array<Record<string, unknown>> = [];
    const prompts = discoverController(root, {
      agentCommand: `env PROMPT_STUB_FAIL=1 bun ${CHAT_STUB}`,
    });
    await prompts.chat(
      { send: (data) => frames.push(JSON.parse(data) as Record<string, unknown>) },
      "discover-testing-strategy",
      "Change it.",
      before,
    );
    prompts.dispose();
    const failure = frames.find((frame) => frame.type === "discoverPromptChatError");
    expect(failure?.agent).toBe("discover-testing-strategy");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("an installed prefix refuses chat without spawning", async () => {
    const root = await temporaryRoot("discover-installed-chat");
    mkdirSync(join(root, ".devboard", "prompts"), { recursive: true });
    const file = join(root, ".devboard", "prompts", "discover-sheet.md");
    writeFileSync(file, "# sheet\n");
    const frames: Array<Record<string, unknown>> = [];
    const prompts = discoverController(root, { agentCommand: "definitely-not-an-agent" });
    await prompts.chat(
      { send: (data) => frames.push(JSON.parse(data) as Record<string, unknown>) },
      "sheet",
      "Change it.",
      "# sheet\n",
    );
    prompts.dispose();
    expect(frames[0]?.type).toBe("discoverPromptChatError");
    expect(String(frames[0]?.message)).toContain("harness source checkout");
    expect(readFileSync(file, "utf8")).toBe("# sheet\n");
  });
});

describe("Coach template prompt", () => {
  function coachController(
    root: string,
    coachDir: string,
    frames: Array<Record<string, unknown>>,
  ): AgentPromptController {
    return new AgentPromptController({
      registry: agentRegistry,
      repoDir: root,
      agentCommand: "definitely-not-an-agent",
      agentEnvironment: async () => ({ ...process.env }),
      harnessDir: HARNESS_ROOT,
      send: (event) => frames.push(event as Record<string, unknown>),
      templates: {
        coach: () =>
          coachPromptTemplate({
            settings: readCoachSettings(coachDir),
            openIssues: null,
          }),
      },
    });
  }

  function coachSettings(root: string, allowlist: string[]): string {
    const directory = coachDirectory(join(root, ".devboard", ".tmp", "state"));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "settings.json"), JSON.stringify({ allowlist }));
    return directory;
  }

  test("publishes the generated template, not an absence or an editor", async () => {
    const root = await temporaryRoot("coach-template");
    const coachDir = coachSettings(root, ["bun "]);
    const frames: Array<Record<string, unknown>> = [];
    const prompts = coachController(root, coachDir, frames);
    const prompt = prompts.snapshot("coach");
    expect(prompt?.absent).toBe(false);
    expect(prompt?.editable).toBe(false);
    expect(prompt?.text).toBeNull();
    expect(prompt?.error).toBeNull();
    expect(prompt?.template).toContain("<family>");
    expect(prompt?.template).toContain("<fragments>");
    expect(prompt?.template).toContain("<excerpts>");
    expect(prompt?.template).toContain(COACH_PROMPT_ISSUES_UNAVAILABLE);
    expect(prompt?.template).toContain('"bun "');
  });

  test("a reconnect shows the current settings file and writes nothing", async () => {
    const root = await temporaryRoot("coach-template-settings");
    const coachDir = coachSettings(root, ["bun "]);
    const settingsFile = join(coachDir, "settings.json");
    const frames: Array<Record<string, unknown>> = [];
    const prompts = coachController(root, coachDir, frames);
    expect(prompts.snapshot("coach")?.template).toContain('"bun "');
    const edited = `${JSON.stringify({ allowlist: ["git status", "bun test"] }, null, 2)}\n`;
    writeFileSync(settingsFile, edited);
    prompts.publishTemplates();
    const published = frames.find(
      (frame) => frame.type === "agentPromptState" && frame.id === "coach",
    ) as { prompt?: { template?: string } } | undefined;
    expect(published?.prompt?.template).toContain('"bun test"');
    expect(published?.prompt?.template).not.toContain('"bun "');
    expect(readFileSync(settingsFile, "utf8")).toBe(edited);
  });

  test("refuses every Coach prompt command without touching a file", async () => {
    const root = await sourceRoot("coach-template-source");
    const coachDir = coachSettings(root, ["bun "]);
    const frames: Array<Record<string, unknown>> = [];
    const prompts = coachController(root, coachDir, frames);
    const before = readdir(join(root, ".devboard", "prompts"));
    prompts.save(
      { send: (data) => frames.push(JSON.parse(data) as Record<string, unknown>) },
      "coach",
      "replacement\n",
    );
    await prompts.chat(
      { send: (data) => frames.push(JSON.parse(data) as Record<string, unknown>) },
      "coach",
      "Change it.",
      "",
    );
    expect(frames[0]?.type).toBe("agentPromptError");
    const coachPrompt = agentRegistry.require("coach").prompt;
    expect(frames[0]?.message).toBe(
      coachPrompt.kind === "template" ? coachPrompt.message : "unexpected descriptor",
    );
    expect(frames[1]?.type).toBe("agentPromptChatError");
    expect(readdir(join(root, ".devboard", "prompts"))).toEqual(before);
  });
});
