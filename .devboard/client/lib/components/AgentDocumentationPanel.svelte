<script lang="ts">
  import ChevronRight from "lucide-svelte/icons/chevron-right";
  import type { AgentDocumentationEntry } from "../types";

  interface Props {
    entries: AgentDocumentationEntry[];
  }

  let { entries }: Props = $props();

  /** A local clock reading; the raw ISO value stays in the tooltip. */
  function releasedLabel(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
</script>

<section
  class="panel agent-documentation"
  data-testid="agent-documentation"
  aria-label="Documentation changes"
>
  <div class="panel__header">
    <h2 class="panel__title">Documentation changes</h2>
    <span class="panel__subtitle" data-testid="agent-documentation-count">
      {entries.length} released
    </span>
  </div>
  <div class="panel__body panel__body--flush">
    {#if entries.length === 0}
      <p class="agent-documentation__empty" data-testid="agent-documentation-empty">
        No documentation change has been released yet.
      </p>
    {:else}
      <ul class="agent-documentation__list">
        {#each entries as entry (entry.version + entry.at)}
          <li class="agent-documentation__entry" data-testid="agent-documentation-entry">
            <details class="agent-documentation__details">
              <summary class="agent-documentation__summary">
                <span class="agent-documentation__headline">
                  <span class="agent-documentation__title" data-testid="agent-documentation-summary">
                    {entry.summary}
                  </span>
                  <span class="agent-documentation__chevron">
                    <ChevronRight size={14} aria-hidden="true" />
                  </span>
                </span>
                <span class="agent-documentation__meta">
                  <a
                    class="agent-documentation__version mono"
                    data-testid="agent-documentation-version"
                    href={entry.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {entry.version}
                  </a>
                  <time
                    class="agent-documentation__at"
                    data-testid="agent-documentation-at"
                    datetime={entry.at}
                    title={entry.at}
                  >
                    {releasedLabel(entry.at)}
                  </time>
                  <span class="agent-documentation__files mono" data-testid="agent-documentation-files">
                    {entry.files.join(", ")}
                  </span>
                </span>
              </summary>
              <pre
                class="agent-documentation__diff mono"
                data-testid="agent-documentation-diff"
                aria-label={`${entry.version} documentation diff`}>{entry.diff}</pre>
            </details>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>

<style>
  /* A flex item in the scrolling agent column: without a fixed basis the panel
     shrinks to its header and clips every released diff, so it keeps its own
     height and the page's scroll region carries the list. */
  .agent-documentation {
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    min-height: 0;
  }

  .agent-documentation__empty {
    color: var(--muted-foreground);
    font-size: 12px;
    line-height: 1.45;
    margin: 0;
    padding: 14px 12px;
  }

  .agent-documentation__list {
    display: flex;
    flex-direction: column;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .agent-documentation__entry + .agent-documentation__entry {
    border-top: 1px solid var(--border);
  }

  .agent-documentation__summary {
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 2px;
    list-style: none;
    padding: 8px 12px;
  }

  .agent-documentation__summary::-webkit-details-marker {
    display: none;
  }

  .agent-documentation__summary:hover {
    background: var(--row-hover);
  }

  .agent-documentation__summary:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: -2px;
  }

  .agent-documentation__headline {
    align-items: flex-start;
    display: flex;
    gap: 8px;
    min-width: 0;
  }

  .agent-documentation__title {
    flex: 1 1 auto;
    font-size: 12px;
    line-height: 1.45;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .agent-documentation__chevron {
    align-items: center;
    color: var(--muted-foreground);
    display: inline-flex;
    flex: 0 0 auto;
    transition: transform 120ms ease;
  }

  .agent-documentation__details[open] .agent-documentation__chevron {
    transform: rotate(90deg);
  }

  @media (prefers-reduced-motion: reduce) {
    .agent-documentation__chevron {
      transition: none;
    }
  }

  .agent-documentation__meta {
    align-items: baseline;
    color: var(--muted-foreground);
    display: flex;
    flex-wrap: wrap;
    font-size: 11.5px;
    gap: 2px 10px;
    line-height: 1.4;
  }

  .agent-documentation__version {
    color: var(--accent);
  }

  .agent-documentation__files {
    overflow-wrap: anywhere;
  }

  .agent-documentation__diff {
    background: var(--background);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    font-size: 12px;
    line-height: 1.45;
    margin: 0 12px 12px;
    max-height: clamp(240px, 46vh, 480px);
    overflow: auto;
    padding: 8px;
    white-space: pre;
  }
</style>
