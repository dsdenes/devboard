<script lang="ts">
  import type { LifecycleStage } from "../../types";

  interface Props {
    stage: LifecycleStage;
    pass: number;
    paused: boolean;
    /** False until the server reports a stage other than `goal`; never infer progress. */
    seen: boolean;
    /** The unit being processed, or the manual run title. */
    workLabel?: string | null;
    workUrl?: string | null;
    /** A single-record run that runs outside the lifecycle. */
    manual?: boolean;
    testid?: string;
  }

  const STAGES: Array<{ id: LifecycleStage; label: string }> = [
    { id: "goal", label: "Goal" },
    { id: "epic", label: "Epics" },
    { id: "adr", label: "ADRs" },
    { id: "implementation", label: "Implementation" },
    { id: "finished", label: "Finished" },
  ];

  let {
    stage,
    pass,
    paused,
    seen,
    workLabel = null,
    workUrl = null,
    manual = false,
    testid,
  }: Props = $props();

  const currentIndex = $derived(Math.max(0, STAGES.findIndex((entry) => entry.id === stage)));
  const stateLabel = $derived(
    paused
      ? "Paused"
      : manual
        ? "Manual run"
        : !seen
          ? "Not started"
          : stage === "finished"
            ? "Finished"
            : "Running",
  );
</script>

<div class="stage-track" data-testid={testid} data-state={stateLabel.toLowerCase().replace(" ", "-")}>
  <ol class="stage-track__steps" aria-label="Lifecycle stages">
    {#each STAGES as entry, index (entry.id)}
      <li
        class="stage-track__step"
        data-complete={seen && index < currentIndex}
        aria-current={index === currentIndex ? "step" : undefined}
      >
        {entry.label}
      </li>
    {/each}
  </ol>
  <p class="stage-track__detail">
    {#if seen}
      <span>Pass <strong class="mono">{pass}</strong></span>
    {/if}
    <span data-testid="stage-state">{stateLabel}</span>
    {#if workLabel !== null && workLabel.length > 0}
      <span class="stage-track__work">
        {manual ? "Resolving" : "Working on"}
        {#if workUrl !== null}
          <a href={workUrl} target="_blank" rel="noopener noreferrer">{workLabel}</a>
        {:else}
          <strong>{workLabel}</strong>
        {/if}
      </span>
    {/if}
  </p>
</div>

<style>
  .stage-track {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .stage-track__steps {
    display: flex;
    gap: 4px;
    list-style: none;
    margin: 0;
    min-width: 0;
    padding: 0;
  }

  .stage-track__step {
    border: 1px solid var(--border-subtle);
    border-radius: 3px;
    color: var(--muted-foreground);
    flex: 1 1 0;
    font-size: 11px;
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    padding: 4px 6px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stage-track__step[data-complete="true"] {
    border-color: var(--border);
    color: var(--foreground);
  }

  .stage-track__step[aria-current="step"] {
    background: var(--accent-surface);
    border-color: var(--accent);
    color: var(--foreground);
  }

  .stage-track__detail {
    align-items: baseline;
    color: var(--muted-foreground);
    display: flex;
    flex-wrap: wrap;
    font-size: 11px;
    gap: 4px 12px;
    margin: 0;
  }

  .stage-track__work {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .stage-track a {
    color: var(--accent);
  }
</style>
