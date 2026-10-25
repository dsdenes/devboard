<script lang="ts">
  import {
    COMMAND_HINTS,
    COMMAND_LABELS,
    conceptTitle,
    contextTitle,
    HIDDEN_LEAVES,
    humanize,
    isLeaf,
    labelText,
    labelTexts,
    leafLines,
    pyramidTiers,
    pyramidTestCount,
    recordColumnValues,
    recordColumns,
    recordItems,
    scalarText,
    SECTION_LABELS,
    SECTION_ORDER,
    sectionEntries,
    sectionLeaf,
    TABS,
    unknownText,
  } from "../discover-format";
  import { discover } from "../discover.svelte";
  import type { WorkspaceTab } from "../layout.svelte";
  import type { Concept, Leaf } from "../types";
  import DataTable from "./DataTable.svelte";
  import DetailSplit from "./DetailSplit.svelte";
  import MonacoEditor from "./MonacoEditor.svelte";
  import PyramidChart from "./PyramidChart.svelte";
  import Terminal from "./Terminal.svelte";
  import Button from "./ui/button.svelte";

  interface Props {
    tab: WorkspaceTab | null;
    openTab: (tab: WorkspaceTab) => void;
    closeTab: (tab: WorkspaceTab) => void;
  }

  let { tab, openTab, closeTab }: Props = $props();

  const RECORD_COLUMNS = [
    { id: "label", header: "Command", accessorKey: "label" },
    { id: "value", header: "Line", accessorKey: "value" },
  ];

  const PYRAMID_COLUMNS = [
    { id: "level", header: "Level", accessorKey: "level" },
    { id: "tests", header: "Tests", accessorKey: "tests" },
    { id: "command", header: "Command", accessorKey: "command" },
    { id: "detail", header: "Paths & fixtures", accessorKey: "detail" },
  ];

  const GLOSSARY_COLUMNS = [
    { id: "title", header: "Term", accessorKey: "title" },
    { id: "definition", header: "Definition", accessorKey: "definition" },
    { id: "kind", header: "Kind", accessorKey: "kind" },
  ];

  const activeSkill = $derived(tab?.kind === "skill" ? tab.resourceId : null);
  const skill = $derived(activeSkill === null ? null : discover.skill(activeSkill));
  const skillDraft = $derived(activeSkill === null ? "" : discover.skillDraft(activeSkill));
  const skillTab = $derived(
    activeSkill === null ? null : (TABS.find((entry) => entry.skill === activeSkill) ?? null),
  );

  const term = $derived.by(() => {
    if (tab?.kind !== "term") return null;
    const separator = tab.resourceId.indexOf(":");
    if (separator < 0) return null;
    const context = tab.resourceId.slice(0, separator);
    const id = tab.resourceId.slice(separator + 1);
    const glossary = discover.contexts.find((entry) => entry.boundedContext === context);
    const concept = glossary?.concepts.find((entry) => entry.id === id);
    return glossary === undefined || concept === undefined ? null : { glossary, concept };
  });

  function leafText(leaf: Leaf): string {
    if (leaf.confidence === "unknown") return unknownText(leaf);
    return leafLines(leaf.value).join(" · ");
  }

  function recordRows(records: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return records;
  }

  function recordCols(records: Array<Record<string, unknown>>) {
    return recordColumns(records).map((column) => ({
      id: column.key,
      header: column.label,
      accessorKey: column.key,
    }));
  }

  function recordCell(row: Record<string, unknown>, columnId: string): string {
    const values = recordColumnValues(row, columnId);
    return values.length > 0 ? values.join(" · ") : "—";
  }

  function commandRows(section: Record<string, unknown>, testCommand: string) {
    const rows: Array<Record<string, unknown>> = [];
    for (const [key, leaf] of Object.entries(section)) {
      if (!isLeaf(leaf)) continue;
      if (key === "tryOut" && testCommand.length > 0 && scalarText(leaf.value) === testCommand) {
        continue;
      }
      const value = leaf.confidence === "unknown" ? "unknown" : scalarText(leaf.value);
      const hint = COMMAND_HINTS[key];
      rows.push({
        key,
        label: COMMAND_LABELS[key] ?? humanize(key),
        value: hint !== undefined && leaf.confidence !== "unknown" ? `${value} — ${hint}` : value,
      });
    }
    return rows;
  }

  function openTerm(context: string, concept: Concept): void {
    openTab({
      id: `term:${context}:${concept.id}`,
      kind: "term",
      resourceId: `${context}:${concept.id}`,
      title: conceptTitle(concept),
    });
  }
</script>

{#snippet recordsTable(records: Array<Record<string, unknown>>)}
  {#if records.length === 0}
    <p class="empty">Not recorded.</p>
  {:else}
    <DataTable
      columns={recordCols(records)}
      rows={recordRows(records)}
      cellValue={recordCell}
      full
      wrap
    />
  {/if}
{/snippet}

{#snippet leafValue(leaf: Leaf)}
  {#if recordItems(leaf).length > 0}
    {@render recordsTable(recordItems(leaf))}
  {:else if leaf.confidence === "unknown"}
    <p class="discover-value" data-confidence="unknown">{unknownText(leaf)}</p>
  {:else}
    {@const lines = leafLines(leaf.value)}
    {#if lines.length === 1}
      <p class="discover-value">{lines[0]}</p>
    {:else}
      <ul class="discover-list">
        {#each lines as line, index (index)}
          <li>{line}</li>
        {/each}
      </ul>
    {/if}
  {/if}
{/snippet}

{#snippet fieldList(section: Record<string, unknown>, hidden: string[])}
  {@const entries = sectionEntries(section, hidden)}
  {#if entries.length === 0}
    <p class="empty">Not recorded.</p>
  {:else}
    <dl class="field-list">
      {#each entries as [leafKey, leaf] (leafKey)}
        {#if recordItems(leaf).length > 0}
          <div class="field-list__block" data-field={leafKey}>
            <dt>{humanize(leafKey)}</dt>
            <dd>{@render recordsTable(recordItems(leaf))}</dd>
          </div>
        {:else}
          <div class="field-list__row" data-field={leafKey}>
            <dt>{humanize(leafKey)}</dt>
            <dd>
              {@render leafValue(leaf)}
            </dd>
          </div>
        {/if}
      {/each}
    </dl>
  {/if}
{/snippet}

{#snippet testingView(levels: Leaf | undefined, pyramid: Leaf | undefined, fullSuite: string)}
  {#if levels === undefined}
    <p class="empty">No test levels were detected.</p>
  {:else if levels.confidence === "unknown"}
    {@render leafValue(levels)}
  {:else}
    {@const tiers = pyramidTiers(levels)}
    {@const total = pyramidTestCount(tiers)}
    <div class="discover-stats" data-testid="discover-test-summary">
      <div class="discover-stat">
        <span class="discover-stat__value">{tiers.length}</span>
        <span class="discover-stat__label">{tiers.length === 1 ? "level" : "levels"}</span>
      </div>
      <div class="discover-stat">
        <span class="discover-stat__value">{total === null ? "—" : String(total)}</span>
        <span class="discover-stat__label">tests</span>
      </div>
    </div>
    {#if fullSuite.length > 0}
      <div class="discover-command-line" data-testid="discover-suite-command">
        <span class="muted">Whole suite</span>
        <code>{fullSuite}</code>
      </div>
    {/if}
    {#if tiers.length > 0}
      <PyramidChart tiers={tiers} data-testid="discover-pyramid-chart" />
      <DataTable
        data-testid="discover-pyramid"
        columns={PYRAMID_COLUMNS}
        rows={tiers.map((tier) => ({
          level: humanize(tier.level),
          tests:
            tier.tests === "unknown"
              ? "count unknown"
              : `${tier.tests} ${tier.tests === "1" ? "test" : "tests"}`,
          command: tier.command,
          detail: tier.detail.length > 0 ? tier.detail : "—",
          rawLevel: tier.level,
        }))}
        rowAttrs={(row) => ({ "data-level": String(row.rawLevel ?? "") })}
        cellValue={(row, columnId) => String(row[columnId] ?? "")}
        full
        wrap
      />
    {:else}
      {@render leafValue(levels)}
    {/if}
  {/if}
  {#if pyramid !== undefined && pyramid.confidence !== "unknown" && pyramid.value !== null}
    <p class="discover-note">{scalarText(pyramid.value)}</p>
  {/if}
{/snippet}

{#snippet commandsView(section: Record<string, unknown>, testCommand: string)}
  <DataTable
    data-testid="discover-command-list"
    columns={RECORD_COLUMNS}
    rows={commandRows(section, testCommand)}
    rowAttrs={(row) => ({ "data-command-key": String(row.key ?? "") })}
    cellValue={(row, columnId) => String(row[columnId] ?? "")}
    cellAttrs={(_row, columnId) => (columnId === "value" ? { "data-column": "line" } : {})}
    full
    wrap
  />
{/snippet}

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

{#snippet overviewPanel()}
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

    <header class="discover-page__header">
      <div class="discover-page__heading">
        <h1 class="discover-page__title">Discover</h1>
        <p class="discover-page__subtitle">
          {#if discover.hasArtifacts}
            Read-only current-state inventory of {discover.freshness?.project ?? "this project"}.
          {:else}
            Crawl this project for evidence-backed conventions, a glossary, and agent skills.
          {/if}
        </p>
      </div>
      <div class="row-sm discover-page__actions">
        {#if discover.busy !== null}
          <span class="muted">{discover.busy}</span>
        {/if}
        {@render startControl()}
      </div>
    </header>

    {#if discover.hasArtifacts}
      {#if discover.sheet !== null}
        <div class="discover-grid" data-testid="discover-sheet">
          {#each SECTION_ORDER as key (key)}
            {@const section = discover.sheet[key]}
            <section class="panel discover-card" data-testid="discover-card" data-field={key}>
              <div class="panel__header discover-card__header">
                <h2 class="panel__title">{SECTION_LABELS[key] ?? humanize(key)}</h2>
              </div>
              <div class="panel__body discover-card__body">
                {#if key === "testing" && typeof section === "object" && section !== null}
                  {@render testingView(
                    sectionLeaf(section, "levels"),
                    sectionLeaf(section, "pyramid"),
                    discover.testCommand,
                  )}
                {:else if key === "commands" && typeof section === "object" && section !== null}
                  {@render commandsView(section as Record<string, unknown>, discover.testCommand)}
                {:else if isLeaf(section)}
                  {@render leafValue(section)}
                {:else if typeof section === "object" && section !== null}
                  {@render fieldList(section as Record<string, unknown>, HIDDEN_LEAVES[key] ?? [])}
                {:else}
                  <p class="empty">Not recorded.</p>
                {/if}
              </div>
            </section>
          {/each}
        </div>
      {/if}
    {:else}
      <section class="panel discover-empty" data-testid="discover-empty">
        <div class="discover-empty__body">
          <h2>No Discover artifacts yet</h2>
          <p>
            Run Discover once to publish this project's inventory, glossary, and the five skills under
            <code>.omp/skills/</code>.
          </p>
          {#if discover.busy !== null}
            <p class="muted">{discover.busy}</p>
          {/if}
        </div>
      </section>
    {/if}
  </div>
{/snippet}

{#snippet glossaryPanel()}
  <div class="scroll-column discover-page" data-testid="discover-panel" data-tab="glossary" aria-label="Discover glossary">
    <header class="discover-page__header">
      <div class="discover-page__heading">
        <h1 class="discover-page__title">Glossary</h1>
        <p class="discover-page__subtitle">
          {discover.contexts.length}
          {discover.contexts.length === 1 ? "bounded context" : "bounded contexts"} in the published
          glossary.
        </p>
      </div>
      <div class="discover-page__actions">
        <input
          id="discover-glossary-search"
          class="textarea discover-search"
          type="search"
          value={discover.glossarySearch}
          oninput={(event) => discover.setGlossarySearch(event.currentTarget.value)}
          placeholder="Search terms"
          aria-label="Search glossary terms"
          data-testid="discover-glossary-search"
        />
      </div>
    </header>

    {#if discover.filteredContexts.length === 0}
      <p class="empty">No glossary terms match the current search.</p>
    {:else}
      {#each discover.filteredContexts as context (context.boundedContext)}
        <section class="panel discover-card" data-testid="discover-context" data-context={context.boundedContext}>
          <div class="panel__header discover-card__header">
            <h2 class="panel__title">{contextTitle(context)}</h2>
            <span class="muted">
              {context.concepts.length} {context.concepts.length === 1 ? "term" : "terms"}
            </span>
          </div>
          <div class="panel__body discover-card__body">
            <DataTable
              columns={GLOSSARY_COLUMNS}
              rows={context.concepts.map((concept) => ({
                ...concept,
                title: conceptTitle(concept),
                definition: labelText(concept.definitions) || "No definition recorded.",
              }))}
              rowTestId="discover-term"
              rowAttrs={(row) => ({
                "data-context": context.boundedContext,
                "data-id": String(row.id ?? ""),
                "data-status": String(row.status ?? ""),
                "data-kind": String(row.kind ?? ""),
              })}
              rowCommand={(row) =>
                `discover.term.open.${context.boundedContext}.${String(row.id ?? "")}`}
              onRowActivate={(row) => {
                const concept = context.concepts.find((entry) => entry.id === row.id);
                if (concept !== undefined) openTerm(context.boundedContext, concept);
              }}
              cellValue={(row, columnId) => String(row[columnId] ?? "")}
              cellAttrs={(_row, columnId) =>
                columnId === "kind" ? { class: "discover-cell--muted" } : {}}
              full
              wrap
            />
          </div>
        </section>
      {/each}
    {/if}
  </div>
{/snippet}

{#snippet skillPanel()}
  {#if activeSkill === null || skillTab === null}
    <p class="empty">No skill selected.</p>
  {:else}
    <div data-testid="discover-panel" data-tab={skillTab.id} aria-label={skillTab.label} style="height: 100%;">
      <div class="discover-skill" data-testid="discover-skill" data-name={activeSkill} style="height: 100%;">
        <div class="skill-editor">
          <div class="panel__header">
            <div class="discover-skill__heading">
              <h2 class="panel__title">{skillTab.label}</h2>
              <span class="muted">{activeSkill}</span>
            </div>
            <div class="row-sm">
              {#if discover.skillDirty(activeSkill)}
                <span class="muted" data-testid="discover-skill-dirty">Unsaved changes</span>
              {/if}
              <Button
                variant="default"
                data-command={`discover.skill.save.${activeSkill}`}
                data-testid="discover-skill-save"
                onclick={() => discover.saveSkill(activeSkill)}
              >
                Save
              </Button>
              {#if (skill?.state ?? "missing") !== "generated"}
                <Button
                  variant="outline"
                  data-command={`discover.skill.restore.${activeSkill}`}
                  data-testid="discover-skill-restore"
                  title={skill?.state === "missing"
                    ? "Recreate the skill from its generated version."
                    : "Discard your edits and return to the generated version."}
                  onclick={() => discover.restoreSkill(activeSkill)}
                >
                  {skill?.state === "missing" ? "Recreate generated version" : "Discard edits"}
                </Button>
              {/if}
            </div>
          </div>
          <div class="grow" style="min-height: 0;">
            <MonacoEditor
              value={skillDraft}
              label={`${activeSkill} skill text`}
              data-testid="discover-skill-text"
              dirty={discover.skillDirty(activeSkill)}
              onchange={(text) => discover.updateDraft(activeSkill, text)}
              onsave={() => discover.saveSkill(activeSkill)}
            />
          </div>
        </div>
      </div>
    </div>
  {/if}
{/snippet}

{#snippet termPanel()}
  {#if term === null}
    <p class="empty">This glossary term is no longer listed.</p>
  {:else}
    <div data-testid="discover-panel" data-tab="glossary" aria-label="Glossary term" style="height: 100%;">
      <DetailSplit id="discover-term" label="Term detail">
        {#snippet main()}
          <section
            class="panel"
            data-testid="discover-term"
            data-context={term.glossary.boundedContext}
            data-id={term.concept.id}
            data-status={term.concept.status}
            data-kind={term.concept.kind}
            style="height: 100%;"
          >
            <div class="panel__header">
              <div class="discover-skill__heading">
                <h2 class="panel__title">{conceptTitle(term.concept)}</h2>
                <span class="muted">{contextTitle(term.glossary)}</span>
              </div>
              <div class="row-sm">
                <span class="badge" data-tone={term.concept.status === "confirmed" ? "confirmed" : "accent"}>
                  {term.concept.status}
                </span>
                <Button
                  variant="outline"
                  data-command={`tab.close.discover.${tab?.id ?? ""}`}
                  onclick={() => {
                    if (tab !== null) closeTab(tab);
                  }}
                >
                  Close
                </Button>
              </div>
            </div>
            <div class="panel__body stack-sm">
              <p style="margin: 0;">
                {labelText(term.concept.definitions) || "No definition recorded."}
              </p>
              <dl class="kv-grid">
                <dt>Context</dt>
                <dd>{contextTitle(term.glossary)}</dd>
                <dt>Kind</dt>
                <dd>{term.concept.kind}</dd>
                <dt>Origin</dt>
                <dd>{term.concept.origin}</dd>
                <dt>Grounding</dt>
                <dd>
                  {Array.isArray(term.concept.grounding) ? term.concept.grounding.length : 0}
                </dd>
                <dt>ID</dt>
                <dd><code>{term.concept.id}</code></dd>
              </dl>
            </div>
          </section>
        {/snippet}
        {#snippet detail()}
          <section class="panel" style="height: 100%;">
            <div class="panel__header"><h2 class="panel__title">Labels &amp; context</h2></div>
            <div class="panel__body stack-sm">
              <div>
                <div class="field__label">Preferred labels</div>
                <p style="margin: 2px 0 0;">{labelTexts(term.concept.prefLabels).join(" · ")}</p>
              </div>
              {#if term.concept.altLabels !== undefined}
                <div>
                  <div class="field__label">Alternate labels</div>
                  <p style="margin: 2px 0 0;">{labelTexts(term.concept.altLabels).join(" · ")}</p>
                </div>
              {/if}
              <div>
                <div class="field__label">Related terms</div>
                <div class="stack-xs">
                  {#each term.glossary.concepts.filter((entry) => entry.id !== term.concept.id) as concept (concept.id)}
                    <button
                      type="button"
                      class="sidebar-item"
                      data-command={`discover.term.open.${term.glossary.boundedContext}.${concept.id}`}
                      onclick={() => openTerm(term.glossary.boundedContext, concept)}
                    >
                      <span class="sidebar-item__label">{conceptTitle(concept)}</span>
                      <span class="badge">{concept.status}</span>
                    </button>
                  {/each}
                </div>
              </div>
            </div>
          </section>
        {/snippet}
      </DetailSplit>
    </div>
  {/if}
{/snippet}

{#snippet warningsPanel()}
  <div class="scroll-column discover-page" data-testid="discover-panel" data-tab="warnings" aria-label="Discover warnings">
    <header class="discover-page__header">
      <div class="discover-page__heading">
        <h1 class="discover-page__title">Warnings</h1>
        <p class="discover-page__subtitle">
          {discover.displayedWarnings.length}
          {discover.displayedWarnings.length === 1 ? "warning" : "warnings"} from the published artifacts.
        </p>
      </div>
    </header>
    <section class="panel discover-card">
      <div class="panel__body panel__body--flush">
        {#each discover.displayedWarnings as warning, index (index)}
          <p class="discover-warning" data-testid="discover-warning">{warning}</p>
        {:else}
          <p class="empty">No warnings.</p>
        {/each}
      </div>
    </section>
  </div>
{/snippet}

<div class="mode-body" style="gap: 6px;">
  {#if discover.displayError !== null}
    <p class="message" data-severity="error" data-testid="discover-error" role="alert">
      {discover.displayError}
    </p>
  {/if}
  {#if discover.displayedWarnings.length > 0}
    <div class="row-sm" data-testid="discover-warnings" style="padding: 0 2px;">
      <span class="badge" data-tone="warning">{discover.displayedWarnings.length} warnings</span>
      <span class="muted">{discover.displayedWarnings[0]}</span>
    </div>
  {/if}
  {#if discover.interrupted}
    <p class="message" data-severity="warning" data-testid="discover-interrupted">
      The last Discover run was interrupted. Nothing was published.
    </p>
  {/if}
  {#if discover.transition !== null}
    <p class="message" data-severity="notice" data-testid="discover-transition" role="status">
      {discover.transition}
    </p>
  {/if}

  {#if tab === null}
    <p class="empty">No tab is open. Choose a section from the sidebar.</p>
  {:else if tab.kind === "overview"}
    {@render overviewPanel()}
  {:else if tab.kind === "glossary"}
    {@render glossaryPanel()}
  {:else if tab.kind === "skill"}
    {@render skillPanel()}
  {:else if tab.kind === "term"}
    {@render termPanel()}
  {:else if tab.kind === "warnings"}
    {@render warningsPanel()}
  {/if}
</div>
