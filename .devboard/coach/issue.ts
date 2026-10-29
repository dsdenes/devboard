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
  return action === "tool" ? `[coach] ${family.key}` : `[coach] prompt: ${family.key}`;
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
