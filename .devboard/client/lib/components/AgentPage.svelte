<script lang="ts">
  import { agentRegistry } from "../../../server/agents/registry";
  import { agents } from "../agents.svelte";
  import { connection } from "../connection.svelte";
  import { statusTone } from "../status-tone";
  import type { AgentDocumentationEntry, AgentIssueRow } from "../types";
  import AgentActivityPanel from "./AgentActivityPanel.svelte";
  import AgentCyclesPanel from "./AgentCyclesPanel.svelte";
  import AgentDocumentationPanel from "./AgentDocumentationPanel.svelte";
  import AgentIssuesTable from "./AgentIssuesTable.svelte";
  import AgentPromptSection from "./AgentPromptSection.svelte";
  import SaveFeedback from "./SaveFeedback.svelte";
  import Button from "./ui/button.svelte";
  import Input from "./ui/input.svelte";
  import PageHeader from "./ui/page-header.svelte";

  interface Props {
    agentId: string;
  }

  let { agentId }: Props = $props();

  const descriptor = $derived(agentRegistry.get(agentId));
  const snapshot = $derived(agents.snapshot(agentId));
  const lifecycle = $derived(snapshot?.lifecycle ?? "stopped");
  const lifecycleTone = $derived(statusTone(lifecycle));
  const sync = $derived(snapshot?.sync ?? { state: "stale", at: null, error: null });
  const issues = $derived<AgentIssueRow[]>(snapshot?.issues ?? []);
  const documentation = $derived<AgentDocumentationEntry[]>(snapshot?.documentation ?? []);
  const detail = $derived(snapshot?.detail ?? null);
  const blocked = $derived(snapshot?.timer?.blocked === true);
  const showStop = $derived(
    snapshot?.owned === true &&
      (snapshot.lifecycle === "running" || snapshot.lifecycle === "stopping"),
  );
  const activity = $derived(agents.activity[agentId] ?? []);
  const activityScanId = $derived(
    agents.activityScan[agentId] ??
      (snapshot?.detail.panel === "activity" ? snapshot.detail.scanId : null),
  );

  // Opening this page asks for one fresh read instead of waiting for the next
  // cadence. The tracked connection state sends it if the socket was still
  // connecting when the page mounted; it never starts a worker or a scan.
  $effect(() => {
    if (descriptor === undefined) return;
    agents.refresh(agentId);
  });

  let cadenceText = $state("");
  let maxPerHourText = $state("");
  let maxPendingText = $state("");
  let settingsError = $state<string | null>(null);
  let lastSettings = $state("");

  // A snapshot that changes the saved settings wins over the fields; typing
  // never changes the snapshot, so an edit in progress is never overwritten.
  $effect(() => {
    const current = snapshot;
    if (current === null) return;
    const signature =
      `${current.cadence.minutes}/${current.limits.maxPerHour}/` +
      `${current.limits.maxPending}`;
    if (signature === lastSettings) return;
    lastSettings = signature;
    cadenceText = String(current.cadence.minutes);
    maxPerHourText = current.limits.maxPerHour === null ? "" : String(current.limits.maxPerHour);
    maxPendingText =
      current.limits.maxPending === null ? "" : String(current.limits.maxPending);
    settingsError = null;
  });

  function stamp(value: string | null): string {
    if (value === null) return "never";
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

  /** Empty is unlimited; undefined is invalid and sends nothing. */
  function parseLimit(value: string): number | null | undefined {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (!/^\d+$/.test(trimmed)) return undefined;
    const parsed = Number(trimmed);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : undefined;
  }

  function saveSettings(scope: string): void {
    const trimmed = cadenceText.trim();
    const minutes = Number(trimmed);
    if (
      !/^\d+$/.test(trimmed) ||
      !Number.isInteger(minutes) ||
      minutes < 1 ||
      minutes > 1440
    ) {
      settingsError = "The cadence must be an integer from 1 through 1440 minutes.";
      return;
    }
    const perHour = parseLimit(maxPerHourText);
    const pending = parseLimit(maxPendingText);
    if (perHour === undefined || pending === undefined) {
      settingsError = "Both limits must be empty or integers from 1 through 100.";
      return;
    }
    settingsError = null;
    agents.saveSettings(agentId, minutes, perHour, pending, scope);
  }
</script>

{#if descriptor === undefined}
  <section class="agent-page" data-testid="agent-page" data-agent={agentId}>
    <p class="issues-error" role="alert">Unknown background agent: {agentId}.</p>
  </section>
{:else}
  <section class="agent-page" data-testid="agent-page" data-agent={agentId} aria-label={descriptor.label}>
    <PageHeader
      title={descriptor.label}
      subtitle={descriptor.description}
      layout="bar"
      testid="agent-header"
    >
      {#snippet meta()}
        <span class="badge" data-tone={lifecycleTone} data-testid="agent-lifecycle" data-state={lifecycle}>
          {lifecycle}
        </span>
        <span class="agent-sync-at">
          Last read
          <span class="mono" data-testid="agent-sync-at" title={sync.at ?? "never"}>
            {#if sync.at === null}
              never
            {:else}
              <time datetime={sync.at}>{stamp(sync.at)}</time>
            {/if}
          </span>
        </span>
      {/snippet}
      {#snippet actions()}
        {#if showStop}
          <Button
            variant="default"
            data-testid="agent-stop"
            data-agent={agentId}
            data-id={agentId}
            data-command={`issues.${agentId}.stop`}
            disabled={lifecycle === "stopping"}
            onclick={() => agents.stop(agentId)}
          >
            Stop
          </Button>
        {:else}
          <Button
            variant="default"
            data-testid="agent-start"
            data-agent={agentId}
            data-id={agentId}
            data-command={`issues.${agentId}.start`}
            disabled={!connection.open || blocked || snapshot === null}
            onclick={() => agents.start(agentId)}
          >
            Start
          </Button>
        {/if}
      {/snippet}
      {#snippet footer()}
        <div class="agent-settings" role="group" aria-label="Cadence and filing limits">
          <div class="agent-settings__group" role="group" aria-label="Cadence">
            <span class="agent-settings__title">Cadence</span>
            <label class="agent-settings__field">
              <span>Every</span>
              <Input
                type="number"
                min="1"
                max="1440"
                step="1"
                inputmode="numeric"
                class="w-16 text-center"
                data-testid="agent-cadence"
                value={cadenceText}
                oninput={(event) => (cadenceText = event.currentTarget.value)}
              />
              <span class="agent-settings__unit">min</span>
            </label>
            <span class="agent-settings__run">
              Last run
              <span class="mono" data-testid="agent-last-run" title={snapshot?.cadence.lastRunAt ?? "never"}>
                {stamp(snapshot?.cadence.lastRunAt ?? null)}
              </span>
            </span>
            <span class="agent-settings__run">
              Next run
              <span class="mono" data-testid="agent-next-run" title={snapshot?.cadence.nextRunAt ?? "—"}>
                {stamp(snapshot?.cadence.nextRunAt ?? null)}
              </span>
            </span>
            <Button
              variant="secondary"
              data-testid="agent-save-cadence"
              data-command={`issues.${agentId}.settings.cadence`}
              onclick={() => saveSettings(`agent.cadence.${agentId}`)}
            >
              Save cadence
            </Button>
            <SaveFeedback scope={`agent.cadence.${agentId}`} />
          </div>
          <div class="agent-settings__group" role="group" aria-label="Filing limits">
            <span class="agent-settings__title">Filing limits</span>
            <label class="agent-settings__field">
              <span>Per hour</span>
              <Input
                type="number"
                min="1"
                max="100"
                step="1"
                inputmode="numeric"
                placeholder="unlimited"
                class="w-20 text-center"
                data-testid="agent-limit-hour"
                value={maxPerHourText}
                oninput={(event) => (maxPerHourText = event.currentTarget.value)}
              />
            </label>
            <label class="agent-settings__field">
              <span>Open issues</span>
              <Input
                type="number"
                min="1"
                max="100"
                step="1"
                inputmode="numeric"
                placeholder="unlimited"
                class="w-20 text-center"
                data-testid="agent-limit-pending"
                value={maxPendingText}
                oninput={(event) => (maxPendingText = event.currentTarget.value)}
              />
            </label>
            <Button
              variant="secondary"
              data-testid="agent-save-limits"
              data-command={`issues.${agentId}.settings.limits`}
              onclick={() => saveSettings(`agent.limits.${agentId}`)}
            >
              Save limits
            </Button>
            <SaveFeedback scope={`agent.limits.${agentId}`} />
          </div>
        </div>
      {/snippet}
    </PageHeader>

    {#key agentId}
      <AgentPromptSection {agentId} />
    {/key}

    {#if blocked && snapshot?.timer !== null && snapshot?.timer !== undefined}
      <div class="agent-blocked" data-testid="agent-blocked" role="status">
        <p>
          The legacy <span class="mono">{snapshot.timer.unit}</span> timer is active or enabled.
          Disable it before starting {descriptor.label}.
        </p>
        {#if snapshot.timer.error !== null}
          <p class="issues-error" role="alert">{snapshot.timer.error}</p>
        {/if}
        <Button
          variant="secondary"
          data-testid="agent-disable-timer"
          data-agent={agentId}
          onclick={() => agents.disableTimer(agentId)}
        >
          Disable legacy timer
        </Button>
      </div>
    {/if}

    {#if snapshot?.error !== null || sync.error !== null || settingsError !== null}
      <div class="agent-page__alerts">
        {#if sync.error !== null}
          <p class="issues-error" data-testid="agent-sync-error" role="alert">{sync.error}</p>
        {/if}
        {#if snapshot?.error !== null && snapshot?.error !== undefined}
          <p class="issues-error" data-testid="agent-error" role="alert">{snapshot.error}</p>
        {/if}
        {#if settingsError !== null}
          <p class="issues-error" data-testid="agent-settings-error" role="alert">
            {settingsError}
          </p>
        {/if}
      </div>
    {/if}

    <div class="agent-page__main">
      <div class="agent-page__column">
        {#if descriptor.documentation !== undefined}
          <AgentDocumentationPanel entries={documentation} />
        {/if}
        <section class="panel agent-page__issues" aria-label={`${descriptor.label} filed issues`}>
          <div class="panel__header">
            <h2 class="panel__title">Filed issues</h2>
            <span class="panel__subtitle" data-testid="agent-issues-count">{issues.length} filed</span>
          </div>
          <div class="panel__body panel__body--flush">
            <AgentIssuesTable {issues} agentLabel={descriptor.label} />
          </div>
        </section>
      </div>

      <div class="agent-page__detail" data-testid="agent-detail">
        {#if detail?.panel === "cycles"}
          <AgentCyclesPanel cycles={detail.cycles} />
        {:else}
          <AgentActivityPanel agentId={agentId} lines={activity} scanId={activityScanId} />
        {/if}
      </div>
    </div>
  </section>
{/if}

<style>
  .agent-page {
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 100%;
    min-height: 0;
    min-width: 0;
    overflow: auto;
    padding: 16px;
  }

  .agent-page__alerts {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .agent-blocked {
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 3px solid var(--warning, var(--accent));
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
  }

  .agent-blocked p {
    font-size: 12px;
    margin: 0;
  }

  /* Two overline groups, each ending in its own save control. */
  .agent-settings {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 24px;
    width: 100%;
  }

  .agent-settings__group {
    align-items: center;
    column-gap: 10px;
    display: flex;
    flex-wrap: wrap;
    row-gap: 6px;
  }

  .agent-settings__title {
    color: var(--muted-foreground);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    line-height: 1.2;
    text-transform: uppercase;
  }

  .agent-settings__field {
    align-items: center;
    color: var(--muted-foreground);
    display: flex;
    font-size: 11px;
    gap: 4px;
    white-space: nowrap;
  }

  .agent-settings__unit,
  .agent-settings__run {
    color: var(--muted-foreground);
    font-size: 11px;
    white-space: nowrap;
  }

  .agent-settings__run {
    align-items: center;
    display: inline-flex;
    gap: 4px;
  }

  .agent-settings__run .mono {
    font-variant-numeric: tabular-nums;
  }

  .agent-sync-at {
    color: var(--muted-foreground);
    font-size: 11px;
    white-space: nowrap;
  }

  .agent-page__main {
    display: grid;
    flex: 1 1 auto;
    gap: 12px;
    grid-template-columns: minmax(0, 1.45fr) minmax(340px, 0.9fr);
    min-height: 0;
  }

  .agent-page__column {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    min-width: 0;
  }

  .agent-page__column .agent-page__issues {
    flex: 1 1 auto;
  }

  .agent-page__issues,
  .agent-page__detail {
    min-height: 0;
    min-width: 0;
  }

  .agent-page__issues {
    display: flex;
    flex-direction: column;
  }

  .agent-page__issues :global(.panel__body) {
    flex: 1 1 auto;
    min-height: 0;
  }

  @media (max-width: 1100px) {
    .agent-page__main {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
