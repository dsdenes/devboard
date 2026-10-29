<script lang="ts">
  import type { Snippet } from "svelte";
  import { Tooltip } from "bits-ui";
  import { cn } from "../../utils";
  import { buttonVariants } from "./button.svelte";

  interface Props {
    label: string;
    command?: string;
    "data-testid"?: string;
    disabled?: boolean;
    active?: boolean;
    class?: string;
    onclick?: (event: MouseEvent) => void;
    children: Snippet;
  }

  let {
    label,
    command,
    "data-testid": testid,
    disabled = false,
    active = false,
    class: className = "",
    onclick,
    children,
  }: Props = $props();
</script>

<Tooltip.Root>
  <Tooltip.Trigger
    class={cn(
      buttonVariants({ variant: "ghost", size: "icon" }),
      active &&
        "border-[var(--accent)] bg-[var(--accent-surface)] text-[var(--accent)] hover:bg-[var(--accent-surface)] hover:text-[var(--accent)]",
      className,
    )}
    aria-label={label}
    title={label}
    data-command={command}
    data-testid={testid}
    {disabled}
    aria-pressed={active}
    {onclick}
  >
    {@render children()}
  </Tooltip.Trigger>
  <Tooltip.Portal>
    <Tooltip.Content
      sideOffset={6}
      class="z-50 rounded-sm border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2 py-1 text-[12px] text-[var(--foreground)] shadow-md"
    >
      {label}
    </Tooltip.Content>
  </Tooltip.Portal>
</Tooltip.Root>
