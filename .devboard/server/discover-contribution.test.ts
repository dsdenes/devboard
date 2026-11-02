import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DiscoverValidationError,
  validateAgentStaged,
  type Freshness,
} from "./discover";

/**
 * The Contribution Agent's staged contract. It proves the validator accepts the
 * documented shape and refuses every defect the server must never publish.
 */

const HARNESS_ROOT = join(import.meta.dir, "..");
const TEST_ROOT = join(HARNESS_ROOT, ".tmp", "discover-contribution-tests");
mkdirSync(TEST_ROOT, { recursive: true });
const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // A locked fixture is left for the operator.
    }
  }
});

const FRESHNESS: Freshness = {
  project: "fixture",
  commit: "abc1234",
  dirty: false,
  discoveredAt: "2026-10-27T12:00:00.000Z",
  fingerprint: "0123456789abcdef",
};

function mergedPullRequest(
  number: number,
  title: string,
  body: string,
  mergedAt: string,
  files: string[],
  testFiles: number,
  documentationFiles: number,
): Record<string, unknown> {
  return {
    number,
    title,
    body,
    mergedAt,
    additions: 10,
    deletions: 2,
    filesChanged: files.length,
    files,
    testFiles,
    documentationFiles,
    labels: ["area:orders"],
    draft: false,
    approvals: 1,
    checks: ["ci/test"],
    commits: [{ subject: title, body: "" }],
    branch: "feat/orders",
    mergeMethod: "squash",
    references: [5],
  };
}

const MERGED = [
  mergedPullRequest(
    3,
    "feat(orders): add totals",
    "## Summary\n- Add totals.",
    "2026-03-03T00:00:00.000Z",
    ["src/order.ts", "test/order.test.ts"],
    1,
    0,
  ),
  mergedPullRequest(
    2,
    "fix(orders): keep totals",
    "## Summary\n- Keep totals.",
    "2026-02-02T00:00:00.000Z",
    ["src/order.ts"],
    0,
    0,
  ),
  mergedPullRequest(
    1,
    "docs(orders): document totals",
    "## Summary\nDocument totals.",
    "2026-01-01T00:00:00.000Z",
    ["CHANGELOG.md", "docs/orders.md"],
    0,
    2,
  ),
];

function document(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    source: {
      forge: "gitea",
      host: "gitea.example.test",
      unavailable: null,
      window: { from: "2026-01-01T00:00:00.000Z", to: "2026-03-03T00:00:00.000Z" },
      mergedPullRequests: MERGED.map((pullRequest) => ({ ...pullRequest })),
      closedUnmergedPullRequests: [4],
    },
    workflow: [
      {
        key: "entryPoints",
        value: ["CONTRIBUTING.md"],
        evidence: ["README.md"],
        confidence: "declared",
      },
      { key: "steps", value: ["Open a pull request."], evidence: ["CONTRIBUTING.md"], confidence: "declared" },
      { key: "prerequisites", value: ["Bun"], evidence: ["package.json"], confidence: "declared" },
      { key: "install", value: "bun install", evidence: ["package.json"], confidence: "declared" },
      { key: "build", value: "bun run build", evidence: ["package.json"], confidence: "declared" },
      { key: "lint", value: "bun run lint", evidence: ["package.json"], confidence: "declared" },
      { key: "typecheck", value: "bunx tsc --noEmit", evidence: ["package.json"], confidence: "declared" },
      { key: "run", value: "bun run start", evidence: ["package.json"], confidence: "declared" },
    ],
    testing: [
      { key: "suite", value: "bun test", evidence: ["package.json"], confidence: "declared" },
      {
        key: "levels",
        value: [{ level: "unit", command: "bun test", paths: ["test"], fixtures: [] }],
        evidence: ["test/order.test.ts"],
        confidence: "observed",
      },
    ],
  };
}

function skillBody(exemplars = true): string {
  const quotes = exemplars
    ? [
        "## Exemplars",
        "> PR #3 — feat(orders): add totals",
        "> ## Summary",
        "> - Add totals.",
        "> PR #2 — fix(orders): keep totals",
        "> ## Summary",
        "> - Keep totals.",
        "> PR #1 — docs(orders): document totals",
        "> ## Summary",
        "> Document totals.",
      ]
    : [];
  return [
    "# Author a pull request this repository accepts",
    "- Read `.omp/discover/contribution.json` before writing a pull request.",
    "- Run `bun test` and include the test evidence.",
    ...quotes,
    "",
  ].join("\n");
}

function skillText(body = skillBody(), name = "discover-contribution"): string {
  return [
    "---",
    `name: ${name}`,
    "description: Author a pull request that matches the merged pull requests this repository accepts.",
    "metadata:",
    '  devboard-managed: "true"',
    '  devboard-family: "discover"',
    '  devboard-skill: contribution',
    "---",
    "",
    body,
  ].join("\n");
}

interface Staged {
  directory: string;
  write(): void;
  writeDocument(value: Record<string, unknown>): void;
  writeSkill(text: string): void;
  remove(relative: string): void;
}

function staged(prefix: string): Staged {
  const directory = mkdtempSync(join(TEST_ROOT, prefix));
  directories.push(directory);
  const docPath = join(directory, "contribution.json");
  const skillPath = join(directory, "skills", "discover-contribution", "SKILL.md");
  mkdirSync(join(directory, "skills", "discover-contribution"), { recursive: true });
  const writeDocument = (value: Record<string, unknown>): void => {
    writeFileSync(docPath, `${JSON.stringify(value, null, 2)}\n`);
  };
  return {
    directory,
    write() {
      writeDocument(document());
      writeFileSync(skillPath, skillText());
    },
    writeDocument,
    writeSkill(text: string) {
      writeFileSync(skillPath, text);
    },
    remove(relative: string) {
      rmSync(join(directory, relative), { force: true });
    },
  };
}

function validate(current: Staged): unknown {
  return validateAgentStaged(
    HARNESS_ROOT,
    current.directory,
    FRESHNESS,
    "discover-contribution",
  );
}

function refusal(current: Staged, pattern: RegExp): void {
  expect(() => validate(current)).toThrow(DiscoverValidationError);
  expect(() => validate(current)).toThrow(pattern);
}

describe("contribution document validation", () => {
  test("accepts the documented shape and derives nine sections", () => {
    const current = staged("accept-");
    current.write();
    const result = validate(current) as {
      contribution?: { sections: Array<{ id: string }>; sample: unknown[] };
      skills: unknown[];
    };
    expect(result.contribution?.sections.map((section) => section.id)).toEqual([
      "workflow",
      "testing",
      "pull-request-style",
      "pull-request-size",
      "conventions",
      "review",
      "documentation",
      "hotspots",
      "evidence",
    ]);
    expect(result.contribution?.sample).toHaveLength(3);
    expect(result.skills).toHaveLength(1);
  });

  test("refuses a missing owned document or skill", () => {
    const missingDocument = staged("missing-document-");
    missingDocument.write();
    missingDocument.remove("contribution.json");
    refusal(missingDocument, /left no contribution\.json/);

    const missingSkill = staged("missing-skill-");
    missingSkill.write();
    missingSkill.remove("skills/discover-contribution/SKILL.md");
    refusal(missingSkill, /left no discover-contribution skill/);
  });

  test("refuses a known fact without its value or evidence", () => {
    const noValue = staged("no-value-");
    noValue.write();
    const noValueDoc = document();
    (noValueDoc.workflow as Array<Record<string, unknown>>)[3] = {
      key: "install",
      evidence: ["package.json"],
      confidence: "declared",
    };
    noValue.writeDocument(noValueDoc);
    refusal(noValue, /install\.value.*must be present/);

    const noEvidence = staged("no-evidence-");
    noEvidence.write();
    const noEvidenceDoc = document();
    (noEvidenceDoc.workflow as Array<Record<string, unknown>>)[3] = {
      key: "install",
      value: "bun install",
      evidence: [],
      confidence: "declared",
    };
    noEvidence.writeDocument(noEvidenceDoc);
    refusal(noEvidence, /install\.evidence.*must ground a known fact/);
  });

  test("refuses an unknown fact without its one-line reason", () => {
    const current = staged("unknown-no-reason-");
    current.write();
    const value = document();
    (value.testing as Array<Record<string, unknown>>)[0] = {
      key: "suite",
      evidence: [],
      confidence: "unknown",
    };
    current.writeDocument(value);
    refusal(current, /testing\.suite\.reason: must be a string/);
  });

  test("refuses an unknown fact that carries a value", () => {
    const current = staged("unknown-value-");
    current.write();
    const value = document();
    (value.testing as Array<Record<string, unknown>>)[0] = {
      key: "suite",
      value: "bun test",
      evidence: [],
      confidence: "unknown",
      reason: "No suite command was found.",
    };
    current.writeDocument(value);
    refusal(current, /suite\.value.*must be absent/);
  });

  test("refuses an exemplar that is not in the merged sample", () => {
    const current = staged("unmerged-excerpt-");
    current.write();
    current.writeSkill(
      skillText(
        [
          "# Author a pull request this repository accepts",
          "- Read `.omp/discover/contribution.json` before writing a pull request.",
          "## Exemplars",
          "> PR #4 — closed: never merged",
          "> A description the forge never merged.",
          "",
        ].join("\n"),
      ),
    );
    refusal(current, /exemplar 1 must quote PR #3 verbatim|exactly 3 merged exemplars/);
  });

  test("refuses a secret in the document or the skill", () => {
    const documentSecret = staged("secret-document-");
    documentSecret.write();
    const value = document();
    ((value.source as Record<string, unknown>).mergedPullRequests as Array<Record<string, unknown>>)[0]!
      .body = "Token ghp_0123456789abcdefghijklmnopqrstuvwxyz";
    documentSecret.writeDocument(value);
    refusal(documentSecret, /secret value/);

    const skillSecret = staged("secret-skill-");
    skillSecret.write();
    skillSecret.writeSkill(
      skillText(
        skillBody().replace(
          "- Run `bun test` and include the test evidence.",
          "- Use ghp_0123456789abcdefghijklmnopqrstuvwxyz for the forge.",
        ),
      ),
    );
    refusal(skillSecret, /secret value/);
  });

  test("refuses an absolute path in a fact, an evidence entry, or the skill", () => {
    const factPath = staged("absolute-fact-");
    factPath.write();
    const value = document();
    (value.workflow as Array<Record<string, unknown>>)[3] = {
      key: "install",
      value: "/home/operator/bin/install",
      evidence: ["package.json"],
      confidence: "declared",
    };
    factPath.writeDocument(value);
    refusal(factPath, /absolute host path/);

    const evidencePath = staged("absolute-evidence-");
    evidencePath.write();
    const evidence = document();
    (evidence.workflow as Array<Record<string, unknown>>)[3] = {
      key: "install",
      value: "bun install",
      evidence: ["/home/operator/package.json"],
      confidence: "declared",
    };
    evidencePath.writeDocument(evidence);
    refusal(evidencePath, /absolute host path/);

    const skillPath = staged("absolute-skill-");
    skillPath.write();
    skillPath.writeSkill(
      skillText(
        skillBody().replace(
          "- Run `bun test` and include the test evidence.",
          "- Run /home/operator/bin/test before review.",
        ),
      ),
    );
    refusal(skillPath, /absolute host path/);
  });

  test("refuses a malformed contribution skill", () => {
    const wrongName = staged("wrong-name-");
    wrongName.write();
    wrongName.writeSkill(skillText(skillBody(), "discover-testing-strategy"));
    refusal(wrongName, /must equal the directory name/);

    const prose = staged("prose-");
    prose.write();
    prose.writeSkill(
      skillText(
        skillBody().replace(
          "- Run `bun test` and include the test evidence.",
          "A paragraph instead of a bullet.",
        ),
      ),
    );
    refusal(prose, /imperative bullets/);

    const missingExemplars = staged("missing-exemplars-");
    missingExemplars.write();
    missingExemplars.writeSkill(skillText(skillBody(false)));
    refusal(missingExemplars, /must quote exactly 3 merged exemplars/);
  });

  test("accepts an unavailable forge corpus and requires the unknown statement", () => {
    const current = staged("no-forge-");
    current.write();
    const value = document();
    value.source = {
      forge: null,
      host: null,
      unavailable: "No forge credential or network was available for the target.",
      window: null,
      mergedPullRequests: [],
      closedUnmergedPullRequests: [],
    };
    current.writeDocument(value);
    current.writeSkill(
      skillText(
        [
          "# Author a pull request this repository accepts",
          "- Read `.omp/discover/contribution.json` before writing a pull request.",
          "- Treat pull-request-derived rules and exemplars as unknown: " +
            "No forge credential or network was available for the target.",
          "- Run `bun test` and include the test evidence.",
          "",
        ].join("\n"),
      ),
    );
    const result = validate(current) as { contribution?: { sections: Array<{ id: string; facts: Array<Record<string, unknown>> }> } };
    const style = result.contribution?.sections.find((section) => section.id === "pull-request-style");
    expect(style?.facts.every((fact) => fact.confidence === "unknown")).toBe(true);
    const workflow = result.contribution?.sections.find((section) => section.id === "workflow");
    expect(workflow?.facts.find((fact) => fact.key === "install")?.value).toBe("bun install");
  });
});
