<script lang="ts">
  import FolderGit2 from "lucide-svelte/icons/folder-git-2";
  import RefreshCw from "lucide-svelte/icons/refresh-cw";
  import { connection } from "../connection.svelte";
  import { goal } from "../goal.svelte";
  import { issues } from "../issues.svelte";
  import { layout } from "../layout.svelte";
  import IconButton from "./ui/icon-button.svelte";
  import WatchdogIndicator from "./watchdog-indicator.svelte";

  const connectionLabel = $derived(
    connection.state === "open"
      ? "Connected"
      : connection.state === "connecting"
        ? "Connecting"
        : "Disconnected",
  );

  /**
   * The status bar names the project, not its directory path: the sidebar owns
   * the full path, and a home-relative path is unreadable at 11px in a 26px bar.
   * The last segment is the worktree or repository name the operator recognizes;
   * the whole path stays in the tooltip.
   */
  const projectName = $derived.by(() => {
    const path = connection.projectPath.trim();
    if (path.length === 0) return "No project";
    const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0);
    return segments[segments.length - 1] ?? path;
  });

  const issuesLabel = $derived.by(() => {
    const pending = issues.pending;
    if (issues.lifecycle === "running") return `issues working (${issues.agents.length})`;
    if (issues.lifecycle === "pausing") return "issues pausing";
    if (issues.lifecycle === "paused") return "issues paused";
    if (issues.lifecycle === "failed") return "issues failed";
    if (issues.enabled) return pending > 0 ? `issues idle (${pending})` : "issues idle";
    return "issues stopped";
  });

  const issuesTitle = $derived.by(() => {
    const repo = issues.repo ?? "this checkout";
    const detail =
      issues.lifecycle === "failed" && issues.snapshot?.lastError !== null
        ? ` · ${issues.snapshot?.lastError}`
        : issues.snapshot?.worker === null || issues.snapshot?.worker === undefined
          ? ""
          : ` · worker pid ${issues.snapshot.worker.pid}`;
    return `Issues automation for ${repo} · ${issues.lifecycle} · ${issues.agents.length} running agent(s)${detail}`;
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
  <span class="status-item status-project" title={connection.projectPath}>
    <FolderGit2 size={12} aria-hidden="true" />
    <span class="mono" data-testid="status-project">{projectName}</span>
  </span>
  <span class="status-bar__spacer" aria-hidden="true"></span>
  <span class="status-item" title="Running and total agent lanes">
    <span class="mono">lanes {goal.runningLanes}/{goal.lanes.length}</span>
  </span>
  <button
    type="button"
    class="status-item status-issues"
    data-testid="issues-indicator"
    data-command="view.mode.issues"
    title={issuesTitle}
    aria-label={`${issuesLabel}. Open Issues mode.`}
    onclick={() => layout.setMode("issues")}
  >
    {issuesLabel}
  </button>
  <WatchdogIndicator />
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
