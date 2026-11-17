<script lang="ts">
  import { Tooltip } from "bits-ui";
  import Bell from "lucide-svelte/icons/bell";
  import Blocks from "lucide-svelte/icons/blocks";
  import Compass from "lucide-svelte/icons/compass";
  import Flag from "lucide-svelte/icons/flag";
  import ListTodo from "lucide-svelte/icons/list-todo";
  import Moon from "lucide-svelte/icons/moon";
  import Search from "lucide-svelte/icons/search";
  import Sparkles from "lucide-svelte/icons/sparkles";
  import Sun from "lucide-svelte/icons/sun";
  import Target from "lucide-svelte/icons/target";
  import Trash2 from "lucide-svelte/icons/trash-2";
  import Workflow from "lucide-svelte/icons/workflow";
  import { discover } from "../discover.svelte";
  import { flow } from "../flow.svelte";
  import { issues } from "../issues.svelte";
  import { goal } from "../goal.svelte";
  import { layout } from "../layout.svelte";
  import { notifications } from "../notifications.svelte";
  import {
    discoverModeState,
    flowRunState,
    issuesRunState,
    modeStateOf,
    type ModeState,
  } from "../run-state";
  import type { FeedbackAction, FeedbackPhase, Mode } from "../types";
  import IconButton from "./ui/icon-button.svelte";

  interface Props {
    onopenpalette: () => void;
    onreportissue: () => void;
    onremoveelement: () => void;
    onredesignelement: () => void;
    reportphase: FeedbackPhase;
    reportaction: FeedbackAction | null;
    feedbackenabled: boolean;
  }

  let {
    onopenpalette,
    onreportissue,
    onremoveelement,
    onredesignelement,
    reportphase,
    reportaction,
    feedbackenabled,
  }: Props = $props();

  const tooltipClass =
    "z-50 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2 py-1 text-[12px] text-[var(--foreground)] shadow-md";

  // The rail follows the live mode, never the terminal state of one manual run:
  // a resumed lifecycle keeps the Goal tab running, and a stopped run is
  // reported by the console's own notice, exactly while no lifecycle is live.
  const goalState = $derived<ModeState>(
    goal.questionWaiting || (goal.runState === "stopped" && !goal.lifecycleActive)
      ? "attention"
      : goal.lifecycleActive && goal.lifecycle.paused
        ? "attention"
        : goal.lifecycleActive || goal.running
          ? "running"
          : goal.pendingCount > 0
            ? "idle"
            : null,
  );
  // A waiting question wins over the live phase in every mode, and each mode's
  // own derivation lives once in run-state.ts beside its sidebar entry's.
  const issuesRun = $derived(
    issuesRunState(
      issues.lifecycle,
      issues.agents.some((agent) => agent.question !== null),
    ),
  );
  const issuesState = $derived<ModeState>(
    issuesRun === "idle" && !issues.enabled ? null : modeStateOf(issuesRun),
  );
  const flowRun = $derived(flowRunState(flow.status, flow.question !== null));
  const flowState = $derived<ModeState>(
    flowRun !== "idle"
      ? modeStateOf(flowRun)
      : flow.status === "none"
        ? null
        : flow.blockers.some((blocker) => !blocker.dismissed)
          ? "attention"
          : "idle",
  );
  const discoverQuestion = $derived(
    discover.question !== null ||
      Object.values(discover.agentQuestions).some((question) => question !== null),
  );
  const discoverState = $derived<ModeState>(
    discoverModeState({
      active: discover.active,
      stale: discover.stale,
      busy: discover.busy !== null,
      hasQuestion: discoverQuestion,
      hasFailedAgent: discover.errorAgent !== null,
    }),
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
    reportphase !== "idle" && reportaction === "REPORT"
      ? reportphase === "sending"
        ? "Filing the UI issue"
        : reportphase === "composing" || reportphase === "failed"
          ? "Cancel UI issue report"
          : "Cancel element selection"
      : "Report a UI issue",
  );
  const removeLabel = $derived(
    reportaction === "REMOVE"
      ? reportphase === "sending"
        ? "Filing the removal issue"
        : "Cancel element removal"
      : "Remove element",
  );
  const redesignLabel = $derived(
    reportaction === "REDESIGN"
      ? reportphase === "sending"
        ? "Filing the redesign issue"
        : "Cancel element redesign"
      : "Redesign element",
  );
  // A quick action cannot run while the report panel owns the selection.
  const quickDisabled = $derived(
    reportphase === "sending" || reportphase === "composing" || reportphase === "failed",
  );

  // The rail declares the tabs pattern, so it owns that pattern's inputs: one
  // Tab stop, carried by the selected tab, plus arrows, Home, and End that move
  // focus and selection together.
  const modes: Mode[] = ["goal", "issues", "flow", "discover", "devboard"];

  function focusMode(mode: Mode): void {
    layout.setMode(mode);
    document.getElementById(`mode-${mode}-tab`)?.focus();
  }

  function handleModesKeydown(event: KeyboardEvent): void {
    const focusedTab =
      event.target instanceof HTMLElement ? event.target.closest('[role="tab"]') : null;
    const focused = modes.findIndex((mode) => `mode-${mode}-tab` === focusedTab?.id);
    const index = focused === -1 ? modes.indexOf(layout.mode) : focused;
    if (index === -1) return;
    const last = modes.length - 1;
    const next =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    const nextMode = modes[next];
    if (nextMode === undefined) return;
    event.preventDefault();
    focusMode(nextMode);
  }
</script>

<div class="activity-bar" data-testid="activity-bar" aria-label="Devboard application menu">
  <!-- The tabs carry the roving tabindex, so the tablist itself is not a focus target. -->
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div
    class="activity-bar__modes"
    role="tablist"
    aria-label="Devboard modes"
    aria-orientation="vertical"
    onkeydown={handleModesKeydown}
  >
    <Tooltip.Root>
      <Tooltip.Trigger
        role="tab"
        id="mode-goal-tab"
        aria-controls="workspace-goal"
        aria-selected={layout.mode === "goal"}
        tabindex={layout.mode === "goal" ? 0 : -1}
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
        id="mode-issues-tab"
        aria-controls="workspace-issues"
        aria-selected={layout.mode === "issues"}
        tabindex={layout.mode === "issues" ? 0 : -1}
        aria-label={modeLabel("Issues (Alt+2)", issuesState)}
        title={modeLabel("Issues — Alt+2", issuesState)}
        data-testid="mode-issues"
        data-command="view.mode.issues"
        class="activity-tab"
        onclick={() => layout.setMode("issues")}
      >
        <ListTodo size={18} strokeWidth={1.7} aria-hidden="true" />
        <span class="activity-tab__label">Issues</span>
        {#if issuesState !== null}
          <span class="activity-tab__state" data-state={issuesState} aria-hidden="true"></span>
        {/if}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content sideOffset={6} class={tooltipClass}>Issues — Alt+2</Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>

    <Tooltip.Root>
      <Tooltip.Trigger
        role="tab"
        id="mode-flow-tab"
        aria-controls="workspace-flow"
        aria-selected={layout.mode === "flow"}
        tabindex={layout.mode === "flow" ? 0 : -1}
        aria-label={modeLabel("Flow (Alt+3)", flowState)}
        title={modeLabel("Flow — Alt+3", flowState)}
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
        <Tooltip.Content sideOffset={6} class={tooltipClass}>Flow — Alt+3</Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>

    <Tooltip.Root>
      <Tooltip.Trigger
        role="tab"
        id="mode-discover-tab"
        aria-controls="workspace-discover"
        aria-selected={layout.mode === "discover"}
        tabindex={layout.mode === "discover" ? 0 : -1}
        aria-label={modeLabel("Discover (Alt+4)", discoverState)}
        title={modeLabel("Discover — Alt+4", discoverState)}
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
        <Tooltip.Content sideOffset={6} class={tooltipClass}>Discover — Alt+4</Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>

    <Tooltip.Root>
      <Tooltip.Trigger
        role="tab"
        id="mode-devboard-tab"
        aria-controls="workspace-devboard"
        aria-selected={layout.mode === "devboard"}
        tabindex={layout.mode === "devboard" ? 0 : -1}
        aria-label="Devboard (Alt+5)"
        title="Devboard — Alt+5"
        data-testid="mode-devboard"
        data-command="view.mode.devboard"
        class="activity-tab"
        onclick={() => layout.setMode("devboard")}
      >
        <Blocks size={18} strokeWidth={1.7} aria-hidden="true" />
        <span class="activity-tab__label">Devboard</span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content sideOffset={6} class={tooltipClass}>Devboard — Alt+5</Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  </div>

  <div class="activity-bar__actions" aria-label="Application actions">
    <IconButton
      label="Commands (Ctrl+K)"
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
    {#if feedbackenabled}
      <IconButton
        label={reportLabel}
        command="app.report"
        data-testid="activity-report"
        class="activity-bar__action"
        active={reportaction === "REPORT"}
        disabled={reportphase === "sending"}
        onclick={onreportissue}
      >
        <Flag size={15} aria-hidden="true" />
      </IconButton>
      <IconButton
        label={removeLabel}
        command="app.remove"
        data-testid="activity-remove"
        class="activity-bar__action"
        active={reportaction === "REMOVE"}
        disabled={quickDisabled}
        onclick={onremoveelement}
      >
        <Trash2 size={15} aria-hidden="true" />
      </IconButton>
      <IconButton
        label={redesignLabel}
        command="app.redesign"
        data-testid="activity-redesign"
        class="activity-bar__action"
        active={reportaction === "REDESIGN"}
        disabled={quickDisabled}
        onclick={onredesignelement}
      >
        <Sparkles size={15} aria-hidden="true" />
      </IconButton>
    {/if}
  </div>
</div>
