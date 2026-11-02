<script lang="ts">
  import type { Snippet } from "svelte";
  import { Tooltip } from "bits-ui";
  import { busyWord } from "../../command-busy.svelte";
  import { cn } from "../../utils";
  import { buttonVariants } from "./button.svelte";

  interface Props {
    label: string;
    command?: string;
    "data-testid"?: string;
    disabled?: boolean;
    active?: boolean;
    /** True while the dispatched command awaits its confirming server state. */
    busy?: boolean;
    /** Exact busy phrase; defaults to the present participle of `label`. */
    busyLabel?: string;
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
    busy = false,
    busyLabel,
    class: className = "",
    onclick,
    children,
  }: Props = $props();

  const word = $derived(busyLabel ?? busyWord(label));
  const name = $derived(busy && word.length > 0 ? word : label);
  let pressed = $state(false);

  function press(): void {
    pressed = true;
  }

  function release(): void {
    pressed = false;
  }

  function activate(event: MouseEvent): void {
    if (busy) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    onclick?.(event);
  }

  function keyDown(event: KeyboardEvent): void {
    if (event.key === " " || event.key === "Enter") press();
  }
</script>

<Tooltip.Provider>
  <Tooltip.Root>
    <Tooltip.Trigger
      class={cn(
        buttonVariants({ variant: "ghost", size: "icon" }),
        active &&
          "border-[var(--border-strong)] bg-[var(--secondary-hover)] text-[var(--foreground)] hover:bg-[var(--secondary-hover)] hover:text-[var(--foreground)]",
        className,
      )}
      data-slot="button"
      data-variant="ghost"
      data-pressed={pressed ? "true" : undefined}
      aria-label={name}
      title={name}
      aria-busy={busy ? "true" : undefined}
      data-command={command}
      data-testid={testid}
      {disabled}
      aria-pressed={active}
      onpointerdown={press}
      onpointerup={release}
      onpointerleave={release}
      onpointercancel={release}
      onkeydown={keyDown}
      onkeyup={release}
      onblur={release}
      onclick={activate}
    >
      {@render children()}
    </Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Content
        sideOffset={6}
        class="z-50 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2 py-1 text-[12px] text-[var(--foreground)] shadow-md"
      >
        {name}
      </Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>
</Tooltip.Provider>
