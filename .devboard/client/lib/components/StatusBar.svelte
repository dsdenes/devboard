<script lang="ts">
  import FolderGit2 from "lucide-svelte/icons/folder-git-2";
  import RefreshCw from "lucide-svelte/icons/refresh-cw";
  import { connection } from "../connection.svelte";
  import { goal } from "../goal.svelte";
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
    const state = connection.orchestrator;
    if (state === null || state.present === false) return "";
    if (state.status === "running") return `issues working (${state.open})`;
    if (state.status === "failed") return "issues failed";
    return "issues idle";
  });

  const issuesTitle = $derived.by(() => {
    const state = connection.orchestrator;
    if (state === null || state.present === false) return "";
    if (state.status === "running") {
      const since = state.startedAt === null ? "" : ` · working since ${state.startedAt}`;
      return `Issue orchestrator for ${state.repo}${since}`;
    }
    if (state.status === "failed") {
      const reason = state.lastError === null ? "" : ` · ${state.lastError}`;
      return `Issue orchestrator for ${state.repo} · last run failed${reason}`;
    }
    return `Issue orchestrator for ${state.repo} · idle`;
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
  {#if connection.orchestrator?.present === true}
    <span class="status-item" data-testid="status-issues" title={issuesTitle}>{issuesLabel}</span>
  {/if}
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
