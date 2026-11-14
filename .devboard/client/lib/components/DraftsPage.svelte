<script lang="ts">
  import { onMount } from "svelte";
  import MousePointerClick from "lucide-svelte/icons/mouse-pointer-click";
  import NotebookPen from "lucide-svelte/icons/notebook-pen";
  import Trash2 from "lucide-svelte/icons/trash-2";
  import { draftProposal } from "../draft-format";
  import { goalDrafts, markDraftsPage } from "../goal-drafts.svelte";
  import { issues } from "../issues.svelte";
  import { statusTone } from "../status-tone";
  import Button from "./ui/button.svelte";
  import CommandButton from "./CommandButton.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import IssuesAgentLog from "./IssuesAgentLog.svelte";
  import IssuesQuestion from "./IssuesQuestion.svelte";

  /**
   * The Draft goals surface. It mounts only while the Draft goals tab is
   * active: the scheduler plans the drafts list at its body cadence, and this
   * page restores the stored draft path on mount. A path whose file vanished
   * resolves to the list.
   */
  const proposal = $derived(draftProposal(goalDrafts.draft?.text ?? ""));
  const hasDrafts = $derived(goalDrafts.drafts.length > 0);
  /**
   * The server could not read `.devboard/goal-proposals`. The page then shows
   * the message and keeps the list it already had: a failed read never claims
   * the directory is empty.
   */
  const draftsUnreadable = $derived(goalDrafts.draftsReadError !== null);

  // The header reports the selected draft's run only; another draft's run is not this draft's state.
  const run = $derived(goalDrafts.draft !== null ? goalDrafts.draftRunFor(goalDrafts.draft.path) : null);
  const status = $derived(run?.status ?? "idle");
  const running = $derived(run?.status === "running");
  const question = $derived(run?.question ?? null);
  const error = $derived(goalDrafts.draftErrorFor(goalDrafts.draft?.path ?? null));

  let instructions = $state("");
  let input = $state<HTMLTextAreaElement | undefined>(undefined);
  /** The draft whose deletion waits for the dialog's confirmation. */
  let deleteTarget = $state<{ path: string; name: string } | null>(null);

  $effect(() => {
    if (goalDrafts.draftCreateOpen) input?.focus();
  });

  async function submitNewGoal(): Promise<void> {
    if (instructions.trim().length === 0 || goalDrafts.draftCreating) return;
    if (await goalDrafts.createDraft(instructions)) instructions = "";
  }

  function cancelNewGoal(): void {
    if (goalDrafts.draftCreating) return;
    instructions = "";
    goalDrafts.cancelDraftCreate();
  }

  function onNewGoalKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancelNewGoal();
  }

  onMount(() => {
    markDraftsPage(true);
    goalDrafts.restoreDraft();
    return () => {
      markDraftsPage(false);
    };
  });
</script>

<section class="issues-drafts-page" data-testid="issues-drafts" aria-label="Goal drafts">
  <header class="issues-overview__header">
    <div>
      <h1 class="issues-overview__title">Draft goals</h1>
      <p class="issues-overview__repo mono" title={issues.repoLabel}>
        {issues.repoLabel} · {goalDrafts.draftStatus} ·
        {draftsUnreadable ? "drafts unreadable" : `${goalDrafts.drafts.length} draft(s)`}
      </p>
    </div>
  </header>
  <div class="issues-drafts__body" data-empty={hasDrafts || draftsUnreadable ? undefined : "true"}>
    <section class="panel">
      <div class="panel__header">
        <h2 class="panel__title">Proposed goals</h2>
        <Button
          variant={goalDrafts.draftCreateOpen ? "secondary" : "default"}
          size="sm"
          data-testid="issues-draft-new"
          data-command="issues.draft.new"
          aria-expanded={goalDrafts.draftCreateOpen}
          aria-controls={goalDrafts.draftCreateOpen ? "issues-draft-new-popover" : undefined}
          onclick={() => goalDrafts.beginDraftCreate()}
        >
          New goal
        </Button>
      </div>
      {#if goalDrafts.draftCreateOpen}
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
            disabled={goalDrafts.draftCreating}
            placeholder="Describe the goal in your own words."
          ></textarea>
          {#if goalDrafts.draftCreateError !== null}
            <p class="issues-error" data-testid="issues-draft-new-error" role="alert">
              {goalDrafts.draftCreateError}
            </p>
          {/if}
          <div class="issues-draft-new__actions">
            <Button
              variant="ghost"
              data-testid="issues-draft-new-cancel"
              data-command="issues.draft.new.cancel"
              disabled={goalDrafts.draftCreating}
              onclick={cancelNewGoal}
            >
              Cancel
            </Button>
            <CommandButton
              variant="default"
              label="Create draft"
              evidence={() => goalDrafts.draftCreateError ?? goalDrafts.draftCreateOpen}
              command={() => void submitNewGoal()}
              data-testid="issues-draft-new-submit"
              data-command="issues.draft.new.submit"
              disabled={goalDrafts.draftCreating || instructions.trim().length === 0}
            >
              {goalDrafts.draftCreating ? "Creating…" : "Create draft"}
            </CommandButton>
          </div>
        </div>
      {/if}
      {#if draftsUnreadable}
        <div class="panel__body">
          <p class="issues-error" data-testid="issues-drafts-error" role="alert">
            {goalDrafts.draftsReadError}
          </p>
        </div>
      {/if}
      {#if !hasDrafts && !draftsUnreadable}
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
      {:else if hasDrafts}
        <div class="panel__body panel__body--flush">
          <ol class="issues-drafts" data-testid="issues-draft-list">
            {#each goalDrafts.drafts as draft (draft.path)}
              {@const draftStatus = goalDrafts.draftState(draft.path)}
              {@const waiting = goalDrafts.draftWaiting(draft.path)}
              {@const blocker = goalDrafts.draftStartBlocker(draft.path)}
              <li
                class="issues-draft-row"
                data-current={goalDrafts.draftPath === draft.path}
              >
                <Button
                  bare
                  class="issues-draft"
                  data-testid="issues-draft"
                  data-path={draft.path}
                  data-command="issues.draft.open"
                  data-status={draftStatus}
                  data-question={waiting ? "true" : undefined}
                  aria-current={goalDrafts.draftPath === draft.path}
                  onclick={() => goalDrafts.openDraft(draft.path)}
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
                </Button>
                <div class="issues-draft-row__action">
                  <CommandButton
                    variant="outline"
                    size="sm"
                    label="Start"
                    evidence={() => goalDrafts.draftRunFor(draft.path)?.status}
                    command={() => goalDrafts.startDraft(draft.path)}
                    data-testid="issues-draft-row-start"
                    data-command="issues.draft.start"
                    data-path={draft.path}
                    aria-label={`Start ${draft.name}`}
                    disabled={goalDrafts.draftRunning(draft.path)}
                    title={blocker ?? "Start the elaboration agent"}
                  >
                    Start
                  </CommandButton>
                  <Button
                    bare
                    class="issues-draft-row__delete"
                    data-testid="issues-draft-row-delete"
                    data-command="issues.draft.delete"
                    data-path={draft.path}
                    aria-label={`Delete ${draft.name}`}
                    disabled={goalDrafts.draftRunning(draft.path)}
                    title={blocker ?? `Delete ${draft.name} from ${draft.path}`}
                    onclick={() => (deleteTarget = { path: draft.path, name: draft.name })}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </Button>
                </div>
              </li>
            {/each}
          </ol>
        </div>
      {/if}
    </section>

    {#if goalDrafts.draft !== null}
      <section
        class="panel issues-draft-detail"
        data-testid="issues-draft-detail"
        data-path={goalDrafts.draft.path}
        aria-labelledby="issues-draft-detail-title"
      >
        <div class="issues-draft-detail__header">
          <div class="issues-draft-detail__identity">
            <h2
              class="issues-draft-detail__title"
              id="issues-draft-detail-title"
              title={goalDrafts.draft.heading || goalDrafts.draft.name}
            >
              {goalDrafts.draft.heading || goalDrafts.draft.name}
            </h2>
            <span class="issues-draft-detail__path mono" title={goalDrafts.draft.path}>
              {goalDrafts.draft.name}
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
                <CommandButton
                  variant="ghost"
                  label="Stop"
                  evidence={() => goalDrafts.draftRunFor(goalDrafts.draftPath)?.status}
                  command={() => goalDrafts.stopDraft()}
                  class="issues-draft-detail__stop"
                  data-testid="issues-draft-stop"
                  data-command="issues.draft.stop"
                >
                  Stop
                </CommandButton>
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
                onanswer={(value) => goalDrafts.submitDraftAnswer(value)}
                answerRevision={() =>
                  goalDrafts.draftPath === null ? 0 : goalDrafts.answerRevision(goalDrafts.draftPath)}
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
              <IssuesAgentLog
                lines={run.activity}
                testid="issues-draft-activity"
                identity={goalDrafts.draft.path}
              />
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

<ConfirmDialog
  open={deleteTarget !== null}
  title="Delete draft"
  message={deleteTarget === null
    ? ""
    : `Delete "${deleteTarget.name}" from .devboard/goal-proposals/? The draft is removed ` +
      "permanently; nothing is elaborated from it."}
  confirmLabel="Delete draft"
  destructive
  testid="issues-draft-delete-confirmation"
  confirmCommand="issues.draft.delete.confirm"
  cancelCommand="issues.draft.delete.cancel"
  evidence={() => goalDrafts.drafts}
  onconfirm={() => {
    if (deleteTarget !== null) goalDrafts.deleteDraft(deleteTarget.path);
    deleteTarget = null;
  }}
  oncancel={() => (deleteTarget = null)}
/>
