#!/usr/bin/env bun
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(process.argv[2] ?? ".");
const ignoreDirs = new Set([
  "node_modules", ".git", ".worktree", "dist", "build", ".next", ".nuxt", ".svelte-kit",
  "coverage", ".turbo", ".cache", "vendor", "out", "target",
]);

const result = {
  root,
  applicable: false,
  checks: {},
  missing: [],
};

function addMissing(id, requirement, remediation, detail = "") {
  result.missing.push({ id, requirement, remediation, detail });
}

function rel(path) {
  return path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function firstFile(candidates) {
  for (const candidate of candidates) {
    const path = join(root, candidate);
    if (isFile(path)) return path;
  }
  return undefined;
}

function ignored(path) {
  return path.split("/").some((part) => ignoreDirs.has(part));
}

async function globFiles(pattern, { dot = false } = {}) {
  const glob = new Bun.Glob(pattern);
  const files = [];
  for await (const path of glob.scan({ cwd: root, onlyFiles: true, dot })) {
    if (!ignored(path)) files.push(path);
  }
  return files;
}

function readJson(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function checkLayout(text) {
  const heading = /^##\s+(Layout|Layout & Spacing)\s*$/im.exec(text);
  if (!heading) {
    return { ok: false, reason: "missing a ## Layout or ## Layout & Spacing section" };
  }
  const after = text.slice(heading.index + heading[0].length);
  const next = /^##\s+/m.exec(after);
  const section = next ? after.slice(0, next.index) : after;
  const hasSystem = /\b(base(?:\s+unit)?|scale|rhythm|grid|token)\b/i.test(section);
  const hasMeasure = /\b\d+(?:\.\d+)?\s*(?:px|rem|em)\b/i.test(section);
  const hasConvention = /\b(padding|margin|gap|section|container|gutter|component)\b/i.test(
    section,
  );
  if ((!hasSystem && !hasMeasure) || !hasConvention) {
    return {
      ok: false,
      reason:
        "Layout must state a spacing system (base unit/scale/rhythm/grid or a measure) and " +
        "conventions for padding, gaps, sections, containers, or components",
    };
  }
  return { ok: true };
}

function runDesignMdLint() {
  const proc = spawnSync(
    "npx",
    ["--yes", "@google/design.md@0.4.0", "lint", "--format", "json", "DESIGN.md"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  if (proc.error) {
    return { status: "unverified", error: proc.error.message };
  }

  let parsed;
  try {
    parsed = JSON.parse(proc.stdout);
  } catch {
    parsed = undefined;
  }

  if (parsed && parsed.summary) {
    const errors = Number(parsed.summary.errors ?? 0);
    const warnings = Number(parsed.summary.warnings ?? 0);
    const errorFindings = Array.isArray(parsed.findings)
      ? parsed.findings
          .filter((finding) => finding.severity === "error")
          .slice(0, 5)
          .map((finding) => `${finding.path ?? "?"}: ${finding.message}`)
      : [];
    return {
      status: errors > 0 ? "invalid" : "pass",
      errors,
      warnings,
      errorFindings,
    };
  }

  if (proc.status === 0) {
    return { status: "unverified", error: "lint exited 0 without parseable JSON" };
  }

  const stderr = (proc.stderr ?? "").trim();
  const stdout = (proc.stdout ?? "").trim();
  return {
    status: "unverified",
    error: stderr || stdout || `lint exited ${proc.status}`,
  };
}

function countDTCG(node, counter) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  if (Object.prototype.hasOwnProperty.call(node, "$value")) {
    counter.count += 1;
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("$")) continue;
    countDTCG(value, counter);
  }
}

function checkDTCGFile(path) {
  const parsed = readJson(path);
  if (!parsed.ok) return { ok: false, reason: `invalid JSON: ${parsed.error}` };
  const counter = { count: 0 };
  countDTCG(parsed.value, counter);
  if (counter.count === 0) {
    return { ok: false, reason: "no DTCG token with a $value found" };
  }
  return { ok: true, tokenCount: counter.count };
}

function checkOpenUIObject(value) {
  const problems = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problems: ["root must be an object"] };
  }
  for (const key of ["name", "version", "description"]) {
    if (typeof value[key] !== "string" || !value[key].trim()) {
      problems.push(`${key} must be a non-empty string`);
    }
  }
  const components = value.components;
  if (!components || typeof components !== "object" || Array.isArray(components)) {
    problems.push("components must be an object");
    return { ok: false, problems };
  }
  const names = Object.keys(components);
  if (names.length === 0) problems.push("components must not be empty");
  for (const name of names) {
    const component = components[name];
    if (!component || typeof component !== "object" || Array.isArray(component)) {
      problems.push(`${name} must be an object`);
      continue;
    }
    if (typeof component.description !== "string" || !component.description.trim()) {
      problems.push(`${name}.description must be a non-empty string`);
    }
    if (!component.props || typeof component.props !== "object" || Array.isArray(component.props)) {
      problems.push(`${name}.props must be an object`);
    }
  }
  return { ok: problems.length === 0, problems, componentCount: names.length };
}

function checkA2UIVersion() {
  const configPath = join(root, ".design/a2ui/config.json");
  const versionPath = join(root, ".design/a2ui/version");
  let raw = "0.9.1";
  if (isFile(configPath)) {
    const parsed = readJson(configPath);
    if (!parsed.ok) {
      return { ok: false, reason: `invalid .design/a2ui/config.json: ${parsed.error}` };
    }
    raw = String(parsed.value.version ?? "0.9.1");
  } else if (isFile(versionPath)) {
    raw = readFileSync(versionPath, "utf8").trim();
  }
  const version = raw.replace(/^v/i, "");
  if (!["0.9.1", "1.0"].includes(version)) {
    return { ok: false, reason: `unsupported A2UI version "${raw}"` };
  }
  return { ok: true, version };
}

async function main() {
  if (!isDir(root)) {
    result.error = `not a directory: ${root}`;
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // DESIGN.md
  const designPath = join(root, "DESIGN.md");
  if (!isFile(designPath)) {
    result.checks.designMd = { status: "missing", path: "DESIGN.md" };
    addMissing(
      "designMd",
      "DESIGN.md at the project root",
      "Create DESIGN.md in the DESIGN.md alpha format; include tokens and a ## Layout spacing " +
        "section; run `npx --yes @google/design.md@0.4.0 lint --format json DESIGN.md`.",
    );
  } else {
    const text = readFileSync(designPath, "utf8");
    const layout = checkLayout(text);
    const lint = runDesignMdLint();
    const details = [];
    if (!layout.ok) details.push(`Layout: ${layout.reason}`);
    if (lint.status !== "pass") {
      const lintDetail = lint.errorFindings?.length
        ? lint.errorFindings.join("; ")
        : lint.error ?? "lint did not pass";
      details.push(`Lint: ${lintDetail}`);
    }
    const pass = layout.ok && lint.status === "pass";
    result.checks.designMd = {
      status: pass ? "pass" : lint.status === "unverified" ? "unverified" : "invalid",
      path: "DESIGN.md",
      layout,
      lint,
    };
    if (!pass) {
      addMissing(
        "designMd",
        "valid DESIGN.md with mandatory spacing conventions",
        "Fix the DESIGN.md findings; add a ## Layout section with base unit, scale, rhythm, " +
          "component padding, gaps, section spacing, container widths, and token mapping; rerun " +
          "`npx --yes @google/design.md@0.4.0 lint --format json DESIGN.md`.",
        details.join(" "),
      );
    }
  }

  // DTCG
  let dtcgPath = firstFile([
    "design/tokens.json",
    "tokens.json",
    "src/design/tokens.json",
    "src/styles/tokens.json",
    ".design/tokens.json",
  ]);
  if (!dtcgPath) {
    const files = await globFiles("**/*.tokens.json");
    dtcgPath = files[0] ? join(root, files[0]) : undefined;
  }
  if (!dtcgPath && isDir(join(root, "design/tokens"))) {
    const files = await globFiles("design/tokens/**/*.json");
    dtcgPath = files[0] ? join(root, files[0]) : undefined;
  }
  if (!dtcgPath) {
    result.checks.dtcg = { status: "missing" };
    addMissing(
      "dtcg",
      "DTCG token file",
      "Generate it from DESIGN.md with `npx --yes @google/design.md@0.4.0 export --format dtcg " +
        "DESIGN.md > design/tokens.json`, or add the project's existing DTCG source.",
    );
  } else {
    const dtcg = checkDTCGFile(dtcgPath);
    result.checks.dtcg = {
      status: dtcg.ok ? "pass" : "invalid",
      path: rel(dtcgPath),
      tokenCount: dtcg.tokenCount,
      reason: dtcg.reason,
    };
    if (!dtcg.ok) {
      addMissing(
        "dtcg",
        "valid DTCG token file",
        "Regenerate design/tokens.json from DESIGN.md or fix the DTCG structure ($value/$type).",
        `${rel(dtcgPath)}: ${dtcg.reason}`,
      );
    }
  }

  // OpenUI
  const openuiPath = firstFile([
    "openui.json",
    "openui.yaml",
    "design/openui.json",
    "design/openui.yaml",
  ]);
  if (!openuiPath) {
    result.checks.openui = { status: "missing" };
    addMissing(
      "openui",
      "OpenUI component catalog at the project root",
      "Add openui.json or openui.yaml following openuispec.org draft-01, with name, version, " +
        "description, and components.",
    );
  } else {
    let parsed;
    let parseError;
    if (openuiPath.endsWith(".json")) {
      const json = readJson(openuiPath);
      if (json.ok) parsed = json.value;
      else parseError = json.error;
    } else {
      try {
        parsed = Bun.YAML.parse(readFileSync(openuiPath, "utf8"));
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
    }
    if (parseError) {
      result.checks.openui = { status: "invalid", path: rel(openuiPath), reason: parseError };
      addMissing(
        "openui",
        "valid OpenUI component catalog",
        "Fix the OpenUI file so it parses and follows the draft-01 component schema.",
        `${rel(openuiPath)}: ${parseError}`,
      );
    } else {
      const openui = checkOpenUIObject(parsed);
      result.checks.openui = {
        status: openui.ok ? "pass" : "invalid",
        path: rel(openuiPath),
        componentCount: openui.componentCount,
        problems: openui.problems,
      };
      if (!openui.ok) {
        addMissing(
          "openui",
          "valid OpenUI component catalog",
          "Fix the OpenUI catalog: require name, version, description, and a non-empty components " +
            "map; each component needs description and props.",
          `${rel(openuiPath)}: ${openui.problems.join("; ")}`,
        );
      }
    }
  }

  // Storybook
  let storybookConfig = firstFile([
    ".storybook/main.js",
    ".storybook/main.ts",
    ".storybook/main.mjs",
    ".storybook/main.cjs",
    ".storybook/main.mts",
    ".storybook/main.cts",
    "storybook/main.js",
    "storybook/main.ts",
  ]);
  if (!storybookConfig) {
    const configs = await globFiles("**/.storybook/main.*", { dot: true });
    storybookConfig = configs[0] ? join(root, configs[0]) : undefined;
  }
  if (!storybookConfig) {
    const configs = await globFiles("**/storybook/main.*", { dot: true });
    storybookConfig = configs[0] ? join(root, configs[0]) : undefined;
  }
  const storyFiles = (await globFiles("**/*.stories.*")).filter((path) =>
    /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/.test(path),
  );
  if (!storybookConfig || storyFiles.length === 0) {
    result.checks.storybook = {
      status: "missing",
      config: storybookConfig ? rel(storybookConfig) : null,
      storyCount: storyFiles.length,
    };
    addMissing(
      "storybook",
      "Storybook config and at least one CSF story",
      "Add .storybook/main.* and at least one *.stories.* CSF file. The page's in-scope " +
        "components need stories in Step 5.",
    );
  } else {
    result.checks.storybook = {
      status: "pass",
      config: rel(storybookConfig),
      storyCount: storyFiles.length,
      sampleStories: storyFiles.slice(0, 5),
      note: "Per-component story coverage is checked at Step 4 and completed at Step 5.",
    };
  }

  // A2UI is provided by this skill; only the pinned version can be invalid.
  const a2ui = checkA2UIVersion();
  if (!a2ui.ok) {
    result.checks.a2ui = { status: "invalid", reason: a2ui.reason };
    addMissing(
      "a2ui",
      "supported A2UI version",
      'Set .design/a2ui/config.json to {"version":"0.9.1"} or {"version":"1.0"}, or remove the pin.',
      a2ui.reason,
    );
  } else {
    result.checks.a2ui = {
      status: "provided-by-skill",
      version: a2ui.version,
      note: "Step 3 writes A2UI JSONL plus a standalone wireframe.",
    };
  }

  result.checks.mcp = {
    status: "check-at-mutation",
    requiredTools: [
      "mcp__designmd_search_design_kits",
      "mcp__designmd_get_design_kit",
    ],
    note: "Not checked here. Verify before any design-system mutation; no research means no mutation.",
  };

  result.applicable = result.missing.length === 0;
  console.log(JSON.stringify(result, null, 2));
}

await main();
