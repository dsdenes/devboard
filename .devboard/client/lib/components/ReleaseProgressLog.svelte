<script lang="ts">
  import type { ReleaseProgressRecord } from "../release-run";

  interface Props {
    /** The run's retained progress records, oldest first. */
    records: ReleaseProgressRecord[];
    /** What the log follows; a new run starts at its newest record. */
    identity: string;
  }

  let { records, identity }: Props = $props();

  let element = $state<HTMLOListElement | null>(null);
  let follow = $state(true);
  let shownIdentity = $state<string | null>(null);

  // The offset and follow flag belong to the run the operator scrolled, so a
  // switch to another run starts at that run's newest record.
  $effect(() => {
    if (identity === shownIdentity) return;
    shownIdentity = identity;
    follow = true;
    if (element !== null) element.scrollTop = element.scrollHeight;
  });

  // Tracked so the log follows its newest record unless the operator scrolled
  // up; then their position is left exactly where they put it.
  $effect(() => {
    void records.length;
    void records[records.length - 1]?.at;
    if (!follow || element === null) return;
    element.scrollTop = element.scrollHeight;
  });

  function trackFollow(event: Event & { currentTarget: HTMLOListElement }): void {
    const current = event.currentTarget;
    follow = current.scrollHeight - current.scrollTop - current.clientHeight <= 8;
  }

  function stamp(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
</script>

<ol
  class="release-log mono"
  data-testid="release-progress-log"
  bind:this={element}
  onscroll={trackFollow}
>
  {#if records.length === 0}
    <li class="release-log__empty">No phases recorded yet.</li>
  {:else}
    {#each records as record, index (index)}
      <li class="release-log__line" data-phase={record.phase}>
        <span class="release-log__at">{stamp(record.at)}</span>
        <span class="release-log__phase">{record.phase}</span>
        <span class="release-log__detail">{record.detail}</span>
      </li>
    {/each}
  {/if}
</ol>

<style>
  .release-log {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    margin: 0;
    padding: 0.5rem;
    max-height: 12rem;
    overflow-y: auto;
    list-style: none;
    font-size: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
  }

  .release-log__line {
    display: grid;
    grid-template-columns: 5.5rem 5rem 1fr;
    gap: 0.5rem;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .release-log__at {
    color: var(--muted);
  }

  .release-log__phase {
    color: var(--accent);
  }

  .release-log__empty {
    color: var(--muted);
  }
</style>
