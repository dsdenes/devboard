#!/usr/bin/env bun
/**
 * Runs both prompt saves with a `renameSync` that always fails, so the failure
 * lands after the staged sibling is written and before it replaces the prompt.
 * A separate process is what makes the module mock safe: `mock.module` leaks to
 * every later importer in the same test process.
 *
 * Usage: bun tests/fixtures/prompt-save-rename-failure.ts <fixture-root>
 */
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

mock.module("node:fs", () => {
  const real = require("node:fs");
  return {
    ...real,
    renameSync: () => {
      throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
    },
  };
});

// The mock must be registered before these modules bind their `node:fs`
// imports, so this path is imported after the registration, not statically.
const { AgentPromptController, DiscoverPromptController } = await import(
  "../../server/agents/prompt.ts"
);
const { agentRegistry } = await import("../../server/agents/registry.ts");

const root = process.argv[2];
assert.ok(root, "a fixture root is required");

const promptsDir = join(root, ".devboard", "prompts");
const harnessDir = join(root, ".devboard");
const agentCommand = "definitely-not-an-agent";
const agentEnvironment = async () => ({});

const agentFrames: Array<Record<string, unknown>> = [];
const agentPrompt = new AgentPromptController({
  registry: agentRegistry,
  repoDir: root,
  agentCommand,
  agentEnvironment,
  harnessDir,
  send: () => undefined,
});
const agentFile = join(promptsDir, "scout-recommendations.md");
const agentBefore = readFileSync(agentFile, "utf8");
agentPrompt.save(
  { send: (data) => agentFrames.push(JSON.parse(data) as Record<string, unknown>) },
  "scout",
  "replacement agent prompt\n",
);
assert.equal(readFileSync(agentFile, "utf8"), agentBefore, "agent prompt keeps its previous bytes");
assert.equal(
  agentFrames.some((frame) => frame.type === "agentPromptSaved"),
  false,
  "a failed agent save reports no success",
);
const agentError = agentFrames.find((frame) => frame.type === "agentPromptError");
assert.ok(agentError, "a failed agent save reports an error frame");
assert.match(String(agentError.message), /Could not write the Auto Scout prompt: injected rename failure/);

const discoverFrames: Array<Record<string, unknown>> = [];
const discoverPrompt = new DiscoverPromptController({
  repoDir: root,
  agentCommand,
  agentEnvironment,
  harnessDir,
  send: () => undefined,
});
const discoverFile = join(promptsDir, "discover-naming-conventions.md");
const discoverBefore = readFileSync(discoverFile, "utf8");
discoverPrompt.save(
  { send: (data) => discoverFrames.push(JSON.parse(data) as Record<string, unknown>) },
  "discover-naming-conventions",
  "replacement discover prompt\n",
);
assert.equal(
  readFileSync(discoverFile, "utf8"),
  discoverBefore,
  "discover prompt keeps its previous bytes",
);
assert.equal(
  discoverFrames.some((frame) => frame.type === "discoverPromptSaved"),
  false,
  "a failed discover save reports no success",
);
const discoverError = discoverFrames.find((frame) => frame.type === "discoverPromptError");
assert.ok(discoverError, "a failed discover save reports an error frame");
assert.match(
  String(discoverError.message),
  /Could not write the Naming Conventions prompt: injected rename failure/,
);

assert.deepEqual(
  readdirSync(promptsDir).filter((name) => name.endsWith(".tmp")),
  [],
  "neither failed save leaves a staging file behind",
);
