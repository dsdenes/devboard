<script lang="ts">
  import { issues } from "../issues.svelte";
  import type { WorkspaceTab } from "../layout.svelte";
  import Button from "./ui/button.svelte";
  import IssuesAgentLog from "./IssuesAgentLog.svelte";
  import IssuesAgentQuestion from "./IssuesAgentQuestion.svelte";

  interface Props {
    tab: WorkspaceTab;
    close: () => void;
    openRuns: () => void;
  }

  let { tab, close, openRuns }: Props = $props();

  const runId = $derived(tab.resourceId);
  const agent = $derived(issues.agentFor(runId));
  const detail = $derived(issues.run?.runId === runId ? issues.run : null);
  const lines = $derived(agent !== null ? issues.activityFor(runId) : (detail?.activityLines ?? []));
  const status = $derived(agent !== null ? "running" : (detail?.status ?? "unknown"));
  const unavailable = $derived(agent === null && detail === null && issues.runError !== null);

  // A finished run's final status and activity come from run history.
  $effect(() => {
    if (agent !== null) return;
    issues.loadRun(runId);
  });
</script>

<section class="issues-agent-focus" data-testid="issues-agent-focus" data-run={runId}>
  <header class="issues-overview__header">
    <div>
      <p class="muted">Issues · agent</p>
      <h1 class="issues-overview__title">{tab.title}</h1>
      <p class="issues-overview__repo mono">{issues.repoLabel}</p>
    </div>
    <span class="badge" data-tone={status === "failed" ? "error" : status === "running" ? "accent" : "success"} data-testid="issues-agent-focus-status">
      {status}
    </span>
    <Button
      variant="outline"
      data-testid="issues-agent-focus-close"
      data-command="tab.close"
      onclick={close}
    >
      Close
    </Button>
  </header>

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
    <div class="panel issues-activity-panel">
      <div class="panel__header">
        <h2 class="panel__title">Output</h2>
        <span class="panel__subtitle mono">{runId}</span>
      </div>
      <div class="panel__body stack-sm">
        <IssuesAgentLog lines={lines} testid="issues-agent-focus-activity" {runId} />
        {#if agent?.question}
          <IssuesAgentQuestion
            runId={runId}
            question={agent.question}
            testid="issues-agent-focus-question"
          />
        {/if}
      </div>
    </div>
  {/if}
</section>
