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
  import type { Concept } from "../types";
  import ConceptKind from "./ConceptKind.svelte";
  import DataTable from "./DataTable.svelte";
  import DetailSplit from "./DetailSplit.svelte";
  import DiscoverOverview from "./DiscoverOverview.svelte";
  import MonacoEditor from "./MonacoEditor.svelte";
  import Button from "./ui/button.svelte";

  interface Props {
    tab: WorkspaceTab | null;
    openTab: (tab: WorkspaceTab) => void;
  }

  let { tab, openTab }: Props = $props();

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

  function openTerm(context: string, concept: Concept): void {
    openTab({
      id: `term:${context}:${concept.id}`,
      kind: "term",
      resourceId: `${context}:${concept.id}`,
      title: conceptTitle(concept),
    });
  }
</script>

{#snippet glossaryCell(row: Record<string, unknown>, columnId: string)}
  {#if columnId === "kind"}
    <ConceptKind kind={String(row.kind ?? "")} />
  {:else}
    {String(row[columnId] ?? "")}
  {/if}
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
              cell={glossaryCell}
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
