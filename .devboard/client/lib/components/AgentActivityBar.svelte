<script lang="ts">
  import type { Snippet } from "svelte";
  import Button from "./ui/button.svelte";

  interface Props {
    /** The agent or page this bar follows; a change collapses the panel. */
    identity: string;
    /** Accessible name prefix, for example the agent's label. */
    label: string;
    status: "running" | "idle" | "succeeded" | "failed" | "stopped";
    /** Retained activity lines, oldest first, newest last. */
    activity: string[];
    /** The current run's start time, ISO 8601, only while it runs. */
    startedAt?: string | null;
    /** True while the agent waits for an answer. */
    waiting?: boolean;
    /** At most one existing start/stop control, supplied by the page. */
    control?: Snippet;
  }

  let { identity, label, status, activity, startedAt = null, waiting = false, control }: Props =
    $props();

  let expanded = $state(false);
  let logElement = $state<HTMLDivElement | null>(null);
  let follow = $state(true);

  const running = $derived(status === "running");
  const startStamp = $derived(running ? (startedAt ?? null) : null);
  const last = $derived.by(() => {
    for (let index = activity.length - 1; index >= 0; index -= 1) {
      const entry = activity[index] ?? "";
      const lines = entry.split(/\r?\n/);
      for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
        const line = (lines[lineIndex] ?? "").trim();
        if (line.length > 0) return line;
      }
    }
    return "";
  });
  const shown = $derived(last.length > 0 ? last : "No activity yet.");
  const dotLabel = $derived(
    running
      ? startStamp === null
        ? `${label} is running`
        : `${label} is running since ${startStamp}`
      : `${label} is ${status}`,
  );

  // A new page, tab, or mode starts collapsed.
  $effect(() => {
    void identity;
    expanded = false;
    follow = true;
  });

  // Follow the newest line only while the operator stays at the bottom.
  $effect(() => {
    const lines = activity;
    const element = logElement;
    if (!expanded || element === null) return;
    void lines.length;
    void lines[lines.length - 1];
    if (follow) element.scrollTop = element.scrollHeight;
  });

  function toggle(): void {
    expanded = !expanded;
    if (expanded) follow = true;
  }

  function onRowClick(event: MouseEvent): void {
    const target = event.target;
    if (target instanceof Element && target.closest('[data-testid="agent-activity-control"]')) {
      return;
    }
    toggle();
  }

  function onScroll(event: Event & { currentTarget: HTMLDivElement }): void {
    const element = event.currentTarget;
    follow = element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
  }
</script>

<section
  class="agent-activity-bar"
  data-testid="agent-activity-bar"
  aria-label={`${label} activity`}
>
  <!-- The toggle is the keyboard path; the whole row expands on a click. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="agent-activity-bar__row" onclick={onRowClick}>
    <Button
      bare
      class="agent-activity-bar__toggle"
      data-testid="agent-activity-toggle"
      aria-expanded={expanded}
      title={startStamp ?? shown}
      onclick={(event) => {
        event.stopPropagation();
        toggle();
      }}
    >
      <span
        class="agent-activity-bar__dot"
        data-testid="agent-activity-dot"
        data-state={status}
        role="img"
        aria-label={dotLabel}
        title={startStamp ?? undefined}
      ></span>
      <span
        class="agent-activity-bar__last"
        class:agent-activity-bar__last--empty={last.length === 0}
        data-testid="agent-activity-last"
        title={shown}
      >
        {shown}
      </span>
    </Button>
    {#if waiting}
      <span
        class="agent-activity-bar__question"
        data-testid="agent-activity-question"
        title="The agent is waiting for an answer"
      >
        Question
      </span>
    {/if}
    {#if control}
      <span class="agent-activity-bar__control" data-testid="agent-activity-control">
        {@render control()}
      </span>
    {/if}
  </div>
  {#if expanded}
    <div
      class="agent-activity-bar__panel"
      data-testid="agent-activity-log"
      role="log"
      bind:this={logElement}
      onscroll={onScroll}
    >
      {#if activity.length === 0}
        <p class="agent-activity-bar__empty">No activity yet.</p>
      {:else}
        {#each activity as line, index (index)}
          <div class="agent-activity-bar__line">{line}</div>
        {/each}
      {/if}
    </div>
  {/if}
</section>
