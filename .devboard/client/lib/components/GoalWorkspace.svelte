<script lang="ts">
  import { connection } from "../connection.svelte";
  import { goal } from "../goal.svelte";
  import type { WorkspaceTab } from "../layout.svelte";
  import type { AdrRecord, Lane } from "../types";
  import AdrTable from "./AdrTable.svelte";
  import MonacoEditor from "./MonacoEditor.svelte";
  import Terminal from "./Terminal.svelte";
  import Button from "./ui/button.svelte";

  interface Props {
    tab: WorkspaceTab | null;
    openTab: (tab: WorkspaceTab) => void;
    closeTab: (tab: WorkspaceTab) => void;
  }

  let { tab, openTab, closeTab }: Props = $props();

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

  const lane = $derived(tab?.kind === "lane" ? goal.lane(tab.resourceId) : null);
  const record = $derived(
    tab?.kind === "adr" ? (goal.records.find((entry) => entry.file === tab?.resourceId) ?? null) : null,
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
</script>

<div class="mode-body">
  {#if tab === null}
    <div class="panel panel--plain">
      <p class="empty">No tab is open. Choose a surface from the sidebar.</p>
    </div>
  {:else if tab.kind === "overview"}
    <div class="scroll-column">
      <section class="panel" data-testid="lifecycle">
        <div class="panel__header">
          <h2 class="panel__title">Lifecycle</h2>
          <div class="toolbar">
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
            <Button
              variant="secondary"
              data-command="goal.lifecycle.pause"
              disabled={!goal.lifecycleActive || goal.lifecycle.paused}
              onclick={() => goal.pauseLifecycle()}
            >
              Pause
            </Button>
            <Button
              variant="secondary"
              data-command="goal.lifecycle.resume"
              disabled={!goal.lifecycleActive || !goal.lifecycle.paused}
              onclick={() => goal.resumeLifecycle()}
            >
              Resume
            </Button>
            <Button
              variant="secondary"
              data-command="goal.adr.start-next"
              data-testid="start-next"
              title={runStartTitle}
              disabled={goal.runStartDisabled || goal.next === null}
              onclick={() => goal.startNext()}
            >
              Resolve next ADR
            </Button>
          </div>
        </div>
        <div class="panel__body">
          <div class="row-sm" style="gap: 16px;">
            <span class="muted">Open epics <strong class="mono" data-testid="epic-count">{goal.openEpics}</strong></span>
            <span class="muted">Running lanes <strong class="mono" data-testid="lane-count">{goal.runningLanes}</strong></span>
            <span class="muted">Pass <strong class="mono" data-testid="lifecycle-pass">{goal.lifecycle.pass}</strong></span>
            <span class="muted">Stage <strong>{goal.lifecycle.paused ? "paused" : goal.lifecycle.stage}</strong></span>
            {#if goal.lifecycleWorkTitle !== null}
              <span class="muted" data-testid="lifecycle-work">
                Work
                {#if goal.lifecycleWorkUrl !== null}
                  <a
                    href={goal.lifecycleWorkUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="lifecycle-work-link"
                  >
                    {goal.lifecycleWorkTitle}
                  </a>
                {:else}
                  <strong>{goal.lifecycleWorkTitle}</strong>
                {/if}
              </span>
            {/if}
            <span class="muted" data-testid="pending-summary" aria-live="polite">
              {goal.pendingCount} ADR{goal.pendingCount === 1 ? "" : "s"} pending
            </span>
          </div>
          <div class="row-sm" style="margin-top: 8px;">
            <Button
              variant="outline"
              data-command="goal.reset"
              data-testid="reset-implementation"
              disabled={goal.resetDisabled}
              onclick={() => goal.armReset()}
            >
              Reset implementation
            </Button>
          </div>

          {#if goal.resetArmed}
            <div class="message" data-testid="reset-confirmation" style="margin-top: 8px;">
              <p class="message__text" data-testid="reset-keep-set">
                Reset deletes every top-level entry except <code>.devboard</code>, <code>.omp</code>,
                <code>AGENTS.md</code>, <code>.gitignore</code>, and <code>GOAL.md</code>. The
                internal <code>.git</code> and <code>.worktree</code> directories are preserved. Any
                active run, lifecycle, goal creation, revision, or skills preparation stops first.
              </p>
              <div class="row-sm" style="margin-top: 6px;">
                <Button
                  variant="destructive"
                  data-command="goal.reset.confirm"
                  data-testid="confirm-reset"
                  disabled={goal.resetDisabled}
                  onclick={() => goal.confirmReset()}
                >
                  Confirm reset
                </Button>
                <Button
                  variant="outline"
                  data-command="goal.reset.cancel"
                  data-testid="cancel-reset"
                  onclick={() => goal.cancelReset()}
                >
                  Cancel
                </Button>
              </div>
            </div>
          {/if}
          {#if goal.resetting}
            <p class="muted" data-testid="reset-running">Resetting implementation…</p>
          {/if}
          {#if goal.resetStatus !== null}
            <p data-testid="reset-status" role="status">{goal.resetStatus}</p>
          {/if}
          {#if connection.upgradePending}
            <p class="message" data-testid="upgrade-pending" data-severity="notice">
              An update is waiting for the current work to finish. This dashboard restarts when it
              ends.
            </p>
          {/if}
          {#if connection.lastError !== null}
            <p class="message" data-severity="error" role="alert">{connection.lastError}</p>
          {/if}
        </div>
      </section>

      {#if goal.creationActive}
        <section class="panel" data-testid="goal-creation-active">
          <div class="panel__header"><h2 class="panel__title">Creating the goal</h2></div>
        </section>
      {/if}
      {#if goal.revisionActive}
        <section class="panel" data-testid="goal-revision-active">
          <div class="panel__header"><h2 class="panel__title">Revising the goal</h2></div>
        </section>
      {/if}
      {#if goal.skillsPrepActive}
        <section class="panel" data-testid="skills-preparation-active">
          <div class="panel__header"><h2 class="panel__title">Preparing skills</h2></div>
        </section>
      {/if}

      {#if goal.runState === "active" && goal.runTitle !== null}
        <section class="panel" data-testid="active-run" data-action={goal.runAction}>
          <div class="panel__header">
            <h2 class="panel__title">
              {#if goal.runAction === "implementing"}
                Implementing <strong>{goal.runTitle}</strong>
              {:else if goal.runAction === "generating"}
                Generating the next epic
              {:else}
                Resolving <strong>{goal.runTitle}</strong>
              {/if}
            </h2>
          </div>
        </section>
      {:else if goal.runState === "stopped"}
        <p class="message" data-testid="run-stopped" data-severity="notice">Run stopped</p>
      {/if}

      {#if goal.question !== null}
        {@const pending = goal.question}
        <section class="panel" data-testid="question">
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
                class="textarea"
                style="min-height: 28px; padding: 4px 6px;"
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

      {#if goal.activity.length > 0}
        <section class="panel activity-section" data-testid="activity">
          <div class="panel__header">
            <h2 class="panel__title">{goal.activityActive ? "Current action" : "Last action"}</h2>
            <span class="badge" data-tone={goal.activityActive ? "accent" : "warning"}>
              {goal.activityActive ? "live" : "idle"}
            </span>
          </div>
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
        </section>
      {/if}
    </div>
  {:else if tab.kind === "adrs"}
    <section class="panel" data-testid="adrs-overlay">
      <div class="panel__header">
        <h2 class="panel__title">ADRs</h2>
        <div class="row-sm">
          <span class="muted" data-testid="pending-summary">
            {goal.pendingCount} pending · {goal.records.length} records
          </span>
          <Button
            variant="outline"
            data-command={`tab.close.goal.${tab.id}`}
            data-testid="close-adrs"
            onclick={() => closeTab(tab)}
          >
            Close
          </Button>
        </div>
      </div>
      <AdrTable onopen={openAdr} onstart={(entry) => goal.startRecord(entry)} />
    </section>
  {:else if tab.kind === "goal-document"}
    <div class="scroll-column">
      <section class="panel" data-testid="goal-editor">
        <div class="panel__header">
          <h2 class="panel__title">Goal document</h2>
          <div class="toolbar">
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
                Prepare Skills
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
          </div>
        </div>
        <div class="panel__body goal-details" data-testid="goal-details" style="height: 320px;">
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
        <div class="panel__footer" style="justify-content: flex-start; flex-wrap: wrap;">
          <div class="field grow" style="flex-direction: row; align-items: center; gap: 8px;">
            <label class="field__label" for="revision-request">Revision guidance</label>
            <input
              id="revision-request"
              class="textarea"
              style="min-height: 28px; padding: 4px 6px; flex: 1;"
              type="text"
              bind:value={goal.revisionRequest}
              placeholder="Optional guidance for the agent"
              data-testid="revision-request"
              disabled={goal.revisionDisabled}
            />
          </div>
          <Button
            variant="secondary"
            data-command="goal.revision.focus"
            onclick={() => document.getElementById("revision-request")?.focus()}
          >
            Focus guidance
          </Button>
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
      </section>
    </div>
  {:else if tab.kind === "skills"}
    <section class="panel" data-testid="skills-overlay">
      <div class="panel__header">
        <h2 class="panel__title">
          Skills <span class="mono" data-testid="skills-count">{goal.skills.length}</span>
        </h2>
        <div class="row-sm">
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
        </div>
      </div>
      <div class="panel__body stack-sm">
        <ul class="history-list">
          {#each goal.skills as skill (skill.name)}
            <li class="skill" data-testid="skill" data-name={skill.name}>
              <span class="mono">{skill.name}</span>
              <p class="muted" style="margin: 0;">{skill.description}</p>
            </li>
          {/each}
        </ul>
        {#if goal.contradictions.length === 0}
          <p class="muted" data-testid="skills-no-contradictions">No contradictions</p>
        {:else}
          <ul class="history-list" data-testid="skills-contradictions">
            {#each goal.contradictions as contradiction (`${contradiction.skills[0]}:${contradiction.skills[1]}`)}
              <li class="message">
                {contradiction.skills[0]} and {contradiction.skills[1]}:
                “{contradiction.directives[0]}” vs “{contradiction.directives[1]}”
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </section>
  {:else if tab.kind === "adr"}
    {#if record === null}
      <p class="empty">This ADR is no longer listed.</p>
    {:else}
      <div class="scroll-column">
        <section class="panel">
          <div class="panel__header">
            <h2 class="panel__title">{record.title}</h2>
            <div class="row-sm">
              {#if goal.next === record.file}
                <span class="badge" data-tone="accent" data-testid="next-marker">Next</span>
              {/if}
              <span class="badge" data-tone={record.pending ? "pending" : "resolved"}>
                {record.pending ? "Pending" : "Resolved"}
              </span>
              <span class="badge">{record.status || "Unknown"}</span>
            </div>
          </div>
          <div class="panel__body stack-sm">
            <dl class="kv-grid">
              <dt>File</dt>
              <dd><code data-testid="record-file">{record.file}</code></dd>
              <dt>State</dt>
              <dd>{record.pending ? "Pending" : "Resolved"}</dd>
              <dt>Next</dt>
              <dd>{goal.next === record.file ? "Yes" : "No"}</dd>
            </dl>
            <div>
              <div class="field__label">Decision summary</div>
              <p data-testid="record-summary" style="margin: 2px 0 0;">
                {record.summary || "No decision summary recorded."}
              </p>
            </div>
            {#if record.pending}
              <div class="row-sm">
                <Button
                  variant="default"
                  data-command={`goal.adr.start.${record.file}`}
                  data-testid="start"
                  data-file={record.file}
                  title={runStartTitle}
                  disabled={goal.runStartDisabled}
                  onclick={() => goal.startRecord(record)}
                >
                  Start
                </Button>
              </div>
            {/if}
          </div>
        </section>
      </div>
    {/if}
  {:else if tab.kind === "lane"}
    {#if lane === null}
      <p class="empty">This lane is no longer active.</p>
    {:else}
      {@const panel = lanePanel(lane)}
      <div class="scroll-column">
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
            <span
              class="badge"
              data-testid="lane-status"
              data-kind={lane.kind}
              data-status={lane.status}
              data-tone={lane.status === "running" ? "accent" : "warning"}
            >
              {lane.status}
            </span>
          </div>
          <div class="panel__body term-split">
            <Terminal lines={panel.current} data-testid="lane-current" label="Lane current activity" />
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

        {#if lane.question !== null}
          {@const pending = lane.question}
          <section class="panel" data-testid="lane-question" data-lane={lane.id}>
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
                  class="textarea"
                  style="min-height: 28px; padding: 4px 6px;"
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
      </div>
    {/if}
  {/if}
</div>
