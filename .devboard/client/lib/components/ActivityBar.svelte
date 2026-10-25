<script lang="ts">
  import { Tooltip } from "bits-ui";
  import Target from "lucide-svelte/icons/target";
  import Workflow from "lucide-svelte/icons/workflow";
  import Compass from "lucide-svelte/icons/compass";
  import { layout } from "../layout.svelte";

  const tooltipClass =
    "z-50 rounded-sm border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2 py-1 text-[11px] text-[var(--foreground)] shadow-md";
</script>

<div class="activity-bar" data-testid="activity-bar" aria-label="Devboard modes" role="tablist">
  <span class="activity-bar__brand" aria-hidden="true">DB</span>

  <Tooltip.Root>
    <Tooltip.Trigger
      role="tab"
      id="mode-goal-tab"
      aria-controls="workspace-goal"
      aria-selected={layout.mode === "goal"}
      aria-label="Goal (Alt+1)"
      title="Goal — Alt+1"
      data-testid="mode-goal"
      data-command="view.mode.goal"
      class="activity-tab"
      onclick={() => layout.setMode("goal")}
    >
      <Target size={18} strokeWidth={1.7} aria-hidden="true" />
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
      aria-label="Flow (Alt+2)"
      title="Flow — Alt+2"
      data-testid="mode-flow"
      data-command="view.mode.flow"
      class="activity-tab"
      onclick={() => layout.setMode("flow")}
    >
      <Workflow size={18} strokeWidth={1.7} aria-hidden="true" />
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
      aria-label="Discover (Alt+3)"
      title="Discover — Alt+3"
      data-testid="mode-discover"
      data-command="view.mode.discover"
      class="activity-tab"
      onclick={() => layout.setMode("discover")}
    >
      <Compass size={18} strokeWidth={1.7} aria-hidden="true" />
    </Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Content sideOffset={6} class={tooltipClass}>Discover — Alt+3</Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>
</div>
