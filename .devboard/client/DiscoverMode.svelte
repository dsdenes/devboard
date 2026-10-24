<script lang="ts">
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
      label: "Testing Strategy",
      skill: "discover-testing-strategy",
    },
    {
      id: "naming-conventions",
      label: "Naming Conventions",
      skill: "discover-naming-conventions",
    },
    {
      id: "coding-conventions",
      label: "Coding Conventions",
      skill: "discover-coding-conventions",
    },
    {
      id: "architecture-boundaries",
      label: "Architecture & Boundaries",
      skill: "discover-architecture-boundaries",
    },
    { id: "glossary-skill", label: "Glossary Skill", skill: "discover-glossary" },
  ];

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

  function objectLine(value: Record<string, unknown>): string {
    return Object.entries(value)
      .filter(([, entry]) => entry !== null && entry !== undefined && entry !== "")
      .map(([key, entry]) => {
        if (Array.isArray(entry)) {
          return `${humanize(key)}: ${entry.map((item) => scalarText(item)).join(", ")}`;
        }
        return `${humanize(key)}: ${scalarText(entry)}`;
      })
      .filter((line) => !line.endsWith(": "))
      .join(" · ");
  }

  /** Renders any leaf value shape as one display line per item. */
  function leafLines(value: unknown): string[] {
    if (value === null || value === undefined) return ["Not recorded."];
    if (typeof value === "string") return value.length === 0 ? ["Not recorded."] : [value];
    if (typeof value === "number" || typeof value === "boolean") return [String(value)];
    if (Array.isArray(value)) {
      if (value.length === 0) return ["None detected."];
      return value.map((item) =>
        typeof item === "object" && item !== null
          ? objectLine(item as Record<string, unknown>)
          : scalarText(item),
      );
    }
    if (typeof value === "object") {
      return [objectLine(value as Record<string, unknown>)];
    }
    return [String(value)];
  }

  function confidenceLabel(confidence: string): string {
    return confidence.length === 0 ? "unknown" : confidence;
  }

  function skillStateLabel(value: string): string {
    return value === "generated" ? "Generated" : value === "edited" ? "Edited" : "Missing";
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

  function resetSkill(name: string): void {
    const baseline = skillEntry(name)?.baseline ?? null;
    if (baseline !== null) {
      drafts = { ...drafts, [name]: baseline };
      dirty = { ...dirty, [name]: false };
    }
    send({ type: "resetDiscoverSkill", name });
  }

  function rederiveSkill(name: string): void {
    const baseline = skillEntry(name)?.baseline ?? null;
    if (baseline !== null) {
      drafts = { ...drafts, [name]: baseline };
      dirty = { ...dirty, [name]: false };
    }
    send({ type: "rederiveDiscoverSkill", name });
  }

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

{#snippet leafView(label: string, leaf: Leaf)}
  <div class="discover-leaf">
    <p class="discover-leaf-label">{label}</p>
    {#if leaf.confidence === "unknown"}
      <p class="discover-value discover-value-unknown">
        unknown{#if typeof leaf.reason === "string" && leaf.reason.length > 0}
          — {leaf.reason}{/if}
      </p>
    {:else}
      <div class="discover-value">
        {#each leafLines(leaf.value) as line, index (index)}
          <p class="discover-value-line">{line}</p>
        {/each}
      </div>
    {/if}
    <div class="discover-badges">
      <span
        class="discover-badge"
        data-testid="discover-confidence"
        data-confidence={leaf.confidence}
      >
        {confidenceLabel(leaf.confidence)}
      </span>
    </div>
    {#if leaf.evidence.length > 0}
      <div class="discover-chips">
        {#each leaf.evidence as evidence, index (index)}
          <span class="discover-chip" data-testid="discover-evidence">{evidence}</span>
        {/each}
      </div>
    {/if}
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
      <button
        type="button"
        class="discover-tab"
        role="tab"
        aria-selected={selectedTab === tab.id}
        data-testid="discover-tab"
        data-tab={tab.id}
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
              <span class="flow-label">Commit</span>
              <code>{freshness.commit}</code>
            </span>
            <span>
              <span class="flow-label">Tree</span>
              {freshness.dirty ? "dirty" : "clean"}
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
            {#each SECTION_KEYS as key (key)}
              {@const section = sheet[key]}
              <section
                class="flow-panel discover-card"
                data-testid="discover-card"
                data-field={key}
              >
                <h2>{SECTION_LABELS[key] ?? humanize(key)}</h2>
                {#if isLeaf(section)}
                  {@render leafView(SECTION_LABELS[key] ?? humanize(key), section)}
                {:else if typeof section === "object" && section !== null}
                  {#each Object.entries(section) as [leafKey, leaf] (leafKey)}
                    {#if isLeaf(leaf)}
                      {@render leafView(humanize(leafKey), leaf)}
                    {/if}
                  {/each}
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
                <code class="discover-context-id">{context.boundedContext}</code>
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
                  >
                    <div class="discover-term-heading">
                      <span class="discover-term-label">
                        {labelText(concept.prefLabels) || concept.id}
                      </span>
                      <span class="discover-badge" data-status={concept.status}>
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

                    {#if concept.status === "proposed"}
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
        {@const diff = baseline === null ? [] : diffLines(baseline, draft)}
        <div class="discover-skill" data-testid="discover-skill" data-name={name}>
          <div class="discover-skill-heading">
            <h2>{TABS.find((tab) => tab.id === selectedTab)?.label}</h2>
            <span class="discover-skill-identity"><code>{name}</code></span>
            <span
              class="discover-badge"
              data-testid="discover-skill-state"
              data-state={entry?.state ?? "missing"}
            >
              {skillStateLabel(entry?.state ?? "missing")}
            </span>
          </div>

          <textarea
            class="flow-textarea discover-skill-text"
            aria-label={`${name} skill text`}
            data-testid="discover-skill-text"
            value={draft}
            oninput={(event) => updateDraft(name, event.currentTarget.value)}
          ></textarea>

          <div class="flow-actions discover-skill-actions">
            <button
              type="button"
              class="start-button"
              data-testid="discover-skill-save"
              onclick={() => saveSkill(name)}
            >
              Save
            </button>
            <button
              type="button"
              class="start-button"
              data-testid="discover-skill-reset"
              onclick={() => resetSkill(name)}
            >
              Reset to baseline
            </button>
            <button
              type="button"
              class="start-button"
              data-testid="discover-skill-rederive"
              onclick={() => rederiveSkill(name)}
            >
              Re-derive
            </button>
            {#if (entry?.state ?? "missing") === "missing"}
              <button
                type="button"
                class="start-button"
                data-testid="discover-skill-restore"
                onclick={() => resetSkill(name)}
              >
                Restore
              </button>
            {/if}
          </div>

          <div class="discover-skill-diff-section">
            <p class="flow-section-title">Diff against generated baseline</p>
            {#if baseline === null}
              <p class="empty" data-testid="discover-skill-diff">
                No baseline has been published for this skill yet.
              </p>
            {:else}
              <ol class="discover-diff" data-testid="discover-skill-diff">
                {#each diff as line, index (index)}
                  <li data-diff={line.kind}>
                    {line.kind === "added"
                      ? `+ ${line.text}`
                      : line.kind === "removed"
                        ? `- ${line.text}`
                        : `  ${line.text}`}
                  </li>
                {/each}
              </ol>
            {/if}
          </div>
        </div>
      {/if}
    </section>
  {/if}
</div>
