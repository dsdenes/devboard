<script lang="ts">
  import { agents } from "../agents.svelte";
  import { pollAge } from "../poll-status";
  import Button from "./ui/button.svelte";

  const MAX_ISSUES = 10;

  let open = $state(false);
  let now = $state(Date.now());

  const snapshot = $derived(agents.snapshot("watchdog"));
  const cycle = $derived(
    snapshot?.detail.panel === "cycles" ? (snapshot.detail.cycles[0] ?? null) : null,
  );
  const action = $derived(
    snapshot === null ? "unknown" : (cycle?.action ?? "none"),
  );
  const issues = $derived(snapshot?.issues.slice(0, MAX_ISSUES) ?? []);

  // The status strip keeps the compact age the poll lines already render, so
  // one compact relative-time rule serves both; `now` advances it between
  // snapshots.
  const age = $derived(cycle === null ? "never" : pollAge(cycle.at, now));

  // A snapshot arrives only when the worker pushes one, so a stopped or paused
  // Watchdog would otherwise freeze its newest cycle's age at the last push.
  $effect(() => {
    if (cycle === null) return;
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  /** Cycle actions that leave nothing pending and nothing unsent. */
  const HEALTHY_ACTIONS = new Set(["none", "filed", "commented", "duplicate"]);

  const dot = $derived(
    snapshot === null
      ? "connecting"
      : action === "failed"
        ? "closed"
        : HEALTHY_ACTIONS.has(action)
          ? "open"
          : // capped, deferred, skipped, and any unrecognized action leave
            // findings pending or unsent, so they never paint healthy green.
            "connecting",
  );

  function toggle(): void {
    open = !open;
  }

  function handleKey(event: KeyboardEvent): void {
    if (event.key === "Escape" && open) open = false;
  }
</script>

<svelte:window onkeydown={handleKey} />

<div class="watchdog">
  <Button
    bare
    class="status-item status-item--button watchdog-trigger"
    data-testid="status-watchdog"
    aria-expanded={open}
    aria-haspopup="dialog"
    title="Watchdog: the last cycle and the issues it filed"
    onclick={toggle}
  >
    <span class="status-dot" data-state={dot} aria-hidden="true"></span>
    <span class="status-metric__label">watchdog</span>
    <span class="mono status-metric__value">{action} · {age}</span>
  </Button>
  {#if open}
    <div
      class="watchdog-popover shadow-md"
      data-testid="watchdog-popover"
      role="dialog"
      aria-label="Watchdog report"
    >
      <p class="watchdog-summary">
        {#if snapshot === null}
          No cycle reported yet.
        {:else}
          Cycle {cycle?.at ?? "never"} · {cycle?.findings ?? 0} finding(s) ·
          {snapshot.pending} pending
        {/if}
      </p>
      {#if cycle?.reason !== undefined}
        <p class="watchdog-reason">{cycle.reason}</p>
      {/if}
      {#if issues.length === 0}
        <p class="watchdog-empty">No issues filed.</p>
      {:else}
        <ul class="watchdog-issues">
          {#each issues as issue (issue.url)}
            <li>
              <a href={issue.url} target="_blank" rel="noopener noreferrer">
                {issue.title}
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .watchdog {
    display: inline-flex;
    flex: 0 0 auto;
  }

  .watchdog-popover {
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    bottom: 30px;
    color: var(--foreground);
    display: flex;
    flex-direction: column;
    font-size: 11px;
    gap: 6px;
    max-height: 50vh;
    max-width: 520px;
    overflow: auto;
    padding: 8px 10px;
    position: fixed;
    right: 8px;
    white-space: normal;
    z-index: 40;
  }

  .watchdog-summary,
  .watchdog-reason,
  .watchdog-empty {
    margin: 0;
  }

  .watchdog-reason {
    color: var(--muted-foreground);
  }

  .watchdog-issues {
    display: flex;
    flex-direction: column;
    gap: 4px;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .watchdog-issues a {
    color: var(--foreground);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
</style>
