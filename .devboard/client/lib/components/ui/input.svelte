<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";
  import { cn } from "../../utils";

  interface Props extends Omit<HTMLInputAttributes, "class"> {
    class?: string;
  }

  let { class: className = "", ...rest }: Props = $props();
</script>

<input
  data-slot="input"
  class={cn(
    "h-7 w-full min-w-0 rounded-sm border border-[var(--border-strong)] bg-[var(--background)] px-2 text-[12px] font-medium leading-[1.3] text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)] focus-visible:border-[var(--ring)] focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-50",
    className,
  )}
  {...rest}
/>
