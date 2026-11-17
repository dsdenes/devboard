<script lang="ts">
  import { untrack } from "svelte";
  import { agentRegistry } from "../../../lib/agent-registry.ts";
  import { agents } from "../agents.svelte";
  import { connection } from "../connection.svelte";
  import { layout } from "../layout.svelte";
  import { pageVisibility } from "../page-visibility.svelte";
  import { statusTone } from "../status-tone";
  import type {
    AgentCycle,
    AgentDeployRow,
    AgentDocumentationEntry,
    AgentIssueRow,
    AgentReleaseRow,
    AgentSync,
    AgentWorker,
  } from "../types";
  import AgentActivityBar from "./AgentActivityBar.svelte";
  import AgentDeploysTable from "./AgentDeploysTable.svelte";
  import AgentDocumentationPanel from "./AgentDocumentationPanel.svelte";
  import AgentIssuesTable from "./AgentIssuesTable.svelte";
  import AgentPromptSection from "./AgentPromptSection.svelte";
  import AgentReleasesTable from "./AgentReleasesTable.svelte";
  import AgentSettings from "./AgentSettings.svelte";
  import ReleaseRunPanel from "./ReleaseRunPanel.svelte";
  import CommandButton from "./CommandButton.svelte";
  import SaveFeedback from "./SaveFeedback.svelte";
  import PageHeader from "./ui/page-header.svelte";

  interface Props {
    agentId: string;
  }

  let { agentId }: Props = $props();

  const descriptor = $derived(agentRegistry.get(agentId));
  const snapshot = $derived(agents.snapshot(agentId));
  const lifecycle = $derived(snapshot?.lifecycle ?? "stopped");
  const sync = $derived<AgentSync>(snapshot?.sync ?? { state: "stale", at: null, error: null });
  // Deploy on main lists its runs in one history panel; the run-status line
  // that used to sit under the prompt repeats what a row already states.
  const RUN_STATUS_NOTICE_PREFIXES = [
    "deploying ",
    "deployed ",
    "deploy failed:",
    "deploy skipped:",
    "deploy stopped:",
  ];
  const notice = $derived(snapshot?.notice ?? null);
  const visibleNotice = $derived(
    notice !== null &&
      descriptor?.deploys !== undefined &&
      RUN_STATUS_NOTICE_PREFIXES.some((prefix) => notice.startsWith(prefix))
      ? null
      : notice,
  );
  const issues = $derived<AgentIssueRow[]>(snapshot?.issues ?? []);
  const releases = $derived<AgentReleaseRow[]>(snapshot?.releases ?? []);
  const deploys = $derived<AgentDeployRow[]>(snapshot?.deploys ?? []);
  const releaseRun = $derived(agents.releaseRun(agentId));
  const releaseGate = $derived(agents.releaseGate(agentId));
  // The run panel belongs to the Release Train page and only when the server
  // carries a run or a gate verdict; every other agent renders without it.
  const showReleaseRun = $derived(
    agentId === "release-train" && (releaseRun !== null || releaseGate !== null),
  );
  const documentation = $derived<AgentDocumentationEntry[]>(snapshot?.documentation ?? []);
  const detail = $derived(snapshot?.detail ?? null);
  const blocked = $derived(snapshot?.timer?.blocked === true);
  // A project gate says this checkout never runs the family. The page keeps
  // every read-only fact and drops the Start control, so the operator cannot
  // ask for a worker the server refuses.
  const gated = $derived(snapshot?.availability?.state === "disabled");
  const gateReason = $derived(gated ? (snapshot?.availability.reason ?? null) : null);
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
    barState === "running" ? earliestWorkerStart(snapshot?.workers ?? []) : null,
  );
  const cycles = $derived(detail?.panel === "cycles" ? detail.cycles : []);
  // A cycle family's page names the filing queue beside its filed count: after a
  // capped, deferred, or skipped cycle the findings stay pending, so a
  // count-only subtitle would assert a queue size it never shows.
  const issuesCountLabel = $derived(
    detail?.panel === "cycles"
      ? `${issues.length} filed · ${snapshot?.pending ?? 0} pending filing`
      : `${issues.length} filed`,
  );
  // A Watchdog or MCP optimizer page follows cycles instead of a scan log; the bar's
  // expansion is the one place either history renders.
  const barActivity = $derived(
    detail?.panel === "cycles" ? cycles.slice().reverse().map(cycleLine) : activity,
  );

  // The bar's `running since` is how long the worker process itself has run, so
  // it reads the earliest live worker start. `cadence.lastRunAt` is the last
  // scan's start, which advances on every cadence tick and is labelled `Last
  // run` below; feeding it here claimed one instant under two labels. A frame
  // from a server that sent no worker start makes no uptime claim at all.
  function earliestWorkerStart(workers: AgentWorker[]): string | null {
    let earliest: string | null = null;
    for (const worker of workers) {
      if (worker.startedAt === null) continue;
      if (earliest === null || worker.startedAt < earliest) earliest = worker.startedAt;
    }
    return earliest;
  }

  /** A running family's cap occupancy: the deferral line's `<starter> <count>`. */
  function peerCountLabel(peers: number): string {
    if (peers === 0) return "no peer";
    if (peers === 1) return "1 peer";
    return `${peers} peers`;
  }

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
  // cadence, and it asks once per open: a page mounted while the socket still
  // connects sends when it opens, and switching to another agent sends for
  // that agent. Nothing a pushed frame writes sends again. The send itself is
  // untracked: `connection.send` runs the app root's TanStack mutation, and
  // reading that mutation's reactive result inside this effect would make the
  // effect its own trigger and send on every mutation update.
  //
  // A page the operator cannot see asks for nothing. Every mode workspace
  // stays mounted, so a page left behind a shown mode would otherwise send
  // while another mode renders, and a document the browser reports as hidden
  // defers that work and throttles its timers anyway. The page asks its one
  // read on the first moment it is on screen in a visible document; leaving
  // that state drops the claim, so returning to the page asks again.
  let refreshedAgent: string | null = null;
  let refreshedOpen = false;

  $effect(() => {
    if (descriptor === undefined) return;
    const open = connection.open;
    if (!open || layout.mode !== "devboard" || !pageVisibility.visible) {
      refreshedOpen = false;
      return;
    }
    if (refreshedOpen && refreshedAgent === agentId) return;
    refreshedOpen = true;
    refreshedAgent = agentId;
    untrack(() => agents.refresh(agentId));
  });

  let cadenceText = $state("");
  let maxPerHourText = $state("");
  let maxPendingText = $state("");
  // The refusal names the settings group that owns the invalid field, so the
  // page renders it beside those fields instead of in the page alert stack.
  let settingsError = $state<{ field: "cadence" | "limits"; message: string } | null>(null);
  let settingsAgent = $state("");
  let lastSettings = $state("");

  // One page instance serves every background-agent tab; the workspace swaps
  // the `agentId` prop instead of remounting. The identity therefore belongs in
  // the comparison: a different agent always rewrites the fields, even when its
  // saved settings match the previous agent's. Within one agent, typing never
  // changes the snapshot, so an edit in progress is never overwritten.
  $effect(() => {
    const current = snapshot;
    if (current === null) return;
    const signature =
      `${current.cadence?.minutes ?? "-"}/${current.limits.maxPerHour}/` +
      `${current.limits.maxPending}`;
    if (agentId === settingsAgent && signature === lastSettings) return;
    settingsAgent = agentId;
    lastSettings = signature;
    cadenceText = current.cadence === null ? "" : String(current.cadence.minutes);
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

  /**
   * One save validates all three fields and sends one settings command. A
   * push-triggered family persists no interval, so its save sends `null` for
   * the interval and the field's text is never read. Returns false when it
   * sent nothing: a refused save shows its own message and never claims the
   * action received no answer.
   */
  function saveSettings(scope: string): boolean {
    let minutes: number | null = null;
    if (descriptor?.cadence !== undefined) {
      const trimmed = cadenceText.trim();
      const parsed = Number(trimmed);
      if (
        !/^\d+$/.test(trimmed) ||
        !Number.isInteger(parsed) ||
        parsed < 1 ||
        parsed > 1440
      ) {
        settingsError = {
          field: "cadence",
          message: "The cadence must be an integer from 1 through 1440 minutes.",
        };
        return false;
      }
      minutes = parsed;
    }
    const perHour = parseLimit(maxPerHourText);
    const pending = parseLimit(maxPendingText);
    if (perHour === undefined || pending === undefined) {
      settingsError = {
        field: "limits",
        message: "Both limits must be empty or integers from 1 through 100.",
      };
      return false;
    }
    settingsError = null;
    return agents.saveSettings(agentId, minutes, perHour, pending, scope);
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
            scope={() => agentId}
            evidence={() => agents.revision(agentId)}
            command={() => agents.stop(agentId)}
            data-testid="agent-stop"
            data-agent={agentId}
            data-id={agentId}
            data-command={`issues.${agentId}.stop`}
            disabled={lifecycle === "stopping"}
          >
            Stop
          </CommandButton>
        {:else if !gated}
          <CommandButton
            variant="default"
            label="Start"
            scope={() => agentId}
            evidence={() => agents.revision(agentId)}
            command={() => agents.start(agentId)}
            data-testid="agent-start"
            data-agent={agentId}
            data-id={agentId}
            data-command={`issues.${agentId}.start`}
            disabled={!connection.open || blocked || snapshot === null || lifecycle === "starting"}
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
        <!-- `running` is the worker process, not its work: a family between
             cadence ticks holds no cap slot, and this count is the one the
             Issues deferral line groups by starter. -->
        {#if lifecycle === "running"}
          <span
            class="badge"
            data-tone={snapshot !== null && snapshot.peers > 0 ? "accent" : undefined}
            data-testid="agent-peers"
            data-peers={snapshot?.peers ?? 0}
            aria-label="Agent peers holding the cap"
            title="Agent peers this family holds against the global cap right now"
          >
            {peerCountLabel(snapshot?.peers ?? 0)}
          </span>
        {/if}
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
        <!-- The server's forge-sync verdict is the header's health fact; the
             reason a non-`ok` read failed stays in the alert below. -->
        <span class="agent-sync" role="group" aria-label="Forge read">
          <span
            class="badge"
            data-tone={statusTone(sync.state)}
            data-testid="agent-sync-state"
          >
            {sync.state}
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
        </span>
      {/snippet}
      {#snippet footer()}
        {#if descriptor.limits !== undefined}
          <AgentSettings
            bind:cadenceText
            bind:maxPerHourText
            bind:maxPendingText
            cadence={descriptor.cadence !== undefined}
            lastRunAt={snapshot?.cadence?.lastRunAt ?? null}
            nextRunAt={snapshot?.cadence?.nextRunAt ?? null}
            cadenceError={settingsError?.field === "cadence" ? settingsError.message : null}
            limitsError={settingsError?.field === "limits" ? settingsError.message : null}
          >
            {#snippet cadenceActions()}
              <CommandButton
                variant="secondary"
                label="Save cadence"
                busyLabel="Saving…"
                scope={() => agentId}
                evidence={() => agents.settingsEcho(agentId)}
                command={() => saveSettings(`agent.cadence.${agentId}`)}
                data-testid="agent-save-cadence"
                data-command={`issues.${agentId}.settings.cadence`}
                disabled={!connection.open || snapshot === null}
              >
                Save cadence
              </CommandButton>
              <SaveFeedback scope={`agent.cadence.${agentId}`} />
            {/snippet}
            {#snippet limitsActions()}
              <CommandButton
                variant="secondary"
                label="Save limits"
                busyLabel="Saving…"
                scope={() => agentId}
                evidence={() => agents.settingsEcho(agentId)}
                command={() => saveSettings(`agent.limits.${agentId}`)}
                data-testid="agent-save-limits"
                data-command={`issues.${agentId}.settings.limits`}
                disabled={!connection.open || snapshot === null}
              >
                Save limits
              </CommandButton>
              <SaveFeedback scope={`agent.limits.${agentId}`} />
            {/snippet}
          </AgentSettings>
        {/if}
      {/snippet}
    </PageHeader>

    {#if gated && gateReason !== null}
      <p class="agent-gate" data-testid="agent-gate" role="status">{gateReason}</p>
    {/if}

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
          scope={() => agentId}
          evidence={() => agents.snapshot(agentId)?.timer?.blocked}
          command={() => agents.disableTimer(agentId)}
          data-testid="agent-disable-timer"
          data-agent={agentId}
        >
          Disable legacy timer
        </CommandButton>
      </div>
    {/if}

    {#if visibleNotice !== null}
      <p class="agent-notice" data-testid="agent-notice" role="status">{visibleNotice}</p>
    {/if}

    {#if snapshot?.error !== null || sync.error !== null}
      <div class="agent-page__alerts">
        {#if sync.error !== null}
          <p class="issues-error" data-testid="agent-sync-error" role="alert">{sync.error}</p>
        {/if}
        {#if snapshot?.error !== null && snapshot?.error !== undefined}
          <p class="issues-error" data-testid="agent-error" role="alert">{snapshot.error}</p>
        {/if}
      </div>
    {/if}

    {#if showReleaseRun}
      <ReleaseRunPanel
        run={releaseRun}
        gate={releaseGate}
        nextRunAt={snapshot?.cadence?.nextRunAt ?? null}
      />
    {/if}

    <div class="agent-page__main">
      <div class="agent-page__column">
        {#if descriptor.documentation !== undefined}
          <AgentDocumentationPanel entries={documentation} />
        {/if}
        {#if descriptor.deploys !== undefined}
          <section class="panel agent-page__deploys" aria-label={`${descriptor.label} deploy history`}>
            <div class="panel__header">
              <h2 class="panel__title">Deploy history</h2>
            </div>
            <div class="panel__body panel__body--flush">
              <AgentDeploysTable {deploys} />
            </div>
          </section>
        {:else if descriptor.releases !== undefined}
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
              <span class="panel__subtitle" data-testid="agent-issues-count">{issuesCountLabel}</span>
            </div>
            <div class="panel__body panel__body--flush">
              <AgentIssuesTable {issues} agentLabel={descriptor.label} {sync} />
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

  /* A live worker this dashboard does not own: why Start starts nothing. */
  .agent-notice {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--muted-foreground);
    font-size: 12px;
    margin: 0;
    padding: 8px 12px;
  }

  /* A family this project never runs: the reason replaces the Start control. */
  .agent-gate {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--muted-foreground);
    font-size: 12px;
    margin: 0;
    padding: 8px 12px;
  }
  .agent-sync {
    align-items: center;
    display: inline-flex;
    gap: 6px;
    white-space: nowrap;
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
  .agent-page__column .agent-page__deploys,
  .agent-page__column .agent-page__releases {
    flex: 1 1 auto;
  }

  .agent-page__issues,
  .agent-page__deploys,
  .agent-page__releases {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }

  .agent-page__issues :global(.panel__body),
  .agent-page__deploys :global(.panel__body),
  .agent-page__releases :global(.panel__body) {
    flex: 1 1 auto;
    min-height: 0;
  }
</style>
