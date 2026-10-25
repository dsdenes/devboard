<script lang="ts">
  import {
    COMMAND_HINTS,
    COMMAND_LABELS,
    HIDDEN_LEAVES,
    humanize,
    isLeaf,
    leafLines,
    pyramidTiers,
    pyramidTestCount,
    recordItems,
    scalarText,
    SECTION_ORDER,
    sectionEntries,
    sectionLeaf,
    sectionProvenance,
    sectionUnknowns,
    unknownText,
  } from "../discover-format";
  import { discover } from "../discover.svelte";
  import type { Confidence, Leaf } from "../types";
  import DataTable from "./DataTable.svelte";
  import PyramidChart from "./PyramidChart.svelte";
  import Terminal from "./Terminal.svelte";
  import Button from "./ui/button.svelte";

  const COMMAND_TOTAL = Object.keys(COMMAND_LABELS).length;
  const COMMAND_COLUMNS = [
    { id: "label", header: "Task", accessorKey: "label" },
    { id: "value", header: "Command", accessorKey: "value" },
  ];
  const LEVEL_COLUMNS = [
    { id: "level", header: "Level", accessorKey: "level" },
    { id: "tests", header: "Tests", accessorKey: "tests" },
    { id: "detail", header: "Paths & fixtures", accessorKey: "detail" },
  ];
  const CONTEXT_COLUMNS = [
    { id: "name", header: "Context", accessorKey: "name" },
    { id: "path", header: "Path", accessorKey: "path" },
    { id: "responsibility", header: "Responsibility", accessorKey: "responsibility" },
    { id: "entryPoints", header: "Entry points", accessorKey: "entryPoints" },
  ];
  const UNKNOWN_COLUMNS = [
    { id: "section", header: "Section", accessorKey: "section" },
    { id: "field", header: "Field", accessorKey: "field" },
    { id: "reason", header: "Why it is unknown", accessorKey: "reason" },
  ];
  const CONFIDENCE_ORDER: Confidence[] = ["observed", "declared", "inferred", "unknown"];
  const MONO_FIELDS = new Set(["artifact", "defaultBranch", "manifests"]);
  const UNKNOWN_FIELD_LABELS: Record<string, string> = {
    environments: "Environment names",
  };
  const LEDGER_LABELS: Record<string, string> = {
    definition: "Project definition",
    stack: "Stack",
    deployment: "Deployment",
    environments: "Environments",
    commands: "Commands",
    branching: "Branching",
    testing: "Testing",
    architecture: "Architecture",
    ci: "CI",
    runtime: "Runtime",
    dependencyMap: "Dependency map",
  };
  const DEPENDENCY_GROUPS = [
    { key: "binaries", label: "Binaries" },
    { key: "packages", label: "Packages" },
    { key: "externalServices", label: "External services" },
    { key: "keyDependencies", label: "Key dependencies" },
    { key: "routes", label: "Routes" },
    { key: "dataStores", label: "Data stores" },
  ];

  const sheet = $derived(discover.sheet);
  const freshness = $derived(discover.freshness);
  const definition = $derived(sectionLeaf(sheet, "definition"));
  const definitionText = $derived(
    definition === undefined ? "" : definition.confidence === "unknown"
      ? unknownText(definition)
      : leafText(definition),
  );
  const definitionProvenance = $derived(
    definition === undefined ? null : sectionProvenance(definition),
  );

  const commandsSection = $derived(
    typeof sheet?.commands === "object" && sheet.commands !== null
      ? (sheet.commands as Record<string, unknown>)
      : null,
  );
  const commandRows = $derived(commandRowsOf(commandsSection, discover.testCommand));
  const commandNote = $derived(
    commandRows.some((row) => row.key === "tryOut") && COMMAND_HINTS.tryOut !== undefined
      ? `Try it out ${COMMAND_HINTS.tryOut.charAt(0).toLowerCase()}${COMMAND_HINTS.tryOut.slice(1)}`
      : "",
  );

  const testingSection = $derived(
    typeof sheet?.testing === "object" && sheet.testing !== null ? sheet.testing : null,
  );
  const levels = $derived(sectionLeaf(testingSection, "levels"));
  const tiers = $derived(pyramidTiers(levels));
  const testTotal = $derived(pyramidTestCount(tiers));
  const levelRows = $derived(
    tiers.map((tier) => ({
      level: humanize(tier.level),
      tests:
        tier.tests === "unknown"
          ? "count unknown"
          : `${tier.tests} ${tier.tests === "1" ? "test" : "tests"}`,
      detail: tier.detail.length > 0 ? tier.detail.replaceAll(" · ", "\n") : "—",
      rawLevel: tier.level,
    })),
  );

  const runtimeSection = $derived(visibleSection(sheet?.runtime, HIDDEN_LEAVES.runtime ?? []));
  const deploymentSection = $derived(
    visibleSection(sheet?.deployment, HIDDEN_LEAVES.deployment ?? []),
  );
  const deliveryProvenanceSection = $derived({
    deployment: deploymentSection,
    ci: sheet?.ci,
    branching: sheet?.branching,
  });

  const stackLeaf = $derived(sectionLeaf(sheet, "stack"));
  const stackLines = $derived(
    stackLeaf === undefined || stackLeaf.confidence === "unknown" ? [] : leafLines(stackLeaf.value),
  );

  const architectureSection = $derived(sheet?.architecture);
  const contextRows = $derived(
    recordItems(sectionLeaf(architectureSection, "contexts")).map((record) => ({
      name: scalarText(record.name),
      path: scalarText(record.path),
      responsibility: scalarText(record.responsibility),
      entryPoints: Array.isArray(record.entryPoints)
        ? record.entryPoints.map((entry) => scalarText(entry)).filter(Boolean).join(" · ")
        : "",
    })),
  );
  const dependencyDirection = $derived(
    sectionLeaf(architectureSection, "dependencyDirection"),
  );
  const externalBoundaries = $derived(
    sectionLeaf(architectureSection, "externalBoundaries"),
  );
  const sharedKernels = $derived(sectionLeaf(architectureSection, "sharedKernels"));

  const dependencyGroups = $derived(
    DEPENDENCY_GROUPS.map((group) => {
      const leaf = sectionLeaf(sheet?.dependencyMap, group.key);
      return {
        ...group,
        values:
          leaf === undefined || leaf.confidence === "unknown" ? [] : leafLines(leaf.value),
      };
    }).filter((group) => group.values.length > 0),
  );
  const dependencyProvenance = $derived(
    Object.fromEntries(
      dependencyGroups
        .map((group) => [group.key, sectionLeaf(sheet?.dependencyMap, group.key)])
        .filter((entry): entry is [string, Leaf] => entry[1] !== undefined),
    ),
  );

  const unknownRows = $derived.by(() => {
    const rows: Array<Record<string, unknown>> = [];
    for (const key of SECTION_ORDER) {
      const section = sheet?.[key];
      if (section === undefined || section === null) continue;
      const sectionLabel = LEDGER_LABELS[key] ?? humanize(key);
      const hidden = HIDDEN_LEAVES[key] ?? [];
      if (isLeaf(section)) {
        if (section.confidence === "unknown") {
          rows.push({
            section: sectionLabel,
            field: UNKNOWN_FIELD_LABELS[key] ?? humanize(key),
            reason: reasonOf(section),
          });
        }
        continue;
      }
      for (const [field, leaf] of sectionUnknowns(section, hidden)) {
        rows.push({ section: sectionLabel, field: humanize(field), reason: reasonOf(leaf) });
      }
    }
    return rows;
  });

  function leafText(leaf: Leaf): string {
    return leafLines(leaf.value).join(" · ");
  }

  function reasonOf(leaf: Leaf): string {
    return typeof leaf.reason === "string" && leaf.reason.length > 0
      ? leaf.reason
      : "not recorded";
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
  ): Array<Record<string, unknown>> {
    if (section === null) return [];
    const rows: Array<Record<string, unknown>> = [];
    for (const [key, leaf] of Object.entries(section)) {
      if (!isLeaf(leaf) || leaf.confidence === "unknown") continue;
      if (key === "tryOut" && testCommand.length > 0 && scalarText(leaf.value) === testCommand) {
        continue;
      }
      rows.push({
        key,
        label: COMMAND_LABELS[key] ?? humanize(key),
        value: `$ ${scalarText(leaf.value)}`,
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
    <section class="panel" data-testid="discover-question">
      <div class="panel__body stack-sm">
        <p style="margin: 0;">{discover.question.message}</p>
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
          class="answer-form"
          onsubmit={(event) => {
            event.preventDefault();
            discover.answer(discover.answerDraft);
          }}
        >
          <input
            id="discover-answer-input"
            class="textarea"
            style="min-height: 28px; padding: 4px 6px;"
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

{#snippet provenance(section: unknown, hidden: string[] = [])}
  {@const value = sectionProvenance(section, hidden)}
  {#if value.evidence.length > 0 || value.counts.observed + value.counts.declared + value.counts.inferred + value.counts.unknown > 0}
    <div class="discover-sources">
      {#each CONFIDENCE_ORDER as confidence (confidence)}
        {#if value.counts[confidence] > 0}
          <span
            class="discover-conf"
            data-testid="discover-confidence"
            data-confidence={confidence}
          >
            {confidence} {value.counts[confidence]}
          </span>
        {/if}
      {/each}
      {#each value.evidence as path (path)}
        <code class="discover-evidence" data-testid="discover-evidence">{path}</code>
      {/each}
    </div>
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
      <code class="discover-chip">{line}</code>
    {/each}
  </div>
{/snippet}

<div
  class="scroll-column discover-page"
  data-testid="discover-panel"
  data-tab="overview"
  aria-label="Discover overview"
>
  {#if discover.active}
    <section class="panel" data-testid="discover-active">
      <div class="panel__header">
        <h2 class="panel__title">
          Discover run active{#if discover.runId !== null} · <code>{discover.runId}</code>{/if}
        </h2>
        <div class="row-sm">
          {#if discover.startedAt !== null}
            <span class="muted">Started {discover.startedAt}</span>
          {/if}
          <Button
            variant="destructive"
            data-command="discover.stop"
            data-testid="discover-stop"
            onclick={() => discover.stop()}
          >
            Stop
          </Button>
        </div>
      </div>
      <div style="height: 180px;">
        <Terminal lines={discover.activity} data-testid="discover-activity" label="Discover activity" />
      </div>
    </section>
  {/if}

  {@render questionPanel()}

  <header class="discover-head" data-testid="discover-card" data-field="definition">
    <div class="discover-head__top">
      <div class="discover-head__identity">
        <h1 class="discover-head__title">
          {discover.hasArtifacts ? (freshness?.project ?? "Discover") : "Discover"}
        </h1>
        {#if freshness?.dirty === true}
          <span class="badge" data-tone="warning" title="The working tree has uncommitted changes.">
            dirty
          </span>
        {/if}
        {#if discover.stale}
          <span
            class="badge"
            data-tone="stale"
            data-testid="discover-stale"
            title="The repository fingerprint changed since this sheet was published."
          >
            stale
          </span>
        {/if}
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
          <code>{freshness.commit}</code>
          <span aria-hidden="true">·</span>
          <span>Discovered {discoveredLabel(freshness.discoveredAt)}</span>
          {#if definitionProvenance !== null}
            {#each CONFIDENCE_ORDER as confidence (confidence)}
              {#if definitionProvenance.counts[confidence] > 0}
                <span class="discover-conf" data-confidence={confidence}>
                  {confidence} {definitionProvenance.counts[confidence]}
                </span>
              {/if}
            {/each}
            {#each definitionProvenance.evidence as path (path)}
              <code class="discover-evidence">{path}</code>
            {/each}
          {/if}
        </div>
      {/if}
    {:else}
      <p class="discover-head__definition">
        Inventory this project from repository evidence: stack, commands, testing, architecture, and
        the conventions an agent should follow here.
      </p>
      <div class="discover-head__meta">No artifacts have been published for this host.</div>
    {/if}
  </header>

  {#if discover.hasArtifacts && sheet !== null}
    <div class="discover-sheet" data-testid="discover-sheet">
      <div class="discover-column">
        <section class="discover-group" aria-labelledby="discover-group-run">
          <h2 class="discover-group__title" id="discover-group-run">Run and verify</h2>

          {#if commandsSection !== null}
            <section
              class="panel discover-card"
              data-testid="discover-card"
              data-field="commands"
            >
              <div class="panel__header">
                <h2 class="panel__title">Commands</h2>
                <span class="muted">{commandRows.length} of {COMMAND_TOTAL} commands found</span>
              </div>
              <div class="panel__body">
                {#if isLeaf(commandsSection)}
                  <p class="empty">{unknownText(commandsSection)}</p>
                {:else if commandRows.length === 0}
                  <p class="empty">No command was declared in the crawled files.</p>
                {:else}
                  <DataTable
                    data-testid="discover-command-list"
                    columns={COMMAND_COLUMNS}
                    rows={commandRows}
                    rowAttrs={(row) => ({ "data-command-key": String(row.key ?? "") })}
                    cellValue={(row, columnId) => String(row[columnId] ?? "")}
                    cellAttrs={(_row, columnId) =>
                      columnId === "value"
                        ? { "data-column": "line" }
                        : { class: "discover-command-label" }}
                    full
                    wrap
                  />
                {/if}
                {#if commandNote.length > 0}
                  <p class="discover-note">{commandNote}</p>
                {/if}
                {@render provenance(commandsSection)}
              </div>
            </section>
          {/if}

          {#if testingSection !== null}
            <section
              class="panel discover-card"
              data-testid="discover-card"
              data-field="testing"
            >
              <div class="panel__header">
                <h2 class="panel__title">Testing</h2>
                <span class="muted">
                  {tiers.length} {tiers.length === 1 ? "level" : "levels"}{testTotal === null
                    ? ""
                    : ` · ${testTotal} tests`}
                </span>
              </div>
              <div class="panel__body">
                {#if isLeaf(testingSection)}
                  <p class="empty">{unknownText(testingSection)}</p>
                {:else if levels === undefined}
                  <p class="empty">No test levels were detected.</p>
                {:else if levels.confidence === "unknown"}
                  <p class="empty">{unknownText(levels)}</p>
                {:else}
                  {#if tiers.length > 0}
                    <div class="discover-test-top">
                      <div class="discover-pyramid">
                        <PyramidChart tiers={tiers} compact data-testid="discover-pyramid-chart" />
                      </div>
                      <div class="discover-test-side">
                        <div class="discover-stats" data-testid="discover-test-summary">
                          <div class="discover-stat">
                            <span class="discover-stat__value">
                              {testTotal === null ? "—" : testTotal}
                            </span>
                            <span class="discover-stat__label">tests</span>
                          </div>
                          <div class="discover-stat">
                            <span class="discover-stat__value">{tiers.length}</span>
                            <span class="discover-stat__label">
                              {tiers.length === 1 ? "level" : "levels"}
                            </span>
                          </div>
                        </div>
                        {#if discover.testCommand.length > 0}
                          <div class="discover-command-line" data-testid="discover-suite-command">
                            <span class="muted">Whole suite</span>
                            <code>{discover.testCommand}</code>
                          </div>
                        {/if}
                      </div>
                    </div>
                    <DataTable
                      data-testid="discover-pyramid"
                      columns={LEVEL_COLUMNS}
                      rows={levelRows}
                      rowAttrs={(row) => ({ "data-level": String(row.rawLevel ?? "") })}
                      cellValue={(row, columnId) => String(row[columnId] ?? "")}
                      cellAttrs={(_row, columnId) =>
                        columnId === "detail" ? { class: "discover-mono" } : {}}
                      full
                      wrap
                    />
                  {:else}
                    <p class="empty">No test level was recorded.</p>
                  {/if}
                  {#if sectionLeaf(testingSection, "pyramid") !== undefined &&
                    sectionLeaf(testingSection, "pyramid")?.confidence !== "unknown"}
                    <p class="discover-note">
                      {leafText(sectionLeaf(testingSection, "pyramid") as Leaf)}
                    </p>
                  {/if}
                {/if}
                {@render provenance(testingSection)}
              </div>
            </section>
          {/if}
        </section>
      </div>

      <aside class="discover-column discover-column--rail">
        <section class="discover-group" aria-labelledby="discover-group-platform">
          <h2 class="discover-group__title" id="discover-group-platform">Platform</h2>
          <section class="discover-section" data-testid="discover-card" data-field="runtime">
            <div class="discover-section__head">
              <h3 class="discover-section__title">Runtime</h3>
            </div>
            {@render factList(runtimeSection)}
            {@render provenance(runtimeSection)}
          </section>
        </section>

        <section class="discover-group" aria-labelledby="discover-group-delivery">
          <h2 class="discover-group__title" id="discover-group-delivery">Delivery</h2>
          {#if typeof sheet.deployment === "object" && sheet.deployment !== null}
            <section class="discover-section" data-testid="discover-card" data-field="deployment">
              <div class="discover-section__head">
                <h3 class="discover-section__title">Deployment</h3>
              </div>
              {@render factList(deploymentSection)}
            </section>
          {/if}
          {#if typeof sheet.ci === "object" && sheet.ci !== null}
            <section class="discover-section" data-testid="discover-card" data-field="ci">
              <div class="discover-section__head">
                <h3 class="discover-section__title">CI</h3>
              </div>
              {@render factList(sheet.ci as Record<string, unknown>)}
            </section>
          {/if}
          {#if typeof sheet.branching === "object" && sheet.branching !== null}
            <section class="discover-section" data-testid="discover-card" data-field="branching">
              <div class="discover-section__head">
                <h3 class="discover-section__title">Branching</h3>
              </div>
              {@render factList(sheet.branching as Record<string, unknown>)}
            </section>
          {/if}
          {@render provenance(deliveryProvenanceSection)}
        </section>
      </aside>

      {#if stackLines.length > 0}
        <section class="discover-band full" data-testid="discover-card" data-field="stack">
          <div class="discover-section__head">
            <h2 class="discover-section__title">Stack</h2>
            <span class="discover-section__meta">{stackLines.length} entries</span>
          </div>
          {@render chipList(stackLines)}
          {#if stackLeaf !== undefined}
            {@render provenance(stackLeaf)}
          {/if}
        </section>
      {/if}

      {#if architectureSection !== undefined && typeof architectureSection === "object" && architectureSection !== null}
        <section class="discover-section full" data-testid="discover-card" data-field="architecture">
          <div class="discover-section__head">
            <h2 class="discover-section__title">Architecture and boundaries</h2>
            <span class="discover-section__meta">
              {contextRows.length}
              {contextRows.length === 1 ? "bounded context" : "bounded contexts"}
            </span>
          </div>
          {#if dependencyDirection !== undefined && dependencyDirection.confidence !== "unknown"}
            <p class="discover-lead">{leafText(dependencyDirection)}</p>
          {/if}
          {#if contextRows.length > 0}
            <DataTable
              data-testid="discover-contexts"
              columns={CONTEXT_COLUMNS}
              rows={contextRows}
              rowAttrs={(row) => ({ "data-context": String(row.name ?? "") })}
              cellValue={(row, columnId) => String(row[columnId] ?? "")}
              cellAttrs={(_row, columnId) =>
                columnId === "path" || columnId === "entryPoints"
                  ? { class: "discover-mono" }
                  : {}}
              full
              wrap
            />
          {:else}
            <p class="empty">No bounded context was detected.</p>
          {/if}
          <div class="discover-boundaries">
            <div>
              <div class="discover-subtitle">External boundaries</div>
              {#if externalBoundaries !== undefined && externalBoundaries.confidence !== "unknown"}
                {@render chipList(leafLines(externalBoundaries.value))}
              {:else}
                <p class="empty">Not observed.</p>
              {/if}
            </div>
            <div>
              <div class="discover-subtitle">Shared kernels</div>
              {#if sharedKernels !== undefined && sharedKernels.confidence !== "unknown"}
                {@render chipList(leafLines(sharedKernels.value))}
              {:else}
                <p class="empty">Not observed.</p>
              {/if}
            </div>
          </div>
          {@render provenance(architectureSection)}
        </section>
      {/if}

      {#if dependencyGroups.length > 0}
        <section class="discover-section full" data-testid="discover-card" data-field="dependencyMap">
          <div class="discover-section__head">
            <h2 class="discover-section__title">Entry points and dependencies</h2>
            <span class="discover-section__meta">
              {dependencyGroups.length} observed
              {dependencyGroups.length === 1 ? "group" : "groups"}
            </span>
          </div>
          <div class="discover-dependencies">
            {#each dependencyGroups as group (group.key)}
              <div>
                <div class="discover-subtitle">{group.label}</div>
                {@render chipList(group.values)}
              </div>
            {/each}
          </div>
          {@render provenance(dependencyProvenance)}
        </section>
      {/if}

      <section class="discover-section full" data-testid="discover-card" data-field="unknowns">
        <div class="discover-section__head">
          <h2 class="discover-section__title">Not observed</h2>
          <span class="discover-section__meta">
            {unknownRows.length} {unknownRows.length === 1 ? "field" : "fields"} · nothing here is
            guessed
          </span>
        </div>
        {#if unknownRows.length === 0}
          <p class="empty">Every recorded field carries repository evidence.</p>
        {:else}
          <DataTable
            data-testid="discover-unknowns"
            columns={UNKNOWN_COLUMNS}
            rows={unknownRows}
            cellValue={(row, columnId) => String(row[columnId] ?? "")}
            cellAttrs={(_row, columnId) =>
              columnId === "reason" || columnId === "section"
                ? { class: "discover-cell--muted" }
                : {}}
            full
            wrap
          />
        {/if}
      </section>
    </div>
  {:else}
    <section class="panel discover-empty" data-testid="discover-empty">
      <div class="discover-empty__body">
        <div class="discover-empty__copy">
          <h2>No project sheet yet</h2>
          <p>
            One Discover run reads the repository without running its commands and publishes three
            artifacts. Nothing is written outside <code>.omp/discover/</code> and
            <code>.omp/skills/</code>, and a field the crawl cannot ground is recorded as unknown
            instead of guessed.
          </p>
          <p class="muted">Switching tabs or closing the browser does not start a run.</p>
          {#if discover.busy !== null}
            <p class="muted">{discover.busy}</p>
          {/if}
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
