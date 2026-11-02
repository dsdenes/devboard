import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { dedupPrompt, type DedupRequest } from "../watchdog/dedup";
import { synthesisPrompt } from "../mcp-optimizer/synthesize";
import type { McpOptimizerFamily } from "../mcp-optimizer/families";
import type { McpOptimizerSettings } from "../mcp-optimizer/settings";

/**
 * The prompt contract: every prompt the harness sends begins with a manifesto,
 * never opens with a slash command naming itself, and never asks for one of the
 * retired answer documents.
 */

const PROMPTS = resolve(import.meta.dir, "..", "prompts");
const COMMANDS = resolve(import.meta.dir, "..", "omp", "commands");

function bodyOf(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---\n", 4);
  return end < 0 ? text : text.slice(end + 5);
}

function promptFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => join(directory, name));
}

/** A line that opens with one of this harness's slash commands. */
const SELF_COMMAND =
  /^\s*`?\/(?:scout-recommendations|design-system-audit|discover-[a-z-]+|flow-[a-z]+|epic-next|goal-draft|goal-outcome|implement-issue|prepare-skills|adr-resolve|setup-devboard)\b/;

/**
 * Instructions to write or answer with a retired handoff document. A prompt may
 * still name a published path it reads, so each match also needs a write verb.
 */
const RETIRED_DOCUMENT =
  /(recommendations\.json|audit\.json|widgets\.json|steering-ack\.jsonl|checkpoints\.jsonl|verification\.json|sheet\.json|significance\.json|staged\s+`?SKILL\.md)/i;
const WRITE_VERB = /\b(write|writes|writing|answer|answers|emit|emits|produce|save|saves|return the)\b/i;

function retiredInstruction(text: string): string | undefined {
  for (const line of text.split("\n")) {
    if (RETIRED_DOCUMENT.test(line) && WRITE_VERB.test(line)) return line.trim();
  }
  return undefined;
}

function assertContract(name: string, text: string): void {
  const body = bodyOf(text);
  const first = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  expect({ name, first }).toEqual({ name, first: "## Manifesto" });
  const manifesto = body.slice(body.indexOf("## Manifesto") + "## Manifesto".length).trimStart();
  const sentence = manifesto.split("\n").find((line) => line.trim().length > 0) ?? "";
  expect({ name, sentence: sentence.length > 20 }).toEqual({ name, sentence: true });
  for (const line of body.split("\n")) {
    expect({ name, line: SELF_COMMAND.test(line) }).toEqual({ name, line: false });
  }
  expect({ name, retired: retiredInstruction(body) }).toEqual({ name, retired: undefined });
}

describe("prompt conformance", () => {
  test("every prompt file opens with a manifesto and no retired answer document", () => {
    const files = promptFiles(PROMPTS);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) assertContract(file, readFileSync(file, "utf8"));
  });

  test("every command wrapper names input context, never an output answer", () => {
    for (const file of promptFiles(COMMANDS)) {
      const text = readFileSync(file, "utf8");
      expect({ file, retired: retiredInstruction(text) }).toEqual({ file, retired: undefined });
    }
  });

  test("the watchdog deduplication prompt matches the contract", () => {
    const request: DedupRequest = {
      repository: "acme/fixture",
      filingRoom: 1,
      window: {
        start: "2026-10-27T09:50:00.000Z",
        end: "2026-10-27T10:00:00.000Z",
      },
      candidates: [
        {
          fingerprint: "abc",
          category: "server-error",
          line: "boom",
          firstSeen: "2026-10-27T09:55:00.000Z",
          lastSeen: "2026-10-27T09:56:00.000Z",
          count: 1,
          instances: [],
          window: { start: "2026-10-27T09:50:00.000Z", end: "2026-10-27T10:00:00.000Z" },
        },
      ],
    };
    assertContract("watchdog-dedup", dedupPrompt(request));
  });

  test("the MCP optimizer synthesis prompt matches the contract", () => {
    const family: McpOptimizerFamily = {
      key: "docs:build",
      kind: "command",
      score: 3,
      calls: 2,
      sessions: [],
      days: 1,
      firstAt: "2026-10-26T10:00:00.000Z",
      lastAt: "2026-10-27T10:00:00.000Z",
      fragments: [],
      excerpts: [],
    };
    const settings: McpOptimizerSettings = {
      intervalMinutes: 60,
      maxPerHour: null,
      maxPending: null,
      maxIssuesPerCycle: 1,
      allowlist: ["docs:"],
    };
    assertContract(
      "mcp-optimizer-synthesis",
      synthesisPrompt({ family, settings, openIssues: [], filingRoom: 1 }),
    );
  });
});
