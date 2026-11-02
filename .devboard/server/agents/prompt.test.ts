import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { agentRegistry } from "./registry";
import { AgentPromptController, DiscoverPromptController } from "./prompt";
import { DISCOVER_AGENTS } from "./registry";

const roots: string[] = [];
const PROMPT = "---\ndescription: fixture\n---\n\n# Fixture prompt\n\nKeep this byte for byte.\n";
const DESIGN_PROMPT = "---\ndescription: design fixture\n---\n\n# Design prompt\n";
const HARNESS_ROOT = join(import.meta.dir, "..", "..");

async function temporaryRoot(name: string): Promise<string> {
  const base = join(HARNESS_ROOT, ".tmp", "prompt-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, `${name}-`));
  roots.push(root);
  return root;
}

/**
 * A fixture with one prompt file per shared section. `source` writes the
 * package manifest a harness source checkout carries; an installed prefix does
 * not have one. The prompt bytes are the same in both.
 */
async function fixtureRoot(name: string, source: boolean): Promise<string> {
  const root = await temporaryRoot(name);
  mkdirSync(join(root, ".devboard", "prompts"), { recursive: true });
  if (source) {
    writeFileSync(
      join(root, ".devboard", "package.json"),
      `${JSON.stringify({ name: "@dsdenes/devboard", version: "0.1.0" }, null, 2)}\n`,
    );
  }
  writeFileSync(join(root, ".devboard", "prompts", "scout-recommendations.md"), PROMPT);
  writeFileSync(join(root, ".devboard", "prompts", "design-system.md"), DESIGN_PROMPT);
  return root;
}

function prompts(root: string): AgentPromptController {
  return new AgentPromptController({ registry: agentRegistry, repoDir: root });
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent prompt snapshot", () => {
  for (const source of [true, false]) {
    test(`${source ? "a source checkout" : "an installed prefix"} reads the exact bytes`, async () => {
      const root = await fixtureRoot(source ? "source" : "installed", source);
      const scout = prompts(root).snapshot("scout");
      expect(scout).toEqual({
        id: "scout",
        absent: false,
        text: PROMPT,
        error: null,
      });
      expect(Object.keys(scout ?? {})).not.toContain("editable");

      const design = prompts(root).snapshot("design");
      expect(design?.text).toBe(DESIGN_PROMPT);
      expect(design?.error).toBeNull();
      expect(Object.keys(design ?? {})).not.toContain("editable");
    });
  }

  test("the source checkout and the installed prefix render the same prompt payload", async () => {
    const source = await fixtureRoot("same-source", true);
    const installed = await fixtureRoot("same-installed", false);
    for (const id of ["scout", "design", "watchdog", "coach"]) {
      expect(prompts(source).snapshot(id)).toEqual(prompts(installed).snapshot(id));
    }
  });

  test("Watchdog states its absence and Coach renders its generated template", async () => {
    const root = await fixtureRoot("absent", true);
    expect(prompts(root).snapshot("watchdog")).toEqual({
      id: "watchdog",
      absent: true,
      text: null,
      error: null,
    });
    const coach = new AgentPromptController({
      registry: agentRegistry,
      repoDir: root,
      send: () => undefined,
      templates: { coach: () => "# Coach synthesis template\n" },
    }).snapshot("coach");
    expect(coach).toEqual({
      id: "coach",
      absent: false,
      text: null,
      error: null,
      template: "# Coach synthesis template\n",
    });
    expect(Object.keys(coach ?? {})).not.toContain("editable");
  });

  test("an unreadable prompt reports an error and no bytes", async () => {
    const root = await fixtureRoot("missing-file", true);
    await rm(join(root, ".devboard", "prompts", "scout-recommendations.md"));
    const scout = prompts(root).snapshot("scout");
    expect(scout?.absent).toBe(false);
    expect(scout?.text).toBeNull();
    expect(scout?.error).toContain("Could not read the Auto Scout prompt");
    expect(Object.keys(scout ?? {})).not.toContain("editable");
  });

  test("replaying sends every descriptor's read-only state", async () => {
    const root = await fixtureRoot("replay", true);
    const frames: Array<Record<string, unknown>> = [];
    prompts(root).replay({
      send: (data) => frames.push(JSON.parse(data) as Record<string, unknown>),
    });
    expect(frames).toHaveLength(agentRegistry.descriptors.length);
    for (const frame of frames) {
      expect(frame.type).toBe("agentPromptState");
      expect(Object.keys(frame.prompt as Record<string, unknown>)).not.toContain("editable");
    }
  });
});

describe("discover prompt snapshot", () => {
  test("each card reads exactly its own prompt file", async () => {
    const root = await fixtureRoot("discover", true);
    for (const descriptor of DISCOVER_AGENTS) {
      const bytes = `# ${descriptor.label}\n\n${descriptor.promptFile}\n`;
      writeFileSync(
        join(root, ".devboard", "prompts", descriptor.promptFile),
        bytes,
      );
    }
    const controller = new DiscoverPromptController({ repoDir: root });
    for (const descriptor of DISCOVER_AGENTS) {
      const prompt = controller.snapshot(descriptor.id);
      expect(prompt).toEqual({
        agent: descriptor.id,
        text: `# ${descriptor.label}\n\n${descriptor.promptFile}\n`,
        error: null,
      });
      expect(Object.keys(prompt ?? {})).not.toContain("editable");
    }
  });

  test("a missing prompt file reports an error", async () => {
    const root = await fixtureRoot("discover-missing", false);
    const controller = new DiscoverPromptController({ repoDir: root });
    const prompt = controller.snapshot("sheet");
    expect(prompt?.text).toBeNull();
    expect(prompt?.error).toContain("Could not read the Data Sheet prompt");
  });

  test("replaying sends no editable field", async () => {
    const root = await fixtureRoot("discover-replay", false);
    const frames: Array<Record<string, unknown>> = [];
    new DiscoverPromptController({ repoDir: root }).replay({
      send: (data) => frames.push(JSON.parse(data) as Record<string, unknown>),
    });
    expect(frames).toHaveLength(DISCOVER_AGENTS.length);
    for (const frame of frames) {
      expect(frame.type).toBe("discoverPromptState");
      expect(Object.keys(frame.prompt as Record<string, unknown>)).not.toContain("editable");
    }
  });
});
