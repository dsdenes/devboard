<script lang="ts">
  import { agentRegistry } from "../../../server/agents/registry";
  import { agents } from "../agents.svelte";
  import { connection } from "../connection.svelte";
  import { layout } from "../layout.svelte";
  import type { AgentCycle, AgentDocumentationEntry, AgentIssueRow, AgentReleaseRow } from "../types";
  import AgentActivityBar from "./AgentActivityBar.svelte";
  import AgentDocumentationPanel from "./AgentDocumentationPanel.svelte";
  import AgentIssuesTable from "./AgentIssuesTable.svelte";
  import AgentPromptSection from "./AgentPromptSection.svelte";
  import AgentReleasesTable from "./AgentReleasesTable.svelte";
  import CommandButton from "./CommandButton.svelte";
  import SaveFeedback from "./SaveFeedback.svelte";
  import Input from "./ui/input.svelte";
  import PageHeader from "./ui/page-header.svelte";

  interface Props {
    agentId: string;
  }

  let { agentId }: Props = $props();

  const descriptor = $derived(agentRegistry.get(agentId));
  const snapshot = $derived(agents.snapshot(agentId));
  const lifecycle = $derived(snapshot?.lifecycle ?? "stopped");
  const sync = $derived(snapshot?.sync ?? { state: "stale", at: null, error: null });
  const issues = $derived<AgentIssueRow[]>(snapshot?.issues ?? []);
  const releases = $derived<AgentReleaseRow[]>(snapshot?.releases ?? []);
  const documentation = $derived<AgentDocumentationEntry[]>(snapshot?.documentation ?? []);
  const detail = $derived(snapshot?.detail ?? null);
  const blocked = $derived(snapshot?.timer?.blocked === true);
  const showStop = $derived(
    snapshot?.owned === true &&
      (snapshot.lifecycle === "running" || snapshot.lifecycle === "stopping"),
  );
  const activity = $derived(agents.activity[agentId] ?? []);
  const barState = $derived(
    lifecycle === "running" || lifecycle === "starting" || lifecycle === "stopping"
      ? ("running" as const)
      : lifecycle === "failed"
        ? ("failed" as const)
        : lifecycle === "stopped"
          ? ("stopped" as const)
          : ("idle" as const),
  );
  const barStartedAt = $derived(
    barState === "running" ? (snapshot?.cadence.lastRunAt ?? null) : null,
  );
  const cycles = $derived(detail?.panel === "cycles" ? detail.cycles : []);
  // A Watchdog or Coach page follows cycles instead of a scan log; the bar's
  // expansion is the one place either history renders.
  const barActivity = $derived(
    detail?.panel === "cycles" ? cycles.slice().reverse().map(cycleLine) : activity,
  );

  function cycleLine(cycle: AgentCycle): string {
    const parts = [cycle.at, cycle.action];
    const window = `${cycle.window.start ?? "—"} – ${cycle.window.end ?? "—"}`;
    parts.push(window);
    parts.push(`${cycle.findings} finding(s)`);
    if (cycle.reason !== undefined) parts.push(cycle.reason);
    if (cycle.issues.length > 0) parts.push(cycle.issues.join(", "));
    return parts.join(" · ");
  }

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
    <AgentActivityBar
      identity={`${layout.mode}:${agentId}`}
      label={descriptor.label}
      status={barState}
      activity={barActivity}
      startedAt={barStartedAt}
    >
      {#snippet control()}
        {#if showStop}
          <CommandButton
            variant="default"
            label="Stop"
            evidence={() => agents.lifecycle(agentId)}
            command={() => agents.stop(agentId)}
            data-testid="agent-stop"
            data-agent={agentId}
            data-id={agentId}
            data-command={`issues.${agentId}.stop`}
            disabled={lifecycle === "stopping"}
          >
            Stop
          </CommandButton>
        {:else}
          <CommandButton
            variant="default"
            label="Start"
            evidence={() => agents.lifecycle(agentId)}
            command={() => agents.start(agentId)}
            data-testid="agent-start"
            data-agent={agentId}
            data-id={agentId}
            data-command={`issues.${agentId}.start`}
            disabled={!connection.open || blocked || snapshot === null}
          >
            Start
          </CommandButton>
        {/if}
      {/snippet}
    </AgentActivityBar>

    <div class="agent-page__scroll">
    <PageHeader
      title={descriptor.label}
      subtitle={descriptor.description}
      layout="bar"
      testid="agent-header"
    >
      {#snippet meta()}
        {#if snapshot !== null && snapshot.workers.length > 0}
          <span class="agent-workers" data-testid="agent-workers" aria-label="Live workers">
            {#each snapshot.workers as worker (worker.pid)}
              <span
                class="mono agent-worker"
                data-testid="agent-worker"
                data-version={worker.version ?? "unknown"}
                data-pid={worker.pid}
              >
                {worker.version ?? "unknown"}
              </span>
            {/each}
          </span>
        {/if}
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
            <CommandButton
              variant="secondary"
              label="Save cadence"
              busyLabel="Saving…"
              evidence={() => agents.snapshot(agentId)?.detail}
              command={() => saveSettings(`agent.cadence.${agentId}`)}
              data-testid="agent-save-cadence"
              data-command={`issues.${agentId}.settings.cadence`}
            >
              Save cadence
            </CommandButton>
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
            <CommandButton
              variant="secondary"
              label="Save limits"
              busyLabel="Saving…"
              evidence={() => agents.snapshot(agentId)?.detail}
              command={() => saveSettings(`agent.limits.${agentId}`)}
              data-testid="agent-save-limits"
              data-command={`issues.${agentId}.settings.limits`}
            >
              Save limits
            </CommandButton>
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
        <CommandButton
          variant="secondary"
          label="Disable legacy timer"
          busyLabel="Disabling…"
          evidence={() => agents.snapshot(agentId)?.detail}
          command={() => agents.disableTimer(agentId)}
          data-testid="agent-disable-timer"
          data-agent={agentId}
        >
          Disable legacy timer
        </CommandButton>
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
        {#if descriptor.releases !== undefined}
          <section class="panel agent-page__releases" aria-label={`${descriptor.label} release history`}>
            <div class="panel__header">
              <h2 class="panel__title">Releases</h2>
              <span class="panel__subtitle" data-testid="agent-releases-count">
                {releases.length} released
              </span>
            </div>
            <div class="panel__body panel__body--flush">
              <AgentReleasesTable {releases} />
            </div>
          </section>
        {:else}
          <section class="panel agent-page__issues" aria-label={`${descriptor.label} filed issues`}>
            <div class="panel__header">
              <h2 class="panel__title">Filed issues</h2>
              <span class="panel__subtitle" data-testid="agent-issues-count">{issues.length} filed</span>
            </div>
            <div class="panel__body panel__body--flush">
              <AgentIssuesTable {issues} agentLabel={descriptor.label} />
            </div>
          </section>
        {/if}
      </div>
    </div>
    </div>
  </section>
{/if}

<style>
  .agent-page {
    display: flex;
    flex-direction: column;
    gap: 8px;
    height: 100%;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    padding: 16px;
  }

  .agent-page__scroll {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    min-width: 0;
    overflow: auto;
    padding: 0 8px 8px;
  }

  .agent-page__alerts {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .agent-blocked {
    background: var(--surface);
    border: 1px solid var(--border);
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
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
  }

  .agent-page__column {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    min-width: 0;
  }

  .agent-page__column .agent-page__issues,
  .agent-page__column .agent-page__releases {
    flex: 1 1 auto;
  }

  .agent-page__issues,
  .agent-page__releases {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }

  .agent-page__issues :global(.panel__body),
  .agent-page__releases :global(.panel__body) {
    flex: 1 1 auto;
    min-height: 0;
  }
</style>
