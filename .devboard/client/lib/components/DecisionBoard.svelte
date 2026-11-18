<script lang="ts">
  interface Props {
    /** The stored decision board text, empty until the server settles it. */
    decisions: string;
    /** A stored Flow session this dashboard is still restoring: the board on
     *  that frame is deliberately empty, so it is not a settled board. */
    restoring: boolean;
  }

  let { decisions, restoring }: Props = $props();

  const headerState = $derived.by(() => {
    if (restoring) {
      return { state: "restoring", tone: "accent", label: "Restoring" };
    }
    if (decisions.trim().length > 0) {
      return { state: "saved", tone: "success", label: "Saved" };
    }
    return { state: "empty", tone: null, label: "No decisions yet" };
  });
</script>

<section class="panel" data-testid="flow-decisions-section">
  <div class="panel__header flow-decisions__header">
    <div class="flow-decisions__identity">
      <h2 class="panel__title flow-decisions__title">Decision board</h2>
      <span
        class="badge flow-decisions__state"
        data-state={headerState.state}
        data-tone={headerState.tone}
        data-testid="flow-decisions-state"
      >
        {headerState.label}
      </span>
    </div>
  </div>
  <div class="panel__body flow-decisions__body">
    {#if restoring}
      <div class="flow-goal-onboarding" data-testid="flow-decisions-restoring">
        <p style="margin: 0;">
          This dashboard holds a Flow session that is still being restored. Its decision board
          appears as soon as the restore finishes.
        </p>
      </div>
    {:else}
      <pre class="flow-document__text mono" data-testid="flow-decisions" aria-label="Decision board">{decisions}</pre>
    {/if}
  </div>
</section>
