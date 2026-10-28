<script lang="ts">
  import { onMount } from "svelte";
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
                {#each parts.sections as section (section.title)}
                  <section class="issues-draft-evidence__section">
                    <h4 class="issues-draft-detail__label">{section.title}</h4>
                    <pre class="issues-draft-evidence__text mono">{section.body}</pre>
                  </section>
                {/each}
              {:else if parts.rawContext.length > 0}
                <pre class="issues-draft-evidence__text mono">{parts.rawContext}</pre>
              {:else if parts.facts.length === 0}
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
