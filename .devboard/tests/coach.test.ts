import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { journalFile } from "../server/journal";
import { agentRegistry } from "../server/agents/registry";
import { saveSubscriptions, writeSelectionSnapshot } from "../server/providers";
import { OPENCODE_GO_MODEL } from "../server/providers/catalog";
import { openCodePeers } from "../coach/providers";
import { CoachActivity, preflightCoach } from "../server/coach";
import { coachDirectory } from "../coach/paths";
import {
  DEFAULT_COACH_SETTINGS,
  isValidAllowlist,
  isValidIssuesPerCycle,
  parseCoachSettings,
  readCoachSettings,
  writeCoachSettings,
} from "../coach/settings";
import { readWorkerState, writeWorkerState } from "../coach/worker-state";
import { loadLedger, saveLedger } from "../coach/ledger";
import { readCoachStatus } from "../coach/status";
import { describeCycle, runCycle, type CoachReport } from "../coach/coordinator";
import {
  buildFamilies,
  familyKey,
  isTrivialCommand,
  normalizeCommandSignature,
  type CoachFamily,
} from "../coach/families";
import {
  familyTag,
  issueBody,
  issueTitle,
  ISSUE_BODY_MAX_BYTES,
  ISSUE_TITLE_MAX_BYTES,
} from "../coach/issue";
import {
  parseSynthesisAnswer,
  synthesisPrompt,
  SYNTHESIS_PROMPT_MAX_BYTES,
  synthesizeFamily,
  type Proposal,
  type Synthesize,
} from "../coach/synthesize";
import { allowlistEntryFor, validateProposal } from "../coach/validate";
import type { AgentSession, SessionToolCall, SessionToolResult } from "../lib/agent-sessions";
import type { CoachCollection, CoachJournalRecord } from "../coach/collect";
import type { CoachDelivery, DeliveryResult } from "../coach/delivery";
import type { CoachOpenIssue } from "../coach/issue";

const harnessRoot = resolve(import.meta.dir, "..");
const directories: string[] = [];

afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  await mkdir(join(harnessRoot, ".tmp"), { recursive: true });
  const directory = await mkdtemp(join(harnessRoot, ".tmp", "coach-"));
  directories.push(directory);
  return directory;
}

const NOW = new Date("2026-01-10T12:00:00.000Z");
const START = new Date(NOW.getTime() - 24 * 60 * 60_000);

function instant(minutesAgo: number, from = NOW): string {
  return new Date(from.getTime() - minutesAgo * 60_000).toISOString();
}

async function workspace(): Promise<{ root: string; repoDir: string; stateDir: string }> {
  const root = await temporaryRoot();
  const repoDir = join(root, "checkout");
  const stateDir = join(root, "state");
  await mkdir(join(repoDir, ".devboard"), { recursive: true });
  await mkdir(coachDirectory(stateDir), { recursive: true });
  return { root, repoDir, stateDir };
}

interface CallSeed {
  command: string;
  name?: string;
  isError?: boolean;
  text?: string;
  at?: string;
}

function sessionOf(options: {
  id: string;
  startedAt: string;
  title?: string;
  calls: CallSeed[];
}): AgentSession {
  const calls: SessionToolCall[] = [];
  const results: SessionToolResult[] = [];
  options.calls.forEach((seed, index) => {
    const name = seed.name ?? "bash";
    calls.push({
      id: `call-${index}`,
      name,
      argumentsText: JSON.stringify(
        name === "bash" ? { command: seed.command } : { path: seed.command },
      ),
      command: name === "bash" ? seed.command : null,
      index,
      timestamp: seed.at ?? options.startedAt,
    });
    results.push({
      toolCallId: `call-${index}`,
      toolName: name,
      text: seed.text ?? (seed.isError === true ? "ERROR: failed" : "ok"),
      isError: seed.isError === true,
      index,
      timestamp: seed.at ?? options.startedAt,
    });
  });
  return {
    id: options.id,
    path: `/fixture/${options.id}.jsonl`,
    relativePath: `providers/agents/fixture/sessions/bucket/${options.id}.jsonl`,
    startedAt: options.startedAt,
    title: options.title ?? `session ${options.id}`,
    cwd: "/checkout",
    relativeCwd: ".",
    messages: [],
    calls,
    results,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    cost: 0,
    messageCount: 0,
    toolErrorCount: results.filter((result) => result.isError).length,
    malformed: 0,
  };
}

function collectionOf(
  sessions: AgentSession[],
  journal: CoachJournalRecord[] = [],
): CoachCollection {
  return {
    window: { start: START.toISOString(), end: NOW.toISOString() },
    sessions,
    journal,
    sessionFiles: sessions.length,
    sessionsOmitted: 0,
    truncated: false,
    skipped: 0,
    malformed: 0,
    journalRecords: journal.length,
  };
}

function familiesOf(sessions: AgentSession[], journal: CoachJournalRecord[] = []): CoachFamily[] {
  return buildFamilies({
    sessions,
    journal,
    window: { start: START.toISOString(), end: NOW.toISOString() },
    repoDir: "/checkout",
  }).families;
}

function memoryDelivery(
  open: CoachOpenIssue[] = [],
): CoachDelivery & { created: Array<{ title: string; body: string }> } {
  const created: Array<{ title: string; body: string }> = [];
  const issues = open.slice();
  return {
    repository: "acme/fixture",
    created,
    async list() {
      return issues.slice();
    },
    async create(title: string, body: string): Promise<DeliveryResult> {
      created.push({ title, body });
      issues.push({
        number: issues.length + 1,
        title,
        body,
        url: `https://forge.test/acme/fixture/issues/${issues.length + 1}`,
      });
      return { ok: true, url: issues[issues.length - 1]!.url };
    },
  };
}

function toolProposal(
  family: CoachFamily,
  index = 1,
  overrides: Partial<Proposal> = {},
): Proposal {
  const base: Proposal = {
    family: family.key,
    action: "tool",
    tool: {
      name: `coach_tool_${index}`,
      title: `Coach tool ${index}`,
      description: "Removes the recurring command with one named capability.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      covers: [family.key],
    },
    rationale: "The family recurs; one named tool removes the repeated manual command.",
    acceptance: ["- [ ] The command runs through the named tool."],
  };
  const merged = { ...base, ...overrides } as Proposal;
  if (base.tool !== undefined) merged.tool = overrides.tool ?? base.tool;
  return merged;
}

function synthesisFor(
  proposals: Map<string, Proposal> | ((family: CoachFamily) => Proposal),
  calls: Array<{ key: string; prompt: string }> = [],
): Synthesize {
  let index = 0;
  return async (family, prompt) => {
    calls.push({ key: family.key, prompt });
    index += 1;
    const proposal =
      typeof proposals === "function"
        ? proposals(family)
        : (proposals.get(family.key) ?? toolProposal(family, index));
    return { ok: true, text: JSON.stringify(proposal), model: "stub", durationMs: 1 };
  };
}

function threeFamilies(): AgentSession[] {
  return [
    sessionOf({
      id: "a1",
      startedAt: instant(60),
      calls: [
        { command: "bun run publish 2>&1 | tail -40" },
        { command: "bun install --frozen-lockfile 2>&1 | tail -10" },
      ],
    }),
    sessionOf({
      id: "a2",
      startedAt: instant(30),
      calls: [{ command: "bun .devboard/scripts/forge-auth.ts check --host 127.0.0.1" }],
    }),
  ];
}

describe("Coach registration and lifecycle", () => {
  test("the registry declares coach with its defaults", () => {
    expect(agentRegistry.ids()).toEqual(["scout", "watchdog", "design", "coach"]);
    const coach = agentRegistry.require("coach");
    expect(coach.label).toBe("Coach");
    expect(coach.scope).toBe("repository");
    expect(coach.cadence.defaultMinutes).toBe(60);
    expect(coach.limits.default).toEqual({ maxPerHour: 10, maxPending: 20 });
    expect(coach.detail.panel).toBe("cycles");
    expect(coach.tab.id).toBe("coach");
  });

  test("start reaches starting before the worker and running once its state exists", async () => {
    const { repoDir, stateDir } = await workspace();
    const coachDir = coachDirectory(stateDir);
    let spawned = 0;
    const adapter = new CoachActivity({
      descriptor: agentRegistry.require("coach"),
      repoDir,
      stateDir,
      harnessDir: harnessRoot,
      send: () => undefined,
      preflight: async () => ({ ok: true }),
      spawnWorker: (argv) => {
        spawned += 1;
        expect(argv).toContain(join(harnessRoot, "coach", "worker.ts"));
        writeWorkerState(coachDir, {
          version: 1,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          root: repoDir,
          stateDir,
          lifecycle: "running",
          enabled: true,
          harnessVersion: "test",
          argv,
          lastRunAt: null,
          nextRunAt: null,
          lastError: null,
          notice: null,
          updatedAt: new Date().toISOString(),
        });
        return process.pid;
      },
    });
    const pending = adapter.start();
    expect(adapter.snapshot().lifecycle).toBe("starting");
    const result = await pending;
    expect(result.ok).toBe(true);
    const running = adapter.snapshot();
    expect(running.lifecycle).toBe("running");
    expect(running.owned).toBe(true);
    expect(spawned).toBe(1);

    expect(adapter.stop().ok).toBe(true);
    expect(adapter.snapshot().lifecycle).toBe("stopping");
    writeWorkerState(coachDir, {
      ...readWorkerState(coachDir)!,
      lifecycle: "stopped",
      enabled: false,
    });
    expect(adapter.snapshot().lifecycle).toBe("stopped");
    adapter.dispose();
  });

  test("a refused preflight writes no state and spawns nothing", async () => {
    const { repoDir, stateDir } = await workspace();
    let spawned = 0;
    const adapter = new CoachActivity({
      descriptor: agentRegistry.require("coach"),
      repoDir,
      stateDir,
      harnessDir: harnessRoot,
      send: () => undefined,
      preflight: async () => ({ ok: false, message: "missing prerequisite: no origin" }),
      spawnWorker: () => {
        spawned += 1;
        return process.pid;
      },
    });
    const result = await adapter.start();
    expect(result.ok).toBe(false);
    expect(spawned).toBe(0);
    expect(existsSync(join(coachDirectory(stateDir), "worker.json"))).toBe(false);
    adapter.dispose();
  });

  test("cadence and limits persist without dropping the family settings", async () => {
    const { repoDir, stateDir } = await workspace();
    const coachDir = coachDirectory(stateDir);
    await writeCoachSettings(coachDir, {
      ...DEFAULT_COACH_SETTINGS,
      maxIssuesPerCycle: 5,
      allowlist: ["bun "],
    });
    const adapter = new CoachActivity({
      descriptor: agentRegistry.require("coach"),
      repoDir,
      stateDir,
      harnessDir: harnessRoot,
      send: () => undefined,
    });
    expect(adapter.setSettings(30, 5, null).ok).toBe(true);
    expect(readCoachSettings(coachDir)).toEqual({
      ...DEFAULT_COACH_SETTINGS,
      intervalMinutes: 30,
      maxPerHour: 5,
      maxPending: null,
      maxIssuesPerCycle: 5,
      allowlist: ["bun "],
    });
    expect(adapter.setSettings(0, 5, 5).ok).toBe(false);
    expect(adapter.setSettings(30, 101, 5).ok).toBe(false);
    adapter.dispose();
  });

  test("preflight names a GitLab origin as unsupported", async () => {
    const { repoDir } = await workspace();
    Bun.spawnSync({ cmd: ["git", "init", "-q", repoDir], stdout: "ignore", stderr: "ignore" });
    Bun.spawnSync({
      cmd: ["git", "-C", repoDir, "remote", "add", "origin", "https://gitlab.example/acme/fixture.git"],
      stdout: "ignore",
      stderr: "ignore",
    });
    const result = await preflightCoach({ repoDir, environment: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("GitLab");
  });
});

describe("Coach normalization", () => {
  const repo = "/checkout";

  test("pipes and redirections are output handling, not the family", () => {
    expect(normalizeCommandSignature("bun run publish 2>&1 | tail -40", repo)).toBe(
      "bun run publish",
    );
    expect(normalizeCommandSignature("bun run publish | tail -60", repo)).toBe("bun run publish");
    expect(normalizeCommandSignature("bun install --frozen-lockfile 2>&1 | tail -10", repo)).toBe(
      "bun install",
    );
    expect(
      normalizeCommandSignature(
        "bun .devboard/scripts/forge-auth.ts check --host 127.0.0.1 --project p --required write",
        repo,
      ),
    ).toBe("bun .devboard/scripts/forge-auth.ts check");
  });

  test("segments keep the first non-trivial command and drop the directory change", () => {
    expect(
      normalizeCommandSignature(
        "git push origin HEAD:main && git ls-remote origin refs/heads/main",
        repo,
      ),
    ).toBe("git push origin HEAD:main");
    expect(normalizeCommandSignature("cd .devboard && bun test", repo)).toBe("bun test");
    expect(
      normalizeCommandSignature(`( cd /checkout && bun run publish 2>&1 | tail -5 )`, repo),
    ).toBe("bun run publish");
  });

  test("the environment prefix, root, worktree, and volatile tokens are replaced", () => {
    expect(normalizeCommandSignature(`ADRS_DIR=${repo}/adrs bun run build`, repo)).toBe(
      "bun run build",
    );
    expect(
      normalizeCommandSignature(
        `DEVBOARD_GITEA_URL=x ${repo}/.worktree/task/bin/tool --run 2026-01-10T12:00:00Z`,
        repo,
      ),
    ).toBe("<repo>/.worktree/<worktree>/bin/tool");
    expect(normalizeCommandSignature("git -C /checkout status", repo)).toBe("git status");
    expect(normalizeCommandSignature("tool 1234567890", repo)).toBe("tool <hex>");
  });

  test("trivial prefixes stay trivial and a different prefix is a different family", () => {
    expect(isTrivialCommand("git status --short --branch")).toBe(true);
    expect(isTrivialCommand("git push origin main")).toBe(false);
    expect(familyKey("git push origin main")).toBe("git push origin main");
    expect(familyKey("git push origin other")).not.toBe(familyKey("git push origin main"));
  });
});

describe("Coach families", () => {
  test("groups one normalized command and counts fragments", () => {
    const families = familiesOf([
      sessionOf({
        id: "a",
        startedAt: instant(60),
        calls: [
          { command: "bun run publish 2>&1 | tail -40" },
          { command: "bun run publish --watch" },
          { command: "bun install --frozen-lockfile" },
        ],
      }),
      sessionOf({ id: "b", startedAt: instant(30), calls: [{ command: "bun run publish" }] }),
    ]);
    expect(families.map((family) => family.key).sort()).toEqual([
      "bun install",
      "bun run publish",
    ]);
    const publish = families.find((family) => family.key === "bun run publish")!;
    expect(publish.kind).toBe("command");
    expect(publish.calls).toBe(3);
    expect(publish.sessions).toEqual(["a", "b"]);
    expect(publish.days).toBe(1);
    expect(publish.score).toBe(3 * 2 * 1);
    expect(publish.fragments.reduce((total, fragment) => total + fragment.count, 0)).toBe(3);
  });

  test("a nonzero trivial command and a read-only error produce no family", () => {
    const families = familiesOf([
      sessionOf({
        id: "a",
        startedAt: instant(60),
        calls: [
          { command: "bun run build", isError: true },
          { command: "/some/path.ts", name: "read", isError: true },
        ],
      }),
    ]);
    expect(families).toEqual([]);
  });

  test("a mutating tool error attaches to its family and a retry adds weight", () => {
    const families = familiesOf([
      sessionOf({
        id: "a",
        startedAt: instant(60),
        calls: [
          { command: "src/app.ts", name: "edit", isError: true, text: "ERROR: no match" },
          { command: "git push origin HEAD:main", isError: true, text: "ERROR: rejected" },
          { command: "git push origin HEAD:main", isError: true, text: "ERROR: rejected" },
          { command: "git push origin HEAD:main", isError: true, text: "ERROR: rejected" },
        ],
      }),
    ]);
    expect(families.map((family) => family.key).sort()).toEqual(["edit", "git push origin HEAD:main"]);
    const push = families.find((family) => family.key === "git push origin HEAD:main")!;
    expect(push.calls).toBe(4);
    expect(push.fragments.some((fragment) => fragment.text.startsWith("retry"))).toBe(true);
  });

  test("journal questions and run failures need two scopes", () => {
    const journal: CoachJournalRecord[] = [
      { kind: "question", text: "Should I rewrite it?", scope: "run-a", ts: instant(30) },
      { kind: "question", text: "Should I rewrite it?", scope: "run-b", ts: instant(20) },
      { kind: "acp-stderr", text: "fatal: provider exploded\nmore", scope: "run-a", ts: instant(30) },
      { kind: "acp-stderr", text: "fatal: provider exploded\nmore", scope: "run-b", ts: instant(20) },
      { kind: "question", text: "One scope only?", scope: "run-a", ts: instant(10) },
    ];
    const families = familiesOf([], journal);
    expect(families.map((family) => family.key).sort()).toEqual([
      "question: Should I rewrite it?",
      "run-failure: fatal: provider exploded",
    ]);
    const question = families.find((family) => family.kind === "question")!;
    expect(question.sessions).toEqual(["run-a", "run-b"]);
    expect(question.score).toBe(2 * 1 * 2);
  });

  test("coach-owned, worktree, tmp, and fixture evidence is excluded", () => {
    const families = familiesOf(
      [
        sessionOf({
          id: "a",
          startedAt: instant(60),
          calls: [
            { command: "bun run verify:coach" },
            { command: `cd ${"/checkout/.worktree/task"} && bun run publish` },
            { command: "bun .devboard/.tmp/script.ts" },
            { command: "true" },
            { command: "echo hello" },
            { command: "i: noop" },
          ],
        }),
      ],
    );
    expect(families).toEqual([]);
  });

  test("the score orders families and ties break by key ascending", () => {
    const selection = buildFamilies({
      sessions: [
        sessionOf({
          id: "a1",
          startedAt: instant(120),
          calls: [{ command: "aaa --one" }, { command: "aaa --two" }],
        }),
        sessionOf({ id: "a2", startedAt: instant(100), calls: [{ command: "aaa --three" }] }),
        sessionOf({
          id: "b1",
          startedAt: instant(60),
          calls: [
            { command: "bbb --one", at: instant(1_400) },
            { command: "bbb --two", at: instant(700) },
            { command: "bbb --three", at: instant(600) },
          ],
        }),
      ],
      journal: [],
      window: { start: START.toISOString(), end: NOW.toISOString() },
      repoDir: "/checkout",
    });
    expect(selection.families.map((family) => family.key)).toEqual(["aaa", "bbb"]);
    expect(selection.families.map((family) => family.score)).toEqual([6, 6]);
    expect(selection.selected.map((family) => family.key)).toEqual(["aaa", "bbb"]);
  });

  test("selects at most 20 and reports the omitted count", () => {
    const sessions: AgentSession[] = [];
    for (let index = 0; index < 21; index += 1) {
      sessions.push(
        sessionOf({
          id: `s${index}`,
          startedAt: instant(60 + index),
          calls: [{ command: `cmd-${String(index).padStart(2, "0")}` }],
        }),
      );
    }
    const selection = buildFamilies({
      sessions,
      journal: [],
      window: { start: START.toISOString(), end: NOW.toISOString() },
      repoDir: "/checkout",
    });
    expect(selection.families).toHaveLength(21);
    expect(selection.selected).toHaveLength(20);
    expect(selection.omitted).toBe(1);
    expect(selection.selected.map((family) => family.key)).toEqual(
      selection.selected.map((family) => family.key).slice().sort(),
    );
  });
});

describe("Coach synthesis contract and prompt", () => {
  const family = familiesOf([
    sessionOf({
      id: "a",
      startedAt: instant(60),
      calls: [{ command: "bun run publish", isError: true, text: "ERROR: boom" }],
    }),
  ])[0]!;

  test("the prompt carries the evidence, catalog, issues, allowlist and stays bounded", () => {
    const openIssues: CoachOpenIssue[] = [
      {
        number: 7,
        title: "[coach] bun run publish",
        body: `family:${familyTag(family.key)}`,
        url: "https://forge.test/acme/fixture/issues/7",
      },
    ];
    const settings = { ...DEFAULT_COACH_SETTINGS, allowlist: ["bun "] };
    const prompt = synthesisPrompt({ family, settings, openIssues });
    expect(prompt).toContain(family.key);
    expect(prompt).toContain("bun run verify:mcp");
    expect(prompt).toContain("https://forge.test/acme/fixture/issues/7");
    expect(prompt).toContain('"bun "');
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(24 * 1024);
    expect(synthesisPrompt({ family, settings, openIssues })).toBe(prompt);
  });

  test("a prompt above the byte budget is cut to the budget", () => {
    const huge: CoachFamily = {
      key: family.key,
      kind: "command",
      calls: 1,
      sessions: ["a"],
      days: 1,
      firstAt: family.firstAt,
      lastAt: family.lastAt,
      score: 1,
      fragments: [{ text: "界".repeat(30_000), count: 1 }],
      excerpts: [],
    };
    const prompt = synthesisPrompt({
      family: huge,
      settings: DEFAULT_COACH_SETTINGS,
      openIssues: [],
    });
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(SYNTHESIS_PROMPT_MAX_BYTES);
  });

  test("the contract rejects missing, extra, and mistyped fields", () => {
    const valid = toolProposal(family);
    expect(parseSynthesisAnswer(JSON.stringify(valid), family.key).action).toBe("tool");
    expect(() =>
      parseSynthesisAnswer(JSON.stringify({ ...valid, extra: true }), family.key),
    ).toThrow("unknown field");
    expect(() =>
      parseSynthesisAnswer(JSON.stringify({ ...valid, family: "another" }), family.key),
    ).toThrow("instead of");
    expect(() =>
      parseSynthesisAnswer(JSON.stringify({ ...valid, acceptance: [] }), family.key),
    ).toThrow("acceptance");
    expect(() =>
      parseSynthesisAnswer(JSON.stringify({ ...valid, action: "none" }), family.key),
    ).toThrow("must not carry a tool");
    expect(() => parseSynthesisAnswer("```json\n{}\n```", family.key)).toThrow("no JSON object");
  });
});

describe("Coach validator", () => {
  const family = familiesOf([
    sessionOf({
      id: "a",
      startedAt: instant(60),
      calls: [{ command: "bun run publish", isError: true, text: "ERROR: boom" }],
    }),
  ])[0]!;
  const settings = { ...DEFAULT_COACH_SETTINGS, allowlist: ["bun "] };
  const openIssues: CoachOpenIssue[] = [];

  const ruleOf = (proposal: Proposal, options: {
    settings?: typeof settings;
    openIssues?: CoachOpenIssue[];
  } = {}): string | undefined => {
    const result = validateProposal({
      family,
      proposal,
      settings: options.settings ?? settings,
      openIssues: options.openIssues ?? openIssues,
    });
    return result.ok ? undefined : result.rule;
  };

  test("accepts a closed schema with a family cover and an allowlist entry", () => {
    const result = validateProposal({
      family,
      proposal: toolProposal(family),
      settings,
      openIssues,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.allowlistEntry).toBe("bun ");
      expect(result.body).toContain("## Proposed tool");
    }
  });

  test("rejects every named rule", () => {
    expect(ruleOf(toolProposal(family, 1, { family: "other" }))).toBe("family-mismatch");
    expect(
      ruleOf(
        toolProposal(family, 1, {
          tool: { ...toolProposal(family).tool!, name: "goal_get" },
        }),
      ),
    ).toBe("tool-name-duplicate");
    expect(
      ruleOf(
        toolProposal(family, 1, {
          tool: { ...toolProposal(family).tool!, covers: ["git push"] },
        }),
      ),
    ).toBe("covers-unmatched");
    expect(
      ruleOf(
        toolProposal(family, 1, {
          tool: {
            ...toolProposal(family).tool!,
            covers: ["bun run publish --watch"],
          },
        }),
      ),
    ).toBe("covers-unmatched");
    const fragmentFamily: CoachFamily = {
      ...family,
      fragments: [{ text: "bun run publish --watch", count: 2 }],
    };
    const fragmentResult = validateProposal({
      family: fragmentFamily,
      proposal: toolProposal(fragmentFamily, 1, {
        tool: {
          ...toolProposal(fragmentFamily).tool!,
          covers: ["bun run publish --watch"],
        },
      }),
      settings,
      openIssues,
    });
    expect(fragmentResult.ok).toBe(false);
    if (!fragmentResult.ok) expect(fragmentResult.rule).toBe("covers-requires-family");
    expect(
      ruleOf(
        toolProposal(family, 1, {
          tool: { ...toolProposal(family).tool!, inputSchema: { type: "object", properties: {} } },
        }),
      ),
    ).toBe("input-schema");
    expect(
      ruleOf(toolProposal(family, 1, { acceptance: ["- [ ] ok", "not a box"] })),
    ).toBe("acceptance");
    expect(
      ruleOf(toolProposal(family), { settings: { ...settings, allowlist: [] } }),
    ).toBe("allowlist-missing");
    expect(ruleOf(toolProposal(family))).toBeUndefined();
  });

  test("covers match the family key or a fragment, with a trailing star", () => {
    const star = toolProposal(family, 1, {
      tool: { ...toolProposal(family).tool!, covers: ["bun run*"] },
    });
    expect(ruleOf(star)).toBeUndefined();
    const fragment = toolProposal(family, 1, {
      tool: { ...toolProposal(family).tool!, covers: ["bun run", "bun run publish"] },
    });
    expect(ruleOf(fragment)).toBeUndefined();
    expect(allowlistEntryFor("bun run publish", ["git ", "bun*"])).toBe("bun*");
  });

  test("a rendered body over 64 KiB is rejected", () => {
    const fragments = Array.from({ length: 260 }, (_unused, index) => ({
      text: `${"x".repeat(280)}-${index}`,
      count: 1,
    }));
    const huge: CoachFamily = {
      ...family,
      fragments,
      excerpts: [],
    };
    const result = validateProposal({
      family: huge,
      proposal: toolProposal(huge),
      settings: { ...settings, allowlist: ["bun"] },
      openIssues,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rule).toBe("body-size");
  });

  test("a prompt proposal needs no allowlist and files the instruction", () => {
    const proposal: Proposal = {
      family: family.key,
      action: "prompt",
      prompt: { instruction: "Always run the publish helper.", target: ".devboard/prompts/x.md" },
      rationale: "One instruction is enough.",
      acceptance: ["- [ ] The helper runs."],
    };
    const result = validateProposal({ family, proposal, settings, openIssues });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toContain("## Proposed prompt");
      expect(result.body).toContain("Always run the publish helper.");
    }
  });
});

describe("Coach cycle", () => {
  test("one synthesis call per family, filing the exact tool definition", async () => {
    const { repoDir, stateDir } = await workspace();
    const collection = collectionOf(threeFamilies());
    const delivery = memoryDelivery();
    const calls: Array<{ key: string; prompt: string }> = [];
    const proposals = new Map<string, Proposal>();
    const families = buildFamilies({ ...collection, repoDir });
    families.selected.forEach((family, index) => {
      proposals.set(family.key, toolProposal(family, index + 1));
    });
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () => collection,
      delivery,
      synthesize: synthesisFor(proposals, calls),
      settings: { ...DEFAULT_COACH_SETTINGS, maxIssuesPerCycle: 20, allowlist: ["bun "] },
    });
    expect(result.report.action).toBe("filed");
    expect(calls.length).toBe(families.selected.length);
    expect(delivery.created.length).toBe(families.selected.length);
    for (const created of delivery.created) {
      const family = families.selected.find((entry) => created.title === issueTitle(entry, "tool"));
      expect(family).toBeDefined();
      const proposal = proposals.get(family!.key)!;
      expect(created.body).toContain(JSON.stringify(proposal.tool, null, 2));
      for (const section of [
        "## Family",
        "## Evidence",
        "## Proposed tool",
        "## Acceptance",
        "## Rationale",
      ]) {
        expect(created.body.split(section).length - 1).toBe(1);
      }
      expect(created.body).toContain(`family:${familyTag(family!.key)}`);
      expect(created.body).toContain(JSON.stringify("bun "));
      expect(Buffer.byteLength(created.body, "utf8")).toBeLessThan(ISSUE_BODY_MAX_BYTES);
    }
    expect(result.report.families).toBeGreaterThanOrEqual(3);
    expect(result.report.selected).toHaveLength(families.selected.length);
    expect(result.report.validations.filter((entry) => entry.outcome === "filed")).toHaveLength(
      families.selected.length,
    );
  });

  test("a second cycle files nothing for the same families", async () => {
    const { repoDir, stateDir } = await workspace();
    const collection = collectionOf(threeFamilies());
    const delivery = memoryDelivery();
    const synthesize = synthesisFor(new Map());
    const options = {
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () => collection,
      delivery,
      synthesize,
      settings: { ...DEFAULT_COACH_SETTINGS, maxIssuesPerCycle: 20, allowlist: ["bun "] },
    };
    const first = await runCycle(options);
    expect(first.report.action).toBe("filed");
    const created = delivery.created.length;
    const second = await runCycle(options);
    expect(second.report.action).not.toBe("failed");
    expect(delivery.created.length).toBe(created);
    expect(second.report.duplicates.length).toBeGreaterThan(0);
  });

  test("duplicate detection reads the title and the body family tag", async () => {
    const { repoDir, stateDir } = await workspace();
    const collection = collectionOf(threeFamilies());
    const families = buildFamilies({ ...collection, repoDir });
    const family = families.selected[0]!;
    const delivery = memoryDelivery([
      {
        number: 1,
        title: issueTitle(family, "tool"),
        body: "unrelated",
        url: "https://forge.test/acme/fixture/issues/1",
      },
      {
        number: 2,
        title: "Unrelated title",
        body: `evidence family:${familyTag(family.key)}`,
        url: "https://forge.test/acme/fixture/issues/2",
      },
    ]);
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () => collection,
      delivery,
      synthesize: synthesisFor((entry) => toolProposal(entry, 1)),
      settings: { ...DEFAULT_COACH_SETTINGS, maxIssuesPerCycle: 20, allowlist: ["bun "] },
    });
    expect(result.report.duplicates.length).toBeGreaterThan(0);
    expect(delivery.created.some((entry) => entry.title === issueTitle(family, "tool"))).toBe(false);
  });

  test("none is recorded with its rationale and files nothing", async () => {
    const { repoDir, stateDir } = await workspace();
    const collection = collectionOf(threeFamilies());
    const delivery = memoryDelivery();
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () => collection,
      delivery,
      synthesize: async (family) => ({
        ok: true,
        model: "stub",
        durationMs: 2,
        text: JSON.stringify({
          family: family.key,
          action: "none",
          rationale: "The recurrence is expected and needs no change.",
          acceptance: ["- [ ] Nothing changes."],
        }),
      }),
      settings: { ...DEFAULT_COACH_SETTINGS, maxIssuesPerCycle: 20, allowlist: ["bun "] },
    });
    expect(result.report.action).toBe("none");
    expect(delivery.created).toEqual([]);
    expect(result.report.validations.every((entry) => entry.outcome === "none")).toBe(true);
    const ledger = loadLedger(coachDirectory(stateDir)).ledger;
    expect(Object.values(ledger.families).every((entry) => entry.lastAction === "none")).toBe(true);
  });

  test("a failed synthesis call files nothing and leaves the ledger consistent", async () => {
    const { repoDir, stateDir } = await workspace();
    const delivery = memoryDelivery();
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () => collectionOf(threeFamilies()),
      delivery,
      synthesize: async (family) => ({
        ok: false,
        model: "stub",
        durationMs: 3,
        reason: `peer failed for ${family.key}`,
      }),
      settings: { ...DEFAULT_COACH_SETTINGS, maxIssuesPerCycle: 20, allowlist: ["bun "] },
    });
    expect(result.report.action).toBe("failed");
    expect(result.report.reason).toContain("synthesis failed");
    expect(delivery.created).toEqual([]);
    const ledger = loadLedger(coachDirectory(stateDir)).ledger;
    expect(ledger.pendingFiling).toEqual([]);
  });

  test("a peer proposal that quotes HTTP 401 is not a credential rejection", async () => {
    const { root, repoDir, stateDir } = await workspace();
    const now = NOW.toISOString();
    saveSubscriptions(stateDir, [
      {
        id: "alpha",
        provider: "opencode-go",
        label: "Alpha",
        key: "key-alpha",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const family = familiesOf(threeFamilies())[0]!;
    const answer: Proposal = {
      family: family.key,
      action: "none",
      rationale: "The command exits 7 whenever the API answers HTTP 401; no change is needed.",
      acceptance: ["- [ ] Nothing changes."],
    };
    const script = join(root, "stub-acp.ts");
    await writeFile(
      script,
      `#!/usr/bin/env bun
const sessionId = "stub-session";
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk, { stream: true });
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\\n");
    if (line.length === 0) continue;
    const message = JSON.parse(line);
    if (typeof message.method !== "string" || message.id === undefined) continue;
    if (message.method === "initialize") {
      write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    } else if (message.method === "session/new") {
      write({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    } else if (message.method === "session/prompt") {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "stub-message",
            content: { type: "text", text: ${JSON.stringify(JSON.stringify(answer))} },
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }
  }
}
`,
    );
    const result = await synthesizeFamily({
      repoDir,
      stateDir,
      family,
      prompt: "propose one family issue",
      command: `${process.execPath} ${script}`,
      environment: {},
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe(JSON.stringify(answer));
    expect(parseSynthesisAnswer(result.text!, family.key).action).toBe("none");
  });

  test("a peer credential error rotates to the next subscription", async () => {
    const { root, repoDir, stateDir } = await workspace();
    const now = NOW.toISOString();
    const row = (id: string, key: string) => ({
      id,
      provider: "opencode-go" as const,
      label: id,
      key,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    saveSubscriptions(stateDir, [row("alpha", "key-alpha"), row("beta", "key-beta")]);
    const script = join(root, "stub-acp.ts");
    await writeFile(
      script,
      `#!/usr/bin/env bun
const sessionId = "stub-session";
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk, { stream: true });
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\\n");
    if (line.length === 0) continue;
    const message = JSON.parse(line);
    if (typeof message.method !== "string" || message.id === undefined) continue;
    if (message.method === "initialize") {
      write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    } else if (message.method === "session/new") {
      write({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    } else if (message.method === "session/prompt") {
      if (process.env.OPENCODE_API_KEY === "key-alpha") {
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "401 Unauthorized: invalid api key" },
        });
      } else {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "stub-message",
              content: { type: "text", text: '{"family":"probe","action":"none"}' },
            },
          },
        });
        write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    }
  }
}
`,
    );
    const family = familiesOf(threeFamilies())[0]!;
    const result = await synthesizeFamily({
      repoDir,
      stateDir,
      family,
      prompt: "propose one family issue",
      command: `${process.execPath} ${script}`,
      environment: {},
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('"family":"probe"');
  });

  test("one failed synthesis call does not discard the proposals that parsed", async () => {
    const { repoDir, stateDir } = await workspace();
    const collection = collectionOf(threeFamilies());
    const families = buildFamilies({ ...collection, repoDir });
    const failed = families.selected[0]!;
    const delivery = memoryDelivery();
    let tool = 1;
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () => collection,
      delivery,
      synthesize: async (family) => {
        if (family.key === failed.key) {
          return {
            ok: false,
            model: "stub",
            durationMs: 1,
            reason: "the synthesizer peer timed out after 5000ms",
          };
        }
        tool += 1;
        return {
          ok: true,
          model: "stub",
          durationMs: 1,
          text: JSON.stringify(toolProposal(family, tool)),
        };
      },
      settings: { ...DEFAULT_COACH_SETTINGS, maxIssuesPerCycle: 20, allowlist: ["bun "] },
    });
    expect(result.report.action).toBe("filed");
    expect(delivery.created).toHaveLength(families.selected.length - 1);
    expect(delivery.created.some((entry) => entry.title === issueTitle(failed, "tool"))).toBe(false);
    expect(result.report.synthesis.filter((entry) => !entry.ok)).toHaveLength(1);
    const ledger = loadLedger(coachDirectory(stateDir)).ledger;
    expect(ledger.families[failed.key]?.lastAction).toBe("failed");
  });

  test("the per-cycle cap holds the excess pending and files it next cycle", async () => {
    const { repoDir, stateDir } = await workspace();
    const collection = collectionOf(threeFamilies());
    const delivery = memoryDelivery();
    const settings = {
      ...DEFAULT_COACH_SETTINGS,
      maxIssuesPerCycle: 1,
      allowlist: ["bun "],
    };
    const calls: string[] = [];
    const synthesize: Synthesize = async (family) => {
      calls.push(family.key);
      return {
        ok: true,
        model: "stub",
        durationMs: 1,
        text: JSON.stringify(toolProposal(family, calls.length)),
      };
    };
    const first = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () => collection,
      delivery,
      synthesize,
      settings,
    });
    expect(first.report.action).toBe("filed");
    expect(delivery.created).toHaveLength(1);
    const ledger = loadLedger(coachDirectory(stateDir)).ledger;
    expect(ledger.pendingFiling).toHaveLength(2);
    expect(first.report.pending).toBe(2);

    const queued = new Set(ledger.pendingFiling.map((entry) => entry.family));
    const before = calls.length;
    const second = await runCycle({
      root: repoDir,
      stateDir,
      now: new Date(NOW.getTime() + 30 * 60_000),
      collect: () => collection,
      delivery,
      synthesize,
      settings,
    });
    expect(delivery.created.length).toBe(2);
    expect(second.report.pending).toBe(1);
    expect(calls.length - before).toBeLessThan(3);
    expect(queued.size).toBe(2);
  });

  test("the rolling-hour cap stops filings until the hour passes", async () => {
    const { repoDir, stateDir } = await workspace();
    const collection = collectionOf(threeFamilies());
    const delivery = memoryDelivery();
    const settings = {
      ...DEFAULT_COACH_SETTINGS,
      maxPerHour: 1,
      maxIssuesPerCycle: 3,
      allowlist: ["bun "],
    };
    const first = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () => collection,
      delivery,
      synthesize: synthesisFor(new Map()),
      settings,
    });
    expect(first.report.action).toBe("filed");
    expect(delivery.created).toHaveLength(1);
    const second = await runCycle({
      root: repoDir,
      stateDir,
      now: new Date(NOW.getTime() + 30 * 60_000),
      collect: () => collection,
      delivery,
      synthesize: synthesisFor(new Map()),
      settings,
    });
    expect(delivery.created).toHaveLength(1);
    expect(second.report.action).toBe("capped");
    const third = await runCycle({
      root: repoDir,
      stateDir,
      now: new Date(NOW.getTime() + 61 * 60_000),
      collect: () => collection,
      delivery,
      synthesize: synthesisFor(new Map()),
      settings,
    });
    expect(delivery.created).toHaveLength(2);
    expect(third.report.action).not.toBe("failed");
  });

  test("a pending entry older than seven days or absent from the window is dropped", async () => {
    const { repoDir, stateDir } = await workspace();
    const collection = collectionOf(threeFamilies());
    const settings = {
      ...DEFAULT_COACH_SETTINGS,
      maxIssuesPerCycle: 1,
      allowlist: ["bun "],
    };
    await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () => collection,
      delivery: memoryDelivery(),
      synthesize: synthesisFor(new Map()),
      settings,
    });
    const ledger = loadLedger(coachDirectory(stateDir)).ledger;
    expect(ledger.pendingFiling.length).toBeGreaterThan(0);
    const later = new Date(NOW.getTime() + 8 * 24 * 60 * 60_000);
    const laterCollection = collectionOf(
      threeFamilies().map((session) => ({
        ...session,
        startedAt: new Date(Date.parse(session.startedAt) + 8 * 24 * 60 * 60_000).toISOString(),
        calls: session.calls.map((call) => ({
          ...call,
          timestamp: new Date(Date.parse(call.timestamp!) + 8 * 24 * 60 * 60_000).toISOString(),
        })),
      })),
    );
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: later,
      collect: () => laterCollection,
      delivery: memoryDelivery(),
      synthesize: synthesisFor(new Map()),
      settings: { ...settings, maxIssuesPerCycle: 20 },
    });
    expect(result.report.dropped).toBeGreaterThan(0);
    expect(result.report.pending).toBe(0);
    expect(
      result.report.validations.some((entry) => entry.outcome === "dropped"),
    ).toBe(true);
  });

  test("a version-2 ledger is discarded and the report says so", async () => {
    const { repoDir, stateDir } = await workspace();
    await writeFile(
      join(coachDirectory(stateDir), "state.json"),
      JSON.stringify({ version: 2, findings: { old: {} }, pendingFiling: [] }),
    );
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      dryRun: true,
      collect: () => collectionOf(threeFamilies()),
    });
    expect(result.report.ledgerReset).toBe(true);
    const ledger = loadLedger(coachDirectory(stateDir)).ledger;
    expect(ledger.families).toEqual({});
  });

  test("legacy decision environment variables are never read", async () => {
    const { repoDir, stateDir } = await workspace();
    const delivery = memoryDelivery();
    const legacyEnvironment = {
      ["DEVBOARD_OPENROUTER_" + "DECISIONS_URL"]: "http://127.0.0.1:9/decisions",
      ["DEVBOARD_COACH_" + "DECISIONS" + "_STUB"]: "/does/not/exist.json",
      ["JEV_" + "DECISION_MODEL"]: "typesafe/legacy-1.14",
    };
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      environment: legacyEnvironment,
      collect: () => collectionOf(threeFamilies()),
      delivery,
      synthesize: synthesisFor(new Map()),
      settings: { ...DEFAULT_COACH_SETTINGS, maxIssuesPerCycle: 20, allowlist: ["bun "] },
    });
    expect(result.report.action).toBe("filed");
    expect(delivery.created.length).toBeGreaterThan(0);
  });

  test("the report and status carry the family shapes", async () => {
    const { repoDir, stateDir } = await workspace();
    const delivery = memoryDelivery();
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () => collectionOf(threeFamilies()),
      delivery,
      synthesize: synthesisFor(new Map()),
      settings: { ...DEFAULT_COACH_SETTINGS, maxIssuesPerCycle: 20, allowlist: ["bun "] },
    });
    const report: CoachReport = result.report;
    expect(report).toMatchObject({
      action: "filed",
      families: 3,
      omitted: 0,
      ledgerReset: false,
      dropped: 0,
      pending: 0,
    });
    expect(report.window.start).toBe(START.toISOString());
    expect(report.journalRecords).toBe(0);
    expect(report.synthesis).toHaveLength(3);
    expect(report.selected.map((entry) => entry.key)).toEqual(
      report.selected.map((entry) => entry.key),
    );
    for (const entry of report.validations) {
      expect(["filed", "pending", "none", "duplicate", "invalid", "dropped", "failed"]).toContain(
        entry.outcome,
      );
    }
    expect(describeCycle(result)).toContain("filed");
    expect(existsSync(join(coachDirectory(stateDir), "runs", report.cycle.replace(/[:.]/g, "-"), "report.json"))).toBe(true);

    const status = readCoachStatus(coachDirectory(stateDir));
    expect(status.families).toBe(3);
    expect(status.selected).toBe(3);
    expect(status.filed).toBe(3);
    expect(status.pending).toBe(0);
    expect(status.issues).toHaveLength(3);
    for (const issue of status.issues) {
      expect(issue.title.startsWith("[coach] ")).toBe(true);
      expect(issue.kind).toBe("command");
      expect(issue.family.length).toBeGreaterThan(0);
      expect(issue.url).toContain("https://forge.test/");
    }
  });

  test("a stored proposal is filed with its original bytes", async () => {
    const { repoDir, stateDir } = await workspace();
    const delivery = memoryDelivery();
    const now = new Date().toISOString();
    saveLedger(coachDirectory(stateDir), {
      version: 3,
      families: {
        "bun run publish": {
          firstSeen: now,
          lastSeen: now,
          calls: 3,
          sessions: 2,
          kind: "command",
          lastAction: "capped",
        },
      },
      pendingFiling: [
        {
          family: "bun run publish",
          kind: "command",
          title: "[coach] bun run publish",
          body: "## Family\n\nstored bytes\n",
          score: 6,
          createdAt: now,
        },
      ],
    });
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () => collectionOf([
        sessionOf({
          id: "a",
          startedAt: instant(60),
          calls: [{ command: "bun run publish" }],
        }),
      ]),
      delivery,
      synthesize: async () => {
        throw new Error("no synthesis for a queued family");
      },
      settings: { ...DEFAULT_COACH_SETTINGS, maxIssuesPerCycle: 20, allowlist: ["bun "] },
    });
    expect(result.report.action).toBe("filed");
    expect(delivery.created).toEqual([
      { title: "[coach] bun run publish", body: "## Family\n\nstored bytes\n" },
    ]);
  });

  test("an overlong queued title is bounded and does not block later filing", async () => {
    const { repoDir, stateDir } = await workspace();
    const delivery = memoryDelivery();
    const now = new Date().toISOString();
    const longKey = `bun run ${"z".repeat(380)}`;
    saveLedger(coachDirectory(stateDir), {
      version: 3,
      families: {
        [longKey]: {
          firstSeen: now,
          lastSeen: now,
          calls: 3,
          sessions: 2,
          kind: "command",
          lastAction: "capped",
        },
      },
      pendingFiling: [
        {
          family: longKey,
          kind: "command",
          title: `[coach] ${longKey}`,
          body: "## Family\n\nstored bytes\n",
          score: 6,
          createdAt: now,
        },
      ],
    });
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () =>
        collectionOf([
          sessionOf({ id: "long", startedAt: instant(60), calls: [{ command: longKey }] }),
          sessionOf({
            id: "short",
            startedAt: instant(30),
            calls: [{ command: "bun run publish" }],
          }),
        ]),
      delivery,
      synthesize: synthesisFor((family) =>
        family.key === longKey
          ? {
              family: family.key,
              action: "none",
              rationale: "The queued proposal already covers it.",
              acceptance: ["- [ ] Nothing else is filed for the long family."],
            }
          : toolProposal(family),
      ),
      settings: { ...DEFAULT_COACH_SETTINGS, maxIssuesPerCycle: 20, allowlist: ["bun "] },
    });
    expect(result.report.action).toBe("filed");
    expect(delivery.created).toHaveLength(2);
    const queued = delivery.created[0]!;
    expect(queued.body).toBe("## Family\n\nstored bytes\n");
    expect(Buffer.byteLength(queued.title, "utf8")).toBeLessThanOrEqual(ISSUE_TITLE_MAX_BYTES);
    expect(queued.title).toContain(familyTag(longKey));
    expect(delivery.created[1]?.title).toBe("[coach] bun run publish");
    expect(loadLedger(coachDirectory(stateDir)).ledger.pendingFiling).toEqual([]);
  });
});

describe("Coach settings compatibility", () => {
  test("an old file falls back on the new keys and ignores removed ones", async () => {
    const { stateDir } = await workspace();
    const legacy = Object.fromEntries([
      ["intervalMinutes", 45],
      ["maxPerHour", 2],
      ["maxPending", null],
      ["decision" + "Model", "typesafe/legacy-1.14"],
      ["approve" + "At", 0.9],
      ["reject" + "At", 0.1],
      ["reject" + "CooldownHours", 168],
    ]);
    await writeFile(
      join(coachDirectory(stateDir), "settings.json"),
      JSON.stringify(legacy),
    );
    expect(readCoachSettings(coachDirectory(stateDir))).toEqual({
      intervalMinutes: 45,
      maxPerHour: 2,
      maxPending: null,
      maxIssuesPerCycle: 2,
      allowlist: [],
    });
  });

  test("missing and invalid values fall back without rejecting the file", () => {
    expect(parseCoachSettings("{}")).toEqual(DEFAULT_COACH_SETTINGS);
    expect(
      parseCoachSettings(
        JSON.stringify({ intervalMinutes: 0, maxPerHour: 500, maxIssuesPerCycle: 99, allowlist: [""] }),
      ),
    ).toEqual(DEFAULT_COACH_SETTINGS);
    expect(parseCoachSettings("not json")).toBeUndefined();
    expect(isValidIssuesPerCycle(20)).toBe(true);
    expect(isValidIssuesPerCycle(21)).toBe(false);
    expect(isValidAllowlist(["bun "])).toBe(true);
  });
});

describe("Coach prompt contract details", () => {
  test("issueTitle bounds a 300- and a 400-character family key to the forge limit", () => {
    const longCommand = "z".repeat(400);
    const longQuestion = `Why ${"z".repeat(400)}`;
    const families = familiesOf(
      [
        sessionOf({ id: "long-a", startedAt: instant(60), calls: [{ command: longCommand }] }),
        sessionOf({ id: "long-b", startedAt: instant(50), calls: [{ command: longCommand }] }),
      ],
      [
        { kind: "question", text: longQuestion, scope: "run-a", ts: instant(40) },
        { kind: "question", text: longQuestion, scope: "run-b", ts: instant(30) },
      ],
    );
    const commandFamily = families.find((family) => family.kind === "command");
    const journalFamily = families.find((family) => family.kind === "question");
    expect(commandFamily?.key.length).toBe(400);
    expect(journalFamily?.key.length).toBe(300);
    for (const family of [commandFamily, journalFamily]) {
      if (family === undefined) throw new Error("expected a long-key family");
      for (const action of ["tool", "prompt"] as const) {
        const title = issueTitle(family, action);
        expect(Buffer.byteLength(title, "utf8")).toBeLessThanOrEqual(ISSUE_TITLE_MAX_BYTES);
        expect(Buffer.from(title, "utf8").toString("utf8")).toBe(title);
        expect(title).toContain(familyTag(family.key));
      }
      // The full key survives in the body and the tag deduplication reads.
      const proposal: Proposal = {
        family: family.key,
        action: "prompt",
        prompt: { instruction: "Instruction.", target: "scout" },
        rationale: "Because.",
        acceptance: ["- [ ] It holds."],
      };
      const body = issueBody({ family, proposal, allowlistEntry: "" });
      expect(body).toContain(family.key);
      expect(body).toContain(`family:${familyTag(family.key)}`);
    }
  });

  test("issueTitle and issueBody use the family key and tag", () => {
    const family = familiesOf([
      sessionOf({
        id: "a",
        startedAt: instant(60),
        calls: [{ command: "bun run publish", isError: true }],
      }),
    ])[0]!;
    expect(issueTitle(family, "tool")).toBe("[coach] bun run publish");
    expect(issueTitle(family, "prompt")).toBe("[coach] prompt: bun run publish");
    const proposal: Proposal = {
      family: family.key,
      action: "prompt",
      prompt: { instruction: "Instruction.", target: "scout" },
      rationale: "Because.",
      acceptance: ["- [ ] It holds."],
    };
    const body = issueBody({ family, proposal, allowlistEntry: "" });
    for (const section of [
      "## Family",
      "## Evidence",
      "## Proposed prompt",
      "## Acceptance",
      "## Rationale",
    ]) {
      expect(body.split(section).length - 1).toBe(1);
    }
  });

  test("the journal path records scopes and writes no comment", async () => {
    const { repoDir, stateDir } = await workspace();
    await mkdir(join(stateDir, "journal"), { recursive: true });
    await writeFile(
      `${journalFile(stateDir, repoDir)}`,
      [
        { kind: "question", text: "Same?", scope: "run-a", ts: instant(30) },
        { kind: "question", text: "Same?", scope: "run-b", ts: instant(20) },
      ]
        .map((row) => JSON.stringify({ repo: repoDir, port: 1, pid: 1, ...row }))
        .join("\n") + "\n",
    );
    const collection = collectionOf([], [
      { kind: "question", text: "Same?", scope: "run-a", ts: instant(30) },
      { kind: "question", text: "Same?", scope: "run-b", ts: instant(20) },
    ]);
    const delivery = memoryDelivery();
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () => collection,
      delivery,
      synthesize: synthesisFor((family) =>
        toolProposal(family, 1, {
          tool: {
            name: "coach_tool_question",
            title: "Answer the repeated question",
            description: "One documented answer for the repeated question.",
            inputSchema: { type: "object", additionalProperties: false, properties: {} },
            covers: ["question:"],
          },
        }),
      ),
      settings: { ...DEFAULT_COACH_SETTINGS, allowlist: ["question:"] },
    });
    expect(result.report.action).toBe("filed");
    expect(delivery.created[0]?.title).toBe("[coach] question: Same?");
    expect(result.report.findings[0]?.kind).toBe("question");
  });
});

describe("Coach synthesizer provider order", () => {
  test("leads with the dashboard's published selection", async () => {
    const stateDir = await temporaryRoot();
    const now = NOW.toISOString();
    const row = (id: string, label: string) => ({
      id,
      provider: "opencode-go" as const,
      label,
      key: `key-${id}`,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    saveSubscriptions(stateDir, [row("alpha", "Alpha"), row("bravo", "Bravo")]);
    writeSelectionSnapshot(stateDir, {
      provider: "opencode-go",
      subscriptionId: "bravo",
      label: "Bravo",
      model: OPENCODE_GO_MODEL,
      remainingFraction: 1,
      checkedAt: now,
    });
    const peers = openCodePeers(stateDir, {});
    expect(peers.ok).toBe(true);
    if (peers.ok) expect(peers.value[0]?.subscriptionId).toBe("bravo");
  });
});
