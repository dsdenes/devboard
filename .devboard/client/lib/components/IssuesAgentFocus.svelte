<script lang="ts">
  import { connection } from "../connection.svelte";
  import { relativeTime } from "../discover-format";
  import { issues } from "../issues.svelte";
  import { versionLabel } from "../issues-label";
  import { layout } from "../layout.svelte";
  import type { WorkspaceTab } from "../layout.svelte";
  import AgentActivityBar from "./AgentActivityBar.svelte";
  import Button from "./ui/button.svelte";
  import IssuesAgentLog from "./IssuesAgentLog.svelte";
  import IssuesQuestion from "./IssuesQuestion.svelte";
  import PageHeader from "./ui/page-header.svelte";

  interface Props {
    tab: WorkspaceTab;
    close: () => void;
    openRuns: () => void;
  }

  let { tab, close, openRuns }: Props = $props();

  const runId = $derived(tab.resourceId);
  const agent = $derived(issues.agentFor(runId));
  const detail = $derived(issues.run?.runId === runId ? issues.run : null);
  // The run's own read carries its whole log. The Issues state read carries
  // only the newest lines of each running agent, so a live agent's page shows
  // the run read as soon as it lands and the preview until then.
  const lines = $derived(detail !== null ? detail.activityLines : issues.activityFor(runId));
  const unavailable = $derived(agent === null && detail === null && issues.missingRun === runId);
  const harnessVersion = $derived(detail?.harnessVersion ?? issues.versionForRun(runId));
  const startedAt = $derived(agent?.startedAt ?? detail?.startedAt ?? null);
  let now = $state(Date.now());
  const startedLabel = $derived(startedAt === null ? "" : relativeTime(startedAt, now));
  const barState = $derived(
    agent !== null
      ? ("running" as const)
      : detail?.status === "succeeded"
        ? ("succeeded" as const)
        : detail?.status === "failed"
          ? ("failed" as const)
          : detail?.status === "stopped"
            ? ("stopped" as const)
            : ("idle" as const),
  );
  const barStartedAt = $derived(barState === "running" ? startedAt : null);

  // The tab names the run it shows, so a history answer for any other run is
  // never stored as this page's history: a quick switch leaves the older
  // answer in flight, and a live agent's tab reads its run at the live cadence
  // without ever opening it.
  $effect(() => {
    issues.showRun(runId);
  });

  // A finished run's final status and activity come from run history. A reload
  // restores this tab before the socket opens and before the replay names the
  // live agents, so the request waits for both: a send rejected while closed,
  // or one made before the replay, would strand or stale the run detail.
  $effect(() => {
    if (agent !== null || !connection.open || !issues.ready) return;
    issues.loadRun(runId);
  });

  // The header's relative start stays current without a reload.
  $effect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });
</script>

<section class="issues-agent-focus" data-testid="issues-agent-focus" data-run={runId}>
  <AgentActivityBar
    identity={`${layout.mode}:${tab.id}`}
    label={tab.title}
    status={barState}
    activity={lines}
    startedAt={barStartedAt}
    waiting={agent?.question != null}
  />
  <div class="issues-agent-focus__scroll">
    <PageHeader
      flat
      eyebrow="Issues · agent"
      title={tab.title}
      subtitle={issues.repoLabel}
      testid="issues-agent-focus-header"
    >
      {#snippet meta()}
        <p class="muted mono" data-testid="issues-agent-focus-version">
          worker {versionLabel(harnessVersion)}
        </p>
      {/snippet}
      {#snippet actions()}
        <Button
          variant="outline"
          data-testid="issues-agent-focus-close"
          data-command="tab.close"
          onclick={close}
        >
          Close
        </Button>
      {/snippet}
    </PageHeader>

    {#if unavailable}
      <div class="panel" data-testid="issues-agent-focus-unavailable">
        <div class="panel__body stack-sm">
          <p class="muted">This run is no longer available in run history.</p>
          <Button variant="outline" data-command="open.issues.runs" onclick={openRuns}>
            Open Runs
          </Button>
        </div>
      </div>
    {:else if agent === null && detail === null}
      <div class="panel">
        <div class="panel__body">
          <p class="muted">Loading the run from history…</p>
        </div>
      </div>
    {:else}
      <section class="panel issues-activity-panel issues-agent-focus__output">
        <div class="panel__header">
          <h2 class="panel__title">Output</h2>
          <span class="issues-run-identity" data-testid="issues-agent-focus-run">
            <span class="issues-run-identity__label">Run</span>
            <code
              class="code-chip issues-run-identity__id"
              title={`Run identifier: ${runId}`}
              data-testid="issues-agent-focus-run-id"
            >
              {runId}
            </code>
            {#if startedAt !== null}
              <span
                class="issues-run-identity__started"
                title={`Started ${startedAt}`}
                data-testid="issues-agent-focus-run-started"
              >
                Started {startedLabel}
              </span>
            {/if}
          </span>
        </div>
        <div class="panel__body stack-sm">
          <IssuesAgentLog lines={lines} testid="issues-agent-focus-activity" {runId} />
          {#if agent?.question}
            <IssuesQuestion
              runId={runId}
              question={agent.question}
              answerRevision={() => issues.answerRevision(runId)}
              testid="issues-agent-focus-question"
            />
          {/if}
        </div>
      </section>
    {/if}
  </div>
</section>
