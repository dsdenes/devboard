<script lang="ts">
  import type { BadgeTone } from "../record-status";
  import type { AgentCycle } from "../types";

  interface Props {
    cycles: AgentCycle[];
  }

  let { cycles }: Props = $props();

  function stamp(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }

  function actionTone(action: string): BadgeTone | undefined {
    if (action === "filed") return "success";
    if (action === "commented") return "accent";
    if (action === "failed") return "error";
    if (action === "capped" || action === "skipped") return "warning";
    return undefined;
  }

  function windowLabel(cycle: AgentCycle): string {
    if (cycle.window.start === null || cycle.window.end === null) return "—";
    return `${stamp(cycle.window.start)} – ${stamp(cycle.window.end)}`;
  }
</script>

<section class="panel watchdog-history" aria-label="Cycle history">
  <div class="panel__header">
    <h2 class="panel__title">Cycle history</h2>
  </div>
  <div class="panel__body panel__body--flush">
    <ol class="watchdog-cycles" data-testid="watchdog-cycles">
      {#each cycles as entry, index (index)}
        <li
          class="watchdog-cycle"
          data-testid="watchdog-cycle"
          data-action={entry.action}
          aria-label={`${entry.action} cycle at ${entry.at}`}
        >
          <span class="watchdog-cycle__at" data-testid="watchdog-cycle-at">
            <time datetime={entry.at}>{stamp(entry.at)}</time>
          </span>
          <span class="watchdog-cycle__window" data-testid="watchdog-cycle-window">
            {windowLabel(entry)}
          </span>
          <span
            class="badge watchdog-cycle__action"
            data-tone={actionTone(entry.action)}
            data-testid="watchdog-cycle-action"
          >
            {entry.action}
          </span>
          <span class="watchdog-cycle__findings" data-testid="watchdog-cycle-findings">
            {entry.findings} finding(s)
          </span>
          {#if entry.reason !== undefined}
            <span class="watchdog-cycle__reason" data-testid="watchdog-cycle-reason">
              {entry.reason}
            </span>
          {/if}
          {#if entry.issues.length > 0}
            <span class="watchdog-cycle__issues" data-testid="watchdog-cycle-issues">
              {#each entry.issues as issue (issue)}
                {@const number = issue.slice(issue.lastIndexOf("/") + 1)}
                <a
                  class="watchdog-cycle__issue"
                  data-testid="watchdog-cycle-issue"
                  href={issue}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={issue}
                  aria-label={`GitHub issue ${number.length > 0 ? number : issue}`}
                >
                  {number.length > 0 ? `#${number}` : issue}
                </a>
              {/each}
            </span>
          {/if}
        </li>
      {:else}
        <li class="watchdog-empty" data-testid="watchdog-cycles-empty">No cycle has run yet.</li>
      {/each}
    </ol>
  </div>
</section>

<style>
  .watchdog-empty {
    color: var(--muted-foreground);
    font-size: 12px;
    margin: 0;
    padding: 10px 12px;
  }

  .watchdog-cycles {
    display: flex;
    flex-direction: column;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .watchdog-cycle {
    align-items: center;
    border-bottom: 1px solid var(--border-subtle);
    display: grid;
    font-size: 12px;
    gap: 8px;
    grid-template-columns: 118px minmax(120px, 1fr) 86px 92px minmax(0, 1.4fr);
    min-height: 27px;
    padding: 5px 10px;
  }

  .watchdog-cycle:last-child {
    border-bottom: 0;
  }

  .watchdog-cycle__at,
  .watchdog-cycle__window,
  .watchdog-cycle__findings,
  .watchdog-cycle__reason {
    color: var(--muted-foreground);
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .watchdog-cycle__action {
    justify-self: start;
  }

  .watchdog-cycle__issues {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
  }

  .watchdog-cycle__issue {
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 11.5px;
    text-decoration: none;
  }

  .watchdog-cycle__issue:hover,
  .watchdog-cycle__issue:focus-visible {
    text-decoration: underline;
    text-underline-offset: 2px;
  }
</style>
