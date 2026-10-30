import { createHash } from "node:crypto";
import type { CoachFamily } from "./families";
import type { Proposal } from "./synthesize";

/**
 * The filed artifact for one family: one title, one deterministic body with
 * exactly five level-two sections, and the family tag deduplication reads.
 * Nothing here generates content: the proposal comes from synthesis and the
 * validator, the evidence from the family builder.
 */

export const ISSUE_BODY_MAX_BYTES = 64 * 1024;
/**
 * The forge title limit: GitHub accepts 256 characters, Gitea 255. The lower
 * bound applies so one title is valid on every forge the Coach can file to.
 */
export const ISSUE_TITLE_MAX_BYTES = 255;

export interface CoachOpenIssue {
  number: number;
  title: string;
  body: string;
  url: string;
}

/** The tag a filed body carries: `family:` plus the first 12 hex of SHA-256. */
export function familyTag(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/** `[coach] <family key>` for a tool, `[coach] prompt: <family key>` for a prompt. */
export function issueTitle(family: CoachFamily, action: "tool" | "prompt"): string {
  const prefix = action === "tool" ? "[coach] " : "[coach] prompt: ";
  return boundTitle(`${prefix}${family.key}`, family.key);
}

/** Cuts a value to at most `max` UTF-8 bytes without splitting a code point. */
function clipBytes(value: string, max: number): string {
  if (Buffer.byteLength(value, "utf8") <= max) return value;
  let kept = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > max) break;
    kept += character;
    bytes += size;
  }
  return kept;
}

/**
 * Bounds a title to the forge limit. A cut title ends with the family tag so
 * two long keys that share a prefix never collapse into one title and read as
 * a duplicate of each other. The full key stays in the body's family tag.
 */
export function boundTitle(title: string, family: string): string {
  if (Buffer.byteLength(title, "utf8") <= ISSUE_TITLE_MAX_BYTES) return title;
  const suffix = ` …${familyTag(family)}`;
  const room = ISSUE_TITLE_MAX_BYTES - Buffer.byteLength(suffix, "utf8");
  return `${clipBytes(title, room).trimEnd()}${suffix}`;
}

/** Escapes a line that would otherwise open a new Markdown section. */
function safeLine(line: string): string {
  return line.replace(/^(#{1,6})(\s)/, "\\$1$2");
}

function familySection(family: CoachFamily): string[] {
  return [
    "## Family",
    "",
    `- Key: \`${family.key}\``,
    `- Kind: ${family.kind}`,
    `- Calls: ${family.calls}`,
    `- Sessions: ${family.sessions.length}`,
    `- Days: ${family.days}`,
    `- First: ${family.firstAt}`,
    `- Last: ${family.lastAt}`,
    `- Family: family:${familyTag(family.key)}`,
    "",
  ];
}

function evidenceSection(family: CoachFamily): string[] {
  const lines = ["## Evidence", "", "### Fragments", ""];
  if (family.fragments.length === 0) {
    lines.push("None.");
  } else {
    for (const fragment of family.fragments) {
      lines.push(`- \`${fragment.text}\` ×${fragment.count}`);
    }
  }
  lines.push("", "### Excerpts", "");
  const chosen = family.excerpts;
  if (chosen.length === 0) {
    lines.push("None.");
  } else {
    for (const excerpt of chosen) {
      lines.push(`- \`${excerpt.command}\` (${excerpt.status}) — ${excerpt.sessionTitle}`);
      if (excerpt.output.length > 0) {
        lines.push("", "```text");
        for (const line of excerpt.output.split("\n")) lines.push(safeLine(line));
        lines.push("```");
      }
      lines.push("");
    }
  }
  lines.push("");
  return lines;
}

function proposalSection(proposal: Proposal, allowlistEntry: string): string[] {
  if (proposal.action === "tool" && proposal.tool !== undefined) {
    const tool = proposal.tool;
    return [
      "## Proposed tool",
      "",
      "```json",
      JSON.stringify(tool, null, 2),
      "```",
      "",
      "Covers:",
      "",
      ...tool.covers.map((entry) => `- \`${entry}\``),
      "",
      "Add this exact entry to the Coach `allowlist` in `settings.json`:",
      "",
      "```json",
      JSON.stringify(allowlistEntry),
      "```",
      "",
    ];
  }
  if (proposal.action === "prompt" && proposal.prompt !== undefined) {
    return [
      "## Proposed prompt",
      "",
      `- Target: \`${proposal.prompt.target}\``,
      "",
      ...proposal.prompt.instruction.split("\n").map((line) => safeLine(line.trimEnd())),
      "",
    ];
  }
  return ["## Proposed tool", "", "None.", ""];
}

/**
 * The tool name an open issue's `## Proposed tool` block declares, or
 * `undefined` when the body has no such section or no JSON object with a
 * string `name`. A filed tool proposal carries its name only in this block,
 * never in the `[coach] <family>` title, so the duplicate rule reads it here.
 */
export function proposedToolName(body: string): string | undefined {
  const heading = /^## Proposed tool\s*$/m.exec(body);
  if (heading === null) return undefined;
  const rest = body.slice(heading.index + heading[0].length);
  const next = /^## /m.exec(rest);
  const section = next === null ? rest : rest.slice(0, next.index);
  const fence = /^```json\s*$/m.exec(section);
  if (fence === null) return undefined;
  const start = fence.index + fence[0].length;
  const close = section.indexOf("```", start);
  if (close < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(section.slice(start, close));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const name = (parsed as Record<string, unknown>)["name"];
  return typeof name === "string" ? name : undefined;
}

function acceptanceSection(proposal: Proposal): string[] {
  return [
    "## Acceptance",
    "",
    ...proposal.acceptance.map((criterion) => safeLine(criterion.replace(/\s+/g, " ").trim())),
    "",
  ];
}

function rationaleSection(proposal: Proposal): string[] {
  return [
    "## Rationale",
    "",
    ...proposal.rationale.split("\n").map((line) => safeLine(line.trimEnd())),
    "",
  ];
}

/**
 * The issue body. The five level-two sections appear exactly once and in
 * order; the validator rejects bytes at or over 64 KiB before filing.
 */
export function issueBody(input: {
  family: CoachFamily;
  proposal: Proposal;
  allowlistEntry: string;
}): string {
  const { family, proposal } = input;
  return [
    ...familySection(family),
    ...evidenceSection(family),
    ...proposalSection(proposal, input.allowlistEntry),
    ...acceptanceSection(proposal),
    ...rationaleSection(proposal),
  ].join("\n");
}
