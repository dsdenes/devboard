<script lang="ts">
  import { onMount } from "svelte";
  import MousePointerClick from "lucide-svelte/icons/mouse-pointer-click";
  import NotebookPen from "lucide-svelte/icons/notebook-pen";
  import { draftProposal } from "../draft-format";
  import { issues, markDraftsPage } from "../issues.svelte";
  import { statusTone } from "../status-tone";
  import Button from "./ui/button.svelte";
  import IssuesAgentLog from "./IssuesAgentLog.svelte";
  import IssuesQuestion from "./IssuesQuestion.svelte";

  /**
   * The Draft goals surface. It mounts only while the Draft goals tab is active, so its
   * refresh loop stops with the page. Opening the page restores the stored
   * draft path; a path whose file vanished resolves to the list.
   */
  const proposal = $derived(draftProposal(issues.draft?.text ?? ""));
  const hasDrafts = $derived(issues.drafts.length > 0);

  // The header reports the selected draft's run only; another draft's run is not this draft's state.
  const run = $derived(issues.draft !== null ? issues.draftRunFor(issues.draft.path) : null);
  const status = $derived(run?.status ?? "idle");
  const running = $derived(run?.status === "running");
  const question = $derived(run?.question ?? null);
  const error = $derived(issues.draftErrorFor(issues.draft?.path ?? null));

  let instructions = $state("");
  let input = $state<HTMLTextAreaElement | undefined>(undefined);

  $effect(() => {
    if (issues.draftCreateOpen) input?.focus();
  });

  async function submitNewGoal(): Promise<void> {
    if (instructions.trim().length === 0 || issues.draftCreating) return;
    if (await issues.createDraft(instructions)) instructions = "";
  }

  function cancelNewGoal(): void {
    if (issues.draftCreating) return;
    instructions = "";
    issues.cancelDraftCreate();
  }

  function onNewGoalKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancelNewGoal();
  }

  onMount(() => {
    markDraftsPage(true);
    const restore = (): void => {
      const saved = issues.draftPath;
      if (saved !== null && issues.draft === null) issues.openDraft(saved);
    };
    issues.refreshDrafts();
    restore();
    const timer = setInterval(() => {
      issues.refreshDrafts();
      restore();
    }, 2000);
    return () => {
      clearInterval(timer);
      markDraftsPage(false);
    };
  });
</script>

<section class="issues-drafts-page" data-testid="issues-drafts" aria-label="Goal drafts">
  <header class="issues-overview__header">
    <div>
      <h1 class="issues-overview__title">Draft goals</h1>
      <p class="issues-overview__repo mono" title={issues.repoLabel}>
        {issues.repoLabel} · {issues.draftStatus} · {issues.drafts.length} draft(s)
      </p>
    </div>
  </header>
  <div class="issues-drafts__body" data-empty={hasDrafts ? undefined : "true"}>
    <section class="panel">
      <div class="panel__header">
        <h2 class="panel__title">Proposed goals</h2>
        <Button
          variant={issues.draftCreateOpen ? "secondary" : "default"}
          size="sm"
          data-testid="issues-draft-new"
          data-command="issues.draft.new"
          aria-expanded={issues.draftCreateOpen}
          aria-controls={issues.draftCreateOpen ? "issues-draft-new-popover" : undefined}
          onclick={() => issues.beginDraftCreate()}
        >
          New goal
        </Button>
      </div>
      {#if issues.draftCreateOpen}
        <div
          class="issues-draft-new"
          id="issues-draft-new-popover"
          data-testid="issues-draft-new-popover"
          role="dialog"
          aria-label="New goal"
          tabindex="-1"
          onkeydown={onNewGoalKeydown}
        >
          <label class="issues-draft-new__label" for="issues-draft-new-input">
            Initial instructions
          </label>
          <textarea
            id="issues-draft-new-input"
            class="issues-draft-new__input"
            data-testid="issues-draft-new-input"
            bind:this={input}
            bind:value={instructions}
            rows="4"
            disabled={issues.draftCreating}
            placeholder="Describe the goal in your own words."
          ></textarea>
          {#if issues.draftCreateError !== null}
            <p class="issues-error" data-testid="issues-draft-new-error" role="alert">
              {issues.draftCreateError}
            </p>
          {/if}
          <div class="issues-draft-new__actions">
            <Button
              variant="ghost"
              data-testid="issues-draft-new-cancel"
              data-command="issues.draft.new.cancel"
              disabled={issues.draftCreating}
              onclick={cancelNewGoal}
            >
              Cancel
            </Button>
            <Button
              variant="default"
              data-testid="issues-draft-new-submit"
              data-command="issues.draft.new.submit"
              disabled={issues.draftCreating || instructions.trim().length === 0}
              onclick={() => void submitNewGoal()}
            >
              {issues.draftCreating ? "Creating…" : "Create draft"}
            </Button>
          </div>
        </div>
      {/if}
      {#if !hasDrafts}
        <div class="panel__body issues-drafts__placeholder" data-testid="issues-drafts-empty">
          <div class="issues-drafts__placeholder-body">
            <span class="issues-drafts__placeholder-icon" aria-hidden="true">
              <NotebookPen size={20} strokeWidth={1.5} />
            </span>
            <p class="issues-drafts__placeholder-title">No drafts yet</p>
            <p class="issues-drafts__placeholder-copy">
              Create one with New goal, or propose it from a report. Each draft becomes a goal you
              can elaborate here.
            </p>
          </div>
        </div>
      {:else}
        <div class="panel__body panel__body--flush">
          <ol class="issues-drafts" data-testid="issues-draft-list">
            {#each issues.drafts as draft (draft.path)}
              {@const draftStatus = issues.draftState(draft.path)}
              {@const waiting = issues.draftWaiting(draft.path)}
              {@const blocker = issues.draftStartBlocker(draft.path)}
              <li
                class="issues-draft-row"
                data-current={issues.draftPath === draft.path}
              >
                <button
                  type="button"
                  class="issues-draft"
                  data-testid="issues-draft"
                  data-path={draft.path}
                  data-command="issues.draft.open"
                  data-status={draftStatus}
                  data-question={waiting ? "true" : undefined}
                  aria-current={issues.draftPath === draft.path}
                  onclick={() => issues.openDraft(draft.path)}
                >
                  <span class="issues-draft__text">
                    <span class="issues-draft__name mono" title={draft.path}>{draft.name}</span>
                    <span class="issues-draft__heading" title={draft.heading || "No heading"}>
                      {draft.heading || "No heading"}
                    </span>
                  </span>
                  <span class="issues-draft__meta">
                    {#if waiting}
                      <span
                        class="badge"
                        data-tone="warning"
                        data-testid="issues-draft-waiting"
                        title="This draft is waiting for your answer."
                      >
                        answer
                      </span>
                    {/if}
                    <span class="badge" data-tone={statusTone(draftStatus)}>{draftStatus}</span>
                  </span>
                </button>
                <div class="issues-draft-row__action">
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="issues-draft-row-start"
                    data-command="issues.draft.start"
                    data-path={draft.path}
                    aria-label={`Start ${draft.name}`}
                    disabled={issues.draftRunning(draft.path)}
                    title={blocker ?? "Start the elaboration agent"}
                    onclick={() => issues.startDraft(draft.path)}
                  >
                    Start
                  </Button>
                </div>
              </li>
            {/each}
          </ol>
        </div>
      {/if}
    </section>

    {#if issues.draft !== null}
      <section
        class="panel issues-draft-detail"
        data-testid="issues-draft-detail"
        data-path={issues.draft.path}
      >
        <div class="issues-draft-detail__header">
          <div class="issues-draft-detail__identity">
            <span class="issues-draft-detail__path mono" title={issues.draft.path}>
              {issues.draft.name}
            </span>
          </div>
          {#if status !== "idle"}
            <div class="issues-draft-detail__actions">
              <span
                class="badge"
                data-tone={statusTone(status)}
                data-testid="issues-draft-state"
              >
                {status}
              </span>
              {#if running}
                <Button
                  variant="ghost"
                  class="issues-draft-detail__stop"
                  data-testid="issues-draft-stop"
                  data-command="issues.draft.stop"
                  onclick={() => issues.stopDraft()}
                >
                  Stop
                </Button>
              {/if}
            </div>
          {/if}
        </div>
        <div class="issues-draft-detail__body">
          {#if error !== null}
            <p class="issues-error" data-testid="issues-draft-error" role="alert">{error}</p>
          {/if}
          {#if question !== null}
            <section
              class="issues-draft-detail__question"
              aria-label="Elaboration question"
            >
              <IssuesQuestion
                question={question}
                testid="issues-draft-question"
                onanswer={(value) => issues.submitDraftAnswer(value)}
                choiceTestid="issues-draft-choice"
                inputTestid="issues-draft-answer-input"
                submitTestid="issues-draft-answer-submit"
                command="issues.draft.answer"
              />
            </section>
          {/if}
          <section class="issues-draft-detail__section" aria-label="Draft">
            {#if proposal.length > 0}
              <pre class="issues-draft-detail__prose mono">{proposal}</pre>
            {:else}
              <p class="issues-draft-detail__empty">This draft holds no proposal text yet.</p>
            {/if}
          </section>
          {#if run !== null}
            <section
              class="issues-draft-detail__section issues-draft-detail__section--activity"
              aria-label="Elaboration activity"
            >
              <h3 class="issues-draft-detail__label">Elaboration activity</h3>
              <IssuesAgentLog lines={run.activity} testid="issues-draft-activity" />
            </section>
          {/if}
        </div>
      </section>
    {:else if hasDrafts}
      <section class="panel">
        <div class="panel__body issues-drafts__placeholder" data-testid="issues-drafts-selection">
          <div class="issues-drafts__placeholder-body">
            <span class="issues-drafts__placeholder-icon" aria-hidden="true">
              <MousePointerClick size={20} strokeWidth={1.5} />
            </span>
            <p class="issues-drafts__placeholder-title">No draft selected</p>
            <p class="issues-drafts__placeholder-copy">
              Choose a draft from Proposed goals to read its proposal and elaborate it.
            </p>
          </div>
        </div>
      </section>
    {/if}
  </div>
</section>
