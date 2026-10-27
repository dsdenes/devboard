<script lang="ts">
  import { Tooltip } from "bits-ui";
  import Bell from "lucide-svelte/icons/bell";
  import Compass from "lucide-svelte/icons/compass";
  import Flag from "lucide-svelte/icons/flag";
  import Moon from "lucide-svelte/icons/moon";
  import Search from "lucide-svelte/icons/search";
  import Sun from "lucide-svelte/icons/sun";
  import Target from "lucide-svelte/icons/target";
  import Workflow from "lucide-svelte/icons/workflow";
  import { discover } from "../discover.svelte";
  import { flow } from "../flow.svelte";
  import { goal } from "../goal.svelte";
  import { layout } from "../layout.svelte";
  import { notifications } from "../notifications.svelte";
  import type { FeedbackPhase } from "../types";
  import IconButton from "./ui/icon-button.svelte";

  interface Props {
    onopenpalette: () => void;
    onreportissue: () => void;
    reportphase: FeedbackPhase;
  }

  let { onopenpalette, onreportissue, reportphase }: Props = $props();

  const tooltipClass =
    "z-50 rounded-sm border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2 py-1 text-[11px] text-[var(--foreground)] shadow-md";

  type ModeState = "running" | "attention" | "idle" | "stale" | null;

  const goalState = $derived<ModeState>(
    goal.question !== null || goal.runState === "stopped"
      ? "attention"
      : goal.lifecycleActive && goal.lifecycle.paused
        ? "attention"
        : goal.lifecycleActive || goal.running
          ? "running"
          : goal.pendingCount > 0
            ? "idle"
            : null,
  );
  const flowState = $derived<ModeState>(
    flow.status === "running"
      ? "running"
      : flow.status === "none"
        ? null
        : flow.blockers.some((blocker) => !blocker.dismissed)
          ? "attention"
          : "idle",
  );
  const discoverState = $derived<ModeState>(
    discover.active ? "running" : discover.stale ? "stale" : discover.busy !== null ? "attention" : null,
  );

  const stateWords: Record<Exclude<ModeState, null>, string> = {
    running: "work running",
    attention: "needs attention",
    idle: "idle",
    stale: "artifacts stale",
  };

  function modeLabel(base: string, state: ModeState): string {
    return state === null ? base : `${base}, ${stateWords[state]}`;
  }

  const notificationLabel = $derived(
    `Notifications${notifications.unread > 0 ? `, ${notifications.unread} unread` : ""}`,
  );
  const themeLabel = $derived(
    layout.theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
  );
  const reportLabel = $derived(
    reportphase === "picking"
      ? "Cancel element selection"
      : reportphase === "composing" || reportphase === "failed"
        ? "Cancel UI issue report"
        : reportphase === "sending"
          ? "Filing the UI issue"
          : "Report a UI issue",
  );
</script>

<div class="activity-bar" data-testid="activity-bar" aria-label="Devboard application menu">
  <div class="activity-bar__modes" role="tablist" aria-label="Devboard modes">
    <Tooltip.Root>
      <Tooltip.Trigger
        role="tab"
        id="mode-goal-tab"
        aria-controls="workspace-goal"
        aria-selected={layout.mode === "goal"}
        aria-label={modeLabel("Goal (Alt+1)", goalState)}
        title={modeLabel("Goal — Alt+1", goalState)}
        data-testid="mode-goal"
        data-command="view.mode.goal"
        class="activity-tab"
        onclick={() => layout.setMode("goal")}
      >
        <Target size={18} strokeWidth={1.7} aria-hidden="true" />
        <span class="activity-tab__label">Goal</span>
        {#if goalState !== null}
          <span class="activity-tab__state" data-state={goalState} aria-hidden="true"></span>
        {/if}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content sideOffset={6} class={tooltipClass}>Goal — Alt+1</Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>

    <Tooltip.Root>
      <Tooltip.Trigger
        role="tab"
        id="mode-flow-tab"
        aria-controls="workspace-flow"
        aria-selected={layout.mode === "flow"}
        aria-label={modeLabel("Flow (Alt+2)", flowState)}
        title={modeLabel("Flow — Alt+2", flowState)}
        data-testid="mode-flow"
        data-command="view.mode.flow"
        class="activity-tab"
        onclick={() => layout.setMode("flow")}
      >
        <Workflow size={18} strokeWidth={1.7} aria-hidden="true" />
        <span class="activity-tab__label">Flow</span>
        {#if flowState !== null}
          <span class="activity-tab__state" data-state={flowState} aria-hidden="true"></span>
        {/if}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content sideOffset={6} class={tooltipClass}>Flow — Alt+2</Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>

    <Tooltip.Root>
      <Tooltip.Trigger
        role="tab"
        id="mode-discover-tab"
        aria-controls="workspace-discover"
        aria-selected={layout.mode === "discover"}
        aria-label={modeLabel("Discover (Alt+3)", discoverState)}
        title={modeLabel("Discover — Alt+3", discoverState)}
        data-testid="mode-discover"
        data-command="view.mode.discover"
        class="activity-tab"
        onclick={() => layout.setMode("discover")}
      >
        <Compass size={18} strokeWidth={1.7} aria-hidden="true" />
        <span class="activity-tab__label">Discover</span>
        {#if discoverState !== null}
          <span class="activity-tab__state" data-state={discoverState} aria-hidden="true"></span>
        {/if}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content sideOffset={6} class={tooltipClass}>Discover — Alt+3</Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  </div>

  <div class="activity-bar__actions" aria-label="Application actions">
    <IconButton
      label="Commands (Ctrl+K)"
      command="app.palette.open"
      data-testid="activity-commands"
      onclick={onopenpalette}
    >
      <Search size={15} aria-hidden="true" />
    </IconButton>
    <IconButton
      label={notificationLabel}
      command="app.notifications.open"
      data-testid="notification-indicator"
      class="activity-bar__action"
      onclick={() => notifications.openHistory()}
    >
      <Bell size={15} aria-hidden="true" />
      {#if notifications.unread > 0}
        <span class="activity-bar__unread" aria-hidden="true"></span>
      {/if}
    </IconButton>
    <IconButton
      label={themeLabel}
      command="view.theme.toggle"
      data-testid="theme-toggle"
      onclick={() => layout.toggleTheme()}
    >
      {#if layout.theme === "dark"}
        <Sun size={15} aria-hidden="true" />
      {:else}
        <Moon size={15} aria-hidden="true" />
      {/if}
    </IconButton>
    <IconButton
      label={reportLabel}
      command="app.report"
      data-testid="activity-report"
      class="activity-bar__action"
      active={reportphase !== "idle"}
      disabled={reportphase === "sending"}
      onclick={onreportissue}
    >
      <Flag size={15} aria-hidden="true" />
    </IconButton>
  </div>
</div>
