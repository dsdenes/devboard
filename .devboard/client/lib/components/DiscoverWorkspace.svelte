<script lang="ts">
  import {
    conceptTitle,
    contextTitle,
    labelText,
    TABS,
  } from "../discover-format";
  import { DISCOVER_AGENTS } from "../../../lib/agent-registry.ts";
  import { discover } from "../discover.svelte";
  import { layout } from "../layout.svelte";
  import type { WorkspaceTab } from "../layout.svelte";
  import { discoverSuiteRunState } from "../run-state";
  import AgentActivityBar from "./AgentActivityBar.svelte";
  import DiscoverAgentCard from "./DiscoverAgentCard.svelte";
  import DataTable from "./DataTable.svelte";
  import DiscoverContribution from "./DiscoverContribution.svelte";
  import DiscoverOverview from "./DiscoverOverview.svelte";
  import Button from "./ui/button.svelte";
  import CommandButton from "./CommandButton.svelte";
  import Input from "./ui/input.svelte";
  import PageHeader from "./ui/page-header.svelte";

  interface Props {
    tab: WorkspaceTab | null;
  }

  let { tab }: Props = $props();

  const GLOSSARY_COLUMNS = [
    { id: "title", header: "Term", accessorKey: "title" },
    { id: "significance", header: "Significance", accessorKey: "significance" },
    { id: "definition", header: "Definition", accessorKey: "definition" },
    { id: "examples", header: "", accessorKey: "examples" },
  ];
  const GLOSSARY_WIDTHS = {
    title: "210px",
    significance: "104px",
    examples: "240px",
  };

  /** The suite stop's tooltip, the same on the Overview and on an agent page. */
  const SUITE_STOP_TITLE = "Stop the Run all sequence";

  const activeSkill = $derived(tab?.kind === "skill" ? tab.resourceId : null);
  const skillText = $derived(activeSkill === null ? "" : discover.skillText(activeSkill));
  const skillTab = $derived(
    activeSkill === null ? null : (TABS.find((entry) => entry.skill === activeSkill) ?? null),
  );
  const skillState = $derived(
    activeSkill === null ? "pending" : discover.skillState(activeSkill),
  );
  const skillStateTone = $derived(
    skillState === "generated"
      ? "success"
      : skillState === "edited"
        ? "warning"
        : skillState === "missing"
          ? "error"
          : "muted",
  );
  const skillStateLabel = $derived(
    skillState === "missing"
      ? "Live file missing"
      : skillState === "pending"
        ? "Not generated yet"
        : skillState,
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
  /** The glossary's identity line: the term count and the filter it reflects. */
  const glossarySubtitle = $derived(
    `${visibleTerms} of ${totalTerms} terms ${
      discover.glossaryHasScores && discover.glossarySignificantOnly
        ? `at or above a significance floor of ${discover.glossaryThreshold}`
        : discover.glossaryHasScores
          ? "with no significance floor applied"
          : "with no significance scores published"
    } across ${discover.contexts.length} ${
      discover.contexts.length === 1 ? "bounded context" : "bounded contexts"
    }.`,
  );

  /**
   * The agent whose work the open page reports: its own card, the Glossary
   * page's Glossary Agent, the Contribution page's Contribution Agent, or the
   * agent that owns a skill page. The Overview and the warnings page report the
   * seven-agent suite instead, and only the Overview runs it.
   */
  const ownerAgent = $derived.by((): string | null => {
    if (tab === null) return null;
    if (tab.kind === "agent") return tab.resourceId;
    if (tab.kind === "glossary") return "discover-glossary";
    if (tab.kind === "contribution") return "discover-contribution";
    if (tab.kind === "skill") {
      return DISCOVER_AGENTS.find((descriptor) => descriptor.skill === tab.resourceId)?.id ?? null;
    }
    return null;
  });
  const agentCard = $derived(ownerAgent === null ? null : discover.agent(ownerAgent));
  const agentRunActive = $derived(
    ownerAgent !== null && discover.active && discover.activeAgent === ownerAgent,
  );
  /**
   * The stop control an agent page renders. A Run all suite is one run, so
   * while it runs the control names the suite's stop even on the running
   * agent's own page; only a single agent's run says it stops that agent.
   * Both send the one `stopDiscover`, so neither names a command the server
   * does not serve.
   */
  const agentStopTitle = $derived(
    discover.runningAll ? SUITE_STOP_TITLE : "Stop this discovery agent",
  );
  const agentStopTestId = $derived(
    discover.runningAll ? "discover-stop" : "discover-agent-stop",
  );
  const barLabel = $derived(
    ownerAgent === null ? "Discover" : (discover.agent(ownerAgent)?.label ?? "Discovery agent"),
  );
  /**
   * The seven-agent suite's own run state, the same source the sidebar's
   * Overview entry reads. The Overview and the warnings page report the suite,
   * so one agent's run never paints their bar running.
   */
  const suiteState = $derived(
    discoverSuiteRunState(
      discover.runningAll,
      discover.allFailed !== null,
      discover.question !== null,
    ),
  );
  const barState = $derived(
    ownerAgent !== null
      ? (agentCard?.state ?? "idle")
      : suiteState === "answer"
        ? ("running" as const)
        : suiteState,
  );
  const barStartedAt = $derived(
    barState === "running"
      ? ownerAgent !== null
        ? (agentCard?.startedAt ?? null)
        : discover.runningAll
          ? discover.startedAt
          : null
      : null,
  );
  const barActivity = $derived(
    ownerAgent !== null
      ? agentRunActive
        ? discover.activity
        : []
      : discover.runningAll
        ? discover.activity
        : [],
  );
  const barQuestion = $derived(
    ownerAgent !== null
      ? discover.agentQuestionOf(ownerAgent)
      : discover.runningAll
        ? discover.question
        : null,
  );

  function clearGlossaryFilters(): void {
    discover.resetGlossaryFilters();
  }
</script>

{#snippet glossaryCell(row: Record<string, unknown>, columnId: string)}
  {#if columnId === "title"}
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
  {#if discover.noticeError !== null || discover.interrupted}
    <div class="discover-notices">
      {#if discover.noticeError !== null}
        <p class="message" data-severity="error" data-testid="discover-error" role="alert">
          {discover.noticeError}
        </p>
      {/if}
      {#if discover.interrupted}
        <p class="message" data-severity="warning" data-testid="discover-interrupted">
          The last Discover run was interrupted. Nothing was published; the previous artifacts are
          unchanged.
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
    <PageHeader flat titleWrap wideActions title="Glossary" subtitle={glossarySubtitle}>
      {#snippet actions()}
        <div class="discover-glossary-controls">
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
      {/snippet}
    </PageHeader>

    {#if discover.contexts.length === 0}
      <section class="panel">
        <div class="panel__body">
          <p class="empty" data-testid="discover-glossary-unpublished">
            No glossary is published. Start the Glossary Agent to collect one.
          </p>
        </div>
      </section>
    {:else if discover.filteredContexts.length === 0}
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
      <PageHeader flat titleWrap title={skillTab.label} testid="discover-skill-header" />

      <div class="discover-skill" data-testid="discover-skill" data-name={activeSkill}>
        <div class="panel discover-skill__panel">
          <div class="panel__header discover-skill__header">
            <div class="discover-skill__identity">
              <h2
                class="panel__title mono discover-skill__title"
                title={`${activeSkill}/SKILL.md`}
              >
                <span class="code-chip discover-skill__path">
                  <span class="discover-skill__name">{activeSkill}</span><span
                    class="discover-skill__file">/SKILL.md</span
                  >
                </span>
              </h2>
            </div>
            <span
              class="discover-skill__state"
              data-testid="discover-skill-state"
              data-state={skillState}
              data-tone={skillStateTone}
            >
              <span class="discover-skill__state-dot" aria-hidden="true"></span>
              <span class="discover-skill__state-word">{skillStateLabel}</span>
            </span>
          </div>
          <div class="grow discover-skill__body">
            {#if skillState === "pending"}
              <p class="empty discover-skill__pending" data-testid="discover-skill-pending">
                No Discover agent has generated this file yet. Start the agent above to create it.
              </p>
            {:else}
              <pre class="discover-skill__text mono" data-testid="discover-skill-text" aria-label={`${activeSkill} skill text`}>{skillText}</pre>
            {/if}
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
    <PageHeader
      flat
      titleWrap
      title="Warnings"
      subtitle={`${discover.displayedWarnings.length} ${
        discover.displayedWarnings.length === 1 ? "warning" : "warnings"
      } recorded while validating the published artifacts.`}
      testid="discover-warnings-header"
    />

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
  {#if tab !== null &&
    ["overview", "glossary", "contribution", "skill", "warnings", "agent"].includes(tab.kind)}
    <AgentActivityBar
      identity={`${layout.mode}:${tab.id}`}
      label={barLabel}
      status={barState}
      activity={barActivity}
      startedAt={barStartedAt}
      waiting={barQuestion !== null}
    >
      {#snippet control()}
        {#if ownerAgent !== null}
          {#if agentRunActive}
            <CommandButton
              bare
              type="button"
              class="discover-run__stop"
              label="Stop"
              evidence={() => discover.active}
              command={() => discover.stop()}
              data-testid={agentStopTestId}
              data-command="discover.stop"
              title={agentStopTitle}
            >
              Stop
            </CommandButton>
          {:else}
            <CommandButton
              variant="default"
              label={(agentCard?.state ?? "idle") === "idle" ? "Start" : "Re-run"}
              busyLabel={(agentCard?.state ?? "idle") === "idle"
                ? "Starting…"
                : "Re-running…"}
              evidence={() => discover.agent(ownerAgent)?.state}
              scope={() => ownerAgent}
              command={() => discover.startAgent(ownerAgent)}
              data-command={`discover.agent.start.${ownerAgent}`}
              data-testid="discover-agent-start"
              disabled={discover.agentStartDisabled(ownerAgent)}
              title={discover.agentStartTitle(ownerAgent)}
            >
              {(agentCard?.state ?? "idle") === "idle" ? "Start" : "Re-run"}
            </CommandButton>
          {/if}
        {:else if tab.kind === "overview"}
          {#if discover.runningAll}
            <CommandButton
              bare
              type="button"
              class="discover-run__stop"
              label="Stop"
              evidence={() => discover.runningAll}
              command={() => discover.stop()}
              data-command="discover.stop"
              data-testid="discover-stop"
              title={SUITE_STOP_TITLE}
            >
              Stop
            </CommandButton>
          {:else}
            <CommandButton
              variant="default"
              label={discover.hasArtifacts ? "Re-discover" : "Discover project"}
              evidence={() => discover.active}
              command={() => discover.start()}
              data-command="discover.start"
              data-testid="discover-start"
              disabled={discover.startDisabled}
              title={discover.startTitle}
            >
              {discover.hasArtifacts ? "Re-discover" : "Discover project"}
            </CommandButton>
          {/if}
        {/if}
      {/snippet}
    </AgentActivityBar>
  {/if}
  {@render notices()}

  {#if tab === null}
    <p class="empty">No page is open. Choose Overview or Glossary from the sidebar.</p>
  {:else if tab.kind === "overview"}
    <DiscoverOverview />
  {:else if tab.kind === "glossary"}
    {@render glossaryPanel()}
  {:else if tab.kind === "contribution"}
    <DiscoverContribution />
  {:else if tab.kind === "skill"}
    {@render skillPanel()}
  {:else if tab.kind === "warnings"}
    {@render warningsPanel()}
  {:else if tab.kind === "agent"}
    <DiscoverAgentCard agent={tab.resourceId} />
  {/if}
</div>
