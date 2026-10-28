<script lang="ts">
  import { agents } from "../agents.svelte";

  const MAX_ISSUES = 10;

  let open = $state(false);

  const snapshot = $derived(agents.snapshot("watchdog"));
  const cycle = $derived(
    snapshot?.detail.panel === "cycles" ? (snapshot.detail.cycles[0] ?? null) : null,
  );
  const action = $derived(
    snapshot === null ? "unknown" : (cycle?.action ?? "none"),
  );
  const issues = $derived(snapshot?.issues.slice(0, MAX_ISSUES) ?? []);

  const age = $derived.by(() => {
    const at = cycle?.at ?? null;
    if (at === null) return "never";
    const elapsed = Date.now() - Date.parse(at);
    if (!Number.isFinite(elapsed)) return "unknown";
    const minutes = Math.floor(Math.max(0, elapsed) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  });

  const dot = $derived(
    action === "failed" ? "closed" : action === "none" || snapshot === null ? "connecting" : "open",
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
  <button
    type="button"
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
  </button>
  {#if open}
    <div
      class="watchdog-popover"
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

  .watchdog-trigger {
    max-width: 260px;
  }

  .watchdog-popover {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    bottom: 30px;
    box-shadow: 0 8px 24px rgb(0 0 0 / 25%);
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
