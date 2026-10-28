<script lang="ts">
  import { scout } from "../scout.svelte";
  import { statusTone } from "../status-tone";
  import Button from "./ui/button.svelte";
  import Input from "./ui/input.svelte";
  import IssuesAgentLog from "./IssuesAgentLog.svelte";
  import PageHeader from "./ui/page-header.svelte";
  import ScoutIssues from "./ScoutIssues.svelte";

  const lifecycleTone = $derived(statusTone(scout.lifecycle));
  const sync = $derived(scout.sync);
  const scanLabel = $derived(
    scout.snapshot?.scan?.scanId ?? scout.snapshot?.newestScanId ?? "No scan yet",
  );

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

  /** A local clock reading, so narrow rails never wrap a raw ISO stamp. */
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
</script>

<section class="issues-scout" data-testid="issues-scout" aria-label="Auto Scout">
  <PageHeader
    eyebrow="Issues"
    title="Auto Scout"
    subtitle={scout.repoLabel}
    layout="bar"
    testid="issues-scout-header"
  >
    {#snippet meta()}
      <span class="badge" data-tone={lifecycleTone} data-testid="scout-lifecycle">
        {scout.lifecycle}
      </span>
      <span class="scout-sync-at muted">
        Last read
        <span class="mono" data-testid="scout-sync-at" title={sync.at ?? "never"}>
          {#if sync.at === null}
            never
          {:else}
            <time datetime={sync.at}>{stamp(sync.at)}</time>
          {/if}
        </span>
      </span>
    {/snippet}
    {#snippet actions()}
      <Button
        variant={scout.canStop ? "destructive" : "default"}
        data-testid={scout.canStop ? "scout-stop" : "scout-start"}
        data-command={scout.canStop ? "issues.scout.stop" : "issues.scout.start"}
        disabled={!scout.canStop && !scout.canStart}
        onclick={() => (scout.canStop ? scout.stop() : scout.start())}
      >
        {scout.canStop ? "Stop" : "Start"}
      </Button>
    {/snippet}
  </PageHeader>

  {#if sync.error !== null || scout.error !== null}
    <div class="issues-scout__alerts">
      {#if sync.error !== null}
        <p class="issues-error" data-testid="scout-sync-error" role="alert">{sync.error}</p>
      {/if}
      {#if scout.error !== null}
        <p class="issues-error" data-testid="scout-error" role="alert">{scout.error}</p>
      {/if}
    </div>
  {/if}

  <div class="issues-scout__body">
    <div class="issues-scout__side">
      <section class="panel">
        <div class="panel__header">
          <h2 class="panel__title">Filing limits</h2>
        </div>
        <div class="panel__body stack-sm">
          <div class="scout-limits">
            <label class="scout-limits__field">
              <span>Issues per rolling hour</span>
              <Input
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
              <Input
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
          </div>
          <div class="scout-limits__actions">
            <Button
              variant="secondary"
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
    </div>

    <div class="issues-scout__main">
      <ScoutIssues issues={scout.issues} />

      <section class="panel issues-activity-panel">
        <div class="panel__header">
          <h2 class="panel__title">Scan activity</h2>
          <span class="panel__subtitle" title={scanLabel}>{scanLabel}</span>
        </div>
        <IssuesAgentLog lines={scout.activity} testid="scout-activity" />
      </section>
    </div>
  </div>
</section>
