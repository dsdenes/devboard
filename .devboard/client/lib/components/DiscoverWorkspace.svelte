<script lang="ts">
  import {
    conceptTitle,
    contextTitle,
    labelText,
    labelTexts,
    TABS,
  } from "../discover-format";
  import { discover } from "../discover.svelte";
  import type { WorkspaceTab } from "../layout.svelte";
  import ConceptKind from "./ConceptKind.svelte";
  import DataTable from "./DataTable.svelte";
  import DiscoverOverview from "./DiscoverOverview.svelte";
  import MonacoEditor from "./MonacoEditor.svelte";
  import Button from "./ui/button.svelte";
  import Input from "./ui/input.svelte";

  interface Props {
    tab: WorkspaceTab | null;
  }

  let { tab }: Props = $props();

  const GLOSSARY_COLUMNS = [
    { id: "kind", header: "Kind", accessorKey: "kind" },
    { id: "title", header: "Term", accessorKey: "title" },
    { id: "significance", header: "Significance", accessorKey: "significance" },
    { id: "definition", header: "Definition", accessorKey: "definition" },
    { id: "examples", header: "", accessorKey: "examples" },
  ];
  const GLOSSARY_WIDTHS = {
    kind: "92px",
    title: "210px",
    significance: "104px",
    examples: "240px",
  };

  const activeSkill = $derived(tab?.kind === "skill" ? tab.resourceId : null);
  const skill = $derived(activeSkill === null ? null : discover.skill(activeSkill));
  const skillDraft = $derived(activeSkill === null ? "" : discover.skillDraft(activeSkill));
  const skillTab = $derived(
    activeSkill === null ? null : (TABS.find((entry) => entry.skill === activeSkill) ?? null),
  );
  const skillState = $derived(skill?.state ?? "missing");

  const totalTerms = $derived(
    discover.contexts.reduce(
      (total, context) =>
        total + context.concepts.filter((concept) => concept.status !== "invalidated").length,
      0,
    ),
  );
  const visibleTerms = $derived(
    discover.filteredContexts.reduce((total, context) => total + context.concepts.length, 0),
  );

  function clearGlossaryFilters(): void {
    discover.resetGlossaryFilters();
  }
</script>

{#snippet glossaryCell(row: Record<string, unknown>, columnId: string)}
  {#if columnId === "kind"}
    <ConceptKind kind={String(row.kind ?? "")} />
  {:else if columnId === "title"}
    <strong>{String(row.title ?? "")}</strong>
  {:else if columnId === "significance"}
    {#if typeof row.significance === "number"}
      <span title={String(row.significanceReason ?? "")}>{row.significance}</span>
    {:else}
      <span class="muted">—</span>
    {/if}
  {:else if columnId === "examples"}
    {#if Array.isArray(row.examples) && row.examples.length > 0}
      {@const examples = row.examples as string[]}
      <span class="discover-examples">
        {#each examples as example, index (example)}
          <span class="discover-examples__item">
            <code class="code-chip">{example}</code>
            {#if index < examples.length - 1}<span aria-hidden="true">,</span>{/if}
          </span>
        {/each}
      </span>
    {:else}
      <span class="muted">—</span>
    {/if}
  {:else}
    {String(row[columnId] ?? "")}
  {/if}
{/snippet}

{#snippet notices()}
  {#if discover.displayError !== null || discover.interrupted || discover.transition !== null}
    <div class="discover-notices">
      {#if discover.displayError !== null}
        <p class="message" data-severity="error" data-testid="discover-error" role="alert">
          {discover.displayError}
        </p>
      {/if}
      {#if discover.interrupted}
        <p class="message" data-severity="warning" data-testid="discover-interrupted">
          The last Discover run was interrupted. Nothing was published; the previous artifacts are
          unchanged.
        </p>
      {/if}
      {#if discover.transition !== null && !discover.active}
        <p class="message" data-severity="notice" data-testid="discover-transition" role="status">
          {discover.transition}
        </p>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet glossaryPanel()}
  <div
    class="scroll-column discover-page"
    data-testid="discover-panel"
    data-tab="glossary"
    aria-label="Discover glossary"
  >
    <header class="discover-page__header">
      <div class="discover-page__heading">
        <h1 class="discover-page__title">Glossary</h1>
        <p class="discover-page__subtitle">
          {visibleTerms} of {totalTerms} terms
          {#if discover.glossaryHasScores && discover.glossarySignificantOnly}
            at or above a significance floor of {discover.glossaryThreshold}
          {:else if discover.glossaryHasScores}
            with no significance floor applied
          {:else}
            with no significance scores published
          {/if}
          across {discover.contexts.length}
          {discover.contexts.length === 1 ? "bounded context" : "bounded contexts"}.
        </p>
      </div>
      <div class="discover-page__actions discover-glossary-controls">
        <Input
          id="discover-glossary-search"
          class="discover-search"
          type="search"
          value={discover.glossarySearch}
          oninput={(event) => discover.setGlossarySearch(event.currentTarget.value)}
          placeholder="Search terms"
          aria-label="Search glossary terms"
          data-testid="discover-glossary-search"
        />
        <div class="discover-glossary-filters">
          <label class="discover-toggle">
            <input
              type="checkbox"
              checked={discover.glossarySignificantOnly}
              disabled={!discover.glossaryHasScores}
              aria-label="Significant only"
              data-testid="discover-glossary-significant"
              onchange={(event) => discover.setGlossarySignificantOnly(event.currentTarget.checked)}
            />
            <span class="discover-toggle__track" aria-hidden="true"></span>
            <span class="discover-toggle__label">Significant only</span>
          </label>
          <span class="discover-glossary-divider" aria-hidden="true"></span>
          <label class="discover-floor">
            <span class="discover-floor__label">Floor</span>
            <input
              class="discover-floor__input"
              type="range"
              min="0"
              max="100"
              step="1"
              value={discover.glossaryThreshold}
              disabled={!discover.glossaryHasScores || !discover.glossarySignificantOnly}
              aria-label="Significance floor a term needs to be listed"
              data-testid="discover-glossary-threshold"
              oninput={(event) => discover.setGlossaryThreshold(event.currentTarget.valueAsNumber)}
            />
            <output class="discover-floor__value">≥ {discover.glossaryThreshold}</output>
          </label>
        </div>
      </div>
    </header>

    {#if discover.filteredContexts.length === 0}
      <section class="panel discover-filter-empty" data-testid="discover-glossary-empty">
        <div class="panel__body discover-filter-empty__body">
          <p class="empty">
            No term matches the current search and significance filter. The glossary is published;
            only this view is filtered.
          </p>
          <Button variant="outline" onclick={clearGlossaryFilters}>Clear filters</Button>
        </div>
      </section>
    {:else}
      {#each discover.filteredContexts as context (context.boundedContext)}
        <section
          class="panel discover-card"
          data-testid="discover-context"
          data-context={context.boundedContext}
        >
          <div class="panel__header">
            <h2 class="panel__title">{contextTitle(context)}</h2>
            <span class="panel__subtitle">
              {context.concepts.length} {context.concepts.length === 1 ? "term" : "terms"}
            </span>
          </div>
          <div class="panel__body panel__body--flush">
            <DataTable
              columns={GLOSSARY_COLUMNS}
              rows={context.concepts.map((concept) => {
                const usage = discover.usageFor(context.boundedContext, concept.id);
                const score = discover.significanceFor(context.boundedContext, concept.id);
                return {
                  ...concept,
                  title: conceptTitle(concept),
                  definition: labelText(concept.definitions) || "No definition recorded.",
                  significance: score?.score ?? null,
                  significanceReason: score?.reason ?? "",
                  examples: usage.examples,
                };
              })}
              rowTestId="discover-term"
              rowAttrs={(row) => ({
                "data-context": context.boundedContext,
                "data-id": String(row.id ?? ""),
                "data-status": String(row.status ?? ""),
                "data-kind": String(row.kind ?? ""),
                "data-significance":
                  typeof row.significance === "number" ? String(row.significance) : "",
                "data-examples": Array.isArray(row.examples) ? row.examples.join(",") : "",
              })}
              cell={glossaryCell}
              columnWidths={GLOSSARY_WIDTHS}
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
    <div
      class="discover-skill-page"
      data-testid="discover-panel"
      data-tab={skillTab.id}
      aria-label={skillTab.label}
    >
      <header class="discover-page__header discover-page__header--compact">
        <div class="discover-page__heading">
          <h1 class="discover-page__title">{skillTab.label}</h1>
        </div>
      </header>

      <div class="discover-skill" data-testid="discover-skill" data-name={activeSkill}>
        <div class="panel discover-skill__panel">
          <div class="panel__header discover-skill__header">
            <div class="discover-skill__identity">
              <span class="discover-skill__eyebrow">Skill file</span>
              <h2 class="panel__title">SKILL.md</h2>
              <div class="discover-skill__meta">
                <code class="code-chip">{activeSkill}</code>
                <span
                  class="badge"
                  data-tone={discover.skillDirty(activeSkill)
                    ? "warning"
                    : skillState === "missing"
                      ? "error"
                      : skillState === "edited"
                        ? "warning"
                        : "success"}
                  data-testid={discover.skillDirty(activeSkill)
                    ? "discover-skill-dirty"
                    : "discover-skill-state"}
                >
                  {discover.skillDirty(activeSkill)
                    ? "Unsaved changes"
                    : skillState === "missing"
                      ? "Missing"
                      : skillState === "edited"
                        ? "Edited"
                        : "Generated"}
                </span>
              </div>
            </div>
            <div class="row-sm discover-skill__actions">
              <Button
                variant="default"
                data-command={`discover.skill.save.${activeSkill}`}
                data-testid="discover-skill-save"
                disabled={!discover.skillDirty(activeSkill)}
                onclick={() => discover.saveSkill(activeSkill)}
              >
                Save
              </Button>
              {#if skillState !== "generated"}
                <Button
                  variant="outline"
                  data-command={`discover.skill.restore.${activeSkill}`}
                  data-testid="discover-skill-restore"
                  title={skillState === "missing"
                    ? "Recreate the skill from its generated version."
                    : "Discard your edits and return to the generated version."}
                  onclick={() => discover.restoreSkill(activeSkill)}
                >
                  {skillState === "missing" ? "Recreate generated version" : "Discard edits"}
                </Button>
              {/if}
            </div>
          </div>
          <div class="grow">
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

{#snippet warningsPanel()}
  <div
    class="scroll-column discover-page"
    data-testid="discover-panel"
    data-tab="warnings"
    aria-label="Discover warnings"
  >
    <header class="discover-page__header">
      <div class="discover-page__heading">
        <h1 class="discover-page__title">Warnings</h1>
        <p class="discover-page__subtitle">
          {discover.displayedWarnings.length}
          {discover.displayedWarnings.length === 1 ? "warning" : "warnings"} recorded while
          validating the published artifacts.
        </p>
      </div>
    </header>

    <section class="panel">
      <div class="panel__header">
        <h2 class="panel__title">Artifact warnings</h2>
      </div>
      <div class="panel__body panel__body--flush">
        {#if discover.displayedWarnings.length === 0}
          <p class="empty">No warnings. The published artifacts validated cleanly.</p>
        {:else}
          <ol class="discover-warning-list">
            {#each discover.displayedWarnings as warning, index (index)}
              <li class="discover-warning" data-testid="discover-warning">{warning}</li>
            {/each}
          </ol>
        {/if}
      </div>
    </section>
  </div>
{/snippet}

<div class="mode-body discover-body">
  {@render notices()}

  {#if tab === null}
    <p class="empty">No page is open. Choose Overview or Glossary from the sidebar.</p>
  {:else if tab.kind === "overview"}
    <DiscoverOverview />
  {:else if tab.kind === "glossary"}
    {@render glossaryPanel()}
  {:else if tab.kind === "skill"}
    {@render skillPanel()}
  {:else if tab.kind === "warnings"}
    {@render warningsPanel()}
  {/if}
</div>
