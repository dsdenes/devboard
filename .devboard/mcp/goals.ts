import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GoalDraftError,
  listGoalDrafts,
  readGoalDraft,
  resolveGoalDraft,
} from "../server/goal-drafts";
import { boundBytes } from "../lib/text-budget";
import { issuesFor, resolveContained } from "./context";
import type { McpContext } from "./context";

/**
 * Goal, draft, and issue work that otherwise costs an agent several ad hoc
 * steps: writing a spec, ensuring the `goal` label, filing the spec verbatim,
 * reading it back, and removing a draft only after both checks pass.
 */

export const GOAL_TEXT_MAX_BYTES = 64 * 1024;
export const GOAL_TITLE_MAX = 200;
export const GOAL_SECTION_HEADINGS = [
  "Objective",
  "Success criteria",
  "Verification",
  "Boundaries",
  "Stop conditions",
] as const;

export function goalText(context: McpContext): { goal: string; truncated: boolean } {
  const path = context.environment.GOAL_FILE ?? join(context.repoDir, "GOAL.md");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = "";
  }
  const result = boundBytes(text, GOAL_TEXT_MAX_BYTES);
  return { goal: result.text, truncated: result.truncated };
}

export function goalDrafts(context: McpContext) {
  return listGoalDrafts(context.repoDir);
}

export function goalDraft(context: McpContext, path: unknown) {
  const draft = readGoalDraft(context.repoDir, path);
  const result = boundBytes(draft.text, GOAL_TEXT_MAX_BYTES);
  return { ...draft, text: result.text, truncated: result.truncated };
}

/** Lowercase kebab-case over `[a-z0-9-]`, at most six words. */
export function deriveSlug(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter((word) => word.length > 0)
    .slice(0, 6);
  return words.length === 0 ? "goal" : words.join("-");
}

function freeSlug(goalsDir: string, base: string): string {
  for (let attempt = 1; ; attempt += 1) {
    const slug = attempt === 1 ? base : `${base}-${attempt}`;
    try {
      readFileSync(join(goalsDir, `${slug}.md`));
    } catch {
      return slug;
    }
  }
}

export interface GoalSpecSections {
  objective?: unknown;
  successCriteria?: unknown;
  verification?: unknown;
  boundaries?: unknown;
  stopConditions?: unknown;
  slug?: unknown;
}

export function writeGoalSpec(
  context: McpContext,
  sections: GoalSpecSections,
): { path: string; slug: string } {
  const bodies = [
    sections.objective,
    sections.successCriteria,
    sections.verification,
    sections.boundaries,
    sections.stopConditions,
  ];
  for (const [index, body] of bodies.entries()) {
    if (typeof body !== "string" || body.trim().length === 0) {
      throw new Error(`The ${GOAL_SECTION_HEADINGS[index] ?? ""} section must not be empty.`);
    }
  }
  const goalsDir = resolveContained(context.repoDir, ".devboard/goals", "goal spec directory");
  const objective = bodies[0] as string;
  const requested =
    typeof sections.slug === "string" && sections.slug.trim().length > 0
      ? sections.slug.trim()
      : deriveSlug(objective.split("\n").find((line) => line.trim().length > 0) ?? objective);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(requested)) {
    throw new Error("A slug must be lowercase kebab-case over [a-z0-9-].");
  }
  mkdirSync(goalsDir.absolute, { recursive: true });
  const slug = freeSlug(goalsDir.absolute, requested);
  const content = [
    ...GOAL_SECTION_HEADINGS.flatMap((heading, index) => [
      `## ${heading}`,
      "",
      (bodies[index] as string).replace(/\s+$/, ""),
      "",
    ]),
  ].join("\n");
  writeFileSync(join(goalsDir.absolute, `${slug}.md`), content, { flag: "wx" });
  return {
    path: `.devboard/goals/${slug}.md`,
    slug,
  };
}

function validTitle(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("A one-line title is required.");
  }
  const title = value.trim();
  if (title.includes("\n") || title.includes("\r")) {
    throw new Error("The title must be one line.");
  }
  if (title.length > GOAL_TITLE_MAX) {
    throw new Error(`The title must be at most ${GOAL_TITLE_MAX} characters.`);
  }
  if (/^\s*#/.test(title)) {
    throw new Error("The title must not begin with a heading marker.");
  }
  return title;
}

/** The goal spec path must sit directly under `.devboard/goals/`. */
function goalSpec(context: McpContext, value: unknown): { absolute: string; relative: string } {
  const resolved = resolveContained(context.repoDir, value, "specPath", { mustExist: true });
  if (!resolved.relative.startsWith(".devboard/goals/")) {
    throw new Error("specPath must name a file under .devboard/goals/.");
  }
  if (!resolved.relative.endsWith(".md")) {
    throw new Error("specPath must end in .md.");
  }
  return resolved;
}

export interface GoalDraftFileResult {
  ok: boolean;
  number?: number;
  url?: string;
  draftRemoved?: boolean;
  step?: string;
  message?: string;
}

/**
 * Files one goal spec as an issue. The issue is created, read back, and only
 * then is the named draft deleted; any failure names the step and keeps it.
 */
export async function fileGoalDraft(
  context: McpContext,
  options: { specPath?: unknown; title?: unknown; draftPath?: unknown },
): Promise<GoalDraftFileResult> {
  let step = "validate";
  let draftFile: string | undefined;
  try {
    const title = validTitle(options.title);
    const spec = goalSpec(context, options.specPath);
    if (options.draftPath !== undefined && options.draftPath !== null) {
      draftFile = resolveGoalDraft(context.repoDir, options.draftPath).file;
    }
    const body = readFileSync(spec.absolute, "utf8");
    const forge = issuesFor(context);

    step = "ensure the goal label";
    await forge.ensureLabel("goal");

    step = "create the issue";
    const created = await forge.create({ title, body, labels: ["goal"] });

    step = "read the issue back";
    const stored = await forge.get(created.number);

    step = "verify the label";
    if (!stored.labels.includes("goal")) {
      return {
        ok: false,
        step,
        message: `issue #${created.number} does not carry the goal label`,
        number: created.number,
        url: created.url,
      };
    }
    step = "verify the body";
    if (stored.body !== body) {
      return {
        ok: false,
        step,
        message: `issue #${created.number} body differs from ${spec.relative}`,
        number: created.number,
        url: created.url,
      };
    }

    if (draftFile !== undefined) {
      step = "remove the draft";
      unlinkSync(draftFile);
    }
    return {
      ok: true,
      number: created.number,
      url: created.url,
      draftRemoved: draftFile !== undefined,
    };
  } catch (error) {
    const message =
      error instanceof GoalDraftError || error instanceof Error
        ? error.message
        : String(error);
    return { ok: false, step, message };
  }
}
