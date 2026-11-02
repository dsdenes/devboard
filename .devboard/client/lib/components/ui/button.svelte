<script lang="ts" module>
  import { tv, type VariantProps } from "tailwind-variants";
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";

  export interface ButtonProps extends Omit<HTMLButtonAttributes, "class" | "children"> {
    /**
     * The element the caller styles itself. Bespoke controls (a sidebar row, a
     * choice, a status item) keep their own class rules and their own geometry;
     * only the element that renders them changes.
     */
    bare?: boolean;
    variant?: ButtonVariant;
    size?: ButtonSize;
    /** True while the dispatched command awaits its confirming server state. */
    busy?: boolean;
    /** Exact busy word; defaults to the present participle of `label`. */
    busyLabel?: string;
    /** The resting visible label the busy word is derived from. */
    label?: string;
    class?: string;
    children?: Snippet;
  }

  export const buttonVariants = tv({
    base: "inline-flex shrink-0 items-center justify-center gap-1 rounded-sm border text-[12px] font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--background)] disabled:pointer-events-none disabled:opacity-45",
    variants: {
      variant: {
        default:
          "border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)]",
        secondary:
          "border-[var(--border-strong)] bg-[var(--secondary)] text-[var(--foreground)] hover:bg-[var(--secondary-hover)]",
        outline:
          "border-[var(--border-strong)] bg-transparent text-[var(--foreground)] hover:bg-[var(--secondary)]",
        ghost:
          "border-transparent bg-transparent text-[var(--foreground)] hover:bg-[var(--secondary)]",
        destructive:
          "border-[var(--destructive)] bg-[var(--destructive)] text-[var(--destructive-foreground)] hover:opacity-90",
        link: "border-transparent bg-transparent text-[var(--accent)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-7 px-[10px]",
        sm: "h-6 px-2 text-[11px]",
        icon: "size-7",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  });

  export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
  export type ButtonSize = VariantProps<typeof buttonVariants>["size"];
</script>

<script lang="ts">
  import { busyWord } from "../../command-busy.svelte";
  import { cn } from "../../utils";

  let {
    bare = false,
    variant = "secondary",
    size = "default",
    busy = false,
    busyLabel,
    label,
    class: className = "",
    children,
    onclick,
    onpointerdown,
    onpointerup,
    onpointerleave,
    onpointercancel,
    onkeydown,
    onkeyup,
    onblur,
    "aria-label": ariaLabel,
    ...rest
  }: ButtonProps = $props();

  const word = $derived(busyLabel ?? busyWord(label ?? ""));
  let pressed = $state(false);

  function pointerDown(
    event: PointerEvent & { currentTarget: EventTarget & HTMLButtonElement },
  ): void {
    pressed = true;
    onpointerdown?.(event);
  }

  function pointerUp(
    event: PointerEvent & { currentTarget: EventTarget & HTMLButtonElement },
  ): void {
    pressed = false;
    onpointerup?.(event);
  }

  function pointerLeave(
    event: PointerEvent & { currentTarget: EventTarget & HTMLButtonElement },
  ): void {
    pressed = false;
    onpointerleave?.(event);
  }

  function pointerCancel(
    event: PointerEvent & { currentTarget: EventTarget & HTMLButtonElement },
  ): void {
    pressed = false;
    onpointercancel?.(event);
  }

  function activate(event: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement }): void {
    if (busy) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    onclick?.(event);
  }

  function keyDown(
    event: KeyboardEvent & { currentTarget: EventTarget & HTMLButtonElement },
  ): void {
    if (event.key === " " || event.key === "Enter") pressed = true;
    onkeydown?.(event);
  }

  function keyUp(event: KeyboardEvent & { currentTarget: EventTarget & HTMLButtonElement }): void {
    pressed = false;
    onkeyup?.(event);
  }

  function blur(event: FocusEvent & { currentTarget: EventTarget & HTMLButtonElement }): void {
    pressed = false;
    onblur?.(event);
  }
</script>

<!-- One primitive: every button in the application is this element. -->
<button
  type="button"
  {...rest}
  data-slot="button"
  data-variant={bare ? "bare" : variant}
  data-pressed={pressed ? "true" : undefined}
  aria-busy={busy ? "true" : undefined}
  aria-label={busy && word.length > 0 ? word : ariaLabel}
  class={bare ? className : cn(buttonVariants({ variant, size }), className)}
  onpointerdown={pointerDown}
  onpointerup={pointerUp}
  onpointerleave={pointerLeave}
  onpointercancel={pointerCancel}
  onkeydown={keyDown}
  onkeyup={keyUp}
  onblur={blur}
  onclick={activate}
>
  {#if busy && word.length > 0}
    <span data-slot="button-busy">{word}</span>
  {:else if children}
    {@render children()}
  {:else if label}
    {label}
  {/if}
</button>
