<script lang="ts">
  import { scout } from "../scout.svelte";
  import { statusTone } from "../status-tone";
  import Button from "./ui/button.svelte";
  import IssuesAgentLog from "./IssuesAgentLog.svelte";
  import ScoutIssues from "./ScoutIssues.svelte";

  const lifecycleTone = $derived(statusTone(scout.lifecycle));
  const sync = $derived(scout.sync);

  let maxPerHourText = $state("10");
  let maxPendingText = $state("5");
  let limitsError = $state<string | null>(null);
  let lastLimits = $state("");

  // A snapshot that changes the saved limits wins over the fields; typing
  // never changes the snapshot, so an edit in progress is never overwritten.
  $effect(() => {
    const limits = scout.limits;
    const signature = `${limits.maxPerHour}/${limits.maxPending}`;
    if (signature === lastLimits) return;
    lastLimits = signature;
    maxPerHourText = String(limits.maxPerHour);
    maxPendingText = String(limits.maxPending);
    limitsError = null;
  });

  function parseLimit(value: string): number | null {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : null;
  }

  function saveLimits(): void {
    const perHour = parseLimit(maxPerHourText);
    const pending = parseLimit(maxPendingText);
    if (perHour === null || pending === null) {
      limitsError = "Both limits must be integers from 1 through 100.";
      return;
    }
    limitsError = null;
    scout.saveLimits(perHour, pending);
  }
</script>

<section class="issues-scout" data-testid="issues-scout" aria-label="Auto Scout">
  <header class="issues-overview__header">
    <div>
      <h1 class="issues-overview__title">Auto Scout</h1>
      <p class="issues-overview__repo mono" data-testid="scout-repo">
        {scout.repoLabel}
      </p>
    </div>
    <span class="badge" data-tone={lifecycleTone} data-testid="scout-lifecycle">
      {scout.lifecycle}
    </span>
  </header>

  <section class="panel">
    <div class="panel__header">
      <h2 class="panel__title">Scout worker</h2>
    </div>
    <div class="panel__body stack-sm">
      <div class="toolbar">
        <Button
          variant={scout.canStop ? "destructive" : "default"}
          data-testid={scout.canStop ? "scout-stop" : "scout-start"}
          data-command={scout.canStop ? "issues.scout.stop" : "issues.scout.start"}
          disabled={!scout.canStop && !scout.canStart}
          onclick={() => (scout.canStop ? scout.stop() : scout.start())}
        >
          {scout.canStop ? "Stop" : "Start"}
        </Button>
      </div>
      <dl class="issues-facts">
        <div>
          <dt>Worker</dt>
          <dd class="mono">
            {scout.snapshot?.worker === null || scout.snapshot?.worker === undefined
              ? "none"
              : `pid ${scout.snapshot.worker.pid} · ${scout.snapshot.worker.harnessVersion ?? "unknown"}`}
          </dd>
        </div>
        <div>
          <dt>Pending issues</dt>
          <dd>{scout.count}</dd>
        </div>
        <div>
          <dt>Scan</dt>
          <dd class="mono">{scout.snapshot?.scan?.scanId ?? "none"}</dd>
        </div>
        <div>
          <dt>Next attempt</dt>
          <dd class="mono">{scout.nextAttemptAt ?? "none"}</dd>
        </div>
        <div>
          <dt>GitHub read</dt>
          <dd>
            <span data-testid="scout-sync" data-state={sync.state}>{sync.state}</span>
          </dd>
        </div>
        <div>
          <dt>Last read</dt>
          <dd class="mono" data-testid="scout-sync-at">{sync.at ?? "never"}</dd>
        </div>
      </dl>
      {#if sync.error !== null}
        <p class="issues-error" data-testid="scout-sync-error" role="alert">{sync.error}</p>
      {/if}
      {#if scout.notice !== null}
        <p class="issues-notice" data-testid="scout-notice" role="status">{scout.notice}</p>
      {/if}
      {#if scout.error !== null}
        <p class="issues-error" data-testid="scout-error" role="alert">{scout.error}</p>
      {/if}
    </div>
  </section>

  <section class="panel">
    <div class="panel__header">
      <h2 class="panel__title">Filing limits</h2>
    </div>
    <div class="panel__body stack-sm">
      <div class="scout-limits">
        <label class="scout-limits__field">
          <span>Issues per rolling hour</span>
          <input
            class="scout-limits__input"
            type="number"
            min="1"
            max="100"
            step="1"
            inputmode="numeric"
            data-testid="scout-max-per-hour"
            value={maxPerHourText}
            oninput={(event) => (maxPerHourText = event.currentTarget.value)}
          />
        </label>
        <label class="scout-limits__field">
          <span>Open issues</span>
          <input
            class="scout-limits__input"
            type="number"
            min="1"
            max="100"
            step="1"
            inputmode="numeric"
            data-testid="scout-max-pending"
            value={maxPendingText}
            oninput={(event) => (maxPendingText = event.currentTarget.value)}
          />
        </label>
        <Button
          variant="default"
          data-testid="scout-save-limits"
          data-command="issues.scout.limits"
          onclick={saveLimits}
        >
          Save limits
        </Button>
      </div>
      <p class="muted scout-limits__hint">
        Auto Scout files at most the smaller of the hourly room and the open-issue room, and only
        findings scored 4 or 5.
      </p>
      {#if limitsError !== null}
        <p class="issues-error" data-testid="scout-limits-error" role="alert">{limitsError}</p>
      {/if}
    </div>
  </section>

  <ScoutIssues issues={scout.issues} />

  <section class="panel issues-activity-panel">
    <div class="panel__header">
      <h2 class="panel__title">Scan activity</h2>
      <span class="panel__subtitle">
        {scout.snapshot?.scan?.scanId ?? scout.snapshot?.newestScanId ?? "No scan yet"}
      </span>
    </div>
    <IssuesAgentLog lines={scout.activity} testid="scout-activity" />
  </section>
</section>

<style>
  .scout-limits {
    align-items: flex-end;
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .scout-limits__field {
    color: var(--muted);
    display: flex;
    flex-direction: column;
    font-size: 10.5px;
    gap: 4px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .scout-limits__input {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--foreground);
    font: inherit;
    font-size: 12px;
    height: 24px;
    letter-spacing: normal;
    padding: 0 6px;
    text-transform: none;
    width: 96px;
  }

  .scout-limits__hint {
    font-size: 11px;
    margin: 0;
  }
</style>
