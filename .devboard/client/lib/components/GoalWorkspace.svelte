<script lang="ts">
  import { connection } from "../connection.svelte";
  import { goal } from "../goal.svelte";
  import ChevronRight from "lucide-svelte/icons/chevron-right";
  import Trash2 from "lucide-svelte/icons/trash-2";
  import type { WorkspaceTab } from "../layout.svelte";
  import { recordStatusTone } from "../record-status";
  import { renderSkillDocument } from "../skill-document";
  import { statusTone } from "../status-tone";
  import type { AdrRecord, Lane } from "../types";
  import AdrTable from "./AdrTable.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import MonacoEditor from "./MonacoEditor.svelte";
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
  let skillsList = $state<HTMLUListElement | undefined>();
  let deleteTarget = $state<string | null>(null);

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
  const nextRecord = $derived(
    goal.next === null ? null : (goal.records.find((record) => record.file === goal.next) ?? null),
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

  const documentState = $derived(
    goal.goalEditingDisabled
      ? "Read only while work runs"
      : goal.goalDirty
        ? "Unsaved changes"
        : goal.goalReady
          ? "Saved"
          : "Not written yet",
  );

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
    const item = [...(skillsList?.querySelectorAll<HTMLElement>("[data-name]") ?? [])].find(
      (entry) => entry.dataset.name === selected,
    );
    item?.scrollIntoView({ block: "nearest" });
  });
</script>

<div class="mode-body">
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
              <button
                type="button"
                class="choice"
                data-testid="choice"
                data-command="goal.answer.submit"
                onclick={() => submitAnswer(option.label)}
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
              </button>
            {/each}
          </div>
        {/if}
        <form
          class="answer-form"
          onsubmit={(event) => {
            event.preventDefault();
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
            data-command="goal.answer.submit"
            data-testid="submit-answer"
            disabled={goal.draft.trim().length === 0}
          >
            Submit answer
          </Button>
        </form>
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
          {#if nextRecord !== null && pendingCount > 0}
            <span class="muted">Next: <span class="mono">{nextRecord.title}</span></span>
          {/if}
        {/snippet}
        {#snippet actions()}
          {#if goal.lifecycleActive}
            <Button
              variant="secondary"
              data-command={goal.lifecycle.paused ? "goal.lifecycle.resume" : "goal.lifecycle.pause"}
              onclick={() => (goal.lifecycle.paused ? goal.resumeLifecycle() : goal.pauseLifecycle())}
            >
              {goal.lifecycle.paused ? "Resume" : "Pause"}
            </Button>
          {/if}
          <Button
            variant="outline"
            data-command="goal.adr.start-next"
            data-testid="start-next"
            title={runStartTitle}
            disabled={goal.runStartDisabled || goal.next === null}
            onclick={() => goal.startNext()}
          >
            Resolve next ADR
          </Button>
          <Button
            variant="outline"
            data-command="goal.reset"
            data-testid="reset-implementation"
            disabled={goal.resetDisabled}
            onclick={() => goal.armReset()}
          >
            Reset implementation
          </Button>
          <Button
            variant={goal.lifecycleActive ? "destructive" : "default"}
            data-command="goal.lifecycle.toggle"
            data-testid="lifecycle-control"
            title={goal.lifecycleButtonTitle}
            disabled={goal.lifecycleButtonDisabled}
            onclick={() => goal.toggleLifecycle()}
          >
            {goal.lifecycleActive ? "Stop implementation" : "Start implementation"}
          </Button>
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
        eyebrow="Plan"
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
                <button
                  type="button"
                  class="filter-chip"
                  aria-pressed={filterMode === entry.id}
                  data-testid={`adr-filter-${entry.id}`}
                  onclick={() => (filterMode = entry.id)}
                >
                  {entry.label}
                </button>
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
          <span class="muted">
            {goal.goalDirty ? "Save writes GOAL.md" : "GOAL.md is the source of truth"}
          </span>
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
            <Button
              variant="outline"
              data-command="goal.skills.prepare"
              data-testid="prepare-skills"
              disabled={goal.prepareDisabled}
              onclick={() => goal.prepareSkills()}
            >
              Prepare skills
            </Button>
          {/if}
          <Button
            variant="secondary"
            data-command="goal.create"
            data-testid="create-goal"
            title={createGoalTitle}
            disabled={!connection.open}
            onclick={() => goal.createGoal()}
          >
            {goal.goalReady ? "Recreate goal" : "Create goal"}
          </Button>
          <Button
            variant="default"
            data-command="goal.save"
            data-testid="save-goal"
            title={goal.goalEditingDisabled ? "The goal is read only during work." : undefined}
            disabled={goal.goalEditingDisabled}
            onclick={() => goal.saveGoal()}
          >
            Save goal
          </Button>
        {/snippet}
      </PageHeader>

      <section class="panel goal-document" data-testid="goal-editor">
        <div class="panel__body goal-details">
          <MonacoEditor
            value={goal.goalDraft}
            label="Current goal"
            data-testid="goal-text"
            readOnly={goal.goalEditingDisabled}
            dirty={goal.goalDirty}
            onchange={(text) => goal.setGoalDraft(text)}
            onsave={() => goal.saveGoal()}
          />
        </div>
        <div class="panel__footer goal-revision">
          <div class="goal-revision__heading">
            <label class="field__label" for="revision-request">Revision guidance</label>
            <Button
              variant="secondary"
              data-command="goal.revise"
              data-testid="revise-goal"
              disabled={goal.revisionDisabled}
              onclick={() => goal.reviseGoal()}
            >
              Revise goal
            </Button>
          </div>
          <p class="goal-revision__hint">
            Revision writes a draft; save only when you accept it. Guidance is optional.
          </p>
          <textarea
            id="revision-request"
            class="textarea goal-revision__input"
            rows="3"
            bind:value={goal.revisionRequest}
            placeholder="Optional guidance for the agent"
            data-testid="revision-request"
            disabled={goal.revisionDisabled}
          ></textarea>
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
          <Button
            variant="secondary"
            data-command="goal.skills.prepare"
            data-testid="prepare-skills-overlay"
            disabled={goal.prepareDisabled}
            onclick={() => goal.prepareSkills()}
          >
            Prepare skills again
          </Button>
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
            <ul class="history-list" bind:this={skillsList}>
              {#each goal.skills as skill (skill.name)}
                {@const expanded = goal.selectedSkill === skill.name}
                {@const panelId = skillPanelId(skill.name)}
                {@const skillHtml =
                  skill.content === undefined ? "" : renderSkillDocument(skill.content)}
                <li class="skill">
                  <div class="skill__row">
                    <button
                      type="button"
                      class="skill__button"
                      data-testid="skill"
                      data-name={skill.name}
                      data-selected={expanded}
                      aria-current={expanded ? "true" : undefined}
                      aria-expanded={expanded}
                      aria-controls={expanded ? panelId : undefined}
                      onclick={() => goal.selectSkill(expanded ? null : skill.name)}
                    >
                      <span class="skill__text">
                        <span class="mono skill__name">{skill.name}</span>
                        <span class="muted skill__description">{skill.description}</span>
                      </span>
                      <ChevronRight
                        size={14}
                        aria-hidden="true"
                        class={expanded ? "skill__chevron skill__chevron--open" : "skill__chevron"}
                      />
                    </button>
                    {#if (skill.family ?? "prepare") === "prepare"}
                      <button
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
                      </button>
                    {/if}
                  </div>
                  {#if expanded}
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
                  {/if}
                </li>
              {/each}
            </ul>
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
            <div class="panel__body row-sm">
              <Button
                variant="default"
                data-command={`goal.adr.start.${record.file}`}
                data-testid="start"
                data-file={record.file}
                title={runStartTitle}
                disabled={goal.runStartDisabled}
                onclick={() => goal.startRecord(record)}
              >
                Start this record
              </Button>
              <span class="muted">
                Runs one record outside the lifecycle. Stop the lifecycle first when it is active.
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
            <span
              class="badge"
              data-testid="lane-status"
              data-kind={lane.kind}
              data-status={lane.status}
              data-tone={statusTone(lane.status)}
            >
              {lane.status}
            </span>
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
                    <button
                      type="button"
                      class="choice"
                      data-testid="lane-choice"
                      data-command={`goal.lane.answer.submit.${lane.id}`}
                      onclick={() => goal.submitLaneAnswer(lane.id, option.label)}
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
                  data-command={`goal.lane.answer.submit.${lane.id}`}
                  data-testid="lane-submit-answer"
                  disabled={goal.laneDraft.trim().length === 0}
                >
                  Submit answer
                </Button>
              </form>
            </div>
          </section>
        {/if}

        <section class="panel goal-activity" data-testid="lane-activity">
          <div class="panel__header">
            <h2 class="panel__title">Activity</h2>
            <span class="badge" data-tone={statusTone(lane.status)}>
              {lane.status === "running" || lane.status === "retrying" ? "live" : lane.status}
            </span>
          </div>
          <div class="panel__body term-split">
            <Terminal
              lines={panel.current.length === 0 ? ["No activity yet."] : panel.current}
              data-testid="lane-current"
              label="Lane current activity"
            />
            {#if panel.history.length > 0}
              <details class="activity-history">
                <summary data-testid="lane-history">
                  {panel.history.length === 1
                    ? "1 previous action"
                    : `${panel.history.length} previous actions`}
                </summary>
                <div style="height: 140px;">
                  <Terminal
                    lines={panel.history}
                    data-testid="lane-history-log"
                    label="Lane activity history"
                  />
                </div>
              </details>
            {/if}
          </div>
        </section>
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
  onconfirm={() => {
    if (deleteTarget !== null) goal.deleteSkill(deleteTarget);
    deleteTarget = null;
  }}
  oncancel={() => (deleteTarget = null)}
/>
