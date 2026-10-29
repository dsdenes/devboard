import { MCP_TOOL_NAMES } from "../mcp/catalog";
import type { CoachFamily } from "./families";
import { ISSUE_BODY_MAX_BYTES, issueBody, type CoachOpenIssue } from "./issue";
import type { CoachSettings } from "./settings";
import type { Proposal, ProposedTool } from "./synthesize";

/**
 * The deterministic validator. It never calls a model: each rule reads the
 * proposal, the family, the settings, and the open issues, and a failure
 * records the rule that rejected the proposal. A rejected or `none` proposal
 * files nothing.
 */

export type ValidationResult =
  | { ok: true; body: string; allowlistEntry: string }
  | { ok: false; rule: string; detail: string };

function coverPrefix(entry: string): string {
  return entry.endsWith("*") ? entry.slice(0, -1) : entry;
}

function coverMatchesFamily(entry: string, family: CoachFamily): boolean {
  const prefix = coverPrefix(entry);
  if (prefix.length === 0) return false;
  if (family.key.startsWith(prefix)) return true;
  return family.fragments.some((fragment) => fragment.text.startsWith(prefix));
}

/** The exact configured allowlist entry that covers this family, if one does. */
export function allowlistEntryFor(key: string, allowlist: readonly string[]): string | undefined {
  return allowlist.find((entry) => {
    const prefix = coverPrefix(entry);
    return prefix.length > 0 && key.startsWith(prefix);
  });
}

function toolNameTaken(tool: ProposedTool, openIssues: CoachOpenIssue[]): boolean {
  if (MCP_TOOL_NAMES.includes(tool.name)) return true;
  return openIssues.some((issue) => issue.title.includes(tool.name));
}

function schemaValid(tool: ProposedTool): boolean {
  const schema = tool.inputSchema;
  if (schema["type"] !== "object") return false;
  if (schema["additionalProperties"] !== false) return false;
  const properties = schema["properties"];
  return typeof properties === "object" && properties !== null && !Array.isArray(properties);
}

function acceptanceValid(acceptance: string[]): boolean {
  if (acceptance.length < 1 || acceptance.length > 5) return false;
  return acceptance.every(
    (criterion) => criterion.startsWith("- [ ] ") && criterion.length <= 400,
  );
}

/**
 * Validates one proposal for one family. The body is rendered once with the
 * matched allowlist entry so the size rule sees exactly the bytes filing uses.
 */
export function validateProposal(input: {
  family: CoachFamily;
  proposal: Proposal;
  settings: CoachSettings;
  openIssues: CoachOpenIssue[];
}): ValidationResult {
  const { family, proposal, settings, openIssues } = input;
  if (proposal.family !== family.key) {
    return {
      ok: false,
      rule: "family-mismatch",
      detail: `the proposal names ${proposal.family}, not ${family.key}`,
    };
  }
  if (proposal.action === "none") {
    return { ok: false, rule: "action-none", detail: "a none proposal files nothing" };
  }
  let allowlistEntry = "";
  if (proposal.action === "tool") {
    const tool = proposal.tool;
    if (tool === undefined) {
      return { ok: false, rule: "tool-missing", detail: "the tool proposal carries no tool" };
    }
    if (toolNameTaken(tool, openIssues)) {
      return {
        ok: false,
        rule: "tool-name-duplicate",
        detail: `${tool.name} already exists in the catalog or an open Coach issue`,
      };
    }
    if (!schemaValid(tool)) {
      return {
        ok: false,
        rule: "input-schema",
        detail: "the input schema is not a closed object schema",
      };
    }
    for (const entry of tool.covers) {
      if (!coverMatchesFamily(entry, family)) {
        return {
          ok: false,
          rule: "covers-unmatched",
          detail: `${entry} is neither the family key nor a fragment prefix`,
        };
      }
    }
    if (!tool.covers.some((entry) => family.key.startsWith(coverPrefix(entry)))) {
      return {
        ok: false,
        rule: "covers-requires-family",
        detail: "no covers entry matches the family key",
      };
    }
    const matched = allowlistEntryFor(family.key, settings.allowlist);
    if (matched === undefined) {
      return {
        ok: false,
        rule: "allowlist-missing",
        detail: "no command allowlist entry covers the family",
      };
    }
    allowlistEntry = matched;
  }
  if (!acceptanceValid(proposal.acceptance)) {
    return {
      ok: false,
      rule: "acceptance",
      detail: "an acceptance line is malformed",
    };
  }
  const body = issueBody({ family, proposal, allowlistEntry });
  if (Buffer.byteLength(body, "utf8") > ISSUE_BODY_MAX_BYTES - 1) {
    return { ok: false, rule: "body-size", detail: "the rendered body exceeds 64 KiB" };
  }
  return { ok: true, body, allowlistEntry };
}
