<script lang="ts">
  import { onMount } from "svelte";
  import { issues, markDraftsPage } from "../issues.svelte";
  import { statusTone } from "../status-tone";
  import Button from "./ui/button.svelte";
  import Input from "./ui/input.svelte";

  /**
   * The Drafts surface. It mounts only while the Drafts tab is active, so its
   * refresh loop stops with the page. Opening the page restores the stored
   * draft path; a path whose file vanished resolves to the list.
   */
  const draftContext = $derived.by(() => {
    const text = issues.draft?.text ?? "";
    const marker = "## Captured UI context";
    const index = text.indexOf(marker);
    return index === -1 ? "" : text.slice(index + marker.length).trim();
  });

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
      <p class="muted">Issues</p>
      <h1 class="issues-overview__title">Draft goals</h1>
      <p class="issues-overview__repo mono">
        {issues.draftStatus} · {issues.drafts.length} draft(s)
      </p>
    </div>
    <span class="badge" data-tone="accent" data-testid="issues-drafts-count">
      {issues.drafts.length}
    </span>
  </header>
  <div class="issues-drafts__body">
    <section class="panel">
      <div class="panel__header">
        <h2 class="panel__title">Proposed goals</h2>
        <span class="panel__subtitle">{issues.repoLabel}</span>
      </div>
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
        <div class="panel__header">
          <h2 class="panel__title mono">{issues.draft.name}</h2>
          <span
            class="badge"
            data-tone={statusTone(issues.draftStatus)}
            data-testid="issues-draft-state"
          >
            {issues.draftStatus}
          </span>
        </div>
        <div class="panel__body stack-sm">
          <div class="toolbar">
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
            {#if issues.draftRunning}
              <Button
                variant="destructive"
                data-testid="issues-draft-stop"
                data-command="issues.draft.stop"
                onclick={() => issues.stopDraft()}
              >
                Stop
              </Button>
            {/if}
          </div>
          {#if issues.draftError ?? issues.draftRun?.error ?? null}
            <p class="issues-error" data-testid="issues-draft-error" role="alert">
              {issues.draftError ?? issues.draftRun?.error}
            </p>
          {/if}
          <div class="issues-draft-context" data-testid="issues-draft-context">
            {draftContext.length > 0 ? draftContext : "No captured UI context."}
          </div>
          <pre class="issues-draft-text mono" data-testid="issues-draft-text">{issues.draft.text}</pre>
          <div class="panel__header">
            <h3 class="panel__title">Activity</h3>
            <span class="panel__subtitle mono">{issues.draftRun?.path ?? "no elaboration"}</span>
          </div>
          <pre class="issues-activity mono" data-testid="issues-draft-activity">{
            issues.draftRun === null || issues.draftRun.activity.length === 0
              ? "No elaboration activity yet."
              : issues.draftRun.activity.join("\n")
          }</pre>
          {#if issues.draftRun?.question !== null && issues.draftRun?.question !== undefined}
            <div class="issues-question" data-testid="issues-draft-question">
              <p>{issues.draftRun.question.message}</p>
              {#if issues.draftRun.question.options.length > 0}
                <div class="choice-list">
                  {#each issues.draftRun.question.options as option (option.label)}
                    <button
                      type="button"
                      class="choice"
                      data-testid="issues-draft-choice"
                      data-command="issues.draft.answer"
                      onclick={() => issues.submitDraftAnswer(option.label)}
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
                class="issues-answer"
                onsubmit={(event) => {
                  event.preventDefault();
                  issues.submitDraftAnswer(issues.draftAnswer);
                }}
              >
                <Input
                  type="text"
                  value={issues.draftAnswer}
                  oninput={(event) => (issues.draftAnswer = event.currentTarget.value)}
                  placeholder="Your answer"
                  aria-label="Your answer to the elaboration agent"
                  data-testid="issues-draft-answer-input"
                />
                <Button
                  variant="default"
                  type="submit"
                  data-command="issues.draft.answer"
                  data-testid="issues-draft-answer-submit"
                  disabled={issues.draftAnswer.trim().length === 0}
                >
                  Answer
                </Button>
              </form>
            </div>
          {/if}
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
