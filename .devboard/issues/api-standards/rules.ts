import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  RULE_LEVELS,
  apiStandardsConfig,
  type ApiStandardsConfig,
  type RestRule,
  type RuleLevel,
} from "./paths";

/**
 * The skill is the audit's only normative text. Each cycle reads both files
 * the REST skill ships: its prose document and the rule table, whose rows read
 * `| <rule id> | <MUST|SHOULD|MAY> | <directive> |` under the guideline's REST
 * chapter headings. Nothing here invents a rule id, level, or directive, and
 * no network request is made.
 */

export class ApiStandardsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiStandardsInputError";
  }
}

export interface RestSkill {
  /** Repository-relative path of the skill's prose document. */
  skillPath: string;
  /** Repository-relative path of the rule table. */
  rulesPath: string;
  /** The skill document's bytes. */
  skillText: string;
  /** The rule table's bytes. */
  rulesText: string;
  /** Every parsed row, in file order. */
  rules: RestRule[];
  /** Every chapter heading, in file order. */
  chapters: string[];
}

function level(value: string): RuleLevel | undefined {
  return RULE_LEVELS.find((candidate) => candidate === value);
}

function tableCells(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return undefined;
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * Parses the reference's rule table. A row below a `## <chapter>` heading with
 * three cells, a numeric id, a published level, and a non-empty directive is a
 * rule; the header and separator rows are not. A table with no rows is an
 * input error naming the file, never an empty rule set that would file nothing
 * while claiming an audit ran.
 */
export function parseRules(text: string, path: string): {
  rules: RestRule[];
  chapters: string[];
} {
  const rules: RestRule[] = [];
  const chapters: string[] = [];
  const seen = new Set<string>();
  let chapter: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      chapter = line.slice(3).trim();
      if (chapter.length > 0) chapters.push(chapter);
      continue;
    }
    if (chapter === null) continue;
    const cells = tableCells(line);
    if (cells === undefined || cells.length !== 3) continue;
    const [id, rawLevel, directive] = cells as [string, string, string];
    if (!/^\d+$/.test(id)) continue;
    const parsedLevel = level(rawLevel);
    if (parsedLevel === undefined) continue;
    if (directive.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    rules.push({ id, level: parsedLevel, chapter, directive });
  }
  if (rules.length === 0) {
    throw new ApiStandardsInputError(
      `${path} has no rule table; the skill must list | <rule id> | <MUST|SHOULD|MAY> | ` +
        "<directive> | rows under its chapter headings",
    );
  }
  return { rules, chapters };
}

/** Reads both skill files and parses the rule table. */
export function readRestSkill(
  repoDir: string,
  config: ApiStandardsConfig = apiStandardsConfig(),
): RestSkill {
  const root = resolve(repoDir);
  const skillPath = config.skillDocument.replace(/\\/g, "/");
  const rulesPath = config.rulesDocument.replace(/\\/g, "/");
  const read = (relativePath: string): string => {
    try {
      return readFileSync(join(root, relativePath), "utf8");
    } catch {
      throw new ApiStandardsInputError(`${relativePath} is not readable`);
    }
  };
  const skillText = read(skillPath);
  if (skillText.trim().length === 0) {
    throw new ApiStandardsInputError(`${skillPath} is empty`);
  }
  const rulesText = read(rulesPath);
  const parsed = parseRules(rulesText, rulesPath);
  return {
    skillPath,
    rulesPath,
    skillText,
    rulesText,
    rules: parsed.rules,
    chapters: parsed.chapters,
  };
}
