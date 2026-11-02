<script lang="ts">
  import { createCommandBusy } from "../command-busy.svelte";
  import { connection } from "../connection.svelte";
  import { goal } from "../goal.svelte";
  import { layout } from "../layout.svelte";
  import ChevronRight from "lucide-svelte/icons/chevron-right";
  import Trash2 from "lucide-svelte/icons/trash-2";
  import type { WorkspaceTab } from "../layout.svelte";
  import { recordStatusTone } from "../record-status";
  import { renderSkillDocument } from "../skill-document";
  import { statusTone } from "../status-tone";
  import type { AdrRecord, Lane } from "../types";
  import AdrTable from "./AdrTable.svelte";
  import AgentActivityBar from "./AgentActivityBar.svelte";
  import CommandButton from "./CommandButton.svelte";
  import CommandNotice from "./CommandNotice.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import Terminal from "./Terminal.svelte";
  import Button from "./ui/button.svelte";
  import Input from "./ui/input.svelte";
  import PageHeader from "./ui/page-header.svelte";
  import StageTrack from "./ui/stage-track.svelte";

  interface Props {
    tab: WorkspaceTab | null;
    openTab: (tab: WorkspaceTab) => void;
    closeTab: (tab: WorkspaceTab) => void;
  }

  let { tab, openTab, closeTab }: Props = $props();

  type FilterMode = "all" | "pending" | "resolved";
  let filterMode = $state<FilterMode>("all");
  let filterQuery = $state("");
  let skillsTable = $state<HTMLTableElement | undefined>();
  let deleteTarget = $state<string | null>(null);

  const answerPending = createCommandBusy({
    label: "Submit answer",
    evidence: () => goal.activity.length,
  });
  const laneAnswerPending = createCommandBusy({
    label: "Submit answer",
    evidence: () => goal.activity.length,
  });

  function skillPanelId(name: string): string {
    return `skill-content-${name.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  }

  const createGoalTitle = $derived(
    goal.creationActive
      ? "Restart goal creation."
      : goal.goalReady
        ? "Start a new goal creation and replace the current goal."
        : goal.running || goal.lifecycleActive || goal.revisionActive
          ? "Stop the active run and start goal creation."
          : "Start goal creation.",
  );

  const runStartTitle = $derived(
    goal.lifecycleActive
      ? "Interrupt the lifecycle and resolve the ADRs manually."
      : undefined,
  );

  const resolvedCount = $derived(goal.records.filter((record) => !record.pending).length);
  const pendingCount = $derived(goal.pendingCount);
  const progressLine = $derived(
    `${resolvedCount} of ${goal.records.length} resolved · ${pendingCount} ADR${
      pendingCount === 1 ? "" : "s"
    } pending`,
  );
  const query = $derived(filterQuery.trim().toLowerCase());
  const filteredRecords = $derived(
    goal.records.filter((record) => {
      if (filterMode === "pending" && !record.pending) return false;
      if (filterMode === "resolved" && record.pending) return false;
      if (query.length === 0) return true;
      return [record.title, record.file, record.summary, record.status]
        .join(" ")
        .toLowerCase()
        .includes(query);
    }),
  );

  const lane = $derived(tab?.kind === "lane" ? goal.lane(tab.resourceId) : null);
  const record = $derived(
    tab?.kind === "adr" ? (goal.records.find((entry) => entry.file === tab?.resourceId) ?? null) : null,
  );

  const laneBarState = $derived(
    lane === null
      ? ("idle" as const)
      : lane.status === "running" || lane.status === "retrying"
        ? ("running" as const)
        : lane.status === "failed"
          ? ("failed" as const)
          : ("idle" as const),
  );
  const laneStartedAt = $derived(
    lane === null || laneBarState !== "running" ? null : (goal.laneStartedAt[lane.id] ?? null),
  );
  const recordRunActive = $derived(
    record !== null && goal.running && goal.runFile === record.file,
  );
  const recordBarState = $derived(recordRunActive ? ("running" as const) : ("idle" as const));
  const recordActivity = $derived(recordRunActive ? goal.activity : []);
  const recordQuestion = $derived(recordRunActive ? goal.question : null);

  const filters: Array<{ id: FilterMode; label: string }> = [
    { id: "all", label: "All" },
    { id: "pending", label: "Pending" },
    { id: "resolved", label: "Resolved" },
  ];

  const operationText = $derived(
    goal.creationActive
      ? "Creating the goal"
      : goal.revisionActive
        ? "Revising the goal"
        : goal.skillsPrepActive
          ? "Preparing skills"
          : goal.running
            ? `Manual run: ${goal.runTitle ?? "ADR"}`
            : null,
  );

  const documentState = $derived(goal.goalReady ? "Read-only" : "Not written yet");

  const runActionLabel = $derived(
    goal.runAction === "implementing"
      ? "implementing"
      : goal.runAction === "generating"
        ? "generating an epic"
        : "resolving",
  );

  function openAdr(entry: AdrRecord): void {
    openTab({ id: `adr:${entry.file}`, kind: "adr", resourceId: entry.file, title: entry.title });
  }

  function openLane(entry: Lane): void {
    openTab({
      id: `lane:${entry.id}`,
      kind: "lane",
      resourceId: entry.id,
      title: goal.laneLabel(entry),
    });
  }

  function openOverview(): void {
    openTab({ id: "overview", kind: "overview", resourceId: "overview", title: "Implementation" });
  }

  function lanePanel(entry: Lane) {
    const activity = entry.activity;
    return {
      current: activity.length > 0 ? [activity[activity.length - 1] ?? ""] : [],
      history: activity.slice(0, -1),
      identity: goal.laneIdentity(entry),
      label: goal.laneLabel(entry),
    };
  }

  function submitAnswer(value: string): void {
    goal.submitAnswer(value);
  }

  function clearFilters(): void {
    filterMode = "all";
    filterQuery = "";
  }

  $effect(() => {
    if (tab?.kind !== "skills" || goal.selectedSkill === null) return;
    const selected = goal.selectedSkill;
    const item = [...(skillsTable?.querySelectorAll<HTMLElement>("[data-name]") ?? [])].find(
      (entry) => entry.dataset.name === selected,
    );
    item?.scrollIntoView({ block: "nearest" });
  });
</script>

<div class="mode-body">
{#if tab?.kind === "lane" && lane !== null}
  <AgentActivityBar
    identity={`${layout.mode}:${tab.id}`}
    label={goal.laneLabel(lane)}
    status={laneBarState}
    activity={lane.activity}
    startedAt={laneStartedAt}
    waiting={lane.question !== null}
  />
{:else if tab?.kind === "adr" && record !== null}
  {#if record.pending}
    <AgentActivityBar
      identity={`${layout.mode}:${tab.id}`}
      label={record.title}
      status={recordBarState}
      activity={recordActivity}
      startedAt={recordRunActive ? goal.runStartedAt : null}
      waiting={recordQuestion !== null}
    >
      {#snippet control()}
        <CommandButton
          variant="default"
          label="Start this record"
          evidence={() => goal.runState}
          command={() => goal.startRecord(record)}
          data-command={`goal.adr.start.${record.file}`}
          data-testid="start"
          data-file={record.file}
          title={runStartTitle}
          disabled={goal.runStartDisabled}
        >
          Start this record
        </CommandButton>
      {/snippet}
    </AgentActivityBar>
  {:else}
    <AgentActivityBar
      identity={`${layout.mode}:${tab.id}`}
      label={record.title}
      status={recordBarState}
      activity={recordActivity}
      startedAt={recordRunActive ? goal.runStartedAt : null}
      waiting={recordQuestion !== null}
    />
  {/if}
{/if}
{#snippet runQuestion()}
  {#if goal.question !== null}
    {@const pending = goal.question}
    <section class="panel goal-question" data-testid="question">
      <div class="panel__header">
        <h2 class="panel__title">Waiting on you</h2>
        <span class="badge" data-tone="accent">run blocked</span>
      </div>
      <div class="panel__body stack-sm">
        <p class="muted" style="margin: 0;">{pending.message}</p>
        {#if pending.options.length > 0}
          <div class="choice-list">
            {#each pending.options as option (option.label)}
              <CommandButton
                bare
                type="button"
                class="choice"
                label={option.label}
                busyLabel="Answering…"
                evidence={() => goal.activity.length}
                command={() => submitAnswer(option.label)}
                data-testid="choice"
                data-command="goal.answer.submit"
              >
                <span class="choice__label">
                  {option.label}
                  {#if option.recommended}
                    <span class="choice__recommended" data-testid="recommended">Recommended</span>
                  {/if}
                </span>
                {#if option.description}
                  <span class="choice__description">{option.description}</span>
                {/if}
              </CommandButton>
            {/each}
          </div>
        {/if}
        <form
          class="answer-form"
          onsubmit={(event) => {
            event.preventDefault();
            if (goal.draft.trim().length === 0) return;
            answerPending.start();
            goal.submitAnswer(goal.draft);
          }}
        >
          <input
            id="goal-answer-input"
            class="goal-answer-input"
            style="min-height: 28px; padding: 4px 8px;"
            type="text"
            bind:value={goal.draft}
            placeholder="Your answer"
            aria-label="Your answer"
            data-testid="answer-input"
          />
          <Button
            variant="default"
            type="submit"
            label="Submit answer"
            busy={answerPending.busy}
            data-command="goal.answer.submit"
            data-testid="submit-answer"
            disabled={goal.draft.trim().length === 0}
          >
            Submit answer
          </Button>
        </form>
        {#if answerPending.notice !== null}
          <CommandNotice
            text={answerPending.notice}
            ondismiss={() => answerPending.dismiss()}
          />
        {/if}
      </div>
    </section>
  {/if}
{/snippet}

  {#if tab !== null && tab.kind !== "overview" && goal.question !== null}
    <div class="goal-global-question">{@render runQuestion()}</div>
  {/if}

  {#if tab === null}
    <div class="goal-page">
      <section class="panel goal-empty-state" data-testid="no-open-page">
        <div class="panel__body stack-sm">
          <h1 class="goal-empty-state__title">No page is open</h1>
          <p class="empty" style="padding: 0;">
            Choose a surface from the sidebar, or return to the lifecycle console.
          </p>
          <div class="row-sm">
            <Button
              variant="default"
              data-command="open.goal.overview"
              onclick={openOverview}
            >
              Open implementation
            </Button>
          </div>
        </div>
      </section>
    </div>
  {:else if tab.kind === "overview"}
    <div class="goal-page goal-page--console" data-testid="goal-overview">
      {#if connection.lastError !== null || connection.upgradePending || operationText !== null || goal.runState === "stopped"}
        <div class="goal-notices" data-testid="goal-notices">
          {#if connection.lastError !== null}
            <p class="message" data-severity="error" role="alert">{connection.lastError}</p>
          {/if}
          {#if goal.creationActive}
            <p class="message" data-testid="goal-creation-active" data-severity="notice" role="status">
              Creating the goal. The document is being written by the agent.
            </p>
          {/if}
          {#if goal.revisionActive}
            <p class="message" data-testid="goal-revision-active" data-severity="notice" role="status">
              Revising the goal with your guidance.
            </p>
          {/if}
          {#if goal.skillsPrepActive}
            <p class="message" data-testid="skills-preparation-active" data-severity="notice" role="status">
              Preparing skills from the goal.
            </p>
          {/if}
          {#if goal.runState === "stopped" && !goal.lifecycleActive}
            <p class="message" data-testid="run-stopped" data-severity="notice" role="status">
              Run stopped. The last action is kept below.
            </p>
          {/if}
          {#if connection.upgradePending}
            <p class="message" data-testid="upgrade-pending" data-severity="notice" role="status">
              An update is waiting for the current work to finish. This dashboard restarts when it
              ends.
            </p>
          {/if}
        </div>
      {/if}

      <PageHeader
        title="Implementation"
        subtitle="Drive the lifecycle, or resolve a single decision record by hand."
        testid="implementation-header"
      >
        {#snippet meta()}
          <span class="muted" data-testid="pending-summary">
            {pendingCount} ADR{pendingCount === 1 ? "" : "s"} pending
          </span>
        {/snippet}
        {#snippet actions()}
          {#if goal.lifecycleActive}
            <CommandButton
              variant="secondary"
              label={goal.lifecycle.paused ? "Resume" : "Pause"}
              evidence={() => goal.lifecycle.paused}
              command={() =>
                goal.lifecycle.paused ? goal.resumeLifecycle() : goal.pauseLifecycle()}
              data-command={goal.lifecycle.paused ? "goal.lifecycle.resume" : "goal.lifecycle.pause"}
            >
              {goal.lifecycle.paused ? "Resume" : "Pause"}
            </CommandButton>
          {/if}
          <CommandButton
            variant="outline"
            label="Resolve next ADR"
            evidence={() => goal.runState}
            command={() => goal.startNext()}
            data-command="goal.adr.start-next"
            data-testid="start-next"
            title={runStartTitle}
            disabled={goal.runStartDisabled || goal.next === null}
          >
            Resolve next ADR
          </CommandButton>
          <Button
            variant="outline"
            data-command="goal.reset"
            data-testid="reset-implementation"
            disabled={goal.resetDisabled}
            onclick={() => goal.armReset()}
          >
            Reset implementation
          </Button>
          <CommandButton
            variant={goal.lifecycleActive ? "destructive" : "default"}
            label={goal.lifecycleActive ? "Stop implementation" : "Start implementation"}
            evidence={() => goal.lifecycleActive}
            command={() => goal.toggleLifecycle()}
            data-command="goal.lifecycle.toggle"
            data-testid="lifecycle-control"
            title={goal.lifecycleButtonTitle}
            disabled={goal.lifecycleButtonDisabled}
          >
            {goal.lifecycleActive ? "Stop implementation" : "Start implementation"}
          </CommandButton>
        {/snippet}
      </PageHeader>

      {#if goal.resetting || goal.resetStatus !== null}
        <p
          class="message"
          data-severity="warning"
          data-testid={goal.resetting ? "reset-running" : "reset-status"}
          role="status"
        >
          {goal.resetting ? "Resetting implementation…" : goal.resetStatus}
        </p>
      {/if}

      {@render runQuestion()}

      <section class="panel" data-testid="lifecycle">
        <div class="panel__header">
          <h2 class="panel__title">Lifecycle</h2>
        </div>
        <div class="panel__body">
          <StageTrack
            stage={goal.lifecycle.stage}
            pass={goal.lifecycle.pass}
            paused={goal.lifecycle.paused}
            seen={goal.lifecycleSeen || goal.lifecycleActive}
            workLabel={goal.running && !goal.lifecycleActive ? goal.runTitle : goal.lifecycleWorkTitle}
            workUrl={goal.running && !goal.lifecycleActive ? null : goal.lifecycleWorkUrl}
            manual={goal.running && !goal.lifecycleActive}
            testid="lifecycle-stages"
          />
        </div>
      </section>

      {#if goal.running && !goal.lifecycleActive}
        <section class="panel" data-testid="now">
          <div class="panel__body row-sm">
            <span class="muted">Manual run</span>
            <strong>{goal.runTitle ?? "ADR"}</strong>
            <span class="muted">{runActionLabel}</span>
          </div>
        </section>
      {/if}

      <section
        class="panel goal-activity"
        class:goal-activity--idle={goal.activity.length === 0 && !goal.activityActive}
        data-testid="activity"
      >
        <div class="panel__header">
          <h2 class="panel__title">Activity</h2>
          <span class="badge" data-tone={statusTone(goal.activityActive ? "running" : "idle")}>
            {goal.activityActive ? "live" : "idle"}
          </span>
        </div>
        {#if goal.activity.length === 0 && !goal.activityActive}
          <div class="panel__body" data-testid="activity-current-empty">
            <p class="empty" style="padding: 0;">
              The next action appears here. Start the lifecycle or resolve a record.
            </p>
          </div>
        {:else}
          <div class="panel__body term-split">
            <Terminal
              lines={[goal.currentAction]}
              data-testid="activity-current"
              label="Current activity"
            />
            {#if goal.previousActions.length > 0}
              <details class="activity-history">
                <summary data-testid="activity-history">{goal.previousActionsLabel}</summary>
                <div style="height: 140px;">
                  <Terminal
                    lines={goal.previousActions}
                    data-testid="activity-log"
                    label="Activity history"
                  />
                </div>
              </details>
            {/if}
          </div>
        {/if}
      </section>

    </div>
  {:else if tab.kind === "adrs"}
    <div class="goal-page">
      <PageHeader
        title="Decision records"
        testid="adrs-header"
      >
        {#snippet meta()}
          <span class="muted" data-testid="pending-summary">{progressLine}</span>
        {/snippet}
      </PageHeader>

      {#if goal.records.length === 0}
        <section class="panel" data-testid="adrs-overlay">
          <div class="panel__body stack-sm goal-empty-state">
            <h2 class="goal-empty-state__title">No decision records yet</h2>
            <p class="empty" style="padding: 0;">
              Records appear under <code>adrs/</code> when goal creation or the lifecycle writes them.
            </p>
            <div class="row-sm">
              <Button variant="default" data-command="open.goal.overview" onclick={openOverview}>
                Open implementation
              </Button>
            </div>
          </div>
        </section>
      {:else}
        <section class="panel goal-filters" aria-label="Record filters">
          <div class="panel__body goal-filters__body">
            <Input
              type="search"
              placeholder="Filter by title, file, or summary"
              aria-label="Filter decision records"
              data-testid="adr-search"
              value={filterQuery}
              oninput={(event) => (filterQuery = event.currentTarget.value)}
            />
            <div class="filter-chips" role="group" aria-label="Implementation state">
              {#each filters as entry (entry.id)}
                <Button
                  bare
                  type="button"
                  class="filter-chip"
                  aria-pressed={filterMode === entry.id}
                  data-testid={`adr-filter-${entry.id}`}
                  onclick={() => (filterMode = entry.id)}
                >
                  {entry.label}
                </Button>
              {/each}
              {#if filterMode !== "all" || filterQuery.trim().length > 0}
                <Button variant="ghost" size="sm" data-testid="clear-adr-filter" onclick={clearFilters}>
                  Clear
                </Button>
              {/if}
            </div>
          </div>
        </section>

        <section class="panel goal-adrs-panel" data-testid="adrs-overlay">
          <AdrTable
            records={filteredRecords}
            onopen={openAdr}
            onstart={(entry) => goal.startRecord(entry)}
          />
        </section>
      {/if}
    </div>
  {:else if tab.kind === "goal-document"}
    <div class="goal-page goal-page--fill">
      <PageHeader title="Goal document" subtitle={documentState} testid="document-header">
        {#snippet meta()}
          {#if operationText !== null}
            <span class="badge" data-tone="accent">{operationText}</span>
          {/if}
        {/snippet}
        {#snippet actions()}
          {#if goal.skills.length > 0}
            <Button
              variant="outline"
              data-command="goal.skills.open"
              data-testid="show-skills"
              onclick={() =>
                openTab({ id: "skills", kind: "skills", resourceId: "skills", title: "Skills" })}
            >
              Show skills ({goal.skills.length})
            </Button>
          {:else}
            <CommandButton
              variant="outline"
              label="Prepare skills"
              evidence={() => goal.skillsPrepActive}
              command={() => goal.prepareSkills()}
              data-command="goal.skills.prepare"
              data-testid="prepare-skills"
              disabled={goal.prepareDisabled}
            >
              Prepare skills
            </CommandButton>
          {/if}
          <CommandButton
            variant="secondary"
            label={goal.goalReady ? "Recreate goal" : "Create goal"}
            evidence={() => goal.creationActive}
            command={() => goal.createGoal()}
            data-command="goal.create"
            data-testid="create-goal"
            title={createGoalTitle}
            disabled={!connection.open}
          >
            {goal.goalReady ? "Recreate goal" : "Create goal"}
          </CommandButton>
        {/snippet}
      </PageHeader>

      <section class="panel goal-document" data-testid="goal-editor">
        <div class="panel__body goal-details">
          <pre class="goal-document__text mono" data-testid="goal-text" aria-label="Goal document">{goal.goalText}</pre>
        </div>
        <div class="panel__footer goal-revision">
          <div class="goal-revision__heading">
            <CommandButton
              variant="secondary"
              label="Revise goal"
              evidence={() => goal.revisionActive}
              command={() => goal.reviseGoal()}
              data-command="goal.revise"
              data-testid="revise-goal"
              disabled={goal.revisionDisabled}
            >
              Revise goal
            </CommandButton>
          </div>
          <p class="goal-revision__hint">
            Revision rewrites the document through the revision agent.
          </p>
        </div>
      </section>
    </div>
  {:else if tab.kind === "skills"}
    <div class="goal-page goal-page--fill">
      <PageHeader title="Skills" testid="skills-header">
        {#snippet meta()}
          {#if goal.contradictions.length > 0}
            <span class="badge" data-tone="error">
              {goal.contradictions.length} contradiction{goal.contradictions.length === 1 ? "" : "s"}
            </span>
          {/if}
        {/snippet}
        {#snippet actions()}
          <CommandButton
            variant="secondary"
            label="Prepare skills again"
            evidence={() => goal.skillsPrepActive}
            command={() => goal.prepareSkills()}
            data-command="goal.skills.prepare"
            data-testid="prepare-skills-overlay"
            disabled={goal.prepareDisabled}
          >
            Prepare skills again
          </CommandButton>
          <Button
            variant="outline"
            data-command={`tab.close.goal.${tab.id}`}
            data-testid="close-skills"
            onclick={() => closeTab(tab)}
          >
            Close
          </Button>
        {/snippet}
      </PageHeader>

      <section class="panel goal-skills" data-testid="skills-overlay">
        <div class="panel__header">
          <h2 class="panel__title">
            Prepared skills <span class="mono" data-testid="skills-count">{goal.skills.length}</span>
          </h2>
          <span class="muted">Read by implementing agents</span>
        </div>
        <div class="panel__body stack-sm">
          {#if goal.skills.length === 0}
            <p class="empty" style="padding: 0;">
              No skills prepared yet. Prepare them from the saved goal before starting implementation.
            </p>
          {:else}
            <table class="skill-table" data-testid="skills-table" bind:this={skillsTable}>
              <thead>
                <tr>
                  <th scope="col" class="skill-table__name-heading">Skill</th>
                  <th scope="col">Description</th>
                  <th scope="col" class="skill-table__actions-heading" aria-label="Actions"></th>
                </tr>
              </thead>
              <tbody>
                {#each goal.skills as skill (skill.name)}
                  {@const expanded = goal.selectedSkill === skill.name}
                  {@const panelId = skillPanelId(skill.name)}
                  {@const skillHtml =
                    skill.content === undefined ? "" : renderSkillDocument(skill.content)}
                  <tr
                    class="skill-table__row"
                    data-testid="skill"
                    data-name={skill.name}
                    data-selected={expanded}
                    aria-current={expanded ? "true" : undefined}
                    aria-expanded={expanded}
                    aria-controls={expanded ? panelId : undefined}
                    tabindex="0"
                    onclick={(event) => {
                      if ((event.target as HTMLElement).closest("button") !== null) return;
                      goal.selectSkill(expanded ? null : skill.name);
                    }}
                    onkeydown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        goal.selectSkill(expanded ? null : skill.name);
                      }
                    }}
                  >
                    <td class="skill-table__name">
                      <span class="mono skill__name">{skill.name}</span>
                      <ChevronRight
                        size={14}
                        aria-hidden="true"
                        class={expanded ? "skill__chevron skill__chevron--open" : "skill__chevron"}
                      />
                    </td>
                    <td class="skill-table__description">{skill.description}</td>
                    <td class="skill-table__actions">
                      {#if (skill.family ?? "prepare") === "prepare"}
                        <Button
                          bare
                          type="button"
                          class="skill__delete"
                          data-command={`goal.skills.delete.${skill.name}`}
                          data-testid="delete-skill"
                          data-name={skill.name}
                          aria-label={`Delete ${skill.name}`}
                          title={`Delete ${skill.name} from .omp/skills/`}
                          disabled={goal.skillDeleteDisabled}
                          onclick={() => (deleteTarget = skill.name)}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </Button>
                      {/if}
                    </td>
                  </tr>
                  {#if expanded}
                    <tr class="skill-table__detail-row" data-testid="skill-detail">
                      <td colspan="3" class="skill-table__detail-cell">
                        <div
                          class="skill__detail"
                          id={panelId}
                          data-testid="skill-content"
                          data-name={skill.name}
                          role="region"
                          aria-label={`${skill.name} content`}
                        >
                          <p class="skill__path" title={`.omp/skills/${skill.name}/SKILL.md`}>
                            .omp/skills/{skill.name}/SKILL.md
                          </p>
                          {#if skill.content !== undefined && skill.content.length > 0}
                            {#if skillHtml.length > 0}
                              <div class="skill__document" data-testid="skill-content-text">
                                {@html skillHtml}
                              </div>
                            {:else}
                              <p class="empty" style="padding: 0;">
                                This skill's file carries only preparation metadata; there are no
                                instructions to read.
                              </p>
                            {/if}
                          {:else}
                            <p class="empty" style="padding: 0;">
                              This skill has no file on disk; prepare the skills again to write it.
                            </p>
                          {/if}
                        </div>
                      </td>
                    </tr>
                  {/if}
                {/each}
              </tbody>
            </table>
          {/if}

          {#if goal.contradictions.length > 0}
            <ul class="history-list goal-contradictions" data-testid="skills-contradictions">
              {#each goal.contradictions as contradiction (`${contradiction.skills[0]}:${contradiction.skills[1]}`)}
                <li class="message" data-severity="warning">
                  <strong>{contradiction.skills[0]}</strong> and
                  <strong>{contradiction.skills[1]}</strong> state opposite policies:
                  “{contradiction.directives[0]}” vs “{contradiction.directives[1]}”.
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      </section>


    </div>
  {:else if tab.kind === "adr"}
    {#if record === null}
      <div class="goal-page">
        <section class="panel">
          <div class="panel__body stack-sm">
            <p class="empty" style="padding: 0;">This record is no longer listed.</p>
            <div class="row-sm">
              <Button
                variant="default"
                data-command="goal.adrs.open"
                onclick={() =>
                  openTab({ id: "adrs", kind: "adrs", resourceId: "adrs", title: "ADRs" })}
              >
                Back to records
              </Button>
            </div>
          </div>
        </section>
      </div>
    {:else}
      <div class="goal-page">
        <PageHeader eyebrow="Decision record" title={record.title} testid="record-header">
          {#snippet meta()}
            {#if goal.next === record.file}
              <span class="badge" data-tone="accent" data-testid="next-marker">Next</span>
            {/if}
            <span
              class="badge"
              data-tone={recordStatusTone(record.status)}
              data-testid="record-status"
            >
              {record.status || "Unknown"}
            </span>
          {/snippet}
          {#snippet actions()}
            <Button
              variant="outline"
              data-command="goal.adrs.open"
              data-testid="back-to-records"
              onclick={() =>
                openTab({ id: "adrs", kind: "adrs", resourceId: "adrs", title: "ADRs" })}
            >
              Back to records
            </Button>
            <Button
              variant="outline"
              data-command={`tab.close.goal.${tab.id}`}
              data-testid="close-record"
              onclick={() => closeTab(tab)}
            >
              Close
            </Button>
          {/snippet}
        </PageHeader>

        <section class="panel" data-testid="record-meta">
          <div class="panel__body">
            <dl class="kv-grid">
              <dt>File</dt>
              <dd><code data-testid="record-file">{record.file}</code></dd>
              <dt>Document status</dt>
              <dd>{record.status || "Unknown"}</dd>
              <dt>Implementation</dt>
              <dd>{record.pending ? "Pending" : "Resolved"}</dd>
            </dl>
          </div>
        </section>

        <section class="panel">
          <div class="panel__header">
            <h2 class="panel__title">Decision summary</h2>
          </div>
          <div class="panel__body">
            <p data-testid="record-summary" style="margin: 0;">
              {record.summary || "No decision summary recorded."}
            </p>
          </div>
        </section>

        {#if record.pending}
          <section class="panel" data-testid="record-action">
            <div class="panel__body">
              <span class="muted">
                Runs one record outside the lifecycle from the activity bar. Stop the lifecycle
                first when it is active.
              </span>
            </div>
          </section>
        {/if}
      </div>
    {/if}
  {:else if tab.kind === "lane"}
    {#if lane === null}
      <div class="goal-page">
        <section class="panel">
          <div class="panel__body stack-sm">
            <p class="empty" style="padding: 0;">This lane is no longer active.</p>
            <div class="row-sm">
              <Button variant="default" data-command="open.goal.overview" onclick={openOverview}>
                Back to implementation
              </Button>
            </div>
          </div>
        </section>
      </div>
    {:else}
      {@const panel = lanePanel(lane)}
      <div class="goal-page">
        <PageHeader eyebrow="Lane" title={panel.label} testid="lane-header">
          {#snippet meta()}
            <span class="muted">Attempt <span class="mono">{lane.attempt}</span></span>
          {/snippet}
          {#snippet actions()}
            <Button
              variant="outline"
              data-command={`tab.close.goal.${tab.id}`}
              data-testid="close-lane"
              onclick={() => closeTab(tab)}
            >
              Close
            </Button>
          {/snippet}
        </PageHeader>

        <section class="panel" data-testid="lane-panel" data-lane={lane.id}>
          <div class="panel__header">
            <p class="panel__title" data-testid="lane-identity">
              {#if panel.identity.text.length > 0}
                {panel.identity.text}{#if panel.identity.url !== null}{" — "}{/if}
              {/if}
              {#if panel.identity.url !== null}
                <a
                  href={panel.identity.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="lane-identity-link">{panel.identity.url}</a>
              {/if}
            </p>
          </div>
          <div class="panel__body">
            <dl class="kv-grid">
              <dt>Kind</dt>
              <dd>
                {lane.kind === "generation"
                  ? "Epic generation"
                  : lane.kind === "adr"
                    ? "ADR resolution"
                    : "Epic implementation"}
              </dd>
              <dt>Record</dt>
              <dd>
                {#if lane.record === null}
                  <span class="muted">—</span>
                {:else}
                  <code>{lane.record.file}</code>
                {/if}
              </dd>
              <dt>Epic</dt>
              <dd>
                {#if lane.epic === null}
                  <span class="muted">—</span>
                {:else}
                  #{lane.epic.number} {lane.epic.title}
                {/if}
              </dd>
            </dl>
          </div>
        </section>

        {#if lane.question !== null}
          {@const pending = lane.question}
          <section class="panel goal-question" data-testid="lane-question" data-lane={lane.id}>
            <div class="panel__header">
              <h2 class="panel__title">Waiting on you</h2>
              <span class="badge" data-tone="accent">lane blocked</span>
            </div>
            <div class="panel__body stack-sm">
              <p class="muted" style="margin: 0;">{pending.message}</p>
              {#if pending.options.length > 0}
                <div class="choice-list">
                  {#each pending.options as option (option.label)}
                    <CommandButton
                      bare
                      type="button"
                      class="choice"
                      label={option.label}
                      busyLabel="Answering…"
                      evidence={() => goal.activity.length}
                      command={() => goal.submitLaneAnswer(lane.id, option.label)}
                      data-testid="lane-choice"
                      data-command={`goal.lane.answer.submit.${lane.id}`}
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
                    </CommandButton>
                  {/each}
                </div>
              {/if}
              <form
                class="answer-form"
                onsubmit={(event) => {
                  event.preventDefault();
                  if (goal.laneDraft.trim().length === 0) return;
                  laneAnswerPending.start();
                  goal.submitLaneAnswer(lane.id, goal.laneDraft);
                }}
              >
                <input
                  id={`lane-answer-${lane.id}`}
                  class="goal-answer-input"
                  style="min-height: 28px; padding: 4px 8px;"
                  type="text"
                  bind:value={goal.laneDraft}
                  placeholder="Your answer"
                  aria-label="Your answer"
                  data-testid="lane-answer-input"
                />
                <Button
                  variant="default"
                  type="submit"
                  label="Submit answer"
                  busy={laneAnswerPending.busy}
                  data-command={`goal.lane.answer.submit.${lane.id}`}
                  data-testid="lane-submit-answer"
                  disabled={goal.laneDraft.trim().length === 0}
                >
                  Submit answer
                </Button>
              </form>
              {#if laneAnswerPending.notice !== null}
                <CommandNotice
                  text={laneAnswerPending.notice}
                  ondismiss={() => laneAnswerPending.dismiss()}
                />
              {/if}
            </div>
          </section>
        {/if}

      </div>
    {/if}
  {/if}
</div>

<ConfirmDialog
  open={goal.resetArmed}
  title="Reset implementation"
  message="Reset deletes every top-level entry except .devboard, .omp, AGENTS.md, .gitignore, and GOAL.md. The internal .git and .worktree directories are preserved. Any active run, lifecycle, goal creation, revision, or skills preparation stops first."
  confirmLabel="Confirm reset"
  destructive
  testid="reset-confirmation"
  confirmCommand="goal.reset.confirm"
  cancelCommand="goal.reset.cancel"
  evidence={() => goal.resetStatus}
  onconfirm={() => goal.confirmReset()}
  oncancel={() => goal.cancelReset()}
/>

<ConfirmDialog
  open={deleteTarget !== null}
  title="Delete skill"
  message={deleteTarget === null
    ? ""
    : `Delete "${deleteTarget}" from .omp/skills/? Implementing agents will no longer read it.`}
  confirmLabel="Delete skill"
  destructive
  testid="delete-skill-confirmation"
  confirmCommand="goal.skills.delete.confirm"
  cancelCommand="goal.skills.delete.cancel"
  evidence={() => goal.skills}
  onconfirm={() => {
    if (deleteTarget !== null) goal.deleteSkill(deleteTarget);
    deleteTarget = null;
  }}
  oncancel={() => (deleteTarget = null)}
/>
