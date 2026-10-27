<script lang="ts">
  import { onMount } from "svelte";

  interface WatchdogIssue {
    url: string;
    category: string;
    line: string;
    filedAt: string;
  }

  interface WatchdogStatus {
    cycle: string | null;
    action: string;
    reason?: string;
    findings: number;
    issues: WatchdogIssue[];
    pending: number;
  }

  const POLL_MS = 60_000;
  const MAX_ISSUES = 10;

  let status = $state<WatchdogStatus | null>(null);
  let unavailable = $state(false);
  let open = $state(false);

  async function refresh(): Promise<void> {
    try {
      const response = await fetch("/api/watchdog");
      if (!response.ok) {
        unavailable = true;
        return;
      }
      status = (await response.json()) as WatchdogStatus;
      unavailable = false;
    } catch {
      unavailable = true;
    }
  }

  onMount(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  });

  const action = $derived(status === null ? (unavailable ? "unavailable" : "unknown") : status.action);

  const age = $derived.by(() => {
    if (status === null || status.cycle === null) return "never";
    const elapsed = Date.now() - Date.parse(status.cycle);
    if (!Number.isFinite(elapsed)) return "unknown";
    const minutes = Math.floor(Math.max(0, elapsed) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  });

  const dot = $derived(
    status?.action === "failed"
      ? "closed"
      : status?.action === "none" || status === null
        ? "connecting"
        : "open",
  );

  const issues = $derived(status?.issues.slice(0, MAX_ISSUES) ?? []);

  function toggle(): void {
    open = !open;
    if (open) void refresh();
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
    <span class="mono">watchdog {action} · {age}</span>
  </button>
  {#if open}
    <div
      class="watchdog-popover"
      data-testid="watchdog-popover"
      role="dialog"
      aria-label="Watchdog report"
    >
      <p class="watchdog-summary">
        {#if status === null}
          No cycle reported yet.
        {:else}
          Cycle {status.cycle ?? "never"} · {status.findings} finding(s) ·
          {status.pending} pending
        {/if}
      </p>
      {#if status?.reason !== undefined}
        <p class="watchdog-reason">{status.reason}</p>
      {/if}
      {#if issues.length === 0}
        <p class="watchdog-empty">No issues filed.</p>
      {:else}
        <ul class="watchdog-issues">
          {#each issues as issue (issue.url)}
            <li>
              <a href={issue.url} target="_blank" rel="noopener noreferrer">
                {issue.category}: {issue.line}
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
