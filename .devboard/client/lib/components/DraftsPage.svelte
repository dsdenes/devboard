<script lang="ts">
  import { onMount, tick } from "svelte";
  import { draftParts } from "../draft-format";
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
  const parts = $derived(draftParts(issues.draft?.text ?? ""));

  // The header reports this draft's run only; another draft's run is not this draft's state.
  const run = $derived(
    issues.draft !== null && issues.draftRun?.path === issues.draft.path ? issues.draftRun : null,
  );
  const status = $derived(run?.status ?? "idle");
  const running = $derived(run?.status === "running");
  const question = $derived(run?.question ?? null);
  const error = $derived(issues.draftError ?? run?.error ?? null);
  const startBlocker = $derived(
    issues.draft === null ? null : issues.draftStartBlocker(issues.draft.path),
  );

  // The popover only holds text until a submit; opening, Escape, or Cancel
  // writes no draft and starts no peer.
  let newInstructions = $state("");
  let newTrigger = $state<HTMLElement | null>(null);
  let newInput = $state<HTMLTextAreaElement | null>(null);
  let newPosition = $state("");

  function placeNewPopover(): void {
    const rect = newTrigger?.getBoundingClientRect();
    if (rect === undefined) return;
    const width = Math.min(360, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
    newPosition = `top:${Math.round(rect.bottom + 6)}px;left:${Math.round(left)}px;width:${width}px`;
  }

  $effect(() => {
    if (!issues.draftComposerOpen) return;
    placeNewPopover();
    void tick().then(() => newInput?.focus());
    const update = (): void => placeNewPopover();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, { capture: true, passive: true });
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, { capture: true });
    };
  });

  function toggleNewPopover(): void {
    if (issues.draftComposerOpen) closeNewPopover();
    else issues.openDraftComposer();
  }

  function closeNewPopover(): void {
    issues.closeDraftComposer();
    if (!issues.draftComposerOpen) newInstructions = "";
  }

  async function submitNew(): Promise<void> {
    await issues.createDraft(newInstructions);
    if (!issues.draftComposerOpen) newInstructions = "";
  }

  function onNewKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeNewPopover();
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submitNew();
    }
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
      <p class="issues-overview__repo mono">
        {issues.draftStatus} · {issues.drafts.length} draft(s)
      </p>
    </div>
  </header>
  <div class="issues-drafts__body">
    <section class="panel">
      <div class="panel__header">
        <h2 class="panel__title">Proposed goals</h2>
        <div class="issues-draft-new">
          <span class="panel__subtitle">{issues.repoLabel}</span>
          <span class="issues-draft-new__anchor" bind:this={newTrigger}>
            <Button
              variant="outline"
              size="sm"
              data-testid="issues-draft-new"
              data-command="issues.draft.new"
              aria-haspopup="dialog"
              aria-expanded={issues.draftComposerOpen}
              onclick={toggleNewPopover}
            >
              New goal
            </Button>
          </span>
        </div>
      </div>
      {#if issues.draftComposerOpen}
        <div
          class="issues-draft-new__popover"
          data-testid="issues-draft-new-popover"
          role="dialog"
          aria-label="New goal draft"
          tabindex="-1"
          style={newPosition}
          onkeydown={onNewKeydown}
        >
          <label class="issues-draft-new__label" for="issues-draft-new-input">
            Initial instructions
          </label>
          <textarea
            id="issues-draft-new-input"
            class="issues-draft-new__input mono"
            data-testid="issues-draft-new-input"
            bind:this={newInput}
            bind:value={newInstructions}
            rows={5}
            placeholder="Describe the goal. One submit writes the draft and starts its elaboration."
          ></textarea>
          {#if issues.draftComposerError !== null}
            <p class="issues-draft-new__error" data-testid="issues-draft-new-error" role="alert">
              {issues.draftComposerError}
            </p>
          {/if}
          <div class="issues-draft-new__actions">
            <Button
              variant="ghost"
              size="sm"
              data-testid="issues-draft-new-cancel"
              disabled={issues.draftComposerPending}
              onclick={closeNewPopover}
            >
              Cancel
            </Button>
            <Button
              variant="default"
              size="sm"
              data-testid="issues-draft-new-submit"
              disabled={issues.draftComposerPending}
              onclick={() => void submitNew()}
            >
              {issues.draftComposerPending ? "Creating…" : "Create and elaborate"}
            </Button>
          </div>
        </div>
      {/if}
      <div class="panel__body panel__body--flush">
        <ol class="issues-drafts" data-testid="issues-draft-list">
          {#each issues.drafts as draft (draft.path)}
            {@const blocker = issues.draftStartBlocker(draft.path)}
            <li>
              <button
                type="button"
                class="issues-draft"
                data-testid="issues-draft"
                data-path={draft.path}
                data-command="issues.draft.open"
                aria-current={issues.draftPath === draft.path}
                onclick={() => issues.openDraft(draft.path)}
              >
                <span class="mono">{draft.name}</span>
                <span class="issues-draft__heading">{draft.heading || "No heading"}</span>
                {#if blocker !== null}
                  <span class="issues-draft__blocked" data-testid="issues-draft-blocked">{blocker}</span>
                {/if}
              </button>
            </li>
          {:else}
            <li class="issues-drafts__empty muted" data-testid="issues-drafts-empty">
              No drafts exist.
            </li>
          {/each}
        </ol>
      </div>
    </section>

    {#if issues.draft !== null}
      <section
        class="panel issues-draft-detail"
        data-testid="issues-draft-detail"
        data-path={issues.draft.path}
      >
        <div class="issues-draft-detail__header">
          <div class="issues-draft-detail__identity">
            <h2
              class="issues-draft-detail__title"
              title={issues.draft.heading || issues.draft.name}
            >
              {issues.draft.heading || issues.draft.name}
            </h2>
            <span class="issues-draft-detail__path mono" title={issues.draft.path}>
              {issues.draft.name}
            </span>
          </div>
          <div class="issues-draft-detail__actions">
            {#if status !== "idle"}
              <span
                class="badge"
                data-tone={statusTone(status)}
                data-testid="issues-draft-state"
              >
                {status}
              </span>
            {/if}
            <Button
              variant="default"
              data-testid="issues-draft-start"
              data-command="issues.draft.start"
              disabled={issues.draftRunning}
              title={issues.draftStartBlocker(issues.draft.path) ?? "Start the elaboration agent"}
              onclick={() => issues.startDraft()}
            >
              Start elaboration
            </Button>
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
        </div>
        <div class="issues-draft-detail__body">
          {#if error !== null}
            <p class="issues-error" data-testid="issues-draft-error" role="alert">{error}</p>
          {/if}
          {#if startBlocker !== null && !running}
            <p
              class="issues-draft-detail__blocked"
              data-testid="issues-draft-detail-blocked"
            >
              {startBlocker}
            </p>
          {/if}
          {#if question !== null}
            <section
              class="issues-draft-detail__question"
              aria-label="Elaboration question"
            >
              <h3 class="issues-draft-detail__label issues-draft-detail__label--warning">
                Elaboration question
              </h3>
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
            {#if parts.proposal.length > 0}
              <pre class="issues-draft-detail__prose mono">{parts.proposal}</pre>
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
          <section class="issues-draft-detail__section" aria-label="Captured UI context">
            <h3 class="issues-draft-detail__label">Captured UI context</h3>
            <div class="issues-draft-detail__context" data-testid="issues-draft-context">
              {#if parts.facts.length > 0}
                <dl class="issues-draft-facts">
                  {#each parts.facts as fact (fact.label)}
                    <dt>{fact.label}:</dt>
                    <dd>{fact.value}</dd>
                  {/each}
                </dl>
              {/if}
              {#if parts.sections.length > 0}
                <details class="issues-draft-evidence">
                  <summary>Captured evidence</summary>
                  <div class="issues-draft-evidence__body">
                    {#each parts.sections as section (section.title)}
                      <section class="issues-draft-evidence__section">
                        <h4 class="issues-draft-detail__label">{section.title}</h4>
                        <pre class="issues-draft-evidence__text mono">{section.body}</pre>
                      </section>
                    {/each}
                  </div>
                </details>
              {:else if parts.rawContext.length > 0}
                <pre class="issues-draft-evidence__text mono">{parts.rawContext}</pre>
              {:else}
                <p class="issues-draft-detail__empty">No captured UI context.</p>
              {/if}
            </div>
          </section>
          <details class="issues-draft-source">
            <summary>
              <span class="issues-draft-detail__label">Draft source</span>
              <span class="issues-draft-source__meta mono">{issues.draft.text.length} bytes</span>
            </summary>
            <pre class="issues-draft-text mono" data-testid="issues-draft-text">{issues.draft.text}</pre>
          </details>
        </div>
      </section>
    {:else}
      <section class="panel">
        <div class="panel__body">
          <p class="muted" data-testid="issues-drafts-selection">
            Select a draft to read it and elaborate it.
          </p>
        </div>
      </section>
    {/if}
  </div>
</section>

<style>
  .issues-draft-new {
    align-items: center;
    display: flex;
    gap: 8px;
  }

  .issues-draft-new__anchor {
    display: inline-flex;
  }

  .issues-draft-new__popover {
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    box-shadow: 0 10px 30px rgb(0 0 0 / 28%);
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    position: fixed;
    z-index: 60;
  }

  .issues-draft-new__label {
    color: var(--muted-foreground);
    font-size: 11px;
    font-weight: 600;
  }

  .issues-draft-new__input {
    background: var(--background);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    color: var(--foreground);
    font-size: 12px;
    min-height: 84px;
    padding: 6px 8px;
    resize: vertical;
    width: 100%;
  }

  .issues-draft-new__error {
    color: var(--destructive);
    font-size: 11px;
    margin: 0;
  }

  .issues-draft-new__actions {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }

  .issues-draft-detail__blocked {
    color: var(--warning);
    font-size: 11px;
    margin: 0;
  }
</style>
