<script lang="ts">
  import {
    conceptTitle,
    contextTitle,
    labelText,
    labelTexts,
    SKILL_PURPOSE,
    TABS,
  } from "../discover-format";
  import { discover } from "../discover.svelte";
  import type { WorkspaceTab } from "../layout.svelte";
  import type { Concept } from "../types";
  import ConceptKind from "./ConceptKind.svelte";
  import DataTable from "./DataTable.svelte";
  import DetailSplit from "./DetailSplit.svelte";
  import DiscoverOverview from "./DiscoverOverview.svelte";
  import MonacoEditor from "./MonacoEditor.svelte";
  import Button from "./ui/button.svelte";
  import Input from "./ui/input.svelte";

  interface Props {
    tab: WorkspaceTab | null;
    openTab: (tab: WorkspaceTab) => void;
  }

  let { tab, openTab }: Props = $props();

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
  const skillStateLabel = $derived(
    skillState === "generated" ? "Generated" : skillState === "edited" ? "Edited" : "Missing",
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
  const termUsage = $derived(
    term === null
      ? null
      : discover.usageFor(term.glossary.boundedContext, term.concept.id),
  );
  const termSignificance = $derived(
    term === null
      ? null
      : discover.significanceFor(term.glossary.boundedContext, term.concept.id),
  );
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

  function openTerm(context: string, concept: Concept): void {
    openTab({
      id: `term:${context}:${concept.id}`,
      kind: "term",
      resourceId: `${context}:${concept.id}`,
      title: conceptTitle(concept),
    });
  }

  function backToGlossary(): void {
    openTab({
      id: "glossary",
      kind: "glossary",
      resourceId: "glossary",
      title: "Glossary",
    });
  }

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
            <code>{example}</code>
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
        <label class="discover-threshold">
          <input
            type="checkbox"
            checked={discover.glossarySignificantOnly}
            disabled={!discover.glossaryHasScores}
            aria-label="Significant only"
            data-testid="discover-glossary-significant"
            onchange={(event) => discover.setGlossarySignificantOnly(event.currentTarget.checked)}
          />
          <span class="discover-threshold__label">Significant only</span>
        </label>
        <label class="discover-threshold">
          <span class="discover-threshold__label">Floor</span>
          <input
            class="discover-threshold__input"
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
          <output class="discover-threshold__value">≥ {discover.glossaryThreshold}</output>
        </label>
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
              rowCommand={(row) =>
                `discover.term.open.${context.boundedContext}.${String(row.id ?? "")}`}
              onRowActivate={(row) => {
                const concept = context.concepts.find((entry) => entry.id === row.id);
                if (concept !== undefined) openTerm(context.boundedContext, concept);
              }}
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
          <span class="discover-page__eyebrow">Policy skill</span>
          <h1 class="discover-page__title">{skillTab.label}</h1>
          <p class="discover-skill__meta">
            <span
              class="badge"
              data-tone={skillState === "generated"
                ? "success"
                : skillState === "edited"
                  ? "warning"
                  : "error"}
            >
              {skillStateLabel}
            </span>
            <code>{activeSkill}/SKILL.md</code>
            <span class="muted">{SKILL_PURPOSE[activeSkill] ?? ""}</span>
          </p>
        </div>
      </header>

      <div class="discover-skill" data-testid="discover-skill" data-name={activeSkill}>
        <div class="panel discover-skill__panel">
          <div class="panel__header">
            <div class="discover-skill__heading">
              <h2 class="panel__title">SKILL.md</h2>
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

{#snippet termPanel()}
  {#if term === null}
    <div class="scroll-column discover-page" data-testid="discover-panel" data-tab="glossary">
      <p class="empty">This glossary term is no longer listed. Return to the glossary to choose
        another term.</p>
      <div><Button variant="outline" onclick={backToGlossary}>Back to glossary</Button></div>
    </div>
  {:else}
    <div
      class="discover-term-page"
      data-testid="discover-panel"
      data-tab="glossary"
      aria-label="Glossary term"
    >
      <header class="discover-page__header discover-page__header--compact">
        <div class="discover-page__heading">
          <button
            type="button"
            class="discover-back"
            data-command="discover.tab.glossary"
            onclick={backToGlossary}
          >
            ← Glossary
          </button>
          <span class="discover-page__eyebrow">
            {contextTitle(term.glossary)} · {term.concept.kind}
          </span>
          <h1 class="discover-page__title">{conceptTitle(term.concept)}</h1>
        </div>
      </header>

      <DetailSplit id="discover-term" label="Term detail" defaultSplit={58}>
        {#snippet main()}
          <section
            class="panel"
            data-testid="discover-term"
            data-context={term.glossary.boundedContext}
            data-id={term.concept.id}
            data-status={term.concept.status}
            data-kind={term.concept.kind}
          >
            <div class="panel__header">
              <h2 class="panel__title">Definition</h2>
              <span class="panel__subtitle">{term.concept.status}</span>
            </div>
            <div class="panel__body stack-sm">
              <p class="discover-term-definition">
                {labelText(term.concept.definitions) || "No definition recorded."}
              </p>
              <dl class="discover-facts">
                <div class="discover-fact">
                  <dt>Uses</dt>
                  <dd data-testid="discover-term-uses">
                    {termUsage?.count ?? 0} in {termUsage?.files ?? 0}
                    {(termUsage?.files ?? 0) === 1 ? "file" : "files"}
                  </dd>
                </div>
                <div class="discover-fact">
                  <dt>Significance</dt>
                  <dd data-testid="discover-term-significance">
                    {#if termSignificance === null}
                      <span class="muted">—</span>
                    {:else}
                      <span>{termSignificance.score}</span>
                      <span class="muted">{termSignificance.reason}</span>
                    {/if}
                  </dd>
                </div>
                <div class="discover-fact">
                  <dt>Examples</dt>
                  <dd>
                    {#if termUsage !== null && termUsage.examples.length > 0}
                      <span class="discover-examples">
                        {#each termUsage.examples as example, index (example)}
                          <span class="discover-examples__item">
                            <code>{example}</code>
                            {#if index < termUsage.examples.length - 1}<span aria-hidden="true">,</span>{/if}
                          </span>
                        {/each}
                      </span>
                    {:else}
                      <span class="muted">—</span>
                    {/if}
                  </dd>
                </div>
                <div class="discover-fact">
                  <dt>Kind</dt>
                  <dd>{term.concept.kind}</dd>
                </div>
                <div class="discover-fact">
                  <dt>Bounded context</dt>
                  <dd>{contextTitle(term.glossary)}</dd>
                </div>
              </dl>
            </div>
          </section>
        {/snippet}
        {#snippet detail()}
          <section class="panel">
            <div class="panel__header">
              <h2 class="panel__title">Context &amp; usage</h2>
            </div>
            <div class="panel__body stack-sm">
              <div>
                <div class="field__label">Preferred labels</div>
                <p class="discover-detail-value">
                  {labelTexts(term.concept.prefLabels).join(" · ") || "None recorded."}
                </p>
              </div>
              {#if term.concept.altLabels !== undefined}
                <div>
                  <div class="field__label">Alternate labels</div>
                  <p class="discover-detail-value">
                    {labelTexts(term.concept.altLabels).join(" · ") || "None recorded."}
                  </p>
                </div>
              {/if}
              <div>
                <div class="field__label">Used in</div>
                <p class="discover-detail-value">
                  {termUsage?.files ?? 0} {(termUsage?.files ?? 0) === 1 ? "file" : "files"} with
                  {termUsage?.count ?? 0} {(termUsage?.count ?? 0) === 1 ? "use" : "uses"}
                </p>
              </div>
              <div>
                <div class="field__label">Related terms</div>
                <div class="discover-related">
                  {#each term.glossary.concepts.filter((entry) => entry.id !== term.concept.id) as concept (concept.id)}
                    <button
                      type="button"
                      class="sidebar-item"
                      data-command={`discover.term.open.${term.glossary.boundedContext}.${concept.id}`}
                      onclick={() => openTerm(term.glossary.boundedContext, concept)}
                    >
                      <span class="sidebar-item__label">{conceptTitle(concept)}</span>
                      <span class="sidebar-item__meta">{concept.kind}</span>
                    </button>
                  {:else}
                    <p class="discover-detail-value muted">No related terms in this context.</p>
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
  {:else if tab.kind === "term"}
    {@render termPanel()}
  {:else if tab.kind === "warnings"}
    {@render warningsPanel()}
  {/if}
</div>
