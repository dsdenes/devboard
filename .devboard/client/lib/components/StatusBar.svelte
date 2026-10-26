<script lang="ts">
  import RefreshCw from "lucide-svelte/icons/refresh-cw";
  import { connection } from "../connection.svelte";
  import { discover } from "../discover.svelte";
  import { flow } from "../flow.svelte";
  import { goal } from "../goal.svelte";
  import { layout } from "../layout.svelte";
  import IconButton from "./ui/icon-button.svelte";

  const connectionLabel = $derived(
    connection.state === "open"
      ? "Connected"
      : connection.state === "connecting"
        ? "Connecting"
        : "Disconnected",
  );

  const modeStatus = $derived.by(() => {
    if (layout.mode === "goal") {
      if (goal.lifecycleActive) {
        return goal.lifecycle.paused
          ? `Lifecycle paused · pass ${goal.lifecycle.pass}`
          : `Lifecycle ${goal.lifecycle.stage} · pass ${goal.lifecycle.pass}`;
      }
      if (goal.running) return `Running ${goal.runTitle ?? "ADR"}`;
      return `${goal.pendingCount} ADR${goal.pendingCount === 1 ? "" : "s"} pending`;
    }
    if (layout.mode === "flow") {
      const pr = flow.pr === null ? "" : ` · PR #${flow.pr.number} ${flow.pr.state}`;
      return `Flow ${flow.status}${pr}`;
    }
    if (discover.active) return `Discover running${discover.runId === null ? "" : ` · ${discover.runId}`}`;
    if (discover.stale) return "Discover artifacts stale";
    if (discover.busy !== null) return `Discover busy: ${discover.busy}`;
    return discover.hasArtifacts ? "Discover artifacts ready" : "Discover not run";
  });

  const versions = $derived(
    `running ${connection.version?.running ?? "unknown"} · installed ${
      connection.version?.installed ?? "unknown"
    }`,
  );
</script>

<footer class="status-bar" data-testid="status-bar">
  <span class="status-item" title={`WebSocket ${connection.state}`}>
    <span class="status-dot" data-state={connection.state} aria-hidden="true"></span>
    <span data-testid="status-connection">{connectionLabel}</span>
  </span>
  <span class="status-item status-item--grow" title={connection.projectPath}>
    <span class="mono" data-testid="status-project">{connection.projectPath || "No project"}</span>
  </span>
  <span class="status-item" title="Running and total agent lanes">
    <span class="mono">lanes {goal.runningLanes}/{goal.lanes.length}</span>
  </span>
  <span class="status-item" title="Active mode status" data-testid="status-mode">
    {modeStatus}
  </span>
  <span class="status-item status-versions" title={versions}>{versions}</span>
  {#if connection.version?.stale === true}
    <IconButton
      label={`Restart devboard, running ${connection.version?.running ?? "unknown"}, installed ${
        connection.version?.installed ?? "unknown"
      }`}
      command="app.reload"
      data-testid="reload-devboard"
      disabled={connection.restarting}
      onclick={() => connection.requestRestart()}
    >
      <RefreshCw size={14} aria-hidden="true" />
    </IconButton>
  {/if}
</footer>
