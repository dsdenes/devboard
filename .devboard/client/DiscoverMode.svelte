<script lang="ts">
  import AgentOutput from "./AgentOutput.svelte";
  import { html as diffHtml } from "diff2html";
  import "diff2html/bundles/css/diff2html.min.css";

  type Confidence = "observed" | "declared" | "inferred" | "unknown";

  interface Leaf {
    value: unknown;
    evidence: string[];
    confidence: Confidence;
    reason?: string;
  }

  interface Labelled {
    language: string;
    text: string;
  }

  interface Concept {
    id: string;
    prefLabels: Labelled[];
    altLabels?: Labelled[];
    definitions?: Labelled[];
    status: string;
    origin: string;
    kind: string;
    grounding?: unknown[];
  }

  interface Glossary {
    boundedContext: string;
    titles: Labelled[];
    concepts: Concept[];
  }

  interface DiscoverSkill {
    name: string;
    state: "generated" | "edited" | "missing";
    baseline: string | null;
    live: string | null;
  }

  interface Freshness {
    project: string;
    commit: string;
    dirty: boolean;
    discoveredAt: string;
  }

  interface DiscoverStatePayload {
    active: boolean;
    runId: string | null;
    startedAt: string | null;
    interrupted: boolean;
    stale: boolean;
    warnings: string[];
    busy: string | null;
    error: string | null;
    manifest: unknown;
    freshness: Freshness | null;
    sheet: Record<string, unknown> | null;
    glossaries: Glossary[];
    decisions: unknown[];
    skills: DiscoverSkill[];
  }

  interface DiscoverQuestionOption {
    label: string;
    description?: string;
    recommended: boolean;
  }

  interface DiscoverQuestion {
    id: number | string;
    message: string;
    options: DiscoverQuestionOption[];
  }

  type DiscoverTabId =
    | "overview"
    | "glossary"
    | "testing-strategy"
    | "naming-conventions"
    | "coding-conventions"
    | "architecture-boundaries"
    | "glossary-skill";

  interface DiscoverTab {
    id: DiscoverTabId;
    label: string;
    skill: string | null;
  }

  interface DiffLine {
    kind: "same" | "added" | "removed";
    text: string;
  }

  const TABS: DiscoverTab[] = [
    { id: "overview", label: "Overview", skill: null },
    { id: "glossary", label: "Glossary", skill: null },
    {
      id: "testing-strategy",
      label: "Testing Strategy Skill",
      skill: "discover-testing-strategy",
    },
    {
      id: "naming-conventions",
      label: "Naming Conventions Skill",
      skill: "discover-naming-conventions",
    },
    {
      id: "coding-conventions",
      label: "Coding Conventions Skill",
      skill: "discover-coding-conventions",
    },
    {
      id: "architecture-boundaries",
      label: "Architecture & Boundaries Skill",
      skill: "discover-architecture-boundaries",
    },
    { id: "glossary-skill", label: "Glossary Skill", skill: "discover-glossary" },
  ];

  const SKILL_TAB_BREAK_ID = TABS.find((tab) => tab.skill !== null)?.id ?? null;

  const SECTION_KEYS = [
    "definition",
    "stack",
    "deployment",
    "environments",
    "commands",
    "branching",
    "testing",
    "architecture",
    "ci",
    "runtime",
    "dependencyMap",
    "delivery",
  ];

  const SECTION_LABELS: Record<string, string> = {
    definition: "Project definition",
    stack: "Stack",
    deployment: "Customer-facing deployment",
    environments: "Environments",
    commands: "Main commands",
    branching: "Branching strategy",
    testing: "Testing strategy",
    architecture: "Architecture & boundaries",
    ci: "CI strategy",
    runtime: "Runtime inventory",
    dependencyMap: "Entry points & dependency map",
    delivery: "Delivery & versioning",
  };

  /** The delivery card repeats facts shown by deployment, CI, and runtime. */
  const HIDDEN_SECTIONS = new Set(["delivery"]);

  /** The runtime inventory is the first thing an operator scans for. */
  const SECTION_ORDER = [
    "runtime",
    ...SECTION_KEYS.filter((key) => key !== "runtime" && !HIDDEN_SECTIONS.has(key)),
  ];

  /** Leaves already shown elsewhere or too detailed for the operator's scan. */
  const HIDDEN_LEAVES: Record<string, string[]> = {
    dependencyMap: ["binaries", "packages", "jobs"],
    deployment: ["pipelineSources"],
  };

  const COMMAND_LABELS: Record<string, string> = {
    install: "Install",
    build: "Build",
    test: "Test",
    lint: "Lint",
    typecheck: "Typecheck",
    dev: "Dev / run",
    tryOut: "Try it out",
    release: "Release",
  };

  const COMMAND_HINTS: Record<string, string> = {
    test: "Runs the whole test suite.",
    tryOut: "Starts the project for a hands-on try; it is not the test suite.",
  };

  /** Pyramid tiers from the base (widest) to the apex (narrowest). */
  const PYRAMID_LEVELS = ["unit", "integration", "contract", "end-to-end", "other"];

  const GLOSSARY_STATUSES = [
    "proposed",
    "confirmed",
    "unconfirmed",
    "invalidated",
    "deprecated",
  ] as const;

  const { send, connected }: { send: (command: unknown) => boolean; connected: boolean } =
    $props();

  let state = $state<DiscoverStatePayload | null>(null);
  let active = $state(false);
  let runId = $state<string | null>(null);
  let startedAt = $state<string | null>(null);
  let activity = $state<string[]>([]);
  let question = $state<DiscoverQuestion | null>(null);
  let error = $state<string | null>(null);
  let warnings = $state<string[]>([]);
  let interrupted = $state(false);
  let transition = $state<string | null>(null);
  let answerDraft = $state("");
  let activityEl = $state<HTMLDivElement | null>(null);

  let selectedTab = $state<DiscoverTabId>("overview");
  let glossarySearch = $state("");
  let glossaryStatus = $state<string>("all");
  let rejectingKey = $state<string | null>(null);
  let rejectReason = $state("");

  let drafts = $state<Record<string, string>>({});
  let dirty = $state<Record<string, boolean>>({});

  let activeSkillName = $derived(TABS.find((tab) => tab.id === selectedTab)?.skill ?? null);
  let busy = $derived(state?.busy ?? null);
  let stale = $derived(state?.stale === true);
  let freshness = $derived(state?.freshness ?? null);
  let sheet = $derived(state?.sheet ?? null);
  let hasArtifacts = $derived(sheet !== null);
  let displayError = $derived(error ?? state?.error ?? null);
  let displayedWarnings = $derived(warnings.length > 0 ? warnings : (state?.warnings ?? []));

  function sectionLeaf(section: unknown, key: string): Leaf | undefined {
    if (typeof section !== "object" || section === null) return undefined;
    const leaf = (section as Record<string, unknown>)[key];
    return isLeaf(leaf) ? leaf : undefined;
  }

  let testCommand = $derived.by(() => {
    const commands = sheet?.commands;
    const leaf = sectionLeaf(commands, "test");
    return leaf === undefined || leaf.confidence === "unknown" ? "" : scalarText(leaf.value);
  });

  let startDisabled = $derived(!connected || active || busy !== null);
  let startTitle = $derived(
    !connected
      ? "Not connected"
      : active
        ? "A Discover run is active"
        : (busy ?? undefined),
  );

  let filteredContexts = $derived.by(() => {
    const contexts = Array.isArray(state?.glossaries) ? state.glossaries : [];
    const query = glossarySearch.trim().toLowerCase();
    return contexts
      .map((context) => ({
        ...context,
        concepts: (Array.isArray(context.concepts) ? context.concepts : []).filter(
          (concept) => {
            if (glossaryStatus !== "all" && concept.status !== glossaryStatus) return false;
            if (query.length === 0) return true;
            const haystack = [
              concept.id,
              labelText(concept.prefLabels),
              ...labelTexts(concept.altLabels),
              ...labelTexts(concept.definitions),
            ]
              .join(" ")
              .toLowerCase();
            return haystack.includes(query);
          },
        ),
      }))
      .filter((context) => context.concepts.length > 0);
  });

  $effect(() => {
    const lines = activity;
    if (!active || activityEl === null) return;
    if (lines.length === 0) return;
    activityEl.scrollTop = activityEl.scrollHeight;
  });

  function appendLine(lines: string[], text: string, append: boolean): string[] {
    if (append && lines.length > 0) {
      return [...lines.slice(0, -1), (lines[lines.length - 1] ?? "") + text];
    }
    return [...lines, text];
  }

  function labelText(labels: Labelled[] | undefined): string {
    if (!Array.isArray(labels)) return "";
    const match = labels.find((label) => label.language === "en") ?? labels[0];
    return match?.text ?? "";
  }

  function labelTexts(labels: Labelled[] | undefined): string[] {
    if (!Array.isArray(labels)) return [];
    return labels.map((label) => label.text).filter((text) => typeof text === "string");
  }

  function isLeaf(value: unknown): value is Leaf {
    return (
      typeof value === "object" &&
      value !== null &&
      "confidence" in value &&
      "evidence" in value &&
      Array.isArray((value as { evidence: unknown }).evidence)
    );
  }

  function humanize(key: string): string {
    const spaced = key
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .toLowerCase();
    return spaced.length === 0 ? key : spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }

  function scalarText(value: unknown): string {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return "";
  }

  function objectEntries(value: Record<string, unknown>): Array<[string, string]> {
    return Object.entries(value)
      .filter(([, entry]) => entry !== null && entry !== undefined && entry !== "")
      .map(([key, entry]) => [
        key,
        Array.isArray(entry)
          ? entry.map((item) => scalarText(item)).join(", ")
          : typeof entry === "object" && entry !== null
            ? ""
            : scalarText(entry),
      ] as [string, string])
      .filter(([, text]) => text.length > 0);
  }

  /** Renders a scalar or scalar list as one display line per item. */
  function leafLines(value: unknown): string[] {
    if (value === null || value === undefined) return ["Not recorded."];
    if (typeof value === "string") return value.length === 0 ? ["Not recorded."] : [value];
    if (typeof value === "number" || typeof value === "boolean") return [String(value)];
    if (Array.isArray(value)) {
      if (value.length === 0) return ["None detected."];
      return value
        .map((item) =>
          typeof item === "object" && item !== null ? "" : scalarText(item),
        )
        .filter((line) => line.length > 0);
    }
    if (typeof value === "object") {
      const lines = objectEntries(value as Record<string, unknown>).map(
        ([key, text]) => `${humanize(key)}: ${text}`,
      );
      return lines.length === 0 ? ["Not recorded."] : lines;
    }
    return [String(value)];
  }

  function recordItems(leaf: Leaf | null | undefined): Array<Record<string, unknown>> {
    if (leaf === null || leaf === undefined || !Array.isArray(leaf.value)) return [];
    return leaf.value.filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    );
  }

  function unknownText(leaf: Leaf): string {
    return typeof leaf.reason === "string" && leaf.reason.length > 0
      ? `unknown — ${leaf.reason}`
      : "unknown";
  }

  interface RecordField {
    key: string;
    label: string;
    values: string[];
  }

  function recordFields(record: Record<string, unknown>): RecordField[] {
    return Object.entries(record)
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([key, value]) => ({
        key,
        label: humanize(key),
        values: (Array.isArray(value) ? value : [value])
          .map((item) => scalarText(item))
          .filter((text) => text.length > 0),
      }))
      .filter((field) => field.values.length > 0);
  }

  interface PyramidTier {
    level: string;
    tests: string;
    command: string;
    detail: string;
  }

  /** Pyramid tiers ordered from the base to the apex. */
  function pyramidTiers(leaf: Leaf | null | undefined): PyramidTier[] {
    return recordItems(leaf)
      .map((record) => {
        const paths = Array.isArray(record.paths)
          ? record.paths.map((item) => scalarText(item)).filter(Boolean)
          : [];
        const fixtures = Array.isArray(record.fixtures)
          ? record.fixtures.map((item) => scalarText(item)).filter(Boolean)
          : [];
        return {
          level: scalarText(record.level) || "other",
          tests: scalarText(record.tests) || "unknown",
          command: scalarText(record.command),
          detail: [...paths, ...fixtures].join(" · "),
        };
      })
      .sort(
        (left, right) =>
          (PYRAMID_LEVELS.indexOf(left.level) + 1 || PYRAMID_LEVELS.length) -
          (PYRAMID_LEVELS.indexOf(right.level) + 1 || PYRAMID_LEVELS.length),
      );
  }

  function tierWidth(indexFromBase: number): string {
    return `${Math.max(30, 100 - indexFromBase * 17)}%`;
  }

  function skillStateLabel(value: string): string {
    return value === "generated" ? "Generated" : value === "edited" ? "Edited" : "Missing";
  }

  function statusTitle(status: string): string {
    if (status === "unconfirmed") {
      return "Discover found this term in the project; no operator has confirmed it yet.";
    }
    if (status === "proposed") {
      return "Discover suggests this term; confirm it or reject it with a reason.";
    }
    if (status === "confirmed") return "An operator confirmed this term.";
    if (status === "deprecated") return "This term is deprecated.";
    if (status === "invalidated") return "An operator rejected this term.";
    return status;
  }

  function skillDraft(entry: DiscoverSkill | null, name: string): string {
    const stored = drafts[name];
    if (stored !== undefined) return stored;
    return entry?.live ?? entry?.baseline ?? "";
  }

  function skillEntry(name: string): DiscoverSkill | null {
    const skills = Array.isArray(state?.skills) ? state.skills : [];
    return skills.find((skill) => skill.name === name) ?? null;
  }

  function syncDrafts(payload: DiscoverStatePayload): void {
    const skills = Array.isArray(payload.skills) ? payload.skills : [];
    for (const skill of skills) {
      if (typeof skill?.name !== "string") continue;
      const live = skill.live ?? skill.baseline ?? "";
      if (dirty[skill.name] !== true) {
        drafts = { ...drafts, [skill.name]: live };
      } else if (drafts[skill.name] === live) {
        dirty = { ...dirty, [skill.name]: false };
      }
    }
  }

  function applySnapshot(payload: DiscoverStatePayload): void {
    state = payload;
    active = payload.active === true;
    runId = typeof payload.runId === "string" ? payload.runId : null;
    startedAt = typeof payload.startedAt === "string" ? payload.startedAt : null;
    warnings = Array.isArray(payload.warnings)
      ? payload.warnings.filter((warning): warning is string => typeof warning === "string")
      : [];
    interrupted = payload.interrupted === true;
    syncDrafts(payload);
  }

  function termKey(context: string, concept: Concept): string {
    return `${context}\u0000${concept.id}`;
  }

  function setConceptStatus(context: string, concept: Concept, status: string): void {
    if (state === null) return;
    state = {
      ...state,
      glossaries: state.glossaries.map((entry) =>
        entry.boundedContext !== context
          ? entry
          : {
              ...entry,
              concepts: entry.concepts.map((candidate) =>
                candidate.id === concept.id ? { ...candidate, status } : candidate,
              ),
            },
      ),
    };
  }

  function confirmTerm(context: string, concept: Concept): void {
    setConceptStatus(context, concept, "confirmed");
    rejectingKey = null;
    rejectReason = "";
    send({ type: "confirmGlossaryTerm", context, id: concept.id });
  }

  function startReject(context: string, concept: Concept): void {
    rejectingKey = termKey(context, concept);
    rejectReason = "";
  }

  function submitReject(context: string, concept: Concept): void {
    const reason = rejectReason.trim();
    if (reason.length === 0) return;
    setConceptStatus(context, concept, "invalidated");
    rejectingKey = null;
    rejectReason = "";
    send({ type: "rejectGlossaryTerm", context, id: concept.id, reason });
  }

  function answer(value: string): void {
    if (question === null) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    const id = question.id;
    question = null;
    answerDraft = "";
    send({ type: "answerDiscover", id, value: trimmed });
  }

  function updateDraft(name: string, text: string): void {
    drafts = { ...drafts, [name]: text };
    dirty = { ...dirty, [name]: true };
  }

  function saveSkill(name: string): void {
    send({ type: "saveDiscoverSkill", name, text: drafts[name] ?? "" });
  }

  function restoreSkill(name: string): void {
    const baseline = skillEntry(name)?.baseline ?? null;
    if (baseline !== null) {
      drafts = { ...drafts, [name]: baseline };
      dirty = { ...dirty, [name]: false };
    }
    send({ type: "restoreDiscoverSkill", name });
  }

  function unifiedDiff(name: string, baseline: string, current: string): string {
    const positioned: Array<DiffLine & { oldLine: number; newLine: number }> = [];
    let oldLine = 1;
    let newLine = 1;
    for (const line of diffLines(baseline, current)) {
      positioned.push({ ...line, oldLine, newLine });
      if (line.kind !== "added") oldLine += 1;
      if (line.kind !== "removed") newLine += 1;
    }

    const changed = positioned
      .map((line, index) => (line.kind === "same" ? -1 : index))
      .filter((index) => index >= 0);
    if (changed.length === 0) return "";

    const context = 3;
    const ranges: Array<{ start: number; end: number }> = [];
    for (const index of changed) {
      const start = Math.max(0, index - context);
      const end = Math.min(positioned.length - 1, index + context);
      const last = ranges[ranges.length - 1];
      if (last !== undefined && start <= last.end + 1) {
        last.end = Math.max(last.end, end);
      } else {
        ranges.push({ start, end });
      }
    }

    const output = [`--- a/${name}/SKILL.md`, `+++ b/${name}/SKILL.md`];
    for (const range of ranges) {
      const slice = positioned.slice(range.start, range.end + 1);
      const first = slice[0] as DiffLine & { oldLine: number; newLine: number };
      const oldCount = slice.filter((line) => line.kind !== "added").length;
      const newCount = slice.filter((line) => line.kind !== "removed").length;
      const oldStart = oldCount === 0 ? Math.max(1, first.oldLine - 1) : first.oldLine;
      const newStart = newCount === 0 ? Math.max(1, first.newLine - 1) : first.newLine;
      output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
      for (const line of slice) {
        output.push(
          line.kind === "added"
            ? `+${line.text}`
            : line.kind === "removed"
              ? `-${line.text}`
              : ` ${line.text}`,
        );
      }
    }
    output.push("");
    return output.join("\n");
  }

  const DIFF_OPTIONS = {
    outputFormat: "line-by-line" as const,
    drawFileList: false,
    matching: "none" as const,
    colorScheme: "auto" as const,
  };

  /** Line diff without a dependency; the baseline is the left side. */
  function diffLines(baseline: string, current: string): DiffLine[] {
    const before = baseline.split("\n");
    const after = current.split("\n");
    const rows: DiffLine[] = [];
    let start = 0;
    while (
      start < before.length &&
      start < after.length &&
      before[start] === after[start]
    ) {
      rows.push({ kind: "same", text: before[start] ?? "" });
      start += 1;
    }

    let beforeEnd = before.length - 1;
    let afterEnd = after.length - 1;
    const tail: DiffLine[] = [];
    while (
      beforeEnd >= start &&
      afterEnd >= start &&
      before[beforeEnd] === after[afterEnd]
    ) {
      tail.unshift({ kind: "same", text: before[beforeEnd] ?? "" });
      beforeEnd -= 1;
      afterEnd -= 1;
    }

    const a = before.slice(start, beforeEnd + 1);
    const b = after.slice(start, afterEnd + 1);
    const table: number[][] = Array.from({ length: a.length + 1 }, () =>
      new Array<number>(b.length + 1).fill(0),
    );
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        table[i]![j] =
          a[i] === b[j]
            ? (table[i + 1]![j + 1] ?? 0) + 1
            : Math.max(table[i + 1]![j] ?? 0, table[i]![j + 1] ?? 0);
      }
    }

    const middle: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        middle.push({ kind: "same", text: a[i] ?? "" });
        i += 1;
        j += 1;
      } else if ((table[i + 1]![j] ?? 0) >= (table[i]![j + 1] ?? 0)) {
        middle.push({ kind: "removed", text: a[i] ?? "" });
        i += 1;
      } else {
        middle.push({ kind: "added", text: b[j] ?? "" });
        j += 1;
      }
    }
    while (i < a.length) {
      middle.push({ kind: "removed", text: a[i] ?? "" });
      i += 1;
    }
    while (j < b.length) {
      middle.push({ kind: "added", text: b[j] ?? "" });
      j += 1;
    }

    return [...rows, ...middle, ...tail];
  }

  /** Every parsed server message arrives here, including Discover events. */
  export function handleEvent(message: unknown): void {
    if (typeof message !== "object" || message === null || !("type" in message)) return;
    const type = (message as { type: unknown }).type;

    if (type === "discoverState") {
      const payload = (message as { state?: unknown }).state;
      if (typeof payload !== "object" || payload === null) return;
      applySnapshot(payload as DiscoverStatePayload);
      return;
    }
    if (type === "discoverStarted") {
      const value = message as { runId?: unknown; startedAt?: unknown };
      active = true;
      runId = typeof value.runId === "string" ? value.runId : runId;
      startedAt = typeof value.startedAt === "string" ? value.startedAt : null;
      activity = [];
      question = null;
      answerDraft = "";
      error = null;
      transition = "Discover run started.";
      return;
    }
    if (type === "discoverActivity") {
      const value = message as { text?: unknown; append?: unknown };
      if (typeof value.text !== "string") return;
      activity = appendLine(activity, value.text, value.append === true);
      return;
    }
    if (type === "discoverQuestion") {
      const value = message as {
        id?: unknown;
        message?: unknown;
        options?: unknown;
      };
      if (
        value.id === undefined ||
        (typeof value.id !== "string" && typeof value.id !== "number") ||
        typeof value.message !== "string" ||
        !Array.isArray(value.options)
      ) {
        return;
      }
      question = {
        id: value.id,
        message: value.message,
        options: value.options as DiscoverQuestionOption[],
      };
      answerDraft = "";
      return;
    }
    if (type === "discoverStopped") {
      const value = message as { completed?: unknown; reason?: unknown };
      active = false;
      question = null;
      answerDraft = "";
      if (value.completed === true) {
        transition = "Discover run completed.";
      } else if (typeof value.reason === "string" && value.reason.length > 0) {
        transition = `Discover run stopped: ${value.reason}`;
      } else {
        transition = "Discover run stopped.";
      }
      return;
    }
    if (type === "discoverError") {
      const value = message as { message?: unknown };
      if (typeof value.message === "string") error = value.message;
    }
  }
</script>

{#snippet startControl()}
  <button
    type="button"
    class="start-button discover-start"
    data-testid="discover-start"
    disabled={startDisabled}
    title={startTitle}
    onclick={() => send({ type: "discoverProject" })}
  >
    {hasArtifacts ? "Re-discover" : "Discover project"}
  </button>
{/snippet}

{#snippet questionPanel(pending: DiscoverQuestion)}
  <div class="flow-question" data-testid="discover-question">
    <p class="flow-question-message">{pending.message}</p>
    {#if pending.options.length > 0}
      <div class="flow-choices">
        {#each pending.options as option (option.label)}
          <button
            type="button"
            class="flow-choice"
            data-testid="discover-choice"
            onclick={() => answer(option.label)}
          >
            <span class="flow-choice-label">
              {option.label}
              {#if option.recommended}
                <span class="flow-recommended">Recommended</span>
              {/if}
            </span>
            {#if option.description}
              <span class="flow-choice-description">{option.description}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
    <form
      class="flow-answer-form"
      onsubmit={(event) => {
        event.preventDefault();
        answer(answerDraft);
      }}
    >
      <input
        type="text"
        value={answerDraft}
        oninput={(event) => (answerDraft = event.currentTarget.value)}
        placeholder="Your answer"
        aria-label="Your answer"
        data-testid="discover-answer-input"
      />
      <button
        type="submit"
        data-testid="discover-answer"
        disabled={answerDraft.trim().length === 0}
      >
        Answer
      </button>
    </form>
  </div>
{/snippet}

{#snippet leafValue(leaf: Leaf)}
  {#if leaf.confidence === "unknown"}
    <p class="discover-value discover-value-unknown">{unknownText(leaf)}</p>
  {:else}
    <div class="discover-value">
      {#each leafLines(leaf.value) as line, index (index)}
        <p class="discover-value-line">{line}</p>
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet leafView(leaf: Leaf, label: string | null = null)}
  <div class="discover-leaf">
    {#if label !== null}
      <p class="discover-leaf-label">{label}</p>
    {/if}
    {@render leafValue(leaf)}
  </div>
{/snippet}

{#snippet recordLeafView(leaf: Leaf, label: string | null = null)}
  <div class="discover-leaf">
    {#if label !== null}
      <p class="discover-leaf-label">{label}</p>
    {/if}
    {#if leaf.confidence === "unknown"}
      <p class="discover-value discover-value-unknown">{unknownText(leaf)}</p>
    {:else if recordItems(leaf).length > 0}
      <ul class="discover-record-list">
        {#each recordItems(leaf) as record, index (index)}
          <li class="discover-record">
            {#each recordFields(record) as field (field.key)}
              <div class="discover-record-field">
                <span class="discover-record-name">{field.label}</span>
                <span class="discover-record-values">
                  {#each field.values as value, valueIndex (valueIndex)}
                    {#if ["path", "paths", "entryPoints", "fixtures"].includes(field.key)}
                      <code>{value}</code>
                    {:else}
                      <span>{value}</span>
                    {/if}
                  {/each}
                </span>
              </div>
            {/each}
          </li>
        {/each}
      </ul>
    {:else}
      {@render leafValue(leaf)}
    {/if}
  </div>
{/snippet}

{#snippet contextsView(leaf: Leaf)}
  {#if leaf.confidence === "unknown"}
    <div class="discover-leaf">
      <p class="discover-value discover-value-unknown">{unknownText(leaf)}</p>
    </div>
  {:else}
    <div class="discover-context-cards" data-testid="discover-context-cards">
      {#each recordItems(leaf) as context, index (index)}
        {@const path = scalarText(context.path)}
        {@const entryPoints = Array.isArray(context.entryPoints)
          ? context.entryPoints.map((entry) => scalarText(entry)).filter(Boolean)
          : []}
        <article class="discover-context-card">
          <h3>{scalarText(context.name) || "Context"}</h3>
          <p class="discover-context-responsibility">
            {scalarText(context.responsibility) || "No responsibility recorded."}
          </p>
          <dl class="discover-context-facts">
            {#if path.length > 0}
              <dt>Path</dt>
              <dd><code>{path}</code></dd>
            {/if}
            {#if entryPoints.length > 0}
              <dt>Entry points</dt>
              <dd>
                {#each entryPoints as entry, entryIndex (entryIndex)}
                  <code>{entry}</code>
                {/each}
              </dd>
            {/if}
          </dl>
        </article>
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet testingView(
  levels: Leaf | undefined,
  pyramid: Leaf | undefined,
  fullSuite: string,
)}
  {#if fullSuite.length > 0}
    <div class="discover-suite-command" data-testid="discover-suite-command">
      <span class="flow-label">Whole suite</span>
      <code>{fullSuite}</code>
    </div>
  {/if}
  {#if levels === undefined}
    <p class="discover-value discover-value-unknown">No test levels were detected.</p>
  {:else if levels.confidence === "unknown"}
    {@render leafValue(levels)}
  {:else if pyramidTiers(levels).length > 0}
    <div class="discover-pyramid" data-testid="discover-pyramid">
      {#each [...pyramidTiers(levels)].reverse() as tier, index (tier.level)}
        <div
          class="discover-pyramid-tier"
          data-level={tier.level}
          style={`--tier-width: ${tierWidth(pyramidTiers(levels).length - 1 - index)}`}
          title={tier.detail}
        >
          <span class="discover-pyramid-level">{humanize(tier.level)}</span>
          <span class="discover-pyramid-count">
            {tier.tests === "unknown"
              ? "count unknown"
              : `${tier.tests} ${tier.tests === "1" ? "test" : "tests"}`}
          </span>
          {#if tier.command.length > 0}
            <code class="discover-pyramid-command">{tier.command}</code>
          {/if}
        </div>
      {/each}
    </div>
  {:else}
    {@render leafValue(levels)}
  {/if}
  {#if pyramid !== undefined && pyramid.confidence !== "unknown" && pyramid.value !== null}
    <p class="discover-pyramid-caption">{scalarText(pyramid.value)}</p>
  {/if}
{/snippet}

{#snippet commandsView(section: Record<string, unknown>, testCommand: string)}
  <div class="discover-command-list" data-testid="discover-command-list">
    {#each Object.entries(section) as [key, leaf] (key)}
      {#if isLeaf(leaf)}
        {#if !(key === "tryOut" && testCommand.length > 0 && scalarText(leaf.value) === testCommand)}
          <div class="discover-command" data-command={key}>
            <span class="discover-command-name">{COMMAND_LABELS[key] ?? humanize(key)}</span>
            {#if leaf.confidence === "unknown"}
              <span class="discover-command-value discover-value-unknown">unknown</span>
            {:else}
              <code class="discover-command-value">{scalarText(leaf.value)}</code>
            {/if}
            {#if COMMAND_HINTS[key] !== undefined && leaf.confidence !== "unknown"}
              <span class="discover-command-hint">{COMMAND_HINTS[key]}</span>
            {/if}
          </div>
        {/if}
      {/if}
    {/each}
  </div>
{/snippet}

<div class="discover-mode">
  {#if displayError !== null}
    <p class="error" data-testid="discover-error" role="alert">{displayError}</p>
  {/if}

  {#if displayedWarnings.length > 0}
    <div class="discover-warnings" data-testid="discover-warnings">
      <p class="flow-section-title">Warnings</p>
      <ul>
        {#each displayedWarnings as warning, index (index)}
          <li data-testid="discover-warning">{warning}</li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if interrupted}
    <p class="flow-notice" data-testid="discover-interrupted">
      The last Discover run was interrupted. Nothing was published.
    </p>
  {/if}

  {#if transition !== null}
    <p class="flow-notice" data-testid="discover-transition" role="status">{transition}</p>
  {/if}

  <div class="discover-tabs" role="tablist" aria-label="Discover sections">
    {#each TABS as tab (tab.id)}
      {#if tab.id === SKILL_TAB_BREAK_ID}
        <span class="discover-tab-break" role="presentation"></span>
      {/if}
      <button
        type="button"
        class="discover-tab"
        class:discover-tab-skill={tab.skill !== null}
        role="tab"
        aria-selected={selectedTab === tab.id}
        data-testid="discover-tab"
        data-tab={tab.id}
        data-skill={tab.skill ?? undefined}
        onclick={() => (selectedTab = tab.id)}
      >
        {tab.label}
      </button>
    {/each}
  </div>

  {#if selectedTab === "overview"}
    <section
      class="discover-panel"
      data-testid="discover-panel"
      data-tab="overview"
      aria-label="Discover overview"
    >
      {#if active}
        <div class="flow-notice discover-active" data-testid="discover-active">
          <p>
            <strong>Discover run active.</strong>
            {#if runId !== null}Run <code>{runId}</code>.{/if}
            {#if startedAt !== null}Started {startedAt}.{/if}
          </p>
          <button
            type="button"
            class="start-button"
            data-testid="discover-stop"
            onclick={() => send({ type: "stopDiscover" })}
          >
            Stop
          </button>
          <div class="flow-activity" bind:this={activityEl} data-testid="discover-activity">
            {#if activity.length === 0}
              <p class="empty">Waiting for activity…</p>
            {:else}
              <ol class="flow-activity-log">
                {#each activity as line, index (index)}
                  <li>{line}</li>
                {/each}
              </ol>
            {/if}
          </div>
        </div>
      {/if}

      {#if question !== null}
        {@render questionPanel(question)}
      {/if}

      {#if hasArtifacts}
        <div class="flow-actions discover-controls">
          {@render startControl()}
          {#if busy !== null}
            <span class="discover-busy">{busy}</span>
          {/if}
        </div>

        {#if freshness !== null}
          <div class="discover-freshness" data-testid="discover-freshness">
            <span>
              <span class="flow-label">Project</span>
              {freshness.project}
            </span>
            <span>
              <span class="flow-label">Discovered</span>
              {freshness.discoveredAt}
            </span>
            {#if stale}
              <span class="discover-badge discover-badge-stale" data-testid="discover-stale">
                stale
              </span>
            {/if}
          </div>
        {/if}

        {#if sheet !== null}
          <div class="discover-sheet" data-testid="discover-sheet">
            {#each SECTION_ORDER as key (key)}
              {@const section = sheet[key]}
              <section
                class="flow-panel discover-card"
                data-testid="discover-card"
                data-field={key}
              >
                <h2>{SECTION_LABELS[key] ?? humanize(key)}</h2>
                {#if key === "testing" && typeof section === "object" && section !== null}
                  {@render testingView(
                    sectionLeaf(section, "levels"),
                    sectionLeaf(section, "pyramid"),
                    testCommand,
                  )}
                {:else if key === "commands" && typeof section === "object" && section !== null}
                  {@render commandsView(section, testCommand)}
                {:else if isLeaf(section)}
                  {#if recordItems(section).length > 0}
                    {@render recordLeafView(section)}
                  {:else}
                    {@render leafView(section)}
                  {/if}
                {:else if typeof section === "object" && section !== null}
                  {@const entries = Object.entries(section).filter(
                    ([leafKey, leaf]) =>
                      isLeaf(leaf) &&
                      !(HIDDEN_LEAVES[key] ?? []).includes(leafKey),
                  )}
                  {#if entries.length === 0}
                    <p class="empty">Not recorded.</p>
                  {:else}
                    {#each entries as [leafKey, leaf] (leafKey)}
                      {#if isLeaf(leaf)}
                        {#if key === "architecture" && leafKey === "contexts"}
                          {@render contextsView(leaf)}
                        {:else if recordItems(leaf).length > 0}
                          {@render recordLeafView(
                            leaf,
                            entries.length === 1 ? null : humanize(leafKey),
                          )}
                        {:else}
                          {@render leafView(
                            leaf,
                            entries.length === 1 ? null : humanize(leafKey),
                          )}
                        {/if}
                      {/if}
                    {/each}
                  {/if}
                {:else}
                  <p class="empty">Not recorded.</p>
                {/if}
              </section>
            {/each}
          </div>
        {/if}
      {:else}
        <div class="discover-empty" data-testid="discover-empty">
          <p>No Discover artifacts have been published for this project yet.</p>
          {@render startControl()}
          {#if busy !== null}
            <p class="discover-busy">{busy}</p>
          {/if}
        </div>
      {/if}
    </section>
  {:else if selectedTab === "glossary"}
    <section
      class="discover-panel"
      data-testid="discover-panel"
      data-tab="glossary"
      aria-label="Discover glossary"
    >
      <div class="discover-glossary-controls">
        <input
          type="search"
          value={glossarySearch}
          oninput={(event) => (glossarySearch = event.currentTarget.value)}
          placeholder="Search terms"
          aria-label="Search glossary terms"
          data-testid="discover-glossary-search"
        />
        <label class="discover-filter">
          <span class="flow-label">Status</span>
          <select
            value={glossaryStatus}
            onchange={(event) => (glossaryStatus = event.currentTarget.value)}
            data-testid="discover-glossary-status"
          >
            <option value="all">All</option>
            {#each GLOSSARY_STATUSES as status (status)}
              <option value={status}>{humanize(status)}</option>
            {/each}
          </select>
        </label>
      </div>

      {#if filteredContexts.length === 0}
        <p class="empty">No glossary terms match the current filters.</p>
      {:else}
        <div class="discover-contexts">
          {#each filteredContexts as context (context.boundedContext)}
            <section
              class="flow-panel discover-context"
              data-testid="discover-context"
              data-context={context.boundedContext}
            >
              <div class="discover-context-heading">
                <h2>{labelText(context.titles) || context.boundedContext}</h2>
              </div>
              <div class="discover-terms">
                {#each context.concepts as concept (concept.id)}
                  {@const key = termKey(context.boundedContext, concept)}
                  <article
                    class="discover-term"
                    data-testid="discover-term"
                    data-context={context.boundedContext}
                    data-id={concept.id}
                    data-status={concept.status}
                    data-kind={concept.kind}
                  >
                    <div class="discover-term-heading">
                      <span class="discover-term-label">
                        {labelText(concept.prefLabels) || concept.id}
                      </span>
                      <span
                        class="discover-badge"
                        data-status={concept.status}
                        title={statusTitle(concept.status)}
                      >
                        {concept.status}
                      </span>
                    </div>
                    <p
                      class="discover-term-definition"
                      title={labelTexts(concept.definitions).join(" ")}
                    >
                      {labelText(concept.definitions) || "No definition recorded."}
                    </p>
                    <p class="discover-term-meta">
                      <span>Kind: {concept.kind}</span>
                      <span>Status: {concept.status}</span>
                      <span>
                        Grounding:
                        {Array.isArray(concept.grounding) ? concept.grounding.length : 0}
                      </span>
                      <span>Origin: {concept.origin}</span>
                      <code>{concept.id}</code>
                    </p>

                    {#if concept.status === "proposed" || concept.status === "unconfirmed"}
                      <div class="discover-term-actions">
                        <button
                          type="button"
                          class="start-button"
                          data-testid="discover-confirm"
                          onclick={() => confirmTerm(context.boundedContext, concept)}
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          class="start-button"
                          data-testid="discover-reject"
                          onclick={() => startReject(context.boundedContext, concept)}
                        >
                          Reject
                        </button>
                      </div>
                    {:else if concept.status === "confirmed"}
                      <div class="discover-term-actions">
                        <button
                          type="button"
                          class="start-button"
                          data-testid="discover-reject"
                          onclick={() => startReject(context.boundedContext, concept)}
                        >
                          Reject
                        </button>
                      </div>
                    {/if}

                    {#if rejectingKey === key}
                      <div class="discover-reject-form">
                        <input
                          type="text"
                          value={rejectReason}
                          oninput={(event) => (rejectReason = event.currentTarget.value)}
                          placeholder="Reason for rejection"
                          aria-label="Reason for rejection"
                          data-testid="discover-reject-reason"
                        />
                        <button
                          type="button"
                          class="start-button"
                          data-testid="discover-reject-confirm"
                          disabled={rejectReason.trim().length === 0}
                          onclick={() => submitReject(context.boundedContext, concept)}
                        >
                          Confirm rejection
                        </button>
                        <button
                          type="button"
                          class="start-button"
                          data-testid="discover-reject-cancel"
                          onclick={() => {
                            rejectingKey = null;
                            rejectReason = "";
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    {/if}
                  </article>
                {/each}
              </div>
            </section>
          {/each}
        </div>
      {/if}
    </section>
  {:else}
    <section
      class="discover-panel"
      data-testid="discover-panel"
      data-tab={selectedTab}
      aria-label={TABS.find((tab) => tab.id === selectedTab)?.label ?? "Discover skill"}
    >
      {#if activeSkillName !== null}
        {@const name = activeSkillName}
        {@const entry = skillEntry(name)}
        {@const draft = skillDraft(entry, name)}
        {@const baseline = entry?.baseline ?? null}
        {@const skillState = entry?.state ?? "missing"}
        <div class="discover-skill" data-testid="discover-skill" data-name={name}>
          <div class="discover-skill-heading">
            <h2>{TABS.find((tab) => tab.id === selectedTab)?.label}</h2>
            <span
              class="discover-badge"
              data-testid="discover-skill-state"
              data-state={skillState}
            >
              {skillStateLabel(skillState)}
            </span>
          </div>

          <div class="discover-skill-panes">
            <label class="discover-skill-pane">
              <span class="flow-label">Markdown</span>
              <textarea
                class="flow-textarea discover-skill-text"
                aria-label={`${name} skill text`}
                data-testid="discover-skill-text"
                value={draft}
                oninput={(event) => updateDraft(name, event.currentTarget.value)}
              ></textarea>
            </label>
            <div class="discover-skill-pane">
              <span class="flow-label">Preview</span>
              <div class="discover-skill-preview" data-testid="discover-skill-preview">
                <AgentOutput text={draft} />
              </div>
            </div>
          </div>

          <div class="flow-actions discover-skill-actions">
            <button
              type="button"
              class="start-button"
              data-testid="discover-skill-save"
              onclick={() => saveSkill(name)}
            >
              Save
            </button>
            {#if skillState !== "generated"}
              <button
                type="button"
                class="start-button"
                data-testid="discover-skill-restore"
                title={skillState === "missing"
                  ? "Recreate the skill from its generated version."
                  : "Discard your edits and return to the generated version."}
                onclick={() => restoreSkill(name)}
              >
                {skillState === "missing" ? "Recreate generated version" : "Discard edits"}
              </button>
            {/if}
          </div>

          {#if baseline !== null && draft !== baseline}
            <div class="discover-skill-diff-section">
              <p class="flow-section-title">Your changes against the generated version</p>
              <div class="discover-diff" data-testid="discover-skill-diff">
                {@html diffHtml(unifiedDiff(name, baseline, draft), DIFF_OPTIONS)}
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </section>
  {/if}
</div>
