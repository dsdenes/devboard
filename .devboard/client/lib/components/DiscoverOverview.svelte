<script lang="ts">
  import {
    COMMAND_LABELS,
    HIDDEN_LEAVES,
    humanize,
    implementedTiers,
    isLeaf,
    leafLines,
    pyramidHappyPathCount,
    pyramidTiers,
    pyramidTestCount,
    recordItems,
    relativeTime,
    scalarText,
    sectionEntries,
    sectionLeaf,
    unknownText,
  } from "../discover-format";
  import { onMount } from "svelte";
  import { connection } from "../connection.svelte";
  import { dependencyChart, dependencyEdges } from "../dependency-diagram";
  import { discover } from "../discover.svelte";
  import type { Leaf } from "../types";
  import DataTable from "./DataTable.svelte";
  import MermaidDiagram from "./MermaidDiagram.svelte";
  import Terminal from "./Terminal.svelte";
  import Button from "./ui/button.svelte";
  import Input from "./ui/input.svelte";

  const COMMAND_TOTAL = Object.keys(COMMAND_LABELS).length;
  const COMMAND_COLUMNS = [
    { id: "label", header: "Task", accessorKey: "label" },
    { id: "value", header: "Command", accessorKey: "value" },
  ];
  const COMMAND_WIDTHS = { label: "96px" };
  const LEVEL_COLUMNS = [
    { id: "level", header: "Level", accessorKey: "level" },
    { id: "tests", header: "Tests", accessorKey: "tests" },
    { id: "happyPath", header: "Happy path", accessorKey: "happyPath" },
    { id: "command", header: "Command", accessorKey: "command" },
  ];
  const QUALITY_GATE_COLUMNS = [
    { id: "gate", header: "Quality gate", accessorKey: "gate" },
    { id: "checks", header: "What it checks", accessorKey: "checks" },
  ];
  const QUALITY_GATE_WIDTHS = { gate: "220px" };
  const BOUNDARY_GROUPS = [
    { key: "sharedKernels", label: "Shared kernels", kind: "chips" },
    { key: "externalBoundaries", label: "External boundaries", kind: "chips" },
    { key: "dependencyDirection", label: "Dependency direction", kind: "sentence" },
  ] as const;

  type BoundaryGroup = (typeof BOUNDARY_GROUPS)[number];

  interface ContextRow {
    name: string;
    path: string;
    responsibility: string;
    entryPoints: string[];
  }

  interface BoundaryRow {
    key: BoundaryGroup["key"];
    label: string;
    kind: BoundaryGroup["kind"];
    values: string[];
  }

  const MONO_FIELDS = new Set(["artifact", "defaultBranch", "manifests"]);

  const sheet = $derived(discover.sheet);
  const freshness = $derived(discover.freshness);
  const definition = $derived(sectionLeaf(sheet, "definition"));
  const definitionText = $derived(
    definition === undefined ? "" : definition.confidence === "unknown"
      ? unknownText(definition)
      : leafText(definition),
  );
  const projectPath = $derived(
    discover.remoteTarget?.url ??
      (freshness?.project ?? (connection.projectPath.trim().length > 0 ? connection.projectPath : "")),
  );
  const projectName = $derived(discover.repository ?? (baseName(projectPath) || "Discover"));

  const commandsSection = $derived(
    typeof sheet?.commands === "object" && sheet.commands !== null
      ? (sheet.commands as Record<string, unknown>)
      : null,
  );
  let commandsOpen = $state(false);
  /** The retained dropdown; a host target leaves it with no option chosen. */
  let remoteSelect = $state<HTMLSelectElement | null>(null);
  $effect(() => {
    const select = remoteSelect;
    if (select === null) return;
    const active = discover.remoteTarget?.url ?? "";
    select.selectedIndex = discover.retained.findIndex((project) => project.url === active);
  });
  const foundCommandRows = $derived(
    commandRowsOf(commandsSection, discover.testCommand, { includeMissing: false }),
  );
  const commandRows = $derived(commandsOpen
    ? commandRowsOf(commandsSection, discover.testCommand, { includeMissing: true })
    : foundCommandRows);
  const recordedTestCommand = $derived.by(() => {
    const leaf = sectionLeaf(commandsSection, "test");
    return leaf === undefined || leaf.confidence === "unknown" ? "" : scalarText(leaf.value);
  });

  const testingSection = $derived(
    typeof sheet?.testing === "object" && sheet.testing !== null ? sheet.testing : null,
  );
  const levels = $derived(sectionLeaf(testingSection, "levels"));
  const recordedTiers = $derived(pyramidTiers(levels));
  const tiers = $derived(implementedTiers(recordedTiers));
  const testTotal = $derived(pyramidTestCount(tiers));
  const happyPath = $derived(pyramidHappyPathCount(tiers));
  const levelRows = $derived(
    tiers.map((tier) => {
      const parsed = Number.parseInt(tier.tests, 10);
      const tests = Number.isFinite(parsed) ? parsed : 0;
      const parsedHappy = Number.parseInt(tier.happyPath, 10);
      const happyLabel = Number.isFinite(parsedHappy) ? `${parsedHappy}` : "—";
      return {
        level: humanize(tier.level),
        tests: `${tests} ${tests === 1 ? "test" : "tests"}`,
        happyPath: happyLabel,
        command: tier.command.length > 0 ? discover.aliasFor(tier.command) : "",
        rawLevel: tier.level,
      };
    }),
  );

  const qualityGatesLeaf = $derived(sectionLeaf(sheet?.ci, "qualityGates"));
  const qualityGateRows = $derived(
    recordItems(qualityGatesLeaf)
      .map((record) => ({
        gate: scalarText(record.name).trim(),
        checks: scalarText(record.checks).trim(),
      }))
      .filter((row) => row.gate.length > 0),
  );
  const hasQualityGates = $derived(
    qualityGatesLeaf !== undefined &&
      (qualityGatesLeaf.confidence === "unknown" || qualityGateRows.length > 0),
  );

  const runtimeSection = $derived(visibleSection(sheet?.runtime, HIDDEN_LEAVES.runtime ?? []));
  let now = $state(Date.now());
  const startedLabel = $derived(
    discover.startedAt === null ? "" : relativeTime(discover.startedAt, now),
  );

  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  const deploymentSection = $derived(
    visibleSection(sheet?.deployment, HIDDEN_LEAVES.deployment ?? []),
  );
  const ciSection = $derived(visibleSection(sheet?.ci, HIDDEN_LEAVES.ci ?? []));
  const branchingSection = $derived(visibleSection(sheet?.branching, []));
  const hasDelivery =
    $derived(
      Object.keys(deploymentSection).length > 0 ||
        Object.keys(ciSection).length > 0 ||
        Object.keys(branchingSection).length > 0,
    );

  const stackLeaf = $derived(sectionLeaf(sheet, "stack"));
  const stackLines = $derived(
    stackLeaf === undefined || stackLeaf.confidence === "unknown" ? [] : leafLines(stackLeaf.value),
  );

  const architectureSection = $derived(sheet?.architecture);
  const contextsLeaf = $derived(sectionLeaf(architectureSection, "contexts"));
  const contextRows: ContextRow[] = $derived(
    recordItems(contextsLeaf)
      .map((record) => {
        const path = scalarText(record.path);
        const entryPoints = Array.isArray(record.entryPoints)
          ? record.entryPoints.map((entry) => scalarText(entry).trim()).filter(Boolean)
          : [];
        return {
          name: scalarText(record.name).trim(),
          path,
          responsibility: scalarText(record.responsibility).trim(),
          entryPoints: [...new Set(entryPoints)].filter((entry) => entry !== path),
        };
      })
      .filter((row) => row.name.length > 0 || row.path.length > 0),
  );
  const dependencyDiagram = $derived.by(() => {
    const leaf = sectionLeaf(architectureSection, "dependencies");
    if (leaf === undefined || leaf.confidence === "unknown") return null;
    return dependencyChart(
      contextRows.map((row) => row.name),
      dependencyEdges(leaf.value),
    );
  });
  const boundaryRows: BoundaryRow[] = $derived.by(() => {
    const rows: BoundaryRow[] = [];
    for (const group of BOUNDARY_GROUPS) {
      const leaf = sectionLeaf(architectureSection, group.key);
      if (leaf === undefined || leaf.confidence === "unknown") continue;
      const values = boundaryValues(leaf, group.kind);
      if (values.length === 0) continue;
      rows.push({ key: group.key, label: group.label, kind: group.kind, values });
    }
    return rows;
  });
  const unknownBoundaryGroups = $derived.by(() => {
    const labels: string[] = [];
    const reasons = new Set<string>();
    for (const group of BOUNDARY_GROUPS) {
      const leaf = sectionLeaf(architectureSection, group.key);
      if (leaf === undefined || leaf.confidence !== "unknown") continue;
      labels.push(group.label.toLowerCase());
      if (typeof leaf.reason === "string" && leaf.reason.length > 0) reasons.add(leaf.reason);
    }
    return { labels, reasons: [...reasons] };
  });

  function baseName(value: string): string {
    const trimmed = value.replace(/[\\/]+$/, "");
    const parts = trimmed.split(/[\\/]+/);
    return parts[parts.length - 1] ?? trimmed;
  }

  function leafText(leaf: Leaf): string {
    return leafLines(leaf.value).join(", ");
  }

  function boundaryValues(leaf: Leaf, kind: BoundaryGroup["kind"]): string[] {
    if (kind === "sentence") {
      const text = scalarText(leaf.value).trim();
      return text.length > 0 && text.toLowerCase() !== "none detected" ? [text] : [];
    }
    if (!Array.isArray(leaf.value)) return [];
    if (leaf.value.length === 0) return ["None detected."];
    const values = leaf.value.map((value) => scalarText(value).trim()).filter(Boolean);
    return [...new Set(values)].filter((value) => value.toLowerCase() !== "none detected");
  }

  function visibleSection(section: unknown, hidden: string[]): Record<string, unknown> {
    if (typeof section !== "object" || section === null) return {};
    return Object.fromEntries(
      Object.entries(section).filter(([key, entry]) => !hidden.includes(key) && isLeaf(entry)),
    );
  }

  function commandRowsOf(
    section: Record<string, unknown> | null,
    testCommand: string,
    options: { includeMissing: boolean },
  ): Array<Record<string, unknown>> {
    if (section === null) return [];
    const rows: Array<Record<string, unknown>> = [];
    for (const [key, label] of Object.entries(COMMAND_LABELS)) {
      const leaf = section[key];
      const known = isLeaf(leaf) && leaf.confidence !== "unknown";
      if (known) {
        const command = discover.aliasFor(scalarText(leaf.value));
        // A try-out that only aliases the suite is the same command, not a gap.
        if (key === "tryOut" && testCommand.length > 0 && command === testCommand) continue;
        rows.push({ key, label, value: command, missing: false });
        continue;
      }
      if (!options.includeMissing) continue;
      rows.push({
        key,
        label,
        value: "",
        missing: true,
        reason: isLeaf(leaf) && leaf.confidence === "unknown"
          ? unknownText(leaf)
          : "No command was recorded.",
      });
    }
    return rows;
  }

  function discoveredLabel(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }

  function knownFacts(section: Record<string, unknown>): Array<[string, Leaf]> {
    return sectionEntries(section, []).filter(([, leaf]) => leaf.confidence !== "unknown");
  }
</script>

{#snippet startControl()}
  <Button
    variant="default"
    data-command="discover.start"
    data-testid="discover-start"
    disabled={discover.startDisabled}
    title={discover.startTitle}
    onclick={() => discover.start()}
  >
    {discover.hasArtifacts ? "Re-discover" : "Discover project"}
  </Button>
{/snippet}

{#snippet questionPanel()}
  {#if discover.question !== null}
    <section class="panel discover-question" data-testid="discover-question">
      <div class="panel__header">
        <h2 class="panel__title">The crawl needs a decision</h2>
        <span class="panel__subtitle">Answered once</span>
      </div>
      <div class="panel__body stack-sm">
        <p class="discover-question__message">{discover.question.message}</p>
        {#if discover.question.options.length > 0}
          <div class="choice-list">
            {#each discover.question.options as option (option.label)}
              <button
                type="button"
                class="choice"
                data-testid="discover-choice"
                data-command="discover.answer.submit"
                onclick={() => discover.answer(option.label)}
              >
                <span class="choice__label">
                  {option.label}
                  {#if option.recommended}
                    <span class="choice__recommended">Recommended</span>
                  {/if}
                </span>
                {#if option.description}
                  <span class="choice__description">{option.description}</span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
        <form
          class="discover-answer"
          onsubmit={(event) => {
            event.preventDefault();
            discover.answer(discover.answerDraft);
          }}
        >
          <Input
            id="discover-answer-input"
            type="text"
            value={discover.answerDraft}
            oninput={(event) => (discover.answerDraft = event.currentTarget.value)}
            placeholder="Your answer"
            aria-label="Your answer"
            data-testid="discover-answer-input"
          />
          <Button
            variant="default"
            type="submit"
            data-command="discover.answer.submit"
            data-testid="discover-answer"
            disabled={discover.answerDraft.trim().length === 0}
          >
            Answer
          </Button>
        </form>
      </div>
    </section>
  {/if}
{/snippet}

{#snippet factList(section: Record<string, unknown>)}
  {@const facts = knownFacts(section)}
  {#if facts.length === 0}
    <p class="empty">Not observed.</p>
  {:else}
    <dl class="discover-facts">
      {#each facts as [key, leaf] (key)}
        <div class="discover-fact">
          <dt>{humanize(key)}</dt>
          <dd class:discover-mono={MONO_FIELDS.has(key)}>{leafText(leaf)}</dd>
        </div>
      {/each}
    </dl>
  {/if}
{/snippet}

{#snippet chipList(lines: string[])}
  <div class="discover-chips">
    {#each lines as line, index (index)}
      {@const href = discover.repositoryLink(line)}
      {#if href === null}
        <code class="code-chip">{line}</code>
      {:else}
        <a
          class="code-chip code-chip--link"
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          title="Open the repository"
        >
          {line}
        </a>
      {/if}
    {/each}
  </div>
{/snippet}

{#snippet plainChips(lines: string[])}
  <div class="discover-chips">
    {#each lines as line (line)}
      <code class="code-chip">{line}</code>
    {/each}
  </div>
{/snippet}

{#snippet levelCell(row: Record<string, unknown>, columnId: string)}
  {#if columnId === "command"}
    {#if String(row.command ?? "").length > 0}
      <code class="code-chip">$ {String(row.command)}</code>
    {:else}
      <span class="muted">—</span>
    {/if}
  {:else}
    {String(row[columnId] ?? "")}
  {/if}
{/snippet}

{#snippet qualityGateCell(row: Record<string, unknown>, columnId: string)}
  {#if columnId === "gate"}
    <span class="discover-quality-gate__name">{String(row.gate ?? "")}</span>
  {:else if String(row.checks ?? "").length > 0}
    <span class="discover-quality-gate__checks">{String(row.checks)}</span>
  {:else}
    <span class="muted">No check was recorded.</span>
  {/if}
{/snippet}

{#snippet commandCell(row: Record<string, unknown>, columnId: string)}
  {#if columnId === "value"}
    {#if row.missing === true}
      <span class="muted discover-command-missing" title={String(row.reason ?? "")}>not found</span>
    {:else}
      <code class="code-chip">$ {String(row.value ?? "")}</code>
    {/if}
  {:else}
    <span class="discover-command-label" class:muted={row.missing === true}>
      {String(row.label ?? "")}
    </span>
  {/if}
{/snippet}

{#snippet sheetRail()}
  <div class="discover-rail">
    <section class="discover-block" data-testid="discover-card" data-field="runtime">
      <div class="discover-block__head">
        <h2 class="discover-block__title">Platform</h2>
      </div>
      {@render factList(runtimeSection)}
    </section>

    {#if hasDelivery}
      <section class="discover-block" data-testid="discover-card" data-field="delivery">
        <div class="discover-block__head">
          <h2 class="discover-block__title">Delivery</h2>
        </div>
        {#if Object.keys(deploymentSection).length > 0}
          <div class="discover-subblock">
            <h3 class="discover-subblock__title">Deployment</h3>
            {@render factList(deploymentSection)}
          </div>
        {/if}
        {#if Object.keys(ciSection).length > 0}
          <div class="discover-subblock">
            <h3 class="discover-subblock__title">CI</h3>
            {@render factList(ciSection)}
          </div>
        {/if}
        {#if Object.keys(branchingSection).length > 0}
          <div class="discover-subblock">
            <h3 class="discover-subblock__title">Branching</h3>
            {@render factList(branchingSection)}
          </div>
        {/if}
      </section>
    {/if}

    {#if stackLines.length > 0}
      <section class="discover-block" data-testid="discover-card" data-field="stack">
        <div class="discover-block__head">
          <h2 class="discover-block__title">Stack</h2>
          <span class="discover-block__meta">{stackLines.length} entries</span>
        </div>
        {@render chipList(stackLines)}
      </section>
    {/if}
  </div>
{/snippet}

<div
  class="scroll-column discover-page"
  data-testid="discover-panel"
  data-tab="overview"
  aria-label="Discover overview"
>
  {#snippet remotePanel()}
    {#if discover.remoteAvailable}
      <section class="panel discover-remote" data-testid="discover-remote" aria-label="Discover remote target">
        <div class="panel__header">
          <h2 class="panel__title">Manual testing target</h2>
          <span class="panel__subtitle">Source checkout only</span>
        </div>
        <div class="panel__body stack-sm">
          {#if discover.remoteTarget !== null}
            <p class="row-sm" data-testid="discover-remote-target">
              <span class="badge" data-tone="warning">Manual testing</span>
              <span>Discover reads <code>{discover.remoteTarget.url}</code>.</span>
            </p>
          {/if}
          {#if discover.retained.length > 0}
            <div class="discover-remote__retained">
              <label class="discover-remote__label" for="discover-remote-select">Retained project</label>
              <select
                id="discover-remote-select"
                class="discover-remote__select"
                data-testid="discover-remote-select"
                aria-label="Retained remote project"
                bind:this={remoteSelect}
                disabled={discover.remoteChangeDisabled}
                title={discover.remoteChangeTitle}
                onchange={(event) => discover.switchRemote(event.currentTarget.value)}
              >
                {#each discover.retained as project (project.url)}
                  <option value={project.url}>{project.url}</option>
                {/each}
              </select>
            </div>
            <ul class="discover-remote__list" aria-label="Retained projects">
              {#each discover.retained as project (project.url)}
                <li
                  class="discover-remote__item"
                  class:discover-remote__item--active={project.url === discover.remoteTarget?.url}
                >
                  <span class="discover-remote__url">{project.url}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="discover-remote-remove"
                    data-url={project.url}
                    disabled={discover.remoteChangeDisabled}
                    title={discover.remoteChangeTitle}
                    onclick={() => discover.removeRemote(project.url)}
                  >
                    Remove
                  </Button>
                </li>
              {/each}
            </ul>
          {/if}
          <form
            class="discover-remote__form"
            onsubmit={(event) => {
              event.preventDefault();
              discover.startRemote();
            }}
          >
            <Input
              type="url"
              aria-label="GitHub repository URL"
              placeholder="https://github.com/owner/repo"
              autocomplete="off"
              spellcheck="false"
              value={discover.remoteUrl}
              oninput={(event) => (discover.remoteUrl = event.currentTarget.value)}
              data-testid="discover-remote-url"
            />
            <Button
              variant="outline"
              type="submit"
              data-testid="discover-remote-start"
              disabled={discover.remoteStartDisabled}
              title={discover.remoteStartTitle}
            >
              Discover from URL
            </Button>
            {#if discover.remoteTarget !== null}
              <Button
                variant="ghost"
                data-testid="discover-remote-clear"
                disabled={discover.remoteChangeDisabled}
                title={discover.remoteChangeTitle}
                onclick={() => discover.clearRemote()}
              >
                Clear remote target
              </Button>
            {/if}
          </form>
          {#if discover.cloning !== null}
            <p class="muted" data-testid="discover-remote-cloning">
              Cloning <code>{discover.cloning.url}</code>…
            </p>
          {/if}
        </div>
      </section>
    {/if}
  {/snippet}

  {@render remotePanel()}

  <header class="discover-head" data-testid="discover-card" data-field="definition">
    <div class="discover-head__top">
      <div class="discover-head__identity">
        <h1 class="discover-head__title" title={projectPath}>{projectName}</h1>
      </div>
      <div class="discover-head__actions">
        {#if discover.busy !== null}
          <span class="muted">{discover.busy}</span>
        {/if}
        {@render startControl()}
      </div>
    </div>

    {#if discover.hasArtifacts}
      <p class="discover-head__definition">{definitionText}</p>
      {#if freshness !== null}
        <div class="discover-head__meta" data-testid="discover-freshness">
          <span>{discoveredLabel(freshness.discoveredAt)}</span>
        </div>
      {/if}
    {:else}
      <p class="discover-head__definition">
        Inventory this project from repository evidence: stack, commands, testing, architecture, and
        the conventions an agent should follow here.
      </p>
    {/if}
  </header>

  {#if discover.active}
    <section class="panel discover-run" data-testid="discover-active">
      <div class="panel__header discover-run__header">
        <div class="discover-run__heading">
          <span class="discover-run__dot" aria-hidden="true"></span>
          <h2 class="panel__title">Run in progress</h2>
        </div>
        <div class="discover-run__meta">
          {#if discover.startedAt !== null}
            <span class="muted discover-run__started" title={discover.startedAt}>
              Started {startedLabel}
            </span>
          {/if}
          <button
            type="button"
            class="discover-run__stop"
            title="Stop this Discover run"
            data-command="discover.stop"
            data-testid="discover-stop"
            onclick={() => discover.stop()}
          >
            Stop
          </button>
        </div>
      </div>
      <div class="discover-run__body">
        <div class="discover-run__terminal">
          <Terminal lines={discover.activity} data-testid="discover-activity" label="Discover activity" />
        </div>
      </div>
    </section>
  {/if}

  {@render questionPanel()}

  {#if discover.hasArtifacts && sheet !== null}
    <div class="discover-sheet" data-testid="discover-sheet">
      {@render sheetRail()}
      <div class="discover-col">
        {#if commandsSection !== null}
          <section class="panel discover-card" data-testid="discover-card" data-field="commands">
            <div class="panel__header">
              <h2 class="panel__title">Commands</h2>
              <button
                type="button"
                class="discover-coverage"
                data-testid="discover-command-coverage"
                aria-expanded={commandsOpen}
                aria-controls="discover-command-table"
                title={commandsOpen
                  ? "Hide the commands that were not found"
                  : "Show every command slot, including the ones that were not found"}
                onclick={() => (commandsOpen = !commandsOpen)}
              >
                {foundCommandRows.length}
                of {COMMAND_TOTAL} found
              </button>
            </div>
            <div class="panel__body">
              {#if isLeaf(commandsSection)}
                <p class="empty">{unknownText(commandsSection)}</p>
              {:else}
                <div id="discover-command-table">
                  <DataTable
                    data-testid="discover-command-list"
                    columns={COMMAND_COLUMNS}
                    rows={commandRows}
                    rowAttrs={(row) => ({
                      "data-command-key": String(row.key ?? ""),
                      "data-found": row.missing === true ? "false" : "true",
                    })}
                    cell={commandCell}
                    hideHeader
                    columnWidths={COMMAND_WIDTHS}
                    full
                    wrap
                  />
                </div>
              {/if}
            </div>
          </section>
        {/if}

        {#if testingSection !== null}
          <section class="panel discover-card" data-testid="discover-card" data-field="testing">
            <div class="panel__header">
              <h2 class="panel__title">Testing</h2>
              <span class="panel__subtitle">
                {tiers.length} {tiers.length === 1 ? "level" : "levels"} · {testTotal ?? 0}
                {(testTotal ?? 0) === 1 ? "test" : "tests"}
              </span>
            </div>
            <div class="panel__body">
              {#if isLeaf(testingSection)}
                <p class="empty">{unknownText(testingSection)}</p>
              {:else if levels === undefined}
                <p class="empty">No test levels were detected.</p>
              {:else if levels.confidence === "unknown"}
                <p class="empty">{unknownText(levels)}</p>
              {:else if tiers.length === 0}
                <p class="empty">
                  {recordedTiers.length === 0
                    ? "No test level was recorded."
                    : "No recorded level carries a test."}
                </p>
              {:else}
                <div class="discover-test-summary">
                  <div class="discover-stats" data-testid="discover-test-summary">
                    <div class="discover-stat">
                      <span class="discover-stat__value">{testTotal ?? 0}</span>
                      <span class="discover-stat__label">
                        {(testTotal ?? 0) === 1 ? "test" : "tests"}
                      </span>
                    </div>
                    <div class="discover-stat">
                      <span class="discover-stat__value">{tiers.length}</span>
                      <span class="discover-stat__label">
                        {tiers.length === 1 ? "level" : "levels"}
                      </span>
                    </div>
                    {#if happyPath !== null}
                      <div class="discover-stat">
                        <span class="discover-stat__value">
                          {Math.round((happyPath.happy / happyPath.tests) * 100)}%
                        </span>
                        <span class="discover-stat__label">happy path</span>
                      </div>
                    {/if}
                  </div>
                  {#if discover.testCommand.length > 0}
                    <div class="discover-command-line" data-testid="discover-suite-command">
                      <span class="muted">Whole suite</span>
                      <code class="code-chip" title={recordedTestCommand === discover.testCommand
                        ? undefined
                        : recordedTestCommand}>$ {discover.testCommand}</code>
                    </div>
                  {/if}
                </div>
                <DataTable
                  data-testid="discover-pyramid"
                  columns={LEVEL_COLUMNS}
                  rows={levelRows}
                  rowAttrs={(row) => ({ "data-level": String(row.rawLevel ?? "") })}
                  cell={levelCell}
                  full
                  wrap
                />
              {/if}
            </div>
          </section>
        {/if}

        {#if hasQualityGates}
          <section
            class="panel discover-card"
            data-testid="discover-card"
            data-field="quality-gates"
          >
            <div class="panel__header">
              <h2 class="panel__title">Quality gates</h2>
              {#if qualityGatesLeaf !== undefined && qualityGatesLeaf.confidence !== "unknown"}
                <span class="panel__subtitle">
                  {qualityGateRows.length}
                  {qualityGateRows.length === 1 ? "gate" : "gates"}
                </span>
              {/if}
            </div>
            <div class="panel__body">
              {#if qualityGatesLeaf === undefined}
                <p class="empty">No quality gate was recorded.</p>
              {:else if qualityGatesLeaf.confidence === "unknown"}
                <p class="empty">{unknownText(qualityGatesLeaf)}</p>
              {:else}
                <DataTable
                  data-testid="discover-quality-gates"
                  columns={QUALITY_GATE_COLUMNS}
                  rows={qualityGateRows}
                  rowAttrs={(row) => ({ "data-gate": String(row.gate ?? "") })}
                  cell={qualityGateCell}
                  columnWidths={QUALITY_GATE_WIDTHS}
                  full
                  wrap
                />
              {/if}
            </div>
          </section>
        {/if}

        {#if architectureSection !== undefined && typeof architectureSection === "object" && architectureSection !== null}
          <section class="panel discover-card" data-testid="discover-card" data-field="architecture">
            <div class="panel__header">
              <h2 class="panel__title">Bounded contexts</h2>
            </div>
            <div class="panel__body">
              {#if contextRows.length > 0}
                <ul class="discover-contexts" data-testid="discover-contexts">
                  {#each contextRows as context, index (index)}
                    <li class="discover-context" data-context={context.name}>
                      <div class="discover-context__head">
                        <span class="discover-context__name">{context.name}</span>
                      </div>
                      {#if context.responsibility.length > 0}
                        <p class="discover-context__responsibility">{context.responsibility}</p>
                      {/if}
                      {#if context.entryPoints.length > 0}
                        <div class="discover-context__entries">
                          <span class="discover-context__label">Entry points</span>
                          {@render plainChips(context.entryPoints)}
                        </div>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {:else if contextsLeaf !== undefined && contextsLeaf.confidence === "unknown"}
                <p class="empty">{unknownText(contextsLeaf)}</p>
              {:else}
                <p class="empty">No bounded context was detected.</p>
              {/if}

              {#if boundaryRows.length > 0}
                <dl class="discover-boundaries">
                  {#each boundaryRows as row (row.key)}
                    <div class="discover-boundary" data-role={row.key}>
                      <dt>{row.label}</dt>
                      <dd>
                        {#if row.kind === "chips"}
                          {@render plainChips(row.values)}
                        {:else}
                          {row.values[0]}
                        {/if}
                      </dd>
                    </div>
                  {/each}
                </dl>
              {/if}

              {#if dependencyDiagram !== null}
                <div class="discover-subblock" data-testid="discover-dependency-graph">
                  <h3 class="discover-subblock__title">Dependency graph</h3>
                  <MermaidDiagram
                    chart={dependencyDiagram}
                    label={`Dependency graph for ${projectName}`}
                  />
                </div>
              {/if}

              {#if unknownBoundaryGroups.labels.length > 0}
                <p class="discover-boundary-note">
                  Not observed: {unknownBoundaryGroups.labels.join(", ")}.
                  {unknownBoundaryGroups.reasons.join(" ")}
                </p>
              {/if}
            </div>
          </section>
        {/if}
      </div>
    </div>
  {:else}
    <section class="panel discover-empty" data-testid="discover-empty">
      <div class="discover-empty__body">
        <div class="discover-empty__copy">
          <h2>No project sheet yet</h2>
          <p>
            One Discover run reads the repository without running its commands. It publishes a
            project sheet, one UbiLang glossary per bounded context, and five Agent Skills.
          </p>
          <p class="muted">
            A field the crawl cannot ground is recorded as unknown instead of guessed. Switching
            views or closing the browser never starts a run.
          </p>
        </div>
        <ul class="discover-writes">
          <li>
            <code>.omp/discover/sheet.json</code>
            <span>Project sheet: stack, commands, CI, architecture, unknowns</span>
          </li>
          <li>
            <code>.omp/discover/glossary/</code>
            <span>One UbiLang glossary per bounded context</span>
          </li>
          <li>
            <code>.omp/skills/</code>
            <span>Five project-specific agent skills</span>
          </li>
        </ul>
      </div>
    </section>
  {/if}
</div>
