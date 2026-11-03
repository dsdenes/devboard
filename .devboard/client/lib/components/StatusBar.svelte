<script lang="ts">
  import FolderGit2 from "lucide-svelte/icons/folder-git-2";
  import RefreshCw from "lucide-svelte/icons/refresh-cw";
  import { connection } from "../connection.svelte";
  import { goal } from "../goal.svelte";
  import { issues } from "../issues.svelte";
  import { issuesIndicatorTitle, issuesLabel as issuesLabelFor } from "../issues-label";
  import { layout } from "../layout.svelte";
  import { osNotifications } from "../os-notifications.svelte";
  import { providerIndicatorLabel, providerIndicatorTitle } from "../provider-label";
  import { providers } from "../providers.svelte";
  import { statusTone } from "../status-tone";
  import Button from "./ui/button.svelte";
  import CommandButton from "./CommandButton.svelte";
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

  const issuesLabel = $derived(
    issuesLabelFor(issues.lifecycle, issues.agents.length, issues.pending),
  );

  const issuesTitle = $derived(
    issuesIndicatorTitle({
      repo: issues.repo,
      lifecycle: issues.lifecycle,
      agents: issues.agents.length,
      workerPid: issues.snapshot?.worker?.pid ?? null,
      lastError: issues.snapshot?.lastError ?? null,
    }),
  );

  const providersLabel = $derived(providerIndicatorLabel(providers.selection));

  const providersTitle = $derived(
    providerIndicatorTitle({
      selection: providers.selection,
      refusal: providers.refusal,
      rule: providers.rule,
    }),
  );

  /**
   * A source checkout's second value is the source version a restart would
   * load, so it is labeled `source`; an installed host keeps `installed` for
   * the package under its npm prefix.
   */
  const installedLabel = $derived(connection.version?.source === true ? "source" : "installed");

  const versions = $derived(
    `running ${connection.version?.running ?? "unknown"} · ${installedLabel} ${
      connection.version?.installed ?? "unknown"
    }`,
  );

  const reloadLabel = $derived(
    `Restart devboard, running ${connection.version?.running ?? "unknown"}, ${installedLabel} ${
      connection.version?.installed ?? "unknown"
    }`,
  );
</script>

<footer class="status-bar" data-testid="status-bar">
  <div class="status-group">
    <span class="status-item" title={`WebSocket ${connection.state}`}>
      <span class="status-dot" data-state={connection.state} aria-hidden="true"></span>
      <span data-testid="status-connection">{connectionLabel}</span>
    </span>
    <span class="status-divider" aria-hidden="true"></span>
    <span class="status-item status-project" title={connection.projectPath}>
      <FolderGit2 size={12} aria-hidden="true" />
      <span class="mono" data-testid="status-project">{projectName}</span>
    </span>
    <Button
      bare
      class="status-item status-item--button status-providers"
      data-testid="providers-indicator"
      data-command="settings.providers"
      data-state={providers.selection === null ? "none" : providers.selection.provider}
      title={providersTitle}
      aria-label={`${providersLabel}. Open the Providers dialog.`}
      onclick={() => providers.openDialog()}
    >
      <span class="status-providers__dot" aria-hidden="true"></span>
      <span class="status-providers__label">{providersLabel}</span>
    </Button>
  </div>
  <span class="status-bar__spacer" aria-hidden="true"></span>
  <div class="status-group status-group--metrics">
    <span class="status-item" title="Running and total agent lanes">
      <span class="status-metric__label">lanes</span>
      <span class="mono status-metric__value">{goal.runningLanes}/{goal.lanes.length}</span>
    </span>
    <Button
      bare
      class="status-item status-item--button status-issues"
      data-testid="issues-indicator"
      data-command="view.mode.issues"
      data-state={issues.lifecycle}
      data-tone={statusTone(issues.lifecycle)}
      title={issuesTitle}
      aria-label={`${issuesLabel}. Open the Issues overview.`}
      onclick={() => layout.showIssuesOverview()}
    >
      <span class="status-issues__dot" aria-hidden="true"></span>
      <span class="status-issues__label">{issuesLabel}</span>
    </Button>
    <WatchdogIndicator />
    <Button
      bare
      class="status-item status-item--button status-notifications"
      data-testid="os-notifications"
      data-state={osNotifications.state}
      title={osNotifications.title}
      aria-label={osNotifications.label}
      onclick={() => void osNotifications.toggle()}
    >
      <span class="status-notifications__dot" aria-hidden="true"></span>
      <span class="status-notifications__label">notifications {osNotifications.state}</span>
    </Button>
    <span class="status-item status-versions" title={versions}>
      <span class="status-versions__entry">
        <span class="status-metric__label">running</span>
        <span class="mono">{connection.version?.running ?? "unknown"}</span>
      </span>
      <span class="status-versions__entry">
        <span class="status-metric__label">{installedLabel}</span>
        <span class="mono">{connection.version?.installed ?? "unknown"}</span>
      </span>
    </span>
    {#if connection.version?.replacement != null || connection.version?.stale === true}
      <CommandButton
        bare
        label="Reload"
        evidence={() => connection.version?.running}
        command={() => connection.requestRestart()}
        class="status-item status-item--button"
        data-testid="reload-devboard"
        data-command="app.reload"
        title={reloadLabel}
        aria-label={reloadLabel}
        disabled={connection.restarting}
      >
        <RefreshCw size={12} aria-hidden="true" />
        <span>reload</span>
      </CommandButton>
    {/if}
  </div>
</footer>
