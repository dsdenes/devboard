<script lang="ts">
  import { html as diffHtml } from "diff2html";
  import "diff2html/bundles/css/diff2html.min.css";
  import AgentOutput from "../../AgentOutput.svelte";
  import {
    COMMAND_HINTS,
    COMMAND_LABELS,
    conceptTitle,
    HIDDEN_LEAVES,
    humanize,
    isLeaf,
    labelText,
    labelTexts,
    leafLines,
    pyramidTiers,
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
  import { layout } from "../layout.svelte";
  import type { WorkspaceTab } from "../layout.svelte";
  import { DISCOVER_DIFF_OPTIONS, unifiedDiff } from "../skill-diff";
  import type { Concept, Leaf } from "../types";
  import DataTable from "./DataTable.svelte";
  import DetailSplit from "./DetailSplit.svelte";
  import MonacoEditor from "./MonacoEditor.svelte";
  import Terminal from "./Terminal.svelte";
  import Button from "./ui/button.svelte";

  interface Props {
    tab: WorkspaceTab | null;
    openTab: (tab: WorkspaceTab) => void;
    closeTab: (tab: WorkspaceTab) => void;
  }

  let { tab, openTab, closeTab }: Props = $props();

  const FIELD_COLUMNS = [
    { id: "label", header: "Field", accessorKey: "label" },
    { id: "value", header: "Value", accessorKey: "value" },
  ];

  const RECORD_COLUMNS = [
    { id: "command", header: "Command", accessorKey: "label" },
    { id: "line", header: "Line", accessorKey: "value" },
  ];

  const PYRAMID_COLUMNS = [
    { id: "level", header: "Level", accessorKey: "label" },
    { id: "tests", header: "Tests", accessorKey: "tests" },
    { id: "command", header: "Command", accessorKey: "command" },
    { id: "detail", header: "Paths & fixtures", accessorKey: "detail" },
  ];

  const GLOSSARY_COLUMNS = [
    { id: "term", header: "Term", accessorKey: "title" },
    { id: "definition", header: "Definition", accessorKey: "definition" },
    { id: "kind", header: "Kind", accessorKey: "kind" },
    { id: "status", header: "Status", accessorKey: "status" },
    { id: "origin", header: "Origin", accessorKey: "origin" },
    { id: "grounding", header: "Grounding", accessorKey: "grounding" },
    { id: "id", header: "ID", accessorKey: "id" },
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

  function entryText(leaf: Leaf): string {
    const records = recordItems(leaf);
    if (records.length > 0) return `${records.length} records`;
    return leafText(leaf);
  }

  function fieldRows(section: unknown, hidden: string[]): Array<Record<string, unknown>> {
    return sectionEntries(section, hidden).map(([key, leaf]) => ({
      key,
      label: humanize(key),
      value: entryText(leaf),
    }));
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
      const value =
        leaf.confidence === "unknown" ? "unknown" : scalarText(leaf.value);
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
      compact
    />
  {/if}
{/snippet}

{#snippet singleLeaf(leaf: Leaf)}
  {#if recordItems(leaf).length > 0}
    {@render recordsTable(recordItems(leaf))}
  {:else}
    <DataTable
      columns={[{ id: "value", header: "Value", accessorKey: "value" }]}
      rows={[{ value: leafText(leaf) }]}
      cellValue={(row) => String(row.value ?? "")}
    />
  {/if}
{/snippet}

{#snippet testingView(levels: Leaf | undefined, pyramid: Leaf | undefined, fullSuite: string)}
  {#if fullSuite.length > 0}
    <div class="row-sm" data-testid="discover-suite-command">
      <span class="muted">Whole suite</span>
      <code>{fullSuite}</code>
    </div>
  {/if}
  {#if levels === undefined}
    <p class="empty">No test levels were detected.</p>
  {:else if levels.confidence === "unknown"}
    <DataTable
      columns={[{ id: "value", header: "Value", accessorKey: "value" }]}
      rows={[{ value: leafText(levels) }]}
      cellValue={(row) => String(row.value ?? "")}
    />
  {:else if pyramidTiers(levels).length > 0}
    <DataTable
      data-testid="discover-pyramid"
      columns={PYRAMID_COLUMNS}
      rows={pyramidTiers(levels).map((tier) => ({
        level: tier.level,
        label: humanize(tier.level),
        tests:
          tier.tests === "unknown"
            ? "count unknown"
            : `${tier.tests} ${tier.tests === "1" ? "test" : "tests"}`,
        command: tier.command,
        detail: tier.detail.length > 0 ? tier.detail : "—",
      }))}
      rowAttrs={(row) => ({ "data-level": String(row.level ?? "") })}
      cellValue={(row, columnId) => String(row[columnId] ?? "")}
    />
  {:else}
    <DataTable
      columns={[{ id: "value", header: "Value", accessorKey: "value" }]}
      rows={[{ value: leafText(levels) }]}
      cellValue={(row) => String(row.value ?? "")}
    />
  {/if}
  {#if pyramid !== undefined && pyramid.confidence !== "unknown" && pyramid.value !== null}
    <p class="muted" style="margin: 4px 0 0;">{scalarText(pyramid.value)}</p>
  {/if}
{/snippet}

{#snippet commandsView(section: Record<string, unknown>, testCommand: string)}
  <DataTable
    data-testid="discover-command-list"
    columns={RECORD_COLUMNS}
    rows={commandRows(section, testCommand)}
    rowAttrs={(row) => ({ "data-command-key": String(row.key ?? "") })}
    cellValue={(row, columnId) => String(row[columnId] ?? "")}
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
  <div class="scroll-column" data-testid="discover-panel" data-tab="overview" aria-label="Discover overview">
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

    <div class="row-sm">
      {@render startControl()}
      {#if discover.busy !== null}
        <span class="muted">{discover.busy}</span>
      {/if}
    </div>

    {#if discover.hasArtifacts}
      {#if discover.freshness !== null}
        <section class="panel" data-testid="discover-freshness">
          <div class="panel__body row-sm" style="gap: 16px;">
            <span><span class="muted">Project</span> {discover.freshness.project}</span>
            <span><span class="muted">Discovered</span> {discover.freshness.discoveredAt}</span>
            {#if discover.stale}
              <span class="badge" data-tone="stale" data-testid="discover-stale">stale</span>
            {/if}
          </div>
        </section>
      {/if}

      {#if discover.sheet !== null}
        <div class="discover-sheet" data-testid="discover-sheet">
          {#each SECTION_ORDER as key (key)}
            {@const section = discover.sheet[key]}
            <section class="panel discover-card" data-testid="discover-card" data-field={key}>
              <div class="panel__header">
                <h2 class="panel__title">{SECTION_LABELS[key] ?? humanize(key)}</h2>
              </div>
              <div class="panel__body stack-sm">
                {#if key === "testing" && typeof section === "object" && section !== null}
                  {@render testingView(
                    sectionLeaf(section, "levels"),
                    sectionLeaf(section, "pyramid"),
                    discover.testCommand,
                  )}
                {:else if key === "commands" && typeof section === "object" && section !== null}
                  {@render commandsView(section as Record<string, unknown>, discover.testCommand)}
                {:else if isLeaf(section)}
                  {@render singleLeaf(section)}
                {:else if typeof section === "object" && section !== null}
                  {@const entries = sectionEntries(section, HIDDEN_LEAVES[key] ?? [])}
                  {#if entries.length === 0}
                    <p class="empty">Not recorded.</p>
                  {:else}
                    <DataTable
                      columns={FIELD_COLUMNS}
                      rows={entries.map(([leafKey, leaf]) => ({
                        key: leafKey,
                        label: humanize(leafKey),
                        value: entryText(leaf),
                      }))}
                      rowAttrs={(row) => ({ "data-field": String(row.key ?? "") })}
                      cellValue={(row, columnId) => String(row[columnId] ?? "")}
                    />
                    {#each entries as [leafKey, leaf] (leafKey)}
                      {#if recordItems(leaf).length > 0}
                        <div>
                          <div class="field__label">{humanize(leafKey)}</div>
                          {@render recordsTable(recordItems(leaf))}
                        </div>
                      {/if}
                    {/each}
                  {/if}
                {:else}
                  <p class="empty">Not recorded.</p>
                {/if}
              </div>
            </section>
          {/each}
        </div>
      {/if}
    {:else}
      <section class="panel" data-testid="discover-empty">
        <div class="panel__body stack-sm">
          <p>No Discover artifacts have been published for this project yet.</p>
          {#if discover.busy !== null}
            <p class="muted">{discover.busy}</p>
          {/if}
        </div>
      </section>
    {/if}
  </div>
{/snippet}

{#snippet glossaryPanel()}
  <div class="scroll-column" data-testid="discover-panel" data-tab="glossary" aria-label="Discover glossary">
    <div class="row-sm">
      <input
        id="discover-glossary-search"
        class="textarea"
        style="min-height: 28px; max-width: 360px; padding: 4px 6px;"
        type="search"
        value={discover.glossarySearch}
        oninput={(event) => discover.setGlossarySearch(event.currentTarget.value)}
        placeholder="Search terms"
        aria-label="Search glossary terms"
        data-testid="discover-glossary-search"
      />
    </div>

    {#if discover.filteredContexts.length === 0}
      <p class="empty">No glossary terms match the current search.</p>
    {:else}
      {#each discover.filteredContexts as context (context.boundedContext)}
        <section class="panel" data-testid="discover-context" data-context={context.boundedContext}>
          <div class="panel__header">
            <h2 class="panel__title">
              {labelText(context.titles) || context.boundedContext}
            </h2>
            <span class="muted">{context.concepts.length} terms</span>
          </div>
          <DataTable
            columns={GLOSSARY_COLUMNS}
            rows={context.concepts.map((concept) => ({
              ...concept,
              title: conceptTitle(concept),
              definition: labelText(concept.definitions) || "No definition recorded.",
              grounding: String(Array.isArray(concept.grounding) ? concept.grounding.length : 0),
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
            cellValue={(row, columnId) => {
              if (columnId === "grounding" || columnId === "id") return String(row[columnId] ?? "");
              return String(row[columnId] ?? "");
            }}
          />
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
        <DetailSplit id={`discover-skill-${activeSkill}`} label="Skill preview">
          {#snippet main()}
            <div class="skill-editor">
              <div class="panel__header">
                <h2 class="panel__title">{skillTab.label}</h2>
                <div class="row-sm">
                  <span
                    class="badge"
                    data-testid="discover-skill-state"
                    data-state={skill?.state ?? "missing"}
                    data-tone={skill?.state === "missing" ? "error" : "success"}
                  >
                    {discover.skillStateLabel(skill?.state ?? "missing")}
                  </span>
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
          {/snippet}
          {#snippet detail()}
            <div class="panel" style="height: 100%;">
              <div class="panel__header"><h2 class="panel__title">Preview</h2></div>
              <div class="panel__body preview-pane" data-testid="discover-skill-preview">
                <AgentOutput text={skillDraft} />
              </div>
              {#if skill !== null && skill.baseline !== null && skillDraft !== skill.baseline}
                <div class="panel__header"><h2 class="panel__title">Your changes</h2></div>
                <div
                  class="diff-html"
                  class:d2h-dark-color-scheme={layout.theme === "dark"}
                  data-testid="discover-skill-diff"
                  style="max-height: 40%; overflow: auto;"
                >
                  {@html diffHtml(
                    unifiedDiff(activeSkill, skill.baseline, skillDraft),
                    DISCOVER_DIFF_OPTIONS,
                  )}
                </div>
              {/if}
            </div>
          {/snippet}
        </DetailSplit>
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
              <h2 class="panel__title">{conceptTitle(term.concept)}</h2>
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
                <dd>{term.glossary.boundedContext}</dd>
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
  <div class="scroll-column" data-testid="discover-panel" data-tab="warnings" aria-label="Discover warnings">
    <section class="panel">
      <div class="panel__header">
        <h2 class="panel__title">Warnings</h2>
        <span class="muted">{discover.displayedWarnings.length}</span>
      </div>
      <div class="panel__body panel__body--flush">
        {#each discover.displayedWarnings as warning, index (index)}
          <p class="sidebar-item" data-testid="discover-warning" style="cursor: default;">
            {warning}
          </p>
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
